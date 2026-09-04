// hwj TUI 渲染引擎 — readline + ANSI 转义序列，零依赖（仅 Node 内置）
// 布局模型（自下而上）：readline prompt 行（最底）→ 活动区（状态栏/流式回复/运行中工具，事件驱动重绘，
// 任务结束整体擦除）→ 沉降区（append-only 滚动区：用户消息、折叠工具行、最终回复）。
// 关键不变量：活动区始终是 prompt 上方连续 lastN 行；任何沉降输出前先擦除活动区与 readline 回显，
// 打印后活动区在沉降内容下方重新申请——滚动区永不被覆盖、无重复打印。
const readline = require('readline');

// ---------- 显示宽度（CJK 双宽感知） ----------
// 码点 > 0x2E80 的 CJK 区按 2 列宽（统一表意/全角标点/假名），其余 1 列
function charWidth(cp) {
  if (cp >= 0x1100 && (cp <= 0x115F || cp === 0x2329 || cp === 0x232A)) return 2; // 谚文兼容区
  if (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) return 2; // CJK 部首~彝文区
  if (cp >= 0xAC00 && cp <= 0xD7A3) return 2; // 谚文音节
  if (cp >= 0xF900 && cp <= 0xFAFF) return 2; // CJK 兼容表意
  if (cp >= 0xFE30 && cp <= 0xFE4F) return 2; // CJK 兼容形式
  if (cp >= 0xFF00 && cp <= 0xFF60) return 2; // 全角形式
  if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2; // 全角符号
  if (cp >= 0x20000 && cp <= 0x3FFFD) return 2; // CJK 扩展 B+
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of String(s == null ? '' : s)) w += charWidth(ch.codePointAt(0));
  return w;
}
// 按显示宽度硬折行（CJK 字符不拆半，宽度不够时整字符下移）
function wrapText(text, width) {
  const out = [];
  if (width < 2) return [String(text == null ? '' : text)];
  for (const rawLine of String(text == null ? '' : text).split('\n')) {
    if (!rawLine) { out.push(''); continue; }
    let cur = '', curW = 0;
    for (const ch of rawLine) {
      const cw = charWidth(ch.codePointAt(0));
      if (curW + cw > width) { out.push(cur); cur = ch; curW = cw; }
      else { cur += ch; curW += cw; }
    }
    if (cur || rawLine) out.push(cur);
  }
  return out.length ? out : [''];
}
// 按显示宽度截断加省略号（超长单行摘要用）
function ellipsis(s, max) {
  const str = String(s == null ? '' : s);
  if (max <= 1) return '…';
  if (strWidth(str) <= max) return str;
  let keep = '', w = 0;
  for (const ch of str) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    keep += ch; w += cw;
  }
  return keep + '…';
}
// token 数格式化：12345 → 12.3k
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}
// 耗时格式化：950ms / 13.0s / 2m05s
function fmtDur(ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  const m = Math.floor(v / 60000), s = Math.round((v % 60000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

// ---------- 工具行 / 状态栏渲染（纯函数） ----------
// 参数摘要：优先 path/command/query 等可读字段，单行压平
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const flat = {};
  for (const [k, v] of Object.entries(args)) flat[k] = typeof v === 'string' ? v.replace(/\s+/g, ' ').slice(0, 80) : v;
  const pick = flat.path || flat.command || flat.query || flat.url || flat.name || flat.action || '';
  const rest = Object.keys(flat).filter(k => k !== 'path' && k !== 'command' && k !== 'query' && k !== 'url' && k !== 'name' && k !== 'action');
  let s = String(pick);
  if (rest.length && strWidth(s) < 40) s += ` ${rest.slice(0, 2).map(k => `${k}=${ellipsis(String(flat[k]), 20)}`).join(' ')}`;
  return s.trim();
}
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
// tool: { plugin, args, t0, done, ok, ms, sub, spin }（spin 为当前转圈字符）
function renderToolLine(tool, width) {
  const dur = fmtDur(tool.done ? tool.ms : Date.now() - tool.t0);
  const icon = tool.done ? (tool.ok ? '✓' : '✗') : (tool.spin || SPINNER[0]);
  const head = ` ${icon} ${tool.sub ? '[子] ' : ''}${tool.plugin}`;
  const headW = strWidth(head);
  const durW = strWidth(dur) + 1;
  const body = ellipsis(summarizeArgs(tool.args), Math.max(2, width - headW - durW));
  return { head, body, dur };
}
// 状态栏：hwj-agent v1.1.2 · build · ws:default · 模型 · 任务 8.4s · 运行 3m12s · 12.3k tok · 排队 2 · 执行中
// taskT0 存在时任务时长实时走秒；lastTaskDur 为上一任务定格时长；sessT0 为本程序启动时刻
function renderStatusBar(st, width) {
  const now = Date.now();
  const parts = [`hwj-agent ${st.version || ''}`.trim(), st.mode || 'build', `ws:${st.ws || 'default'}`];
  if (st.model) parts.push(st.model);
  if (st.taskT0) parts.push(`任务 ${fmtDur(now - st.taskT0)}`);
  else if (st.lastTaskDur) parts.push(`任务 ${fmtDur(st.lastTaskDur)}`);
  if (st.sessT0) parts.push(`运行 ${fmtDur(now - st.sessT0)}`);
  if (st.tokens) parts.push(`${fmtTokens(st.tokens.prompt + st.tokens.completion)} tok`);
  if (st.calls) parts.push(`${st.calls} calls`);
  if (st.queueN) parts.push(`排队 ${st.queueN}`);
  if (st.busy) parts.push(st.busy);
  return ellipsis(parts.join(' · '), Math.max(4, width));
}

// ---------- ANSI 帮助 ----------
const A = {
  reset: '\x1b[0m', clearLine: '\x1b[2K\x1b[1G',
  up: n => (n > 0 ? `\x1b[${n}A` : ''),
  down: n => (n > 0 ? `\x1b[${n}B` : ''),
  cyan: s => `\x1b[36m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
  gray: s => `\x1b[90m${s}\x1b[0m`, dim: s => `\x1b[2m\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`
};
const PROMPT = '❯ ';
const PROMPT_W = 2;

// ---------- TUI 对象 ----------
// opts: { onLine, onSigint, version, ws, mode, plain, input, output }（plain=非交互模式：无 ANSI 无重绘，e2e 用）
function createTui(opts = {}) {
  const out = opts.output || process.stdout;
  const input = opts.input || process.stdin;
  const plain = !!opts.plain;
  const st = {
    version: opts.version || '', ws: opts.ws || 'default', mode: opts.mode || 'build',
    model: opts.model || '', sessT0: Date.now(), taskT0: 0, lastTaskDur: 0,
    tokens: null, calls: 0, busy: '', reply: '', tools: [], queueN: 0
  };
  let rl = null;
  let spinIdx = 0;
  let spinTimer = null;
  let redrawQueued = false;
  let lastReplyDraw = 0;
  let lastN = 0;     // 活动区已绘制行数（prompt 上方连续行）
  let echoRows = 0;  // readline 回显占用的行数（用户刚输入未沉降时）
  let onLine = opts.onLine || (() => {});
  let onSigint = opts.onSigint || (() => {});
  const termWidth = () => Math.max(20, (out.columns || 80) - 1);
  // 工具调用历史（/tools 展开用；只记完成态）
  const toolHist = [];
  let toolSeq = 0;
  const REGION_TOOLS_MAX = 4;   // 活动区工具行上限，更早的完成行沉降折叠
  const REGION_REPLY_MAX = 4;   // 流式回复预览行数（最终全文由 printAssistant 沉降一次）

  // ----- 消息流（沉降区，append-only） -----
  function printRaw(line) { out.write(line + '\n'); }

  // 沉降打印：擦除活动区+回显 → 输出 → 活动区重新申请（连续调用时中间态不重绘，setImmediate 合并）
  function settlePrint(fn) {
    if (!rl) { fn(); return; }
    eraseRows(lastN + echoRows);
    lastN = 0; echoRows = 0;
    fn();
    queueRedraw();
  }
  // 擦除 cursor 上方 k 行（连同当前行清空），光标回到擦除区顶行——后续打印复用回收的空间，不留空隙
  function eraseRows(k) {
    if (!rl || k <= 0) return;
    let buf = A.clearLine + A.up(k);
    for (let i = 0; i < k; i++) {
      buf += A.clearLine;
      if (i < k - 1) buf += A.down(1);
    }
    buf += A.up(k - 1);
    out.write(buf);
  }

  // 消息块：前缀只出现在首行（连续行裸文本，markdown 列表对齐不被缩进破坏）
  function printUser(text) {
    if (plain) { printRaw(`你  ${text}`); return; }
    const lines = wrapText(text, Math.max(10, termWidth() - 4));
    settlePrint(() => {
      printRaw(A.cyan('你 ') + lines[0]);
      for (const l of lines.slice(1)) printRaw(l);
    });
  }
  function printAssistant(text) {
    if (plain) { printRaw(String(text == null ? '' : text)); return; }
    const lines = wrapText(String(text == null ? '' : text), Math.max(10, termWidth() - 4));
    settlePrint(() => {
      printRaw('');
      printRaw(A.green('hwj ') + lines[0]);
      for (const l of lines.slice(1)) printRaw(l);
      printRaw('');
    });
  }
  function printInfo(text) {
    if (!String(text == null ? '' : text).trim()) return; // 空事件不打印（空白行根因：框架偶发发空 info）
    if (plain) { printRaw(`[info] ${text}`); return; }
    settlePrint(() => { for (const l of wrapText(text, termWidth() - 2)) printRaw(A.dim(' · ' + l)); });
  }
  function printError(text) {
    if (!String(text == null ? '' : text).trim()) return;
    if (plain) { printRaw(`[错误] ${text}`); return; }
    settlePrint(() => { for (const l of wrapText(text, termWidth() - 2)) printRaw(A.red('✗ ' + l)); });
  }
  function printPlain(text) {
    if (!String(text == null ? '' : text).trim()) return;
    settlePrint(() => printRaw(plain ? text : A.gray(text)));
  }

  // ----- 活动区行集合 -----
  function activeLines() {
    const w = termWidth();
    const lines = [plain ? renderStatusBar(st, w) : A.gray(renderStatusBar(st, w))];
    if (st.reply) {
      const wrapped = wrapText(st.reply, w - 2);
      const shown = wrapped.length > REGION_REPLY_MAX ? ['…', ...wrapped.slice(-REGION_REPLY_MAX)] : wrapped;
      for (const l of shown) lines.push(A.green(l));
    }
    for (const t of st.tools) {
      const { head, body, dur } = renderToolLine(t, w);
      const headStr = t.done ? (t.ok ? A.green(head) : A.red(head)) : A.gray(head);
      lines.push(`${headStr} ${A.gray(ellipsis(body, Math.max(0, w - strWidth(head) - strWidth(dur) - 1)))} ${A.gray(dur)}`);
    }
    // 活动区行数保护：超过终端高度-2（留 prompt+缓冲）截头部
    const maxLines = Math.max(4, (out.rows || 24) - 2);
    if (lines.length > maxLines) return ['…', ...lines.slice(-(maxLines - 1))];
    return lines;
  }

  // ----- 活动区重绘 -----
  // 光标模型：当前位于 readline prompt 行。增长时先吸收 prompt 下方空行（或滚动），
  // 再从 prompt 行上移 clearN=max(旧,新) 行逐行清写——旧多新少时清除残影，绝不覆盖沉降区。
  function redraw() {
    if (plain || !rl) return;
    const lines = activeLines();
    const n = lines.length;
    if (n > lastN) out.write('\n'.repeat(n - lastN));
    const clearN = Math.max(lastN, n);
    let buf = A.clearLine + A.up(clearN);
    for (let i = 0; i < clearN; i++) {
      buf += A.clearLine;
      if (i < n) buf += lines[i];
      if (i < clearN - 1) buf += A.down(1);
    }
    buf += '\n';
    lastN = n;
    out.write(buf);
    rl.prompt(true);
  }
  // 合并高频重绘（text 流式/usage 每轮多次，逐事件全量重绘浪费且闪烁）
  function queueRedraw() {
    if (plain) return;
    if (redrawQueued) return;
    redrawQueued = true;
    setImmediate(() => { redrawQueued = false; redraw(); });
  }
  // 回复流式节流：≥60ms 才真正重绘（快照可能逐 token 高频到达）
  function setReply(text) {
    st.reply = String(text || '');
    if (Date.now() - lastReplyDraw >= 60) { lastReplyDraw = Date.now(); queueRedraw(); }
  }

  // ----- 折叠工具行（沉降区） -----
  // 完成态一行折叠：` ✓ search 惠州天气 · 13.0s`；失败追加一行灰色错误摘要
  function printSettledTool(t) {
    const w = termWidth();
    const { head, body, dur } = renderToolLine(t, w);
    const pad = Math.max(0, w - strWidth(head) - strWidth(dur) - 1);
    if (plain) {
      printRaw(`${head} ${body} ${dur}${t.done ? '' : '（未完成）'}`);
    } else {
      const headStr = t.done ? (t.ok ? A.green(head) : A.red(head)) : A.gray(head);
      printRaw(`${headStr} ${A.gray(ellipsis(body, pad))} ${A.gray(dur)}`);
    }
    if (t.done && !t.ok && t.result != null) {
      const first = String(t.result).split('\n').find(l => l.trim()) || '';
      if (first) printRaw(plain ? `   ↳ ${ellipsis(first, Math.max(4, w - 6))}` : A.gray(`   ↳ ${ellipsis(first, Math.max(4, w - 6))}`));
    }
  }
  // 活动区工具行超限时，把最早已完成的一行沉降（长任务增量反馈，避免结束时堆积）
  function settleOverflow() {
    if (plain) return;
    let spilled = null;
    while (st.tools.length > REGION_TOOLS_MAX && st.tools[0].done) { if (!spilled) spilled = []; spilled.push(st.tools.shift()); }
    if (spilled) settlePrint(() => { for (const t of spilled) printSettledTool(t); });
  }

  // ----- 任务生命周期 -----
  function beginTask() {
    st.reply = ''; st.tools = []; st.busy = '执行中';
    st.taskT0 = Date.now(); st.lastTaskDur = 0;
    startSpin();
    queueRedraw();
  }
  function endTask() {
    stopSpin();
    if (st.taskT0) st.lastTaskDur = Date.now() - st.taskT0; // 定格本次任务总时长（状态栏持续显示）
    st.taskT0 = 0;
    const tools = st.tools.slice();
    st.reply = ''; st.tools = []; st.busy = '';
    // 活动区整体擦除后一次性沉降：工具折叠行（此前未沉降的）+ 回复由调用方 printAssistant 沉降
    settlePrint(() => { for (const t of tools) { if (!t._p) { t._p = true; printSettledTool(t); } } });
  }
  function toolCall(ev) {
    st.tools.push({ plugin: ev.plugin, args: ev.args, t0: Date.now(), done: false, ok: false, ms: 0, sub: !!ev.sub });
    settleOverflow();
    queueRedraw();
  }
  function toolResult(ev) {
    // 子级事件与主级按 plugin 就近匹配；无 id 语义，取最后一个同名未完成行
    for (let i = st.tools.length - 1; i >= 0; i--) {
      const t = st.tools[i];
      if (t.plugin === ev.plugin && !t.done) {
        t.done = true; t.ok = !!ev.ok; t.ms = ev.ms || (Date.now() - t.t0); t.result = ev.result;
        toolSeq += 1;
        toolHist.push({ seq: toolSeq, plugin: t.plugin, args: t.args, ok: t.ok, ms: t.ms, sub: t.sub, result: String(ev.result == null ? '' : ev.result) });
        if (toolHist.length > 40) toolHist.shift();
        break;
      }
    }
    if (plain) { for (const t of st.tools) if (t.done && !t._p) { t._p = true; printSettledTool(t); } }
    settleOverflow();
    queueRedraw();
  }
  function usage(ev) {
    if (ev && ev.totals) {
      st.tokens = { prompt: ev.totals.prompt, completion: ev.totals.completion };
      st.calls = ev.totals.calls;
    }
    queueRedraw();
  }
  function setMeta(patch) { Object.assign(st, patch); queueRedraw(); }

  // ----- 转圈指示 -----
  function startSpin() {
    if (spinTimer || plain) return;
    spinTimer = setInterval(() => {
      spinIdx = (spinIdx + 1) % SPINNER.length;
      for (const t of st.tools) if (!t.done) t.spin = SPINNER[spinIdx];
      if (st.busy) queueRedraw();
    }, 125);
    if (spinTimer.unref) spinTimer.unref();
  }
  function stopSpin() { if (spinTimer) { clearInterval(spinTimer); spinTimer = null; } }

  // ----- 走秒时钟：状态栏的任务时长/程序运行时长每秒刷新（与 spinner 独立，空闲也走——运行时长是全局的） -----
  let clockTimer = null;
  function startClock() {
    if (clockTimer || plain) return;
    clockTimer = setInterval(() => { if (rl) queueRedraw(); }, 1000);
    if (clockTimer.unref) clockTimer.unref();
  }

  // ----- readline -----
  function estimateEcho(line) {
    return Math.max(1, Math.ceil((PROMPT_W + strWidth(line)) / termWidth()));
  }
  function start() {
    if (plain) return;
    rl = readline.createInterface({ input, output: out, prompt: A.bold(PROMPT) });
    rl.on('line', line => { echoRows = estimateEcho(line); onLine(line); });
    let sigintCount = 0; let sigintTs = 0;
    rl.on('SIGINT', () => {
      const now = Date.now();
      if (now - sigintTs > 3000) sigintCount = 0;
      sigintTs = now; sigintCount += 1;
      onSigint(sigintCount);
    });
    out.on('resize', () => { lastN = 0; queueRedraw(); });
    startClock(); // 运行时长走秒（空闲也刷新状态栏）
    rl.prompt();
  }
  function setHandlers(h) { if (h.onLine) onLine = h.onLine; if (h.onSigint) onSigint = h.onSigint; }
  function refreshPrompt() { if (rl) rl.prompt(true); queueRedraw(); }
  function clearPromptLine() { if (!plain) out.write(A.clearLine); }
  function close() {
    stopSpin();
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (rl) { rl.close(); rl = null; }
  }
  function recentTools() { return toolHist.map(t => ({ ...t, args: safeClone(t.args) })); }
  function safeClone(a) { try { return JSON.parse(JSON.stringify(a == null ? null : a)); } catch { return { ...String(a) }; } }

  return { printUser, printAssistant, printInfo, printError, printPlain, beginTask, endTask, setReply, toolCall, toolResult, usage, setMeta, start, setHandlers, refreshPrompt, clearPromptLine, close, recentTools, state: st };
}

module.exports = { createTui, wrapText, ellipsis, strWidth, charWidth, renderToolLine, renderStatusBar, summarizeArgs, fmtTokens, fmtDur, SPINNER };
