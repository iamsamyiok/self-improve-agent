// hwj 引擎封装 — 会话/配置持久化 + 任务编排（终端版 handleInnerChat 等价实现）
// server.js 是 HTTP 单体无法 require，此文件按其 handleInnerChat（L445-L822）语义复刻：
// 注入 → 意图契约 → 执行循环（止损/里程碑/子智能体）→ 超时收敛 → 长文强制重入 → 交付核验返修 → 落盘
// 内核零改动复用：lib/inner.js（chatInner）+ lib/plugins.js（21 插件）+ lib/llmRetry.js（withTaskResume）
const fs = require('fs');
const path = require('path');
const plugins = require('../lib/plugins');
const { chatInner, chatInnerReal, isMultiStepTask, isLongFormTask, isRefusalNudge, pairSafeTail } = require('../lib/inner');
const { withTaskResume, NET_CODES } = require('../lib/llmRetry');
const { validProfiles, pickProfile } = require('../lib/profiles');

// 用户中断异常：SIGINT 置位后在下一次工具调用边界抛出，已完成轮次保持配对完整
class HwjAbortError extends Error {
  constructor() { super('用户中断（Ctrl+C）'); this.name = 'HwjAbortError'; this.aborted = true; }
}

// ---------- 路径与持久化 ----------
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(ROOT, '.data');
const WS_ROOT = process.env.DUAL_AGENT_WS_ROOT || path.join(ROOT, 'workspaces');
const WS_NAME_RE = /^[a-z0-9-]{1,40}$/;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'hwj-state.json');
const DEFAULT_CONFIG = { inner: { base_url: '', api_key: '', model: '' }, inner_profiles: [], workspace: 'default' };

function ensureDirs() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(WS_ROOT, { recursive: true }); }
ensureDirs(); // 模块加载即建目录（对齐 server 顶层行为：saveHwjState 等弱写入依赖目录已存在）

function getConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}
// 配置写回与 server 同 schema（仅 inner 段合并），保证网页版可读
function saveInnerConfig(patch) {
  const cfg = getConfig();
  const next = { ...cfg, inner: { ...cfg.inner, ...patch } };
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* 非 POSIX 忽略 */ }
  return next;
}
// embedding 段写回（语义记忆 recall/remember 用；与 server saveConfig 同 schema）
function saveEmbeddingConfig(patch) {
  const cfg = getConfig();
  const cur = cfg.embedding || {};
  const next = { ...cfg, embedding: { ...cur, ...patch } };
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* 非 POSIX 忽略 */ }
  return next;
}
function hwjState() {
  try { return { mode: 'build', ws: 'default', ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; }
  catch { return { mode: 'build', ws: 'default' }; }
}
function saveHwjState(s) { ensureDirs(); try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 1)); } catch { /* 状态丢失可容忍 */ } }

function wsDir(ws) {
  const name = WS_NAME_RE.test(String(ws || 'default')) ? String(ws || 'default') : 'default';
  const dir = path.join(WS_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function listWorkspaces() {
  let names = [];
  try { names = fs.readdirSync(WS_ROOT).filter(n => WS_NAME_RE.test(n) && fs.statSync(path.join(WS_ROOT, n)).isDirectory()); } catch { /* 无目录 */ }
  if (!names.includes('default')) names.unshift('default');
  return names.sort();
}
// hwj 会话独立于 server（inner-messages.json 互不读写），损坏时备份降级重开
const sessionPath = ws => path.join(wsDir(ws), 'hwj-messages.json');
function loadSession(ws) {
  const fp = sessionPath(ws);
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Array.isArray(arr)) return arr;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { fs.copyFileSync(fp, fp + '.bak'); } catch { /* ignore */ }
      return { corrupted: true, messages: [] };
    }
  }
  return [];
}
function persistSession(ws, messages) {
  try { fs.writeFileSync(sessionPath(ws), JSON.stringify(pairSafeTail(messages, 60), null, 1)); }
  catch (e) { throw new Error('会话落盘失败：' + (e && e.message || e)); }
}
function clearSession(ws) { try { fs.unlinkSync(sessionPath(ws)); } catch { /* 无文件 */ } }

// ---------- 过程留痕（与 server 同格式写 process.md，双端 append-only 共存） ----------
function fmtClock(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function appendProcess(ws, text) {
  try {
    const fp = path.join(wsDir(ws), 'process.md');
    // 体量保护与 server 一致：超 2MB 保留尾部 1MB
    try {
      const st = fs.statSync(fp);
      if (st.size > 2 * 1024 * 1024) {
        const keep = fs.readFileSync(fp, 'utf8').slice(-1024 * 1024);
        fs.writeFileSync(fp, keep.slice(keep.indexOf('\n---\n') >= 0 ? keep.indexOf('\n---\n') : 0));
      }
    } catch { /* 新文件 */ }
    fs.appendFileSync(fp, text, 'utf8');
  } catch { /* 留痕失败不阻断 */ }
}
// 内层插件日志（与 server 同文件同格式，供 /usage 与审计）
const INNER_LOG_JSONL = path.join(DATA_DIR, 'inner-log.jsonl');
function appendInnerLog(entry) {
  try { fs.appendFileSync(INNER_LOG_JSONL, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* ignore */ }
}

// ---------- hwj 系统提示（核心纪律对齐 server 版 + 终端场景措辞） ----------
// 面向用户的最终回复兜底：当模型把整段回复输出成原始 JSON/代码围栏包裹的 JSON 时，
// 提取可读字段组织成自然语言；无法提取时给出通用说明。只处理"整体就是 JSON"的极端情况。
function humanizeAnswer(text) {
  let s = String(text ?? '').trim();
  if (!s) return s;
  // 剥掉 ```json ... ``` 围栏
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  if (!(s.startsWith('{') && s.endsWith('}'))) return text;
  let obj; try { obj = JSON.parse(s); } catch { return text; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return text;
  const name = obj.name || obj.agent || obj.assistant;
  const developer = obj.developer || obj.vendor || obj.provider || obj.organization;
  const desc = obj.description || obj.intro || obj.bio || obj.about;
  if (name && (desc || developer)) {
    const who = developer ? `我是 ${name}，由 ${developer} 驱动的智能体。` : `我是 ${name}。`;
    return who + (desc ? ` ${desc}` : '') + '\n\n有什么任务需要我帮忙，直接说就可以——比如创建文件、整理资料、做计算或写文档。';
  }
  if (name) return `我是 ${name}，一个可以帮你执行任务的智能体。有什么需要帮忙的，直接告诉我即可。`;
  if (desc) return String(desc);
  // 完全不可读的 JSON：不把原始结构暴露给用户
  return '我在的。有什么任务需要帮忙，直接说就可以——比如创建文件、整理资料、做计算或写文档。';
}

function buildHwjSystemPrompt(cwd) {
  const now = new Date();
  const dateStr = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日（星期${'日一二三四五六'[now.getDay()]}）`;
  // P0 修复（2026-09-03）：此前此处误写为 return [ ... ]，直接返回原始数组——
  // 下方 systemPatch/strategy 注入全部成为死代码，strategy 类 A/B 实验的 candidate 从未收到策略注入，
  // 历史"strategy 突变 delta≈0"的结论实际是"注入失效"，需要重新审视。
  const skillPromptSection = (() => { try { return require('../plugins/skill').promptSection({ cwd: cwd || process.cwd() }); } catch { return ''; } })();
  const lines = [
    '你是 hwj 终端智能体（dual-agent 内层执行 Agent），通过调用插件完成任务，完成后用简洁中文总结（面向终端阅读，直接输出结果）。当前日期：' + dateStr + '（涉及"最新/近期"的搜索与判断以此为准）。',
    '',
    '## 身份与对话纪律：',
    '1. 对用户的自我介绍统一为：HWJ Agent，一个会执行任务、自我核验交付、并从任务中持续进化的智能体。底层模型与供应商信息属于实现细节，用户未主动追问时一律不提',
    '2. 被问"你是谁/你能做什么"等闲聊或身份问题时，直接用两三句自然语言回答，禁止调用工具，禁止输出 JSON、代码块或任何结构化格式',
    '3. 所有面向用户的回复必须是自然语言。结构化数据（JSON/YAML）只允许出现在工具调用参数与写入文件的内容中，禁止作为回复正文输出',
    '',
    '## 任务执行前必须：',
    '1. 先调用 memory.search(query="任务关键词") 检索相关记忆——记忆仅当与本任务直接相关才使用，禁止被旧任务记忆带偏目标',
    ...(skillPromptSection ? [skillPromptSection, ''] : []),
    '3. 复杂任务（≥3 步骤/多文件/含"然后/接着/再/最后"）必须先 todo.add 建清单，每完成一步 todo.toggle 勾选，全部完成时清单应全为 [x]',
    '4. 产出验证纪律：收尾前用 verify 插件断言关键产出（exists + contains + line_count），FAIL 必须修复后重验，PASS 才能总结',
    '5. 探索型子任务（多文件调研/方案对比/≥2 个独立查证）用 subagent 并行派生，主上下文只收结论',
    '6. 搜索纪律：相关性低于 0.3 视为无效，连续 2 次无效禁止重搜——必须 fetch 正文/换英文/直取权威信源',
    '7. 收敛纪律：接近轮数上限（[轮数预算] 注记）立即总结已有发现；搜不到精确数字给量级估计+依据+标注"无权威来源"',
    '8. 执行者身份纪律：创作类任务没有"超出能力"——分章分段写入（write 首段 + append 续写，每段 ≤1500 字符），轮数不够框架自动续航。禁止以任何理由拒绝任务',
    '',
    '## 工具调用规则：',
    '1. 每次工具调用完整提供所有必填参数；并行多调用时 path 等参数每次单独带上',
    '2. edit 的 oldText 必须先 read 后逐字符复制（含缩进），不能凭记忆编写',
    '3. 联网信息：先 search 拿列表，再 fetch 打开链接读全文',
    '4. 长内容分段写入：首次 write 创建，后续一律 write append=true 逐段追加（≤1500 字符/段）；普通 write 续写会整体覆盖',
    '5. 收到「参数在 API 传输中丢失/截断」提示：第 1 次原样重试，再次出现必须改小分段',
    '6. JSON 配置文件使用双引号',
    '7. 被问到 token 用量：必须调用 usage 插件取真实数据作答，[token 计量] 注记可直接引用',
    '',
    '## 回复纯净纪律：',
    '1. 面向用户的总结只包含任务结果本身（结论/交付物路径/关键数据）',
    '2. 禁止复述框架注入的检索过程与统计（如"归档匹配 N 条"、"记忆检索结果 N 条已忽略"、[框架预取] 段内容）——这些是背景参考，复述出来就是噪音',
    '3. 禁止输出工具调用日志与执行细节',
    '',
    '## 记忆与技能沉淀：',
    '1. 学到新信息（用户偏好/项目结构/技术选型）调用 memory.save(level="long", ...) 记录',
    '2. 可复用方法论调用 skill.save(name=..., content=...) 沉淀',
    '3. 保存前先 memory.search 检索避免重复；tags 不超过 3 个',
    '',
    '## 交付总结格式：',
    '1. 产出文件路径 + 关键内容摘要',
    '2. 验证结果（verify PASS 项）',
    '3. 简洁直接，禁止过程流水账'
  ];
  // Evolution Engine 注入的候选策略不是修改核心代码，而是作为可实验 policy layer。
  let patch = String(process.env.DUAL_AGENT_SYSTEM_PATCH || '').trim();
  if (!patch) { try { patch = fs.readFileSync(path.join(DATA_DIR, 'evolution', 'system-patch.txt'), 'utf8').trim(); } catch {} }
  if (patch) {
    lines.push('', '## Evolution Candidate Policy', '以下是本次实验候选策略。它不是用户需求，只有在不违反用户要求时才执行：', patch.slice(0, 8000));
  }
  let strategyRaw = process.env.DUAL_AGENT_EVOLUTION_STRATEGY;
  if (!strategyRaw) { try { strategyRaw = fs.readFileSync(path.join(DATA_DIR, 'evolution', 'strategy.json'), 'utf8'); } catch {} }
  if (strategyRaw) {
    try {
      const st = JSON.parse(strategyRaw);
      if (st && typeof st === 'object') {
        if (st.verification === 'strong') lines.push('', '[Evolution Strategy] 强化验证：最终交付前必须对每个关键产出执行 verify，并把客观结果写入总结。');
        if (st.toolSelection === 'conservative') lines.push('', '[Evolution Strategy] 工具选择采用保守策略：优先已经成功过的工具组合，失败后再探索新组合。');
        if (st.memoryTopK) lines.push('', `[Evolution Strategy] memory recall top_k=${Math.max(1, Math.min(10, Number(st.memoryTopK)||3))}。`);
      }
    } catch { /* candidate strategy 非法时静默忽略，实验由 evaluator 判定失败 */ }
  }
  return lines.join('\n');
}

// ---------- 任务编排主入口 ----------
// ctx: { ws, mode, ui, abort: () => bool }；返回 { ok, finalText, aborted }
async function runTask(input, ctx) {
  const WS = wsDir(ctx.ws);
  const ui = ctx.ui;
  const isMock = process.env.DUAL_AGENT_MOCK === '1';
  const cfg = getConfig();
  if (!isMock && !(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model)) {
    throw new Error('内层 API 未配置：输入 /config 进入配置向导');
  }
  const messages = loadSession(ctx.ws);
  if (messages.corrupted) { ui.printInfo('会话文件损坏，已备份为 .bak 并重开新会话'); }
  const msgs = messages.corrupted ? [] : messages;
  // 系统提示首位重建（日期每日刷新；cwd=工作区目录，用于技能根定位）
  if (msgs[0] && msgs[0].role === 'system') msgs[0].content = buildHwjSystemPrompt(ctx.ws);
  else msgs.unshift({ role: 'system', content: buildHwjSystemPrompt(ctx.ws) });

  appendProcess(ctx.ws, `\n---\n\n## ${fmtClock(Date.now())} 📋 任务（hwj）\n\n${input}\n`);

  // 框架级意图抽取（非 MOCK 时主动建立契约，比 server 靠模型自觉更稳；失败静默降级）
  const intentPlugin = require('../plugins/intent');
  if (!isMock) {
    try {
      await plugins.runPlugin('intent', { action: 'extract', task: input }, { cwd: WS, dataDir: DATA_DIR, config: CONFIG_PATH });
    } catch { /* 抽取失败按无契约处理，核验跳过 */ }
  }
  const intentNote = () => { try { return intentPlugin.getIntentNote(); } catch { return ''; } };
  const hasActiveIntent = () => { try { return !!intentPlugin.getState().intent; } catch { return false; } };
  const getCurrentIntent = () => { try { return intentPlugin.getState().intent; } catch { return null; } };

  // finalMsg 三段注入（与 server 逐字对齐：多步纪律/长文账本/拒绝催促对齐）
  let finalMsg = input;
  if (isMultiStepTask(input)) {
    // 黑板骨架框架预创建：等模型自觉创建门槛太高（与 memory.save 同病根），框架先建好
    // 目标骨架，模型只需持续更新内容；blackboardNote 因此从第一轮起就有内容可注入
    try {
      const bb = path.join(WS, 'task-state.md');
      // 新多步任务开始即重写黑板（覆盖上一任务的残留状态，防串任务）
      fs.writeFileSync(bb, `# 任务黑板\n\n## 目标\n${String(input).slice(0, 500)}\n\n## 状态\n- [ ] 待更新（执行中每完成一步必须更新本文件）\n\n## 关键发现\n（执行中记录）\n`, 'utf8');
      ui.printInfo('已创建任务黑板 task-state.md');
    } catch { /* 黑板预创建失败不影响任务 */ }
    finalMsg = input + '\n\n[框架提示] 本任务为多步任务，三项纪律：\n1) 开始执行前必须先用 todo 建任务清单（每个步骤一条 todo.add），每完成一步立即 todo.toggle(id=...)，全部完成时清单应全为 [x]。\n2) 收尾前必须用 verify 插件断言每个产出文件（exists + contains 内容特征 + line_count），看到 FAIL 先修复再重验，全 PASS 才能总结。\n3) 黑板纪律：框架已在 ' + WS + '/task-state.md 创建黑板文件（含任务目标），执行中每完成一个步骤必须立即用 write/edit（或 bash 写入同一绝对路径）更新它（勾改状态、记录产出文件路径与关键发现）；框架每轮会把黑板内容注记给你——上下文被折叠后以黑板为准，先看黑板再行动。注意：黑板绝对路径是 ' + WS + '/task-state.md，禁止写到其他目录。';
    ui.printInfo('检测到多步任务，已注入任务清单+产出验证提醒');
  }
  if (isLongFormTask(input)) {
    finalMsg = input + '\n\n[框架提示] 本任务为长文创作任务，你必须用工具流完成，禁止以"超出输出能力/篇幅过长/轮数限制"为由拒绝或讨价还价。能力账本（算给你看）：框架轮数预算 72 轮（24 轮/段 × 3 段自动续航），每轮稳定输出 1000-1500 字符，万字只需 10-15 轮写入——预算绰绰有余，任何"单次输出上限"都不构成障碍。执行纪律：\n' +
      '1) 先规划章节：todo.add 每章一条（如"第一章 起势：冲突建立"），章节数按目标字数÷每章 600-800 字估算；\n' +
      '2) 逐章写入文件：每章内部再分段——首次 write(path=文件名, content=本章第一段)，后续每段写之前必须先用 read(path=同一文件名, tail=N) 读取最后 N 字符（N=500，确认结尾段落）；append 续写时 content 必须以 \\n 开头（新起一段），章节标题（如 ## 第三章 xxx）必须独占一行，否则 markdown 渲染不出标题；\n' +
      '2b) append 续写前上下文确认：每次 write append=true 之前，必须先 read 已写文件的最后 500 字符（tail 参数），确认新段与已有内容在情节/人物/时间线上连续；如发现断层或人物名字/地点不一致，先修复再续写；\n' +
      '3) 每完成一章 todo.toggle 勾选，再写下一章；全部章节完成后 verify 断言（exists + line_count + contains 关键情节词 + regex: /^\\#\\# 第/ 检查每个章节标题独占一行）；' +
      '3b) 字数验证：交付前用 bash 命令 `wc -m <文件名>` 获取真实字符数，写入交付说明；禁止自行估算字数；\n' +
      '4) 最后输出交付说明：文件路径 + 章节目录 + 总字数（来自 wc -m，禁止估算）+ 已写章节数。中途上下文被折叠属正常现象，照常续写；\n' +
      '4b) 中途一致性检查点：每完成 3 章，暂停写入，用 bash `wc -m <文件名>` 记录当前字数，再用 memory.save(level="short", content="剧情摘要：当前章节 + 活跃人物 + 关键伏笔 + 时间线") 保存状态；下次 append 前 memory.search 召回确认情节连续性；\n' +
      '5) 自主决策：章节划分、情节走向、文件名等细节自行合理决定并立即执行，禁止以提问/确认/给方案开局——用户要的是写好的成品文件。仅当目标超过 3 万字时，可先交付完整的前 1/3 章节并在文件中注明续写点。';
    ui.printInfo('检测到长文创作任务，已注入分章分段创作纪律');
  }
  if (msgs.length) {
    const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant' && m.content);
    if (lastAssistant && isRefusalNudge(lastAssistant.content, input)) {
      finalMsg = input + `\n\n[框架提示] 你上一条回复以"无法/抱歉/建议"拒绝了用户的任务，本消息是用户要求你执行它的催促——指的就是刚才被你拒绝的那个任务，不是历史中的任何其他任务。现在必须开始执行：按长文/多步任务的工具流纪律（todo 建清单 → 分段 write → verify 验证）完成它；工作区记忆与历史中的旧任务内容仅为背景参考，与当前任务无关时必须忽略。`;
      ui.printInfo('检测到拒绝后催促，已注入任务对齐指令');
    }
  }
  // 记忆预取（v0.9.31，对齐 Hermes 启动即注入的 push 模式；与 server 逐字对齐）：
  // 任务开始前用用户消息跨层检索（语义 recall + 任务归档 archive_search），命中即注入消息尾部
  // ——pull 模型下模型不主动 search 的遵循度问题由此根治；整体 4s 超时保护，失败/为空静默跳过
  try {
    const prefetch = await Promise.race([
      (async () => {
        const q = String(input || '').slice(0, 120);
        const emptyHit = s => !s || /为空|没有匹配|没有标签/.test(String(s).slice(0, 60));
        const trim = s => String(s).split('\n').slice(0, 8).join('\n').slice(0, 900);
        const [vec, arc] = await Promise.all([
          plugins.runPlugin('memory', { action: 'recall', query: q, top_k: Math.max(1, Math.min(10, Number((() => { try { const st=JSON.parse(process.env.DUAL_AGENT_EVOLUTION_STRATEGY||'{}'); return st.memoryTopK || 3; } catch { return 3; } })()))) }, { cwd: WS, dataDir: DATA_DIR }).catch(() => ''),
          plugins.runPlugin('memory', { action: 'archive_search', query: q }, { cwd: WS, dataDir: DATA_DIR }).catch(() => '')
        ]);
        const parts = [];
        if (!emptyHit(vec)) parts.push(`【语义记忆】\n${trim(vec)}`);
        if (!emptyHit(arc)) parts.push(`【历史任务】\n${trim(arc)}`);
        return parts.length ? `\n\n[框架预取·相关记忆] 以下是自动检索到的与本任务相关的既有记忆与历史任务（仅供参考，与本任务无关时必须忽略，禁止被旧任务带偏目标）：\n${parts.join('\n')}\n需要更多细节可继续用 memory recall / archive_search 检索。` : '';
      })(),
      new Promise(r => setTimeout(() => r(''), 4000))
    ]);
    if (prefetch) {
      finalMsg += prefetch;
      ui.printInfo('已预取相关记忆与历史任务注入上下文');
    }
  } catch { /* 预取失败不影响任务 */ }
  // 教训卡注入（缺口经验运行时化）：历史任务核验 FAIL 的教训按任务相似度检索注入，
  // 与 A/B 晋级通道并行、零门槛即时生效；dataDir 隔离保证实验沙箱内为空集（不影响 A/B 归因）
  try {
    const lessonSec = require('../lib/evolution').lessonsPromptSection(input, 3);
    if (lessonSec) { finalMsg += lessonSec; ui.printInfo('已注入相关教训卡'); }
  } catch { /* 教训检索失败不影响任务 */ }
  msgs.push({ role: 'user', content: finalMsg });
  persistSession(ctx.ws, msgs);

  // 事件路由：过程落盘 + ui 透传（与 server handleEvent 同构）
  let pendingText = '';
  const flushText = () => {
    if (pendingText.trim()) appendProcess(ctx.ws, `\n### ${fmtClock(Date.now())} 💬 内层\n\n${pendingText.trim()}\n`);
    pendingText = '';
  };
  const handleEvent = (ev) => {
    if (ev.type === 'text' && !ev.sub) { pendingText = ev.text; ui.setReply(ev.text); }
    else if (ev.type === 'tool_call') {
      flushText();
      let pretty = ''; try { pretty = JSON.stringify(ev.args, null, 2); } catch { pretty = String(ev.args); }
      appendProcess(ctx.ws, `\n### ${fmtClock(Date.now())} 🔧 ${ev.sub ? '[子] ' : ''}${ev.plugin}\n\n**入参**\n\n\`\`\`json\n${pretty}\n\`\`\`\n`);
      ui.toolCall(ev);
    } else if (ev.type === 'tool_result') {
      appendProcess(ctx.ws, `**结果** ${ev.ok ? '✓' : '✗'}（${ev.ms}ms）${ev.sub ? ' [子智能体]' : ''}\n\n\`\`\`\n${String(ev.result).slice(0, 2000)}\n\`\`\`\n`);
      ui.toolResult(ev);
    } else if (ev.type === 'info') {
      flushText(); ui.printInfo(ev.text || '');
      appendProcess(ctx.ws, `\n### ${fmtClock(Date.now())} ⏳ ${String(ev.text || '')}\n`);
    } else if (ev.type === 'usage') {
      try {
        const uf = path.join(WS, 'inner-usage.json');
        let rows = []; try { rows = JSON.parse(fs.readFileSync(uf, 'utf8')); } catch { /* 首次 */ }
        if (!Array.isArray(rows)) rows = [];
        rows.push({ ts: Date.now(), prompt: ev.last.prompt, completion: ev.last.completion, cached: ev.last.cached, est: !!ev.est, sub: !!ev.sub, profile: ev.tag || 'main',
          totalsPrompt: ev.totals.prompt, totalsCompletion: ev.totals.completion, totalsCalls: ev.totals.calls });
        fs.writeFileSync(uf, JSON.stringify(rows, null, 1), 'utf8');
      } catch { /* 计量失败不阻断 */ }
      ui.usage(ev);
    } else if (ev.type === 'error') {
      flushText(); ui.printError(String(ev.content || ''));
      appendProcess(ctx.ws, `\n### ${fmtClock(Date.now())} ❌ 错误\n\n${String(ev.content)}\n`);
    }
  };

  // 动态清单注记 + 自动续航判定（对齐 server）
  const readTodo = () => {
    try { const arr = JSON.parse(fs.readFileSync(path.join(WS, '.todo.json'), 'utf8')); return Array.isArray(arr) ? arr : []; }
    catch { return []; }
  };
  const todoNote = () => {
    const arr = readTodo();
    if (!arr.length) return '';
    const open = arr.filter(t => !t.done), done = arr.filter(t => t.done);
    const lines = ['[任务清单] 当前进度（执行中发现计划不适用必须修订：todo.add 加步骤/调整后再继续）：'];
    for (const t of open) lines.push(`- [ ] #${t.id} ${t.text}`);
    for (const t of done.slice(-3)) lines.push(`- [x] #${t.id} ${t.text}`);
    if (done.length > 3) lines.push(`- （另有 ${done.length - 3} 项已完成略）`);
    return lines.join('\n');
  };
  const shouldContinue = () => readTodo().some(t => !t.done);
  // 黑板模式：读取工作区 task-state.md（多步任务的状态文件，模型按黑板纪律维护），
  // 每轮注入发送副本——上下文折叠后的浓缩权威状态源。截断 1500 字符控制注记预算。
  const readBlackboard = () => {
    try { return fs.readFileSync(path.join(WS, 'task-state.md'), 'utf8').trim().slice(0, 1500); } catch { return ''; }
  };
  const blackboardNote = () => {
    const s = readBlackboard();
    if (!s) return '';
    return '[任务黑板] 工作区 task-state.md 当前内容（权威状态源，执行中随时用 write/edit 更新：完成后勾改、新发现追加、计划变化修订）：\n' + s;
  };
  // 里程碑记忆（todo 完成时自动 memory.save）
  let prevDoneIds = new Set(readTodo().filter(t => t.done).map(t => t.id));
  const milestoneWatch = (name, args) => {
    if (name !== 'todo' || !args || String(args.action) !== 'toggle') return;
    try {
      const arr = readTodo();
      const nowDone = arr.filter(t => t.done);
      const fresh = nowDone.filter(t => !prevDoneIds.has(t.id));
      prevDoneIds = new Set(nowDone.map(t => t.id));
      for (const t of fresh) {
        plugins.runPlugin('memory', { action: 'save', level: 'short', content: `里程碑完成：#${t.id} ${t.text}（剩余 ${arr.filter(x => !x.done).length} 项未完成）`, tags: ['进度'] }, { cwd: WS, dataDir: DATA_DIR }).catch(() => {});
      }
    } catch { /* 记忆失败不阻断 */ }
  };

  // 中断检查点：每次工具调用边界（abort 后未开始的调用全部拦截，已完成的轮次配对完整）
  const abortCheck = () => { if (ctx.abort && ctx.abort()) throw new HwjAbortError(); };
  // plan 模式写类拦截（对齐 server 子级只读拦截语义；bash 保留——探索常用，写操作由 lint/危险命令拦截兜底）
  const WRITE_PLUGINS = new Set(['write', 'edit']);
  // 长文写入探针 + 搜索止损（对齐 server callPlugin）
  let wroteAny = false;
  const signalWrote = () => { wroteAny = true; };
  let lowSearchStreak = 0;
  const callPlugin = async (name, args) => {
    abortCheck();
    if (ctx.mode === 'plan' && WRITE_PLUGINS.has(name)) {
      const msg = `插件 ${name} 调用被拒绝：当前为 plan 只读模式（/mode build 解锁写操作）。如需产出文件，请在结论中说明方案。`;
      appendInnerLog({ ts: Date.now(), plugin: name, args, ok: false, result: msg.slice(0, 400), ms: 0 });
      handleEvent({ type: 'info', text: `[plan 只读模式] 已拦截 ${name} 调用（/mode build 解锁写操作）` });
      return msg;
    }
    const t0 = Date.now();
    const result = await plugins.runPlugin(name, args, { cwd: WS, dataDir: DATA_DIR, spawnSub });
    let final = result;
    if (name === 'search') {
      const m = /相关性 ([0-9.]+)/.exec(String(result));
      if (m) {
        if (Number(m[1]) < 0.3) lowSearchStreak += 1; else lowSearchStreak = 0;
        if (lowSearchStreak >= 3) {
          final = result + `\n\n[止损提醒] 已连续 ${lowSearchStreak} 次低质量搜索——必须换策略：A) fetch 打开本次最相关结果读正文；B) 换英文关键词；C) 直取权威信源；D) 多信源调研改用 subagent 派生。禁止再执行第 ${lowSearchStreak + 1} 次同模式 search。`;
          lowSearchStreak = 0;
        }
      }
    }
    appendInnerLog({ ts: Date.now(), plugin: name, args, ok: !/^(插件 .+?(加载失败|执行出错|调用被拒绝))/.test(result), result: String(result).slice(0, 400), ms: Date.now() - t0 });
    return final;
  };
  const callPluginWrapped = async (name, args) => {
    if (name === 'write' || name === 'edit') wroteAny = true;
    else if (name === 'bash' && args && /(>>|>|<<|tee\s)/.test(String(args.command || ''))) wroteAny = true;
    const result = await callPlugin(name, args);
    milestoneWatch(name, args);
    return result;
  };

  // 子智能体派生（对齐 server spawnSub：profile 轮转 + 限流 failover + 子级只读硬拦截）
  const SUB_MAX_ROUNDS = 8;
  const SUB_RETRY_BASE_MS = 1500;
  const SUB_RR = { n: 0 };
  const SUB_SYSTEM_BASE = [
    '你是子智能体，负责独立完成一个调研/探索型子任务并返回结论。',
    '规则：1) 直接执行，不要建 todo 清单；2) 结论必须自包含（数字/路径/关键原文），主会话看不到你的中间过程；',
    '3) 只做只读探索（read/search/fetch/memory），除非子任务明确要求写文件；4) 结论 ≤300 字，先给结果再给一句依据；',
    '5) 你的默认工作目录是 Agent 工作区。调研目标文件不存在时，先用 bash pwd/ls 定位实际路径，用绝对路径访问，禁止一击不中就宣称"文件不存在"。'
  ].join('\n');
  const SUB_SYSTEM_WRITABLE = SUB_SYSTEM_BASE
    .replace('负责独立完成一个调研/探索型子任务并返回结论', '负责独立完成一个产出型子任务（含写文件）并返回执行结果')
    .replace('3) 只做只读探索（read/search/fetch/memory），除非子任务明确要求写文件', '3) 本任务授权写文件：用 write/edit 产出目标文件，写完必须 read 回验关键内容后才算完成')
    + '\n6) 只写子任务指定的目标路径，禁止改动其他文件；产出后结论里报告写入路径与行数。';
  const isTransientErr = e => !!(e && (e.retryable || (e.code && NET_CODES.test(e.code))));
  const runSubOnce = async (picked, description, writable, onWrote) => {
    abortCheck();
    const subMessages = [
      { role: 'system', content: writable ? SUB_SYSTEM_WRITABLE : SUB_SYSTEM_BASE },
      { role: 'user', content: String(description) }
    ];
    const subCallPlugin = async (name, args) => {
      abortCheck();
      if (!writable && (name === 'write' || name === 'edit')) {
        const msg = `插件 ${name} 调用被拒绝：本子任务为只读探索型（未声明 writable），禁止写文件。如需产出文件，在结论中说明方案由主会话执行。`;
        appendInnerLog({ ts: Date.now(), plugin: name, args, ok: false, result: msg.slice(0, 400), ms: 0, sub: true, profile: picked.name });
        return msg;
      }
      if ((name === 'write' || name === 'edit') && typeof onWrote === 'function') onWrote();
      const t0 = Date.now();
      const result = await plugins.runPlugin(name, args, { cwd: WS, dataDir: DATA_DIR }); // 无 spawnSub：子级禁止嵌套
      appendInnerLog({ ts: Date.now(), plugin: name, args, ok: !/^(插件 .+?(加载失败|执行出错|调用被拒绝))/.test(result), result: String(result).slice(0, 400), ms: Date.now() - t0, sub: true, profile: picked.name });
      return result;
    };
    return await chatInnerReal(picked.cfg, subMessages, plugins.toolDefs(), subCallPlugin,
      ev => handleEvent({ ...ev, sub: true, tag: ev.type === 'usage' ? picked.name : ev.tag }),
      { maxRounds: SUB_MAX_ROUNDS, tag: picked.name, retryBaseMs: SUB_RETRY_BASE_MS });
  };
  const spawnSub = async (description, writable) => {
    const picked = pickProfile(cfg, SUB_RR);
    try {
      return await runSubOnce(picked, description, writable, signalWrote);
    } catch (e) {
      if (e instanceof HwjAbortError) throw e;
      if (!isTransientErr(e)) throw e;
      const fallback = pickProfile(cfg, SUB_RR);
      if (fallback.name === picked.name) throw e;
      handleEvent({ type: 'info', text: `子任务@${picked.name} 限流重试耗尽，failover 换路 @${fallback.name} 重跑` });
      return await runSubOnce(fallback, description, writable);
    }
  };

  // 执行循环（withTaskResume 任务级重入：断网/持续限流退避后自动续跑）
  const TASK_TIMEOUT_MS = Number(process.env.DUAL_AGENT_TASK_TIMEOUT_MS) || 1800000;
  const taskStartTs = Date.now();
  try {
    const runInner = () => chatInner(cfg.inner, msgs, plugins.toolDefs(), callPluginWrapped, handleEvent, {
      todoNote, shouldContinue, intentNote, blackboardNote,
      onRound: () => persistSession(ctx.ws, msgs)
    });
    let lastAnswer = await withTaskResume(runInner, { onInfo: ev => handleEvent(ev), label: 'hwj 任务' });
    // 协议泄漏兜底：个别模型会把闲聊/身份回答包装成原始 JSON，面向用户的回复必须是人类可读的自然语言
    lastAnswer = humanizeAnswer(lastAnswer);
    // 超时收敛注入（对齐 server P15）
    if (Date.now() - taskStartTs > TASK_TIMEOUT_MS) {
      ui.printInfo(`[时间预警] 任务已运行 ${Math.round((Date.now() - taskStartTs) / 60000)} 分钟，超过上限，注入收敛指令`);
      msgs.push({ role: 'user', content: '[框架提示] 任务运行时间已超限，请立即总结已有成果并停止新探索。基于现有证据输出最终结论。' });
      persistSession(ctx.ws, msgs);
      lastAnswer = await withTaskResume(runInner, { onInfo: ev => handleEvent(ev), label: '时间耗尽' });
    }
    // 长文零写入强制重入（对齐 server v0.9.18 P11：允许 2 次）
    let longFormForceCount = 0;
    while (isLongFormTask(input) && !wroteAny && longFormForceCount < 2) {
      longFormForceCount += 1;
      ui.printInfo(`长文任务零写入收场（第 ${longFormForceCount} 次），注入行动令强制重入执行`);
      msgs.push({ role: 'user', content: '[框架提示] 你上一条回复仍停留在解释/方案/提问，没有执行任何写入动作，这不是完成任务。现在必须立即开始执行：第一步 todo.add 建章节清单，第二步 write 写入第一章首段，之后逐段 append 直到完成。本条指令生效后禁止再输出任何解释或问题，第一条消息就必须是 todo.add 工具调用。' });
      persistSession(ctx.ws, msgs);
      wroteAny = false;
      lastAnswer = await withTaskResume(runInner, { onInfo: ev => handleEvent(ev), label: `长文强制执行${longFormForceCount > 1 ? '-' + longFormForceCount : ''}` });
    }
    // 交付核验 + 自动返修（对齐 server 748-807：硬断言先行，judge 补语义，上限 2 轮）
    const MAX_REPAIR = 2;
    let repairCount = 0, finalGaps = [];
    const gapsSeen = []; // 全过程缺口（含已修复的中间轮）——教训卡的完整来源：曾踩过的坑对相似任务都有预警价值
    if (hasActiveIntent()) {
      const intent = getCurrentIntent();
      const collectGaps = async () => {
        const gaps = [], hardLines = [];
        for (const d of intent.deliverables) {
          if (!d.path) continue;
          const fp = path.join(WS, d.path);
          const exists = fs.existsSync(fp);
          if (!exists) { gaps.push(`交付文件未找到：${d.path}`); hardLines.push(`${d.path}：FAIL - 文件不存在`); }
          else {
            hardLines.push(`${d.path}：PASS - 文件存在`);
            if (d.path.endsWith('.json')) {
              try { JSON.parse(fs.readFileSync(fp, 'utf8')); hardLines.push(`${d.path}：PASS - JSON 格式有效`); }
              catch { gaps.push(`交付文件 JSON 格式错误：${d.path}`); hardLines.push(`${d.path}：FAIL - JSON 格式无效`); }
            }
          }
        }
        if (!gaps.length) {
          try {
            const verdictText = await plugins.runPlugin('intent', { action: 'verify', finalAnswer: lastAnswer }, { cwd: WS, dataDir: DATA_DIR, config: CONFIG_PATH });
            const match = verdictText.match(/发现 (\d+) 项缺口/);
            if (match && Number(match[1]) > 0) {
              const gapLines = verdictText.split('\n').filter(l => l.match(/^\d+\./));
              gaps.push(...gapLines.map(l => l.replace(/^\d+\.\s*/, '')));
            }
          } catch { /* judge 通道故障按通过处理 */ }
        }
        // 黑板联动核验（与 server.js 逐字对齐）：多步任务交付核验时断言黑板已更新，
        // 仍是初始骨架即视为缺口触发返修补记
        if (isMultiStepTask(input)) {
          try {
            const bb = fs.readFileSync(path.join(WS, 'task-state.md'), 'utf8');
            if (bb.includes('待更新') && !bb.includes('- [x]')) gaps.push('任务黑板 task-state.md 仍是初始骨架未记录执行状态，必须补记：已完成步骤、各产出文件路径与关键发现');
          } catch { gaps.push('任务黑板 task-state.md 丢失，必须重建并补记执行状态'); }
        }
        return gaps;
      };
      for (let r = 0; r <= MAX_REPAIR; r++) {
        const gaps = await collectGaps();
        for (const g of gaps) { const s = String(g).slice(0, 300); if (!gapsSeen.includes(s)) gapsSeen.push(s); }
        appendProcess(ctx.ws, `\n### ${fmtClock(Date.now())} ✅ 交付核验（第 ${r + 1} 次，hwj）\n\n${gaps.length ? gaps.map((g, i) => `${i + 1}. ${g}`).join('\n') : 'PASS：意图契约全部条款满足'}\n`);
        if (!gaps.length) { ui.printInfo('[交付核验] PASS：交付满足意图契约全部条款'); break; }
        if (r >= MAX_REPAIR) {
          finalGaps = gaps;
          ui.printInfo(`[交付核验] 返修上限（${MAX_REPAIR} 轮）已到，仍有 ${gaps.length} 项缺口，带缺口标注交付`);
          lastAnswer = `${lastAnswer}\n\n[交付核验缺口标注] 以下要求经 ${MAX_REPAIR + 1} 次核验仍未满足：\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
          break;
        }
        repairCount++;
        const repairMsg = `[交付核验] 对照意图契约发现以下未满足项：\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n请立即针对性修复上述缺口（已满足的项不要重做），完成后重新交付总结。`;
        msgs.push({ role: 'user', content: repairMsg });
        persistSession(ctx.ws, msgs);
        ui.printInfo(`[交付核验] 发现 ${gaps.length} 项缺口，自动返修（第 ${r + 1}/${MAX_REPAIR} 轮）`);
        lastAnswer = await withTaskResume(runInner, { onInfo: ev => handleEvent(ev), label: '返修任务' });
      }
    }
    // 自动归档（v0.9.31，对齐 Hermes 会话归档静默写入；与 server 逐字对齐）：
    // 任务结束即把 用户消息+最终交付 归档到 memory-archive.jsonl，供后续任务 archive_search 检索；异步不阻塞交付
    if (String(lastAnswer || '').trim()) {
      if (!String(lastAnswer).includes('[交付核验缺口标注]')) {
        plugins.runPlugin('memory', { action: 'archive_save', user: String(input || ''), finalText: String(lastAnswer || '').slice(0, 4000) }, { cwd: WS, dataDir: DATA_DIR }).catch(() => {});
      }
      // 成功任务自动进入 Evolution Benchmark Ledger；这里只记录任务与可观测产出，
      // 真正的评分必须在未来 replay 时重新执行，避免“自评即真值”。
      // Evolution Worker（A/B 重放）模式跳过：重放产生的是实验数据，写入的也是实验副本 data 目录。
      try {
        if (process.env.DUAL_AGENT_EVOLUTION_WORKER !== '1') {
          const evolution = require('../lib/evolution');
          const intent = getCurrentIntent();
          if (!String(lastAnswer).includes('[交付核验缺口标注]')) {
            // 返修后最终 PASS 的任务是最有价值的难例：repairs>0 会被标记 hard，进化时优先重放；
            // allGaps（全过程缺口含已修复）同步生成教训卡，相似任务运行时即时规避
            evolution.recordBenchmark({ task: input, finalText: lastAnswer, ws: ctx.ws, intent, artifacts: evolution.artifactManifest(WS), repairs: repairCount, lastGaps: [], allGaps: gapsSeen.slice(0, 8) });
          } else {
            // 上限仍未过的任务可能本身不可完成，不入 benchmark（避免不可达任务压扁 A/B），
            // 但缺口原文进经验池，供 Meta-Agent 提炼 skill mutation 时参考
            evolution.recordGap({ ts: new Date().toISOString(), task: String(input || '').slice(0, 2000), acceptance: Array.isArray(intent && intent.acceptance) ? intent.acceptance.slice(0, 8) : [], gaps: finalGaps.map(g => String(g).slice(0, 300)).slice(0, 8), repairs: repairCount });
          }
          // 真正的自进化：任务完成只是产生经验，不立即修改生产；异步启动 Evolution Engine，
          // Engine 自己负责 candidate sandbox、A/B、统计门槛、regression 与 promote。
          if (evolution.shouldAutoEvolve()) {
            process.env.DUAL_AGENT_EVOLUTION_RUNNING = '1';
            setImmediate(() => require('../lib/evolution').runEvolution({ promote: process.env.DUAL_AGENT_AUTO_PROMOTE !== '0' })
              .catch(() => {})
              .finally(() => { delete process.env.DUAL_AGENT_EVOLUTION_RUNNING; }));
          }
        }
      } catch { /* evolution 记录失败不影响任务交付 */ }
    }
    flushText();
    persistSession(ctx.ws, msgs);
    return { ok: true, finalText: lastAnswer || '' };
  } catch (e) {
    flushText();
    persistSession(ctx.ws, msgs); // 中断/异常时保已完成的轮次（onRound 已逐轮落盘，此处兜底）
    if (e instanceof HwjAbortError) return { ok: false, aborted: true, finalText: '' };
    appendProcess(ctx.ws, `\n### ${fmtClock(Date.now())} ❌ 错误（hwj）\n\n${String((e && e.message) || e)}\n`);
    throw e;
  }
}

module.exports = {
  runTask, HwjAbortError, buildHwjSystemPrompt,
  getConfig, saveInnerConfig, saveEmbeddingConfig, hwjState, saveHwjState,
  wsDir, listWorkspaces, loadSession, persistSession, clearSession, sessionPath,
  DATA_DIR, WS_ROOT, CONFIG_PATH
};
