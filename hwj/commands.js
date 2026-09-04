// hwj 斜杠命令系统 — 不退出 TUI 完成配置/模式/工作区/导出等常用操作
const fs = require('fs');
const path = require('path');
const core = require('./core');
const { summarizeArgs, fmtDur } = require('./tui');

const HELP = [
  '/help              显示本帮助',
  '/config            内层 API 配置向导（base_url / api_key / model，回车保留旧值）',
  '/mode build|plan   切换执行模式（plan=只读分析，拦截 write/edit）',
  '/model             查看当前模型与 profiles；/model <序号> 切换 profile',
  '/workspace [名称]  列出/切换工作区（会话与记忆随工作区隔离）',
  '/reset             清空当前会话并清除意图契约',
  '/history           会话条数摘要与最近消息预览',
  '/usage             token 用量统计（本会话累计 + 历史分组）',
  '/tools [序号]      最近插件调用折叠列表（带序号展开参数与结果详情）',
  '/memory [关键词]   跨层检索工作区记忆（三层/语义/任务归档）',
  '/todo              查看任务清单',
  '/evolve [--promote] 运行一次 Self-Improving Agent 实验闭环',
  '/export [文件名]   导出当前会话为 Markdown（默认 hwj-export-<时间>.md）',
  '/clear             清屏（保留会话）',
  '/exit              保存会话并退出'
];

// 交互式输入（TUI 模式用 readline 临时接管；plain 模式读 stdin 行）
function makePrompter(ui) {
  // TUI 模式下 readline 已被主循环持有，命令向导用简单的 question 接管：暂停主 rl → 逐项问 → 恢复
  return async function ask(question, defval) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    try {
      const shown = defval ? `${question} [${defval}]: ` : `${question}: `;
      return await new Promise(resolve => {
        rl.question(shown, ans => resolve(String(ans || '').trim() || (defval || '')));
      });
    } finally { rl.close(); }
  };
}

// 执行命令；返回 'exit' 表示退出请求，'handled' 表示已处理，'unknown' 未知命令
async function runCommand(line, ctx) {
  const ui = ctx.ui; // { printInfo, printError, printPlain, printUser, printAssistant }
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');
  const plugins = require('../lib/plugins');

  switch (cmd) {
    case '/help':
      HELP.forEach(l => ui.printPlain(l));
      return 'handled';

    case '/config': {
      const cfg = core.getConfig();
      const ask = makePrompter(ui);
      ui.printPlain('内层 API 配置向导（直接回车保留当前值，api_key 输入显示明文请注意周围环境）');
      const base_url = await ask('Base URL（OpenAI 兼容，如 https://api.agnes-ai.cn/v1）', cfg.inner.base_url);
      const api_key = await ask('API Key', cfg.inner.api_key ? cfg.inner.api_key : '');
      const model = await ask('模型名（如 agnes-2.5-flash）', cfg.inner.model);
      try {
        core.saveInnerConfig({ base_url, api_key, model });
        if (typeof ui.setMeta === 'function') ui.setMeta({ model }); // 状态栏即时显示新模型
        ui.printInfo('配置已保存（与网页版共享 .data/config.json）');
      } catch (e) { ui.printError('保存失败：' + (e && e.message || e)); }
      // embedding（语义记忆 remember/recall 用；推荐硅基流动免费 bge-m3；回车取推荐值，三项全空可跳过）
      const ec = cfg.embedding || {};
      ui.printPlain('Embedding API（语义记忆用，OpenAI 兼容 /embeddings；推荐硅基流动免费 BAAI/bge-m3）');
      ui.printPlain('  免费申请：https://cloud.siliconflow.cn/account/ak 注册/登录 → 新建 API 密钥 → 复制 sk- 开头密钥');
      const e_url = await ask('Embedding Base URL（回车=' + (ec.base_url || 'https://api.siliconflow.cn/v1') + '，输入 none 跳过）', ec.base_url || 'https://api.siliconflow.cn/v1');
      if (e_url && e_url.toLowerCase() !== 'none') {
        const e_key = await ask('Embedding API Key（必填，sk- 开头）', ec.api_key || '');
        const e_model = await ask('Embedding 模型名（回车=BAAI/bge-m3）', ec.model || 'BAAI/bge-m3');
        try {
          core.saveEmbeddingConfig({ base_url: e_url, api_key: e_key, model: e_model });
          ui.printInfo('Embedding 配置已保存，正在测试连接...');
          const out = await plugins.runPlugin('memory', { action: 'emb_test' }, { cwd: core.wsDir(ctx.ws), dataDir: core.DATA_DIR });
          ui.printPlain(String(out).split('\n').filter(l => l.trim()).join('\n'));
        } catch (e) { ui.printError('Embedding 保存失败：' + (e && e.message || e)); }
      } else {
        ui.printInfo(ec.model ? 'Embedding 保持已有配置' : '未配置 Embedding（remember/recall 降级为关键词检索）');
      }
      return 'handled';
    }

    case '/mode': {
      const m = String(arg || '').toLowerCase();
      if (m === 'build' || m === 'plan') {
        const st = core.hwjState(); st.mode = m; core.saveHwjState(st);
        ctx.onModeChange(m);
        ui.printInfo(`已切换为 ${m} 模式${m === 'plan' ? '（write/edit 已拦截，探索零风险）' : '（全插件可用）'}`);
      } else {
        ui.printPlain(`当前模式：${core.hwjState().mode}。用法：/mode build 或 /mode plan`);
      }
      return 'handled';
    }

    case '/model': {
      const cfg = core.getConfig();
      const { validProfiles } = require('../lib/profiles');
      const profiles = validProfiles(cfg);
      ui.printPlain(`当前模型：${cfg.inner.model || '（未配置）'} @ ${cfg.inner.base_url || '（未配置）'}`);
      if (profiles.length) {
        ui.printPlain('profiles 轮转清单（子智能体自动分摊，主配置恒为首位）：');
        profiles.forEach((p, i) => ui.printPlain(`  ${i + 1}. ${p.name}: ${p.cfg.model}`));
        ui.printPlain('主配置由 /config 修改；profiles 编辑请用网页版设置面板');
      } else {
        ui.printPlain('（未配置 profiles，子智能体统一走主配置）');
      }
      return 'handled';
    }

    case '/workspace': {
      if (!arg) {
        const list = core.listWorkspaces();
        const cur = core.hwjState().ws;
        ui.printPlain(`工作区（当前：${cur}）：${list.join('  ')}`);
        ui.printPlain('切换：/workspace <名称>（小写字母数字连字符，会话与记忆随工作区隔离）');
        return 'handled';
      }
      if (!/^[a-z0-9-]{1,40}$/.test(arg)) { ui.printError('工作区名非法：仅小写字母/数字/连字符，≤40 字符'); return 'handled'; }
      const st = core.hwjState(); st.ws = arg; core.saveHwjState(st);
      core.wsDir(arg);
      ctx.onWorkspaceChange(arg);
      const sess = core.loadSession(arg);
      ui.printInfo(`已切换到工作区 ${arg}（会话 ${sess.corrupted ? '损坏已重开' : sess.length + ' 条消息'}，记忆/技能/任务清单随区隔离）`);
      return 'handled';
    }

    case '/reset': {
      core.clearSession(ctx.ws);
      try { await plugins.runPlugin('intent', { action: 'clear' }, { cwd: core.wsDir(ctx.ws), dataDir: core.DATA_DIR, config: core.CONFIG_PATH }); } catch { /* ignore */ }
      ctx.onReset();
      ui.printInfo('会话已清空，意图契约已清除，系统提示已重建');
      return 'handled';
    }

    case '/history': {
      const sess = core.loadSession(ctx.ws);
      const userN = sess.filter(m => m.role === 'user').length;
      const asstN = sess.filter(m => m.role === 'assistant').length;
      ui.printPlain(`当前会话：${sess.length} 条消息（user ${userN} / assistant ${asstN}）`);
      for (const m of sess.slice(-6)) {
        const tag = m.role === 'user' ? '你  ' : m.role === 'assistant' ? 'hwj ' : ` ${m.role} `;
        const text = String(m.content || '').replace(/\s+/g, ' ').slice(0, 80);
        ui.printPlain(`  ${tag}${text}`);
      }
      return 'handled';
    }

    case '/usage': {
      try {
        const out = await plugins.runPlugin('usage', { action: 'history' }, { cwd: core.wsDir(ctx.ws), dataDir: core.DATA_DIR });
        ui.printPlain(String(out));
      } catch (e) { ui.printError('用量查询失败：' + (e && e.message || e)); }
      return 'handled';
    }

    case '/tools': {
      const list = typeof ui.recentTools === 'function' ? ui.recentTools() : [];
      if (!list.length) { ui.printInfo('当前会话暂无插件调用记录'); return 'handled'; }
      const n = parseInt(arg, 10);
      if (arg && Number.isFinite(n)) {
        const it = list.find(x => x.seq === n);
        if (!it) { ui.printError(`没有序号为 ${n} 的记录（/tools 查看列表）`); return 'handled'; }
        ui.printPlain(`#${it.seq} ${it.ok ? '✓' : '✗'} ${it.plugin}${it.sub ? ' [子]' : ''} · ${fmtDur(it.ms)}`);
        let argsStr = '';
        try { argsStr = JSON.stringify(it.args); } catch { argsStr = String(it.args); }
        ui.printPlain(`参数：${argsStr}`);
        ui.printPlain('结果：');
        const rows = String(it.result == null ? '' : it.result).split('\n').filter(l => l.trim());
        for (const l of rows.slice(0, 20)) ui.printPlain(`  ${l.length > 160 ? l.slice(0, 160) + '…' : l}`);
        if (rows.length > 20) ui.printPlain(`  …（共 ${rows.length} 行，完整内容见 process.md）`);
        return 'handled';
      }
      const tail = list.slice(-8);
      ui.printPlain(`最近插件调用（展示 ${tail.length}/${list.length} 条，/tools <序号> 展开详情）：`);
      for (const it of tail) {
        ui.printPlain(`  #${it.seq} ${it.ok ? '✓' : '✗'} ${it.plugin}${it.sub ? ' [子]' : ''} ${summarizeArgs(it.args)} · ${fmtDur(it.ms)}`);
      }
      return 'handled';
    }

    case '/memory': {
      // 跨层检索：short/long（TF-IDF）+ 语义记忆（recall 混合）+ 任务归档（BM25），三路结果合并展示
      const mctx = { cwd: core.wsDir(ctx.ws), dataDir: core.DATA_DIR };
      const sections = [];
      const grab = (label, args2) => plugins.runPlugin('memory', args2, mctx)
        .then(out => { const s = String(out); if (!/为空|没有匹配|不存在/.test(s.slice(0, 30))) sections.push(`【${label}】\n${s}`); })
        .catch(() => {});
      if (!arg) {
        try {
          const out = await plugins.runPlugin('memory', { action: 'list' }, mctx);
          ui.printPlain(String(out));
          const vec = await plugins.runPlugin('memory', { action: 'recall', query: '最近经验', top_k: 3 }, mctx).catch(() => '');
          ui.printPlain(`【语义记忆】${String(vec).split('\n').slice(0, 4).join('\n')}`);
        } catch (e) { ui.printError('记忆读取失败：' + (e && e.message || e)); }
        return 'handled';
      }
      await Promise.all([
        grab('三层记忆', { action: 'search', query: arg }),
        grab('语义记忆', { action: 'recall', query: arg, top_k: 3 }),
        grab('任务归档', { action: 'archive_search', query: arg })
      ]);
      ui.printPlain(sections.length ? `跨层检索「${arg}」：\n\n${sections.join('\n\n')}` : `所有记忆层都没有匹配「${arg}」的内容`);
      return 'handled';
    }

    case '/evolve': {
      const evo = require('../lib/evolution');
      const promote = /(^|\s)--promote(\s|$)/.test(arg);
      try {
        ui.printInfo(`启动 Self-Improving Loop（${promote ? '通过后自动晋级' : '实验通过后等待晋级'}）...`);
        const r = await evo.runEvolution({ promote });
        ui.printPlain(JSON.stringify(r, null, 2));
      } catch (e) { ui.printError('Evolution 失败：' + String(e.message || e)); }
      return 'handled';
    }

    case '/todo': {
      try {
        const out = await plugins.runPlugin('todo', { action: 'list' }, { cwd: core.wsDir(ctx.ws), dataDir: core.DATA_DIR });
        ui.printPlain(String(out));
      } catch (e) { ui.printError('清单读取失败：' + (e && e.message || e)); }
      return 'handled';
    }

    case '/export': {
      const sess = core.loadSession(ctx.ws);
      const name = arg || `hwj-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`;
      const safe = path.basename(name).replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_');
      const lines = [`# hwj 会话导出（工作区：${ctx.ws}）`, `> 导出时间：${new Date().toLocaleString()}`, `> 消息数：${sess.length}`, ''];
      for (const m of sess) {
        if (m.role === 'system') continue;
        if (m.role === 'user') lines.push(`## 你`, '', String(m.content || ''), '');
        else if (m.role === 'assistant') lines.push(`## hwj`, '', String(m.content || ''), '');
        else if (m.role === 'tool') lines.push('```', String(m.content || '').slice(0, 500), '```', '');
      }
      try {
        const fp = path.join(core.wsDir(ctx.ws), safe);
        fs.writeFileSync(fp, lines.join('\n'));
        ui.printInfo(`已导出：${fp}`);
      } catch (e) { ui.printError('导出失败：' + (e && e.message || e)); }
      return 'handled';
    }

    case '/clear':
      process.stdout.write('\x1b[2J\x1b[H');
      return 'handled';

    case '/exit':
      return 'exit';

    default:
      ui.printError(`未知命令：${cmd}，输入 /help 查看全部命令`);
      return 'unknown';
  }
}

function isCommand(line) { return /^\s*\//.test(String(line || '')); }

module.exports = { runCommand, isCommand, HELP };
