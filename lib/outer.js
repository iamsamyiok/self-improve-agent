// 外层引擎：本机 opencode CLI 子进程 + 上下文单向注入 + 建议 JSON 解析
// DUAL_AGENT_MOCK=1 时走本地假输出（无 opencode 也能演示审批闭环）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { withRetry, RetryableError, isRateLimitText } = require('./llmRetry');

const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data');

// ---------- 软约束系统提示词（无硬编码路径限制） ----------
const SYSTEM_PROMPT = [
  '你是「外层迭代 Agent」，负责观察内层 Agent 的运行日志与插件状态，提出插件改进建议。规则：',
  '1. 你只允许修改插件目录（plugins/）下的文件，绝不修改核心 runtime（server.js / lib/ / public/）。',
  '2. 你的任何修改建议只是建议：必须等待用户在审批栏批准后才会生效，绝不假设建议已生效。',
  '3. 建议必须以一个 ```json 代码块输出，格式（可批量）：',
  '   {"proposals":[{"action":"create|update|delete","plugin":"插件名(小写字母数字连字符)","code":"完整插件源码(create/update 必填)","reason":"修改理由"}]}',
  '4. 插件文件约定：文件头注释 // @name // @desc // @essential 提供元信息；module.exports = { params: JSONSchema, run: async (args, ctx) => string }（ctx.cwd 工作区目录、ctx.dataDir 数据目录）。插件分三类形态：工具类（无状态函数）、记忆类（跨会话状态存 ctx.dataDir）、技能类（markdown 方法论存 ctx.cwd）。',
  '5. 你的工作目录即项目根目录：plugins/ 下是全部插件源码（每次上下文都会给出路径）。提出 update 建议前必须先读取该插件的现有源码，基于真实代码修改；禁止凭名称和描述凭空重写整份插件。新建插件前也应浏览 1-2 个现有插件源码对齐写法。',
  '6. 观察要以失败日志为线索：日志中失败条目带有较完整的错误原文，先诊断根因（插件缺陷 / 参数问题 / 通道问题），只对插件缺陷提出代码修改；通道与参数问题应说明并指导内层规避，而不是改插件。',
  '7. 上下文中会附最近几次审批栏的决定（批准/拒绝）。用户拒绝过的建议不要原样重复提出；要提需先说明与被拒版本的实质差异。',
  '8. 除建议代码块外，回复应简明说明你的观察与判断。没有值得修改的就直接说明，不输出 json 块。'
].join('\n');

// ---------- 单向上下文：插件清单（+首评全量源码） + 内层日志（失败详/成功简） + 审批历史 ----------
// opts.codes: Map<name, code> —— 首次评审（无续聊会话）时由调用方全量附带，续聊只给路径让外层自行 read
// opts.audit: 最近审批决定数组（apply/reject），用于避免重复提议
function buildContext(pluginList, innerLog, opts) {
  const o = opts || {};
  const plugins = pluginList.map(p =>
    `- ${p.name} [${p.essential ? '基础' : '业务'}/${p.status === 'broken' ? '损坏' : p.status === 'loaded' ? '已加载' : '懒加载'}] plugins/${p.name}.js ${p.desc || '（无描述）'}${p.err ? ` ⚠ ${p.err}` : ''}`
  ).join('\n');
  // 失败条目放宽到 600 字符（外层核心线索是失败根因），成功压到 80
  const logs = innerLog.slice(-40).map(l => {
    const args = JSON.stringify(l.args).slice(0, 120);
    const result = String(l.result || '').slice(0, l.ok ? 80 : 600);
    return `[${new Date(l.ts).toISOString().slice(11, 19)}] ${l.plugin}(${args}) → ${l.ok ? '成功' : '失败'} ${l.ms}ms：${result}`;
  }).join('\n') || '（内层暂无插件调用日志）';
  let sections = `== 当前插件清单 ==\n${plugins}`;
  if (o.codes && o.codes.size) {
    const codeBlocks = [...o.codes.entries()].map(([name, code]) =>
      `--- plugins/${name}.js ---\n${code}`
    ).join('\n\n');
    sections += `\n\n== 插件源码全文（首次评审快照；之后可随时用文件工具读取 plugins/ 下的文件） ==\n${codeBlocks}`;
  }
  if (Array.isArray(o.audit) && o.audit.length) {
    sections += `\n\n== 最近审批栏决定（勿重复提出被拒建议） ==\n${o.audit.join('\n')}`;
  }
  // 插件质量分：低质量插件（近期成功率 <60% 且 ≥5 次调用）优先级最高，明确指示优先诊断
  if (Array.isArray(o.scores) && o.scores.length) {
    const low = o.scores.filter(s => s.lowQuality);
    const lines = o.scores.slice(0, 12).map(s =>
      `- ${s.name}：调用 ${s.total} 次，近期失败率 ${(s.recentFailRate * 100).toFixed(0)}%${s.lowQuality ? ' ⚠ 低质量' : ''}`
    ).join('\n');
    const hint = low.length
      ? `\n⚠ 低质量插件（${low.map(s => s.name).join('、')}）优先诊断：先读其源码与失败日志原文定位根因，再提修复建议。`
      : '';
    sections += `\n\n== 插件质量统计（按近期失败率排序） ==\n${lines}${hint}`;
  }
  sections += `\n\n== 内层最近插件调用日志（失败条目含错误原文） ==\n${logs}`;
  return sections;
}

// ---------- opencode 子进程 ----------
// Windows 兼容（效仿 agents-chat findCli）：
// - npm 全局安装的 CLI 在 Windows 是 .cmd 垫片，且 where 可能先返回无扩展名的 bash 垫片
//   （文件存在但 Node spawn 直接执行报 ENOENT），须优先选 .exe/.cmd/.bat/.com 可执行垫片
// - .cmd/.bat 垫片必须 shell:true 启动（Node 18.20+ 禁止直接 spawn .cmd）
// - DUAL_AGENT_OPENCODE_CMD 可显式指定完整路径，优先级最高
const { exec } = require('child_process');

function detectOpencode() {
  return new Promise((resolve) => {
    const custom = process.env.DUAL_AGENT_OPENCODE_CMD;
    if (custom && fs.existsSync(custom)) {
      return resolve({ cmd: custom, shell: /\.(cmd|bat)$/i.test(custom) });
    }
    exec(process.platform === 'win32' ? 'where opencode' : 'which opencode', { timeout: 5000 }, (err, so) => {
      if (err) return resolve(null);
      const all = String(so || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(p => fs.existsSync(p));
      if (!all.length) return resolve(null);
      const winExe = all.find(p => /\.(exe|cmd|bat|com)$/i.test(p));
      const first = process.platform === 'win32' && winExe ? winExe : all[0];
      resolve({ cmd: first, shell: /\.(cmd|bat)$/i.test(first) });
    });
  });
}

// shell 模式下 child.kill 只能杀掉 shell 垫片，孙进程会残留，须杀整棵进程树
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      require('child_process').execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', timeout: 10000 });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程可能已退出 */ }
}

// 运行外层：全量文本快照经 onEvent 下发，结束时解析建议 json
// sessionId 非空时以 `-s ses_xxx` 在同一 opencode 会话续聊（外层记得之前的对话）；
// 事件流中首个 sessionID 经 onEvent({type:'session'}) 回传，由调用方持久化供下次续聊
const OC_SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

// 外层限流退避：opencode 内部 LLM 限流耗尽其自身重试后会异常退出，
// 按与内层相同的 3s→9s→27s→81s 序列整体重跑评审会话（有 sessionId 续聊，上下文不丢）
function runOuterReal(runner, prompt, cwd, onEvent, sessionId) {
  return withRetry(async () => {
    const r = await runOuterOnce(runner, prompt, cwd, onEvent, sessionId);
    if (r.error && isRateLimitText(r.error)) throw new RetryableError(r.error.slice(0, 160));
    return r;
  }, { onEvent, label: '外层评审' });
}

function runOuterOnce(runner, prompt, cwd, onEvent, sessionId) {
  return new Promise((resolve) => {
    const args = ['run', '--format', 'json'];
    if (sessionId && OC_SESSION_RE.test(sessionId)) args.push('-s', sessionId);
    if (process.env.DUAL_AGENT_AUTO_APPROVE !== '0') args.push('--auto');
    const child = spawn(runner.cmd, args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: !!runner.shell, windowsHide: true,
      env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' } // 尽量让子进程输出 UTF-8
    });
    let closed = false;
    let seenSession = '';
    const finish = (error) => {
      if (closed) return;
      closed = true;
      resolve({ error, sessionId: seenSession, fullText: full });
    };
    const killer = setTimeout(() => { killTree(child); finish('执行超时（10 分钟）'); }, 10 * 60 * 1000);

    child.stdin.on('error', () => {});
    child.stdin.write(prompt);
    child.stdin.end();

    let buf = '';
    let full = ''; // 全量正文快照
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.sessionID && !seenSession && OC_SESSION_RE.test(String(ev.sessionID))) {
          seenSession = String(ev.sessionID);
          onEvent({ type: 'session', sessionId: seenSession });
        }
        if (ev.type === 'text' && ev.part && typeof ev.part.text === 'string' && ev.part.text.trim()) {
          full = ev.part.text; // opencode text 事件为全量快照
          onEvent({ type: 'text', text: full });
        }
      }
    });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d.toString(); });
    child.on('error', (e) => { clearTimeout(killer); finish(`无法启动 opencode：${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code !== 0 && !full) finish(`opencode 异常退出（码 ${code}）：${errBuf.slice(0, 400)}`);
      else finish('');
    });
  });
}

// ---------- 演示模式：固定建议输出 ----------
async function runOuterMock(cmd, prompt, cwd, onEvent) {
  const text = [
    '观察内层日志：write 插件只能整文件覆盖，写大文件效率低，建议新增一个追加写入插件 append。',
    '',
    '```json',
    JSON.stringify({
      proposals: [{
        action: 'create',
        plugin: 'append',
        code: [
          '// @name append',
          '// @desc 向文件末尾追加内容（文件不存在则创建）',
          '// @essential false',
          "const fs = require('fs');",
          "const path = require('path');",
          '',
          'module.exports = {',
          '  params: {',
          '    type: "object",',
          '    properties: {',
          '      path: { type: "string", description: "文件路径" },',
          '      content: { type: "string", description: "追加的内容" }',
          '    },',
          '    required: ["path", "content"]',
          '  },',
          '  run: async (args, ctx) => {',
          '    const fp = path.resolve(ctx.cwd, String(args.path || ""));',
          "    fs.mkdirSync(path.dirname(fp), { recursive: true });",
          '    fs.appendFileSync(fp, String(args.content == null ? "" : args.content), "utf8");',
          '    return `已追加到 ${fp}`;',
          '  }',
          '};',
          ''
        ].join('\n'),
        reason: 'write 插件整文件覆盖的开销随文件增大；append 支持日志/流水类追加场景，减少内层 token 消耗'
      }]
    }),
    '```'
  ].join('\n');
  // 分片下发模拟流式
  for (let i = 0; i < text.length; i += 80) {
    onEvent({ type: 'text', text: text.slice(0, i + 80) });
    await new Promise(r => setTimeout(r, 30));
  }
  return { error: '', sessionId: '', fullText: text };
}


// ---------- 建议 JSON 解析（```json 代码块 → proposals 数组） ----------
// 围栏容错：插件 code 内部可能嵌套 ```（如 skill 类插件的教学示例），
// 最短闭合点切出的片段常非法 JSON → 从近到远逐个闭合点尝试 parse，首个成功者为准
function parseProposals(text) {
  const out = [];
  const s = String(text || '');
  const startRe = /```(?:json)?[ \t]*\r?\n/g;
  let m;
  while ((m = startRe.exec(s)) !== null) {
    const start = m.index + m[0].length;
    // 收集该起点之后全部候选闭合点
    const ends = [];
    const closeRe = /```/g;
    closeRe.lastIndex = start;
    let e;
    while ((e = closeRe.exec(s)) !== null) ends.push(e.index);
    for (const end of ends) {
      let obj;
      try { obj = JSON.parse(s.slice(start, end)); } catch { continue; } // 扩展到更远闭合点重试
      const list = Array.isArray(obj.proposals) ? obj.proposals : (obj.action ? [obj] : []);
      for (const p of list) {
        const action = ['create', 'update', 'delete'].includes(p.action) ? p.action : null;
        if (!action || !p.plugin) continue;
        out.push({
          action,
          plugin: String(p.plugin).trim(),
          code: String(p.code == null ? '' : p.code),
          reason: String(p.reason == null ? '' : p.reason).slice(0, 500)
        });
      }
      startRe.lastIndex = Math.max(startRe.lastIndex, end + 3);
      break; // 该起点已消费，处理下一个起点
    }
  }
  return out;
}

module.exports = { SYSTEM_PROMPT, buildContext, detectOpencode, runOuter: (process.env.DUAL_AGENT_MOCK === '1' ? runOuterMock : runOuterReal), parseProposals };
