// wsl agent（WorkSpace-Lifeform）— 零依赖 HTTP 服务
// 启动：node server.js [--port 3788]；DUAL_AGENT_MOCK=1 为演示模式（内层假 LLM + 外层假 opencode）
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { EventEmitter } = require('events');

const APP_VERSION = require('./package.json').version;
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.PORT || 3788));
const ROOT = __dirname;
const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(ROOT, '.data');
const WS_ROOT = process.env.DUAL_AGENT_WS_ROOT || path.join(ROOT, 'workspaces'); // 多工作区根目录（每个工作区一个任务域；可用环境变量覆盖供测试隔离）
const WS_NAME_RE = /^[a-z0-9-]{1,40}$/;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LEGACY_MSG_PATH = path.join(DATA_DIR, 'inner-messages.json'); // 旧版全局会话，一次性迁移用

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WS_ROOT, { recursive: true });

const plugins = require('./lib/plugins');
const approval = require('./lib/approval');
const outerMod = require('./lib/outer');
const { chatInner, isMultiStepTask, isLongFormTask, isRefusalNudge, pairSafeTail } = require('./lib/inner');
const { validProfiles, pickProfile } = require('./lib/profiles');
const { NET_CODES, withTaskResume } = require('./lib/llmRetry');
// 意图系统已解耦为插件，通过 plugins.runPlugin('intent', ...) 调用

// ---------- 经验检索层（zvec 融合）----------
// lessons/playbooks 注入从"有什么塞什么"升级为按当前任务语义 top-k 召回。
// lib/experience.js 内部自动降级：zvec 不可用/移动端 → 内置 bigram 扫描（行为与旧版一致）。
// 注入失败仅告警，lessonsPromptSection/playbooksPromptSection 自身还有一层降级兜底。
try {
  const experience = require('./lib/experience');
  const expStore = experience.createExperienceStore({ dataDir: DATA_DIR });
  require('./lib/evolution').setExperienceStore(expStore);
} catch (e) {
  console.warn('[experience] 初始化失败，使用内置检索:', (e && e.message) || e);
}

// ---------- 日志 tee ----------
const LOG_PATH = path.join(DATA_DIR, 'server.log');
try { fs.writeFileSync(LOG_PATH, `=== dual-agent-loop started ${new Date().toISOString()} ===\n`); } catch { /* ignore */ }
const origLog = console.log.bind(console);
console.log = (...a) => { origLog(...a); try { fs.appendFileSync(LOG_PATH, a.join(' ') + '\n'); } catch { /* ignore */ } };
process.on('uncaughtException', e => console.log('[uncaught]', e && e.stack || e));
process.on('unhandledRejection', e => console.log('[unhandled]', e && (e.stack || e) || e));

// ---------- 配置（内层 OpenAI 兼容 API；key 仅存本机） ----------
const DEFAULT_CONFIG = { inner: { base_url: '', api_key: '', model: '' }, embedding: { base_url: '', api_key: '', model: '' }, inner_profiles: [], workspace: 'default', outerSession: '', reviewMark: 0 };
// WSL-SteadyKey：读失败（写盘瞬间被杀致半写损坏）自动回滚 .bak —— 配置"隔一阵子偶尔丢"的根因修复
function readConfigFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function getConfig() {
  const main = readConfigFile(CONFIG_PATH);
  if (main) return { ...DEFAULT_CONFIG, ...main };
  const bak = readConfigFile(CONFIG_PATH + '.bak');
  if (bak) {
    console.log('[config] config.json 损坏，已从 .bak 自动恢复');
    try { fs.copyFileSync(CONFIG_PATH + '.bak', CONFIG_PATH); } catch { /* 恢复失败下次再试 */ }
    return { ...DEFAULT_CONFIG, ...bak };
  }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(patch) {
  const cfg = getConfig();
  const next = { ...cfg, inner: { ...cfg.inner, ...(patch.inner || {}) } };
  // WSL-KeepKey：空 api_key 不覆盖已存 key（"留空=保持不变"；GET 失败弹空表单再保存也不丢配置）
  if (patch.inner && !String(patch.inner.api_key || '').trim() && cfg.inner.api_key) {
    next.inner.api_key = cfg.inner.api_key;
  }
  // 前端回传打码值时保留原 key
  if (patch.inner && /ˣ{4}/.test(patch.inner.api_key || '')) next.inner.api_key = cfg.inner.api_key;
  // 多路 API profile：数组整体替换；key 恢复按 base_url+model 内容匹配（v1.3.9：按索引对齐在前端
  // filter 移位后会恢复到错误的 key——删一路再保存，剩余行全部串位）
  if (Array.isArray(patch.inner_profiles)) {
    const prev = validProfiles(cfg);
    next.inner_profiles = patch.inner_profiles.map(p => {
      if (!p || typeof p !== 'object') return p;
      const masked = /ˣ{4}/.test(String(p.api_key || ''));
      const empty = !String(p.api_key || '').trim();
      if (masked || empty) {
        const old = prev.find(q => q.base_url === p.base_url && q.model === p.model && q.api_key);
        if (old) return { ...p, api_key: old.api_key };
      }
      return p;
    });
  }
  for (const k of ['workspace', 'outerSession', 'reviewMark']) {
    if (k in patch) next[k] = patch[k];
  }
  // embedding 段（语义记忆 remember/recall 用）：与 inner 同模式——空 key 与打码回传均保留原值
  if (patch.embedding && typeof patch.embedding === 'object') {
    next.embedding = { ...(cfg.embedding || {}), ...patch.embedding };
    if (!String(patch.embedding.api_key || '').trim() && (cfg.embedding || {}).api_key) next.embedding.api_key = cfg.embedding.api_key;
    if (/ˣ{4}/.test(patch.embedding.api_key || '')) next.embedding.api_key = (cfg.embedding || {}).api_key || '';
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    // WSL-SteadyKey 原子写三步：旧配置备份 .bak → tmp 写入 + fsync → rename 原子替换
    // （旧实现直接 writeFileSync 主文件：进程在写入瞬间被系统杀掉 → 半写损坏 → 配置丢失）
    // v1.3.9 加固：只有主文件完好时才备份——半写损坏的 main 绝不能覆盖唯一的好 .bak
    if (readConfigFile(CONFIG_PATH) !== null) {
      try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak'); } catch { /* 备份失败不阻断保存 */ }
    }
    const tmp = CONFIG_PATH + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(next, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, CONFIG_PATH);
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* 非 POSIX 环境忽略 */ }
  } catch (e) {
    console.log('[config] 配置落盘失败（当前配置仅存活于内存，重启即失）:', e && e.message || e);
    throw new Error('配置保存失败：' + (e && e.message || e));
  }
  return next;
}
function maskedConfig() {
  const cfg = getConfig();
  const k = cfg.inner.api_key || '';
  const maskKey = key => (key ? String(key).slice(0, 3) + 'ˣˣˣˣ' : '');
  const profiles = validProfiles(cfg).map(p => ({ ...p, api_key: maskKey(p.api_key) }));
  const embedding = { ...(cfg.embedding || {}) };
  if (embedding.api_key) embedding.api_key = maskKey(embedding.api_key);
  return { ...cfg, inner: { ...cfg.inner, api_key: maskKey(k) }, embedding, inner_profiles: profiles };
}

// ---------- 多工作区（内层插件默认工作目录，记忆/技能随工作区隔离） ----------
function currentWorkspace() {
  const name = String(getConfig().workspace || 'default');
  return WS_NAME_RE.test(name) ? name : 'default';
}
function workspaceDir() {
  const dir = path.join(WS_ROOT, currentWorkspace());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function listWorkspaces() {
  let names = [];
  try { names = fs.readdirSync(WS_ROOT).filter(n => WS_NAME_RE.test(n) && fs.statSync(path.join(WS_ROOT, n)).isDirectory()); } catch { /* ignore */ }
  if (!names.includes('default')) names.unshift('default');
  return names.sort();
}

// ---------- 内层执行过程记录（workspaces/<ws>/process.md，按时间顺序记录完整过程） ----------
// 聊天窗口只显示单行动态摘要；完整入参/完整结果/全文回复都落盘到这里，
// 前端双击工具条在 /process 页实时查看（含执行中任务的增量刷新）。
function processPath() { return path.join(workspaceDir(), 'process.md'); }
function fmtClock(ts) { return new Date(ts).toTimeString().slice(0, 8); }
function readProcess() {
  try { return fs.readFileSync(processPath(), 'utf8'); } catch { return ''; }
}
function appendProcess(text) {
  try {
    const fp = processPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    // 体量保护：超过 2MB 保留尾部 1MB（头部旧记录滚动淘汰）
    try {
      const st = fs.statSync(fp);
      if (st.size > 2 * 1024 * 1024) {
        const keep = fs.readFileSync(fp, 'utf8').slice(-1024 * 1024);
        fs.writeFileSync(fp, keep.slice(keep.indexOf('\n---\n') >= 0 ? keep.indexOf('\n---\n') : 0));
      }
    } catch { /* 新文件 */ }
    fs.appendFileSync(fp, text, 'utf8');
  } catch { /* ignore */ }
}

// ---------- 内层运行日志（JSONL 追加式：每条一行 append，读时取尾 200 条；消除全量读改写） ----------
const INNER_LOG_JSONL = path.join(DATA_DIR, 'inner-log.jsonl');
function getInnerLog() {
  try {
    // 大文件优化：只读尾部 256KB（约 300+ 条），避免日志增长后每次全量读
    const st = fs.statSync(INNER_LOG_JSONL);
    const readFrom = Math.max(0, st.size - 256 * 1024);
    const fd = fs.openSync(INNER_LOG_JSONL, 'r');
    const buf = Buffer.alloc(st.size - readFrom);
    fs.readSync(fd, buf, 0, buf.length, readFrom);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    const list = [];
    for (const l of lines) { try { list.push(JSON.parse(l)); } catch { /* 跳过残行 */ } }
    // readFrom > 0 时首行可能是截断残行，已被 JSON.parse 跳过
    return list.slice(-200);
  } catch { return []; }
}
function appendInnerLog(entry) {
  try {
    fs.appendFileSync(INNER_LOG_JSONL, JSON.stringify(entry) + '\n', 'utf8');
    // 体量保护：超 2MB 截断到尾部 1MB（低频滚动，append 主路径零读开销）
    try {
      const st = fs.statSync(INNER_LOG_JSONL);
      if (st.size > 2 * 1024 * 1024) {
        const fd = fs.openSync(INNER_LOG_JSONL, 'r');
        const buf = Buffer.alloc(st.size - 1024 * 1024);
        fs.readSync(fd, buf, 0, buf.length, 1024 * 1024);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').filter(Boolean).slice(1); // 丢弃首截断行
        fs.writeFileSync(INNER_LOG_JSONL, lines.map(l => l + '\n').join(''));
      }
    } catch { /* 截断失败不影响主流程 */ }
  } catch (e) { console.log('[log] 内层日志追加失败:', e && e.message || e); } // 关键写失败可见
}

// ---------- 内层消息历史（v1.3.2 多会话：workspaces/<ws>/sessions/<id>.json + sessions-index.json） ----------
let innerMessages = [];
function wsMsgPath(ws) { return path.join(WS_ROOT, ws || currentWorkspace(), 'inner-messages.json'); }
function sessionsDir(ws) { return path.join(WS_ROOT, ws || currentWorkspace(), 'sessions'); }
function sessionsIndexPath(ws) { return path.join(WS_ROOT, ws || currentWorkspace(), 'sessions-index.json'); }
function sessionFilePath(id) { return path.join(sessionsDir(), `${id}.json`); }

// 会话索引读写（损坏自愈：索引坏 → 重建为单会话）
function loadSessionsIndex() {
  try {
    const idx = JSON.parse(fs.readFileSync(sessionsIndexPath(), 'utf8'));
    if (idx && Array.isArray(idx.list) && idx.list.length && idx.list.some(s => s.id === idx.current)) return idx;
  } catch { /* 无索引或损坏 */ }
  return null;
}
function saveSessionsIndex(idx) {
  fs.mkdirSync(path.dirname(sessionsIndexPath()), { recursive: true });
  fs.writeFileSync(sessionsIndexPath(), JSON.stringify(idx, null, 1), 'utf8');
}
function sessionMeta() {
  const idx = loadSessionsIndex();
  return idx || { current: 's1', seq: 1, list: [{ id: 's1', name: '会话 1', ts: Date.now() }] };
}
// 会话显示名：首条用户消息前 16 字（无则保留默认名）
function sessionDisplayName(msgs, fallback) {
  const first = msgs.find(m => m.role === 'user' && m.content && m.content.trim());
  if (!first) return fallback;
  return first.content.trim().replace(/\s+/g, ' ').slice(0, 16) || fallback;
}

function loadInnerMessages() {
  const idx = sessionMeta();
  // 一次性迁移（v1.3.1 及之前）：单文件会话归入 s1
  if (!loadSessionsIndex()) {
    try {
      const legacy = JSON.parse(fs.readFileSync(wsMsgPath(), 'utf8'));
      if (Array.isArray(legacy) && legacy.length) {
        fs.mkdirSync(sessionsDir(), { recursive: true });
        fs.writeFileSync(sessionFilePath('s1'), JSON.stringify(legacy, null, 1), 'utf8');
        idx.list[0].name = sessionDisplayName(legacy, '会话 1');
      }
      try { fs.renameSync(wsMsgPath(), wsMsgPath() + '.migrated'); } catch { /* 无旧文件 */ }
    } catch { /* 无旧数据 */ }
    // 更早版本（0.4.0 全局会话）迁入
    try {
      const legacy2 = JSON.parse(fs.readFileSync(LEGACY_MSG_PATH, 'utf8'));
      if (Array.isArray(legacy2) && legacy2.length && !fs.existsSync(sessionFilePath('s1'))) {
        fs.mkdirSync(sessionsDir(), { recursive: true });
        fs.writeFileSync(sessionFilePath('s1'), JSON.stringify(legacy2, null, 1), 'utf8');
        idx.list[0].name = sessionDisplayName(legacy2, '会话 1');
      }
      fs.renameSync(LEGACY_MSG_PATH, LEGACY_MSG_PATH + '.migrated');
    } catch { /* 无旧数据 */ }
    saveSessionsIndex(idx);
  }
  try { innerMessages = JSON.parse(fs.readFileSync(sessionFilePath(idx.current), 'utf8')) || []; }
  catch { innerMessages = []; }
}
function persistInnerMessages() {
  try {
    // 配对安全裁剪（v0.9.12 P0-1）：slice(-60) 切点落在 tool_calls 与 tool 结果之间
    // 会落盘悬空配对，下次调 API 直接 400 且无法自愈
    const tail = pairSafeTail(innerMessages, 60);
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(sessionFilePath(sessionMeta().current), JSON.stringify(tail, null, 1));
    // 索引同步（消息数 + 首条消息命名）
    const idx = sessionMeta();
    const it = idx.list.find(s => s.id === idx.current);
    if (it) { it.n = tail.length; it.name = sessionDisplayName(tail, it.name); }
    saveSessionsIndex(idx);
  }
  catch (e) { console.log('[persist] 内层会话落盘失败:', e && e.message || e); } // 关键写失败必须可见
}
function clearInnerMessages() { innerMessages.length = 0; persistInnerMessages(); }
// P12改进：新任务开始时清除旧记忆，防止旧任务记忆污染（v0.9.22）
function clearWorkspaceMemory() {
  try {
    const shortPath = path.join(WS_DIR, '.memory-short.json');
    if (fs.existsSync(shortPath)) {
      fs.unlinkSync(shortPath);
      console.log(`[记忆清理] 已清除工作区短期记忆: ${shortPath}`);
    }
  } catch { /* 清除失败不影响任务 */ }
}
// P14：崩溃后续航标记注入（v0.9.22）
// 历史会话恢复后，在尾部注入续航天气标，让模型知道这是框架自动续航而非新用户新任务
function injectRecoveryMarkIfNeeded() {
  if (innerMessages.length === 0) return false;
  // 检查是否已有 recovery 标记
  const hasRecovery = innerMessages.some(m => m.content && m.content.includes('[框架提示] 本任务由框架自动续航'));
  if (hasRecovery) return false;
  // 检查最后一条是否是 assistant 回复（有历史痕迹）
  const last = innerMessages[innerMessages.length - 1];
  if (last && last.role === 'assistant' && last.content) {
    innerMessages.push({ role: 'user', content: '[框架提示] 本任务由框架自动续航恢复，上下文已压缩保留最近历史。请根据当前上下文和 [任务清单]/[轮数预算] 注记继续执行，不要重复已完成步骤。' });
    persistInnerMessages();
    return true;
  }
  return false;
}
loadInnerMessages();
injectRecoveryMarkIfNeeded();

// ---------- 审批历史摘要（外层上下文用：最近 n 条批准/拒绝决定） ----------
function recentAuditLines(n) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'audit.json'), 'utf8')); } catch { return []; }
  return list
    .filter(e => e.op === 'apply' || e.op === 'reject')
    .slice(-n)
    .map(e => `- [${String(e.ts).slice(0, 16)}] ${e.op === 'apply' ? '已批准' : '已拒绝'} ${e.action} ${e.plugin}${e.reason ? `（理由：${String(e.reason).slice(0, 120)}）` : ''}`);
}

// ---------- HTTP 基础 ----------
// 极简 Markdown → HTML（/view 页渲染用，零依赖）：支持标题/粗斜体/行内代码/代码块/
// 链接/图片/列表/引用/表格/分隔线；先整体转义防 XSS，再逐块结构化
function mdRender(src) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const inline = (s) => {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return s;
  };
  const lines = String(src || '').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { // 代码块
      let buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; i++; continue; }
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) { // 表格
      const head = line.split('|').slice(1, -1).map(c => c.trim());
      i += 2;
      let rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
        i++;
      }
      html += '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    if (/^\s*>\s?/.test(line)) { // 引用（连续行合并）
      let buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      html += `<blockquote>${buf.map(inline).join('<br>')}</blockquote>`;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) { // 列表（不嵌套，ul/ol 混排各成块）
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const itemRe = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      let buf = [];
      while (i < lines.length && itemRe.test(lines[i])) buf.push(lines[i++].replace(itemRe, '$1'));
      html += `<${ordered ? 'ol' : 'ul'}>` + buf.map(x => `<li>${inline(x)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`;
      continue;
    }
    let buf = [line]; // 普通段落（连续非空行合并）
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(```|#{1,6}\s|>|(\s*[-*+]\s)|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    html += `<p>${buf.map(inline).join('<br>')}</p>`;
  }
  return html;
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
}
function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* closed */ } };
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { clearInterval(hb); } }, 15000);
  let closed = false;
  const onClose = () => { if (closed) return; closed = true; clearInterval(hb); };
  req.on('close', onClose);
  res.on('close', onClose);
  return send;
}

// opencode 检测缓存（detectOpencode 返回 { cmd, shell } | null）
let ocCache = { ts: 0, runner: null };
async function opencodeRunner() {
  if (Date.now() - ocCache.ts < 10000) return ocCache.runner;
  ocCache = { ts: Date.now(), runner: await outerMod.detectOpencode() };
  return ocCache.runner;
}

// 内层系统提示：针对真实模型实测暴露的三类问题（并行调用丢参数、超长参数传输截断、oldText 凭记忆编写）
// 日期注入（v0.9.12 P1-5）：模型无实时感知，搜索"最新"数据时只能瞎猜年份——
// 上次调研任务搜 2024/2025 过时数据即此病根。每次构造提示时注入当天日期与星期
function buildInnerSystemPrompt(cwd) {
  const now = new Date();
  const dateStr = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日（星期${'日一二三四五六'[now.getDay()]}）`;
  // 技能清单（渐进披露第 1 层）：与 TUI 共用 skill.promptSection，每次任务实时扫描，晋级技能即时可见
  let skillSection = '';
  try { skillSection = require('./plugins/skill').promptSection({ cwd: cwd || WS_DIR }); } catch { /* 扫描失败按无技能处理 */ }
  // Prompt 基因库：与 core.js 对齐——可独立启停的系统提示片段（A/B 晋级基因经此生效）
  let geneSection = '';
  try { geneSection = require('./lib/evolution').genesPromptSection(); } catch { /* 基因注入失败不影响任务 */ }
  return INNER_SYSTEM_PROMPT_BASE
    .replace('{SKILLS}', skillSection)
    .replace('{TODAY}', dateStr)
    .replace('{FORGE_DIR}', plugins.FORGE_DIR) + geneSection;
}
const INNER_SYSTEM_PROMPT_BASE = [
  '你是内层执行 Agent，通过调用插件完成任务，完成后用简洁中文总结。当前日期：{TODAY}（涉及"最新/近期"的搜索与判断以此为准）。',
  '',
  '## 任务执行前必须：',
  '1. 先调用 memory.search(query="任务关键词") 检索相关记忆，将结果作为背景参考——注意：记忆是历史任务的沉淀，仅当内容与本任务直接相关才使用；与本任务话题无关的记忆必须忽略，禁止被旧任务记忆带偏当前任务的目标',
  '{SKILLS}',
  '3. 复杂任务必须先建任务清单：满足任一条件即算复杂——(a) 需要 ≥3 个执行步骤 (b) 涉及多个文件的创建/修改 (c) 用户消息含"然后/接着/再/最后"等多步标志。建法：每个步骤一次 todo.add(text="动宾短语")；此后每完成一步立即 todo.toggle(id=...) 勾选，开始下一步前如记不清进度就 todo.list() 查看；全部完成时清单应全为 [x]。禁止跳过建清单直接执行复杂任务',
  '4. 产出验证纪律：任务产出文件后，禁止只凭"我写了"就宣称完成。收尾前用 verify 插件断言关键产出（exists + contains 文本特征 + line_count 行数），多规则一次调用；看到 FAIL 必须修复后重新 verify，直到 PASS 才能总结',
  '5. 子智能体（subagent）：探索型子任务（多文件调研、方案对比、联网查证 ≥2 个独立问题）用 subagent 插件并行派生，主上下文只收结论——禁止自己 read 一堆大文件把上下文撑爆。产出写入类操作仍由主会话亲自执行',
  '6. 动态规划：每轮可见 [任务清单] 注记。执行中发现实际状况与计划不符（文件比预期大/依赖缺失/步骤顺序要变）必须先修订清单（todo.add 新步骤）再继续，禁止明知跑偏还硬走原计划',
  '7. 搜索纪律：搜索结果含"相关性"评分，低于 0.3 视为无效。连续 2 次无效后禁止再换关键词重搜——必须换策略：fetch 打开已有结果的正文（摘要常缺数据）、换英文关键词、或直取权威信源。多信源调研任务优先 subagent 并行派生，禁止主上下文堆搜索结果',
  '8. 收敛纪律：调研类任务的目标是"基于可获证据给出带不确定度标注的结论"，而非找到完美数据。接近轮数上限（可见 [轮数预算] 注记）时必须立即总结已有发现；搜不到精确数字时给出量级估计+推理依据+标注"无权威来源"，这是合格的交付',
  '9. 执行者身份纪律：你是执行 Agent，一切任务通过插件工具流完成。创作类任务（长文/小说/报告/代码）没有"超出能力"一说——单次输出不够就分章分段写入文件（write 首段 + append 续写，每段 ≤1500 字符），轮数不够框架会自动续航。禁止以篇幅、难度、体裁为由拒绝或转介用户去别处',
  '',
  '## 技能执行纪律（重要）：',
  '- 技能全文就是操作手册：其中要求的每个步骤（读模板、跑脚本、按格式输出）都必须照做',
  '- SKILL.md 正文引用的捆绑文件用 read 读取，path 填 "skill:技能名/正文相对路径"（如 skill:pdf/scripts/run.py），框架自动定位技能目录',
  '- 正文未引用的相对路径也可用同法读取；禁止跳过步骤后凭空自造替代品',
  '',
  '## 回复纯净纪律（重要）：',
  '- 面向用户的最终总结只包含任务结果本身：结论、交付物路径、关键数据',
  '- 禁止复述框架注入的检索过程与统计（如"归档匹配 N 条"、"记忆检索结果 N 条已忽略"、[框架预取] 段内容）——这些是给你的背景参考，用户在界面上看不到框架注记，复述出来就是噪音',
  '- 禁止输出工具调用日志、过程流水账、"我调用了 xx 插件"这类执行细节',
  '',
  '## 记忆与技能使用规则（重要）：',
  '1. 完成任务后，如果学到新信息（用户偏好、项目结构、技术选型），调用 memory.save(level="long", content="...", tags=["偏好","项目"]) 记录到长期记忆',
  '2. 复杂任务的执行流程可调用 memory.save(level="short", content="...") 记录到近期记忆（限任务摘要，不超过 100 字）',
  '3. 可复用的方法论/操作流程（如"如何分段写入长文"）调用 skill.save(name="xxx", content="markdown 全文") 沉淀为技能',
  '4. 记忆格式：content 一句话，具体明确；tags 不超过 3 个',
  '5. memory 和 skill 是不同概念：memory 记事实/偏好（短句），skill 记方法/流程（长文档）',
  '6. 技能名规范：英文小写+连字符（如 chang-wen-fen-duan-xie-ru）或中文均可',
  '7. 保存记忆前先用 memory.search 检索是否已存在相似内容，避免重复',
  '8. 被问到 token 用量/消耗/成本时：禁止凭感觉估算，必须调用 usage 插件（action=get 或 history）取真实数据作答，并区分"API 计费口径累计"与"净上下文"两个口径；对话中出现的 [token 计量] 注记也是真实数据，可直接引用',
  '9. JSON 配置文件必须使用双引号，不能使用单引号',
  '10. 任务完成后必须检查所有输出文件，确保格式正确',
  '11. 回复必须简洁，不超过 100 字，直接输出结果，不要解释过程',
  '12. 如果检索到相关记忆，必须在任务完成后保存重要发现到长期记忆',
  '13. 系统提示优先级：JSON 双引号 > 目录结构 > 技术栈 > 测试覆盖',
  '',
  '## 工具调用规则：',
  '1. 每次工具调用都必须完整提供所有必填参数；同一轮并行发起多个调用时，path 等参数每次都要单独带上，不能省略或依赖上一条',
  '2. edit 的 oldText 必须先用 read 读取文件后从返回内容逐字符复制（含空格缩进），不能凭记忆编写',
  '3. 需要联网信息时：先用 search(query=关键词) 搜索拿到结果列表，再用 fetch(url=...) 打开需要的链接读全文',
  '4. 长内容分段写入（必须遵守，API 通道对大参数不可靠）：首次 write 创建文件，每段 ≤1500 字符；后续续写一律用 write 的 append=true 逐段追加。绝不能用普通 write 续写——那会整体覆盖之前的段落。需要重新生成完整文件时才用普通 write（覆盖大文件需 confirm=true）。确认文件末尾用 read 的 tail 参数',
  '5. 收到「参数在 API 传输中丢失/截断」的提示时：第 1 次可原样重试；再次出现必须立即改为小分段（≤1500 字符/段 + append=true），禁止第三次发送大参数',
  '6. Python 模块导入：同目录文件可直接导入，跨目录需用 sys.path.insert 或相对导入',
  '',
  '## WSL-SelfForge 插件自我锻造（重要）：',
  '1. 你可以自己制造、安装、改进插件。当现有插件不足以完成任务（缺少能力/功能不够），或用户要求"造一个插件/安装插件/根据这个链接做插件"时，直接锻造，禁止以"没有这个功能"为由拒绝',
  '2. 插件文件规范：注释头必须是 // @name 小写字母数字连字符 与 // @desc 一句话中文说明；随后 module.exports = { params: <JSON Schema 对象，必填项列入 required>, run: async (args, ctx) => <返回字符串> }；只允许 Node 内置模块（fs/path/https 等），禁止任何第三方 require',
  '3. 写入位置：用 write 插件写绝对路径 {FORGE_DIR}/<插件名>.js —— 框架自动热加载，写完即可直接调用测试；修改已有插件同样写该路径覆盖',
  '4. 锻造流程（必须完整执行）：① fetch/search 获取所需 API 文档或参考资料 → ② 设计 params（参数说明写清楚，required 列必填）→ ③ write 写入完整插件代码（顶部加 3-5 行用法注释）→ ④ 立即用正常参数与边界参数各调用一次自测 → ⑤ 失败则 read 检查源码 + edit 修复后重测，直到成功 → ⑥ 总结时报告插件名、功能、用法示例',
  '5. 内置插件是还原点：锻造区同名文件可覆盖增强内置插件；禁止伪造 @essential true 标记规避用户审视',
  '6. 插件 run 中网络请求必须带超时（如 15 秒）与 try/catch，返回人类可读的中文结果或 throw Error（框架会标记失败供你自纠）',
  '',
  '## 任务完成报告：',
  '1. 输出检索到的记忆列表',
  '2. 说明每条记忆如何影响了你的决策',
  '3. 确认所有任务要求已完成',
  '4. 如果学到了新信息，调用 memory.save(level="long", ...) 保存到长期记忆'
].join('\n');

// ---------- 内层消息队列（v0.9.15 病根：409 直接丢用户消息） ----------
// 执行中的用户消息入队（内存 + 落盘 dataDir/inner-queue.json，重启不丢），
// 当前任务 finally 时消化队首：mock req/res 复用 handleInnerChat，结果正常落盘
// （process.md / inner-messages.json），前端经 /api/process 轮询或刷新可见
const INNER_QUEUE_MAX = 5;
let innerQueue = [];
function queuePath() { return path.join(DATA_DIR, 'inner-queue.json'); }
function restoreInnerQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(queuePath(), 'utf8'));
    if (Array.isArray(q)) innerQueue = q.filter(x => typeof x === 'string' && x.trim()).slice(0, INNER_QUEUE_MAX);
  } catch { /* 无文件 */ }
}
function persistInnerQueue() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(queuePath(), JSON.stringify(innerQueue, null, 1), 'utf8'); } catch { /* 落盘失败不阻断 */ }
}
// mock req/res：handleInnerChat 全链路复用（readBody 由 preBody 绕过；SSE send 全部静默丢弃）。
// res.end() 必须触发 close 处理器——sse() 的心跳 interval 靠 req/res close 事件清理，
// mock 对象不发事件会导致 interval 泄漏
function mockReqRes() {
  const handlers = {};
  const req = { on: () => {}, url: '/api/inner/chat', method: 'POST' };
  const res = {
    writeHead: () => {},
    write: () => {},
    end: () => { (handlers.close || []).forEach(f => { try { f(); } catch { /* ignore */ } }); },
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }
  };
  return { req, res };
}
let draining = false;
async function drainInnerQueue() {
  if (draining || !innerQueue.length) return;
  // API 未配置（真实模式）时暂不消化——消息留在盘上，配置就绪后的下一轮 drain 执行
  const _cfg = getConfig();
  if (process.env.DUAL_AGENT_MOCK !== '1' && !(_cfg.inner.base_url && _cfg.inner.api_key && _cfg.inner.model)) return;
  draining = true;
  try {
    while (innerQueue.length) {
      const message = innerQueue.shift();
      persistInnerQueue();
      const { req, res } = mockReqRes();
      // fromQueue=true：跳过锁检查直接执行（刚释放的锁归队首所有；HTTP 新请求此间
      // 进来会正常排队，不与本轮消化抢锁）
      try { await handleInnerChat(req, res, { message }, true); } catch { /* 单条失败继续消化 */ }
    }
  } finally { draining = false; }
}

// 执行互斥：同一时刻只允许一路内层 / 一路外层（防止并发 SSE 交叉写坏会话状态）
let innerLock = false;
let outerLock = false;

// ---------- 网页在线检测与自动退出 ----------
// 语义：任何 /api 请求都视为"网页还开着"（前端有 20s 轮询心跳）；
// 网页关闭时前端用 sendBeacon 发 /api/bye 提前触发；全部网页关闭且
// 无任务执行时，超过 IDLE_MS 无人访问即自动退出（DUAL_AGENT_AUTOSTOP=0 常驻）。
const AUTOSTOP = process.env.DUAL_AGENT_AUTOSTOP !== '0';
const IDLE_MS = Number(process.env.DUAL_AGENT_IDLE_MS) > 0 ? Number(process.env.DUAL_AGENT_IDLE_MS) : 60000;
const BYE_GRACE_MS = Number(process.env.DUAL_AGENT_BYE_GRACE_MS) > 0 ? Number(process.env.DUAL_AGENT_BYE_GRACE_MS) : 25000; // bye 后宽限：默认大于前端轮询间隔 20s，多标签页时另一页的轮询会续命
// 首次运行（未配置内层 API 且非演示模式）多给 4 分钟配置时间，避免向导没填完就被退出
restoreInnerQueue();
// 重启恢复的队列消息立即消化（不等下一次任务 finally——否则恢复的队首要躺到用户再发消息才执行）
setImmediate(() => { drainInnerQueue().catch(() => { /* 启动消化失败不阻断服务 */ }); });
const _cfg0 = getConfig();
let lastSeen = Date.now() + (!(_cfg0.inner.base_url && _cfg0.inner.api_key && _cfg0.inner.model) && process.env.DUAL_AGENT_MOCK !== '1' ? 4 * 60000 : 0);
setInterval(() => {
  if (!AUTOSTOP || innerLock || outerLock) return;
  if (Date.now() - lastSeen > IDLE_MS) {
    console.log(`网页已全部关闭且空闲超过 ${Math.round(IDLE_MS / 1000)} 秒，自动退出（DUAL_AGENT_AUTOSTOP=0 可常驻）`);
    process.exit(0);
  }
}, 5000);

// ---------- 内层任务处理（v0.9.15 从路由 inline 块抽出为函数） ----------
// preBody：队列消化时已解析的请求体（跳过 readBody，配 mock req）
// fromQueue：队列消化调用——跳过锁检查（刚释放的锁归队首所有）
// 闲聊识别与产品化直答（v1.3.9+ 体验修复：身份问题不再交给底层模型即兴发挥）
function matchSmallTalk(message) {
  const m = String(message || '').trim();
  if (!m || m.length > 30) return null; // 长文本必是任务
  const identityRe = /(你|智能体|机器人|agent|助手|助理)?(是|叫|叫做)?谁|你是谁|你叫什么|你的名字|介绍下?你自己|自我介绍|who are you|what are you|introduce yourself/i;
  const abilityRe = /你能(做|干)什么|你会(什么|做|干什么)|你有什么(功能|能力|用)|能帮我(做|干)什么|what can you do|你的功能/i;
  const greetRe = /^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|在么)[!！?？.。~～\s]*$/i;
  if (identityRe.test(m)) {
    return '我是 HWJ Agent——一个会动手执行任务的自进化智能体。给我一个任务，比如创建文件、整理资料、做计算或写文档，我会规划步骤、动手完成，并在交付前自动核验质量。每完成一个任务，我还会积累经验、持续进化。';
  }
  if (abilityRe.test(m)) {
    return '我可以直接在你的工作区里干活：创建和编辑文件、整理数据、真实计算、写文档和表格，交付前会自动核验是否达标。完成任务的同时我会积累经验，越用越顺手。想做什么，直接说就行。';
  }
  if (greetRe.test(m)) {
    return '你好！我是 HWJ Agent。有什么任务想让我帮忙，直接说就行——写个文档、算点数据、整理资料都可以。';
  }
  return null;
}

async function handleInnerChat(req, res, preBody, fromQueue) {
 const body = preBody !== undefined ? preBody : await readBody(req);
 const message = String(body.message || '').trim();
 if (!message) { json(res, 400, { success: false, error: '消息为空' }); return; }
 // 闲聊短路：身份/问候类问题由产品直接回答（秒回、绝对自然），不进任务循环——
 // 底层模型对这类问题有自己的身份模板，会泄漏供应商身份甚至输出 JSON
 const smallTalk = matchSmallTalk(message);
 if (smallTalk && !innerLock) {
   const send = sse(req, res);
   send({ type: 'text', text: smallTalk });
   send({ type: 'info', text: '[交付核验] PASS：闲聊直答，未产生交付物' });
   send({ type: 'done' });
   try { res.end(); } catch { /* closed */ }
   innerMessages.push({ role: 'user', content: message });
   innerMessages.push({ role: 'assistant', content: smallTalk });
   return;
 }
 if (innerLock && !fromQueue) {
     // v0.9.15 病根：执行中的用户消息被 409 直接丢弃——用户输入无声消失，界面上
     // 旧任务的回复还会渲染到新消息下方造成"答非所问"错觉。修复：消息入队（上限 5），
     // 当前任务完成后自动执行；SSE 返回 queued 事件让前端显示排队状态
     if (innerQueue.length >= INNER_QUEUE_MAX) { json(res, 409, { success: false, error: '排队消息已达上限（5 条），请稍候' }); return; }
     innerQueue.push(message);
     persistInnerQueue();
     const qsend = sse(req, res);
     qsend({ type: 'queued', text: `内层正在执行上一条任务，本消息已排队（第 ${innerQueue.length} 位），完成后自动执行`, position: innerQueue.length });
     qsend({ type: 'done' });
     try { res.end(); } catch { /* closed */ }
     return;
   }
 const cfg = getConfig();
 if (process.env.DUAL_AGENT_MOCK !== '1' && !(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model)) {
   json(res, 400, { success: false, error: '内层 API 未配置：点右上角「配置」填写 base_url / api_key / model' });
   return;
 }
 innerLock = true;
      // 测试钩子：DUAL_AGENT_TEST_HOLD=ms 让任务在此停住，供 e2e 验证排队时序（生产不设即零开销）
      if (process.env.DUAL_AGENT_TEST_HOLD) await new Promise(r => setTimeout(r, Number(process.env.DUAL_AGENT_TEST_HOLD)));
 const send = sse(req, res);
 send({ type: 'start' });
 const WS_DIR = workspaceDir();
  // 过程记录：任务头 + 待落盘的中间回复（text 快照式，工具调用前 flush 避免重复）
  appendProcess(`\n---\n\n## ${fmtClock(Date.now())} 📋 任务\n\n${message}\n`);
  // 框架级意图抽取（对齐 hwj/core.js）：任务前建立意图契约，交付核验/返修闭环由此驱动；
  // MOCK 模式跳过；抽取失败按无契约处理（静默降级，不阻断任务）
  if (process.env.DUAL_AGENT_MOCK !== '1') {
    try {
      await plugins.runPlugin('intent', { action: 'extract', task: message }, { cwd: WS_DIR, dataDir: DATA_DIR, config: CONFIG_PATH });
    } catch { /* 无契约时核验跳过 */ }
  }
 let pendingText = '';
 const flushText = () => {
   if (pendingText.trim()) appendProcess(`\n### ${fmtClock(Date.now())} 💬 内层\n\n${pendingText.trim()}\n`);
   pendingText = '';
 };
 // 确保系统提示在会话首位（历史会话无 system 时补插；reset 后重建）
 // 确保系统提示在会话首位（历史会话无 system 时补插；reset 后重建）；每次重建注入当天日期
 if (innerMessages[0] && innerMessages[0].role === 'system') innerMessages[0].content = buildInnerSystemPrompt(currentWorkspace());
 else innerMessages.unshift({ role: 'system', content: buildInnerSystemPrompt(currentWorkspace()) });
      // 多步任务检测 → 注入 todo 提醒到 user 消息尾部（实测 agnes-2.5-flash 无视 system 程序指令，
      // 但对紧邻任务文本遵循度高；注入落盘，历史中形成使用示范）
      let finalMsg = message;
      const multiStep = isMultiStepTask(message);
      if (multiStep) {
        // 黑板骨架框架预创建（与 core.js 逐字对齐）：等模型自觉创建门槛太高，框架先建好
        // 目标骨架，模型只需持续更新内容；blackboardNote 因此从第一轮起就有内容可注入
        try {
          const bb = path.join(WS_DIR, 'task-state.md');
          // 新多步任务开始即重写黑板（覆盖上一任务的残留状态，防串任务）
          fs.writeFileSync(bb, `# 任务黑板\n\n## 目标\n${String(message).slice(0, 500)}\n\n## 状态\n- [ ] 待更新（执行中每完成一步必须更新本文件）\n\n## 关键发现\n（执行中记录）\n`, 'utf8');
          send({ type: 'info', text: '已创建任务黑板 task-state.md' });
        } catch { /* 黑板预创建失败不影响任务 */ }
        finalMsg = message + '\n\n[框架提示] 本任务为多步任务，三项纪律：\n1) 开始执行前必须先用 todo 建任务清单（每个步骤一条 todo.add），每完成一步立即 todo.toggle(id=...)，全部完成时清单应全为 [x]。\n2) 收尾前必须用 verify 插件断言每个产出文件（exists + contains 内容特征 + line_count），看到 FAIL 先修复再重验，全 PASS 才能总结。\n3) 黑板纪律：框架已在 ' + WS_DIR + '/task-state.md 创建黑板文件（含任务目标），执行中每完成一个步骤必须立即更新它（勾改状态、记录产出文件路径与关键发现）。更新方式优先用 write 全量重写整个黑板（黑板文件已豁免覆盖保护，直接重发更新后的完整内容即可）；用 edit 必须先 read 确认最新内容再逐字符复制；框架每轮会把黑板内容注记给你——上下文被折叠后以黑板为准，先看黑板再行动。注意：黑板绝对路径是 ' + WS_DIR + '/task-state.md，禁止写到其他目录。';
        send({ type: 'info', text: '检测到多步任务，已注入任务清单+产出验证+黑板提醒' });
      }
      // 长文创作任务（v0.9.17 病根：模型以"万字超单次输出限制"为由直接拒绝——
      // 它没想到分章分段 write 工具流可以完成；自动续航 72 轮预算 + append 分段
      // 写入足以支撑万字级产出）。注入创作纪律，并明确禁止拒绝。
      // v0.9.18 追加：实测 agnes-2.5-flash 收到纪律后仍会"讲道理+反问"（零工具调用
      // 空谈一轮）——注入能力账本（把预算算给它看，堵死"轮数不够"的论证空间）+
      // 自主决策令（禁止以提问/确认开局）
      if (isLongFormTask(message)) {
        finalMsg = message + '\n\n[框架提示] 本任务为长文创作任务，你必须用工具流完成，禁止以"超出输出能力/篇幅过长/轮数限制"为由拒绝或讨价还价。能力账本（算给你看）：框架轮数预算 72 轮（24 轮/段 × 3 段自动续航），每轮稳定输出 1000-1500 字符，万字只需 10-15 轮写入——预算绰绰有余，任何"单次输出上限"都不构成障碍。执行纪律：\n' +
          '1) 先规划章节：todo.add 每章一条（如"第一章 起势：冲突建立"），章节数按目标字数÷每章 600-800 字估算；\n' +
          '2) 逐章写入文件：每章内部再分段——首次 write(path=文件名, content=本章第一段)，后续每段写之前必须先用 read(path=同一文件名, tail=N) 读取最后 N 字符（N=500，确认结尾段落）；append 续写时 content 必须以 \\n 开头（新起一段），章节标题（如 ## 第三章 xxx）必须独占一行，否则 markdown 渲染不出标题；\n' +
          '2b) append 续写前上下文确认：每次 write append=true 之前，必须先 read 已写文件的最后 500 字符（tail 参数），确认新段与已有内容在情节/人物/时间线上连续；如发现断层或人物名字/地点不一致，先修复再续写；\n' +
          '3) 每完成一章 todo.toggle 勾选，再写下一章；全部章节完成后 verify 断言（exists + line_count + contains 关键情节词 + regex: /^\#\# 第/ 检查每个章节标题独占一行）；' +
          '3b) 字数验证：交付前用 bash 命令 `wc -m <文件名>` 获取真实字符数，写入交付说明；禁止自行估算字数（模型估算通常严重偏离真实值）；' +
          '4) 最后输出交付说明：文件路径 + 章节目录 + 总字数（来自 wc -m，禁止估算）+ 已写章节数。中途上下文被折叠属正常现象（[轮数预算]/[任务清单] 注记会告诉你进度），照常续写；\n' +
          '4b) 中途一致性检查点：每完成 3 章，暂停写入，用 bash `wc -m <文件名>` 记录当前字数，再用 memory.save(level="short", content="剧情摘要：当前章节 + 活跃人物 + 关键伏笔 + 时间线") 保存状态；下次 append 前 memory.search 召回确认情节连续性，避免人物/地点漂移；' +
          '5) 自主决策：章节划分、情节走向、文件名等细节自行合理决定并立即执行，禁止以提问/确认/给方案开局——用户要的是写好的成品文件。仅当目标超过 3 万字时，可先交付完整的前 1/3 章节并在文件中注明续写点。';
        send({ type: 'info', text: '检测到长文创作任务，已注入分章分段创作纪律' });
      }
      // 拒绝后催促对齐（v0.9.17 病根：模型拒绝万字任务 → 用户"请你搞定" → 模型被
      // 工作区旧任务记忆锚定，回复完全跑偏到上一个话题）。检测：上一条 assistant
      // 回复含拒绝话术 + 新消息短促催促 → 注入对齐指令（搞定的是刚才被拒的那件事）
      if (innerMessages.length) {
        const lastAssistant = [...innerMessages].reverse().find(m => m.role === 'assistant' && m.content);
        if (lastAssistant && isRefusalNudge(lastAssistant.content, message)) {
          finalMsg = message + `\n\n[框架提示] 你上一条回复以"无法/抱歉/建议"拒绝了用户的任务，本消息是用户要求你执行它的催促——指的就是刚才被你拒绝的那个任务，不是历史中的任何其他任务。现在必须开始执行：按长文/多步任务的工具流纪律（todo 建清单 → 分段 write → verify 验证）完成它；工作区记忆与历史中的旧任务内容（如有）仅为背景参考，与当前任务无关时必须忽略，禁止被带偏任务目标。`;
          send({ type: 'info', text: '检测到拒绝后催促，已注入任务对齐指令' });
        }
  }
  // 意图注记：从插件读取最新契约注入发送副本
  const intentNote = () => {
    try {
      const intentPlugin = require('./plugins/intent');
      return intentPlugin.getIntentNote();
    } catch { return ''; }
  };
  // 检查是否有活跃意图（用于交付核验）
  const hasActiveIntent = () => {
    try {
      const intentPlugin = require('./plugins/intent');
      return !!intentPlugin.getState().intent;
    } catch { return false; }
  };
  // 获取当前意图对象（用于交付核验）
  const getCurrentIntent = () => {
    try {
      const intentPlugin = require('./plugins/intent');
      return intentPlugin.getState().intent;
    } catch { return null; }
  };
  // 记忆预取（v0.9.31，对齐 Hermes 启动即注入的 push 模式；与 hwj/core.js 逐字对齐）：
  // 任务开始前用用户消息跨层检索（语义 recall + 任务归档 archive_search），命中即注入
  // ——pull 模型下模型不主动 search 的遵循度问题由此根治。
  // P0-2 并行化：预取不再阻塞任务发起（原 await 最长 4s 全额计入首字延迟）——
  // 先短等 300ms（本地 BM25 常态内完成，命中则首轮即带上），未完成则后台继续，
  // 完成后经 prefetchNote 从第二轮 notes 注入；整体 2s 超时保护，失败/为空静默跳过
  let prefetchResult = undefined; // undefined=进行中 ''=完成无命中 string=命中内容
  try {
    Promise.race([
      (async () => {
        const q = String(message || '').slice(0, 120);
        const emptyHit = s => !s || /为空|没有匹配|没有标签/.test(String(s).slice(0, 60));
        const trim = s => String(s).split('\n').slice(0, 8).join('\n').slice(0, 900);
        const [vec, arc] = await Promise.all([
          plugins.runPlugin('memory', { action: 'recall', query: q, top_k: 3 }, { cwd: WS_DIR, dataDir: DATA_DIR }).catch(() => ''),
          plugins.runPlugin('memory', { action: 'archive_search', query: q }, { cwd: WS_DIR, dataDir: DATA_DIR }).catch(() => '')
        ]);
        const parts = [];
        if (!emptyHit(vec)) parts.push(`【语义记忆】\n${trim(vec)}`);
        if (!emptyHit(arc)) parts.push(`【历史任务】\n${trim(arc)}`);
        return parts.length ? `\n\n[框架预取·相关记忆] 以下是自动检索到的与本任务相关的既有记忆与历史任务（仅供参考，与本任务无关时必须忽略，禁止被旧任务带偏目标）：\n${parts.join('\n')}\n需要更多细节可继续用 memory recall / archive_search 检索。` : '';
      })(),
      new Promise(r => setTimeout(() => r(''), 2000))
    ]).then(r => {
      prefetchResult = r || '';
      if (prefetchResult) send({ type: 'info', text: '已预取相关记忆与历史任务注入上下文' });
    }).catch(() => { prefetchResult = ''; });
    // 短等 300ms：本地检索（无 embedding 配置）常态内完成，命中则首轮上下文即带上
    await Promise.race([
      new Promise(r => { const ck = () => prefetchResult !== undefined ? r() : setTimeout(ck, 40); ck(); }),
      new Promise(r => setTimeout(r, 300))
    ]);
    if (prefetchResult) {
      finalMsg += prefetchResult;
      prefetchResult = ''; // 已拼入首消息，避免 prefetchNote 重复注入
    }
  } catch { /* 预取失败不影响任务 */ }
  // prefetchNote：预取后台完成后的第二轮注入通道（inner.js 每轮 notes 构造时调用）
  const prefetchNote = () => {
    if (prefetchResult === undefined || !prefetchResult) return '';
    const r = prefetchResult;
    prefetchResult = '';
    return r;
  };
  // 教训卡注入（缺口经验运行时化）：与 core.js 同步对齐——历史任务核验 FAIL 的教训按
  // 任务相似度检索注入，零门槛即时生效，无需等待 A/B 实验晋级
  try {
    const lessonSec = require('./lib/evolution').lessonsPromptSection(message, 3);
    if (lessonSec) { finalMsg += lessonSec; send({ type: 'info', text: '已注入相关教训卡' }); }
  } catch { /* 教训检索失败不影响任务 */ }
  // 成功套路注入：与 core.js 同步对齐——相似成功任务的工具调用序列参考
  try {
    const pbSec = require('./lib/evolution').playbooksPromptSection(message, 2);
    if (pbSec) finalMsg += pbSec;
  } catch { /* 套路检索失败不影响任务 */ }
  innerMessages.push({ role: 'user', content: finalMsg });
 persistInnerMessages();
 // 事件处理器（主/子智能体共用）：过程落盘 + usage 落账 + SSE 透传（子事件带 sub 标记）
 const handleEvent = (ev) => {
   if (ev.type === 'text' && !ev.sub) pendingText = ev.text;
   else if (ev.type === 'tool_call') {
     flushText();
     let pretty = '';
     try { pretty = JSON.stringify(ev.args, null, 2); } catch { pretty = String(ev.args); }
     appendProcess(`\n### ${fmtClock(Date.now())} 🔧 ${ev.sub ? '[子] ' : ''}${ev.plugin}\n\n**入参**\n\n\`\`\`json\n${pretty}\n\`\`\`\n`);
   } else if (ev.type === 'tool_result') {
     appendProcess(`**结果** ${ev.ok ? '✓' : '✗'}（${ev.ms}ms）${ev.sub ? ' [子智能体]' : ''}\n\n\`\`\`\n${String(ev.result).slice(0, 2000)}\n\`\`\`\n`);
   } else if (ev.type === 'info') {
     flushText();
     appendProcess(`\n### ${fmtClock(Date.now())} ⏳ ${String(ev.text || '')}\n`);
   } else if (ev.type === 'usage') {
     // token 计量落盘：逐轮追加（当轮量 + 会话累计），usage 插件与审计由此取数；子智能体标记 sub
     try {
       const uf = path.join(WS_DIR, 'inner-usage.json');
       let rows = [];
       try { rows = JSON.parse(fs.readFileSync(uf, 'utf8')); } catch { /* 首次 */ }
       if (!Array.isArray(rows)) rows = [];
       rows.push({ ts: Date.now(), prompt: ev.last.prompt, completion: ev.last.completion, cached: ev.last.cached, est: !!ev.est, sub: !!ev.sub, profile: ev.tag || 'main',
         totalsPrompt: ev.totals.prompt, totalsCompletion: ev.totals.completion, totalsCalls: ev.totals.calls });
       fs.writeFileSync(uf, JSON.stringify(rows, null, 1), 'utf8');
     } catch { /* 计量落盘失败不阻断会话 */ }
       appendProcess(`\n> 📊 token${ev.sub ? `（子智能体${ev.tag ? '@' + ev.tag : ''}）` : ''}（第 ${ev.totals.calls} 次调用${ev.est ? '，估算' : '，API 真实返回'}）：prompt ${ev.last.prompt} + 输出 ${ev.last.completion}；会话累计 prompt ${ev.totals.prompt} + 输出 ${ev.totals.completion}\n`);
   } else if (ev.type === 'error') {
     flushText();
     appendProcess(`\n### ${fmtClock(Date.now())} ❌ 错误\n\n${String(ev.content)}\n`);
   }
   send(ev);
 };
 // 子智能体派生（对标 Claude Code Task）：独立 messages 跑完整工具循环（8 轮上限），
 // 探索过程隔离在子上下文，主上下文只收结论。子级 ctx 不带 spawnSub → 无法再派生（深度 1）。
 // 多路 API（v0.9.6）：子任务轮转选择 inner_profiles 里的配置，并行请求分摊到不同端点，
 // 避免同一 LLM API 的并发速率限制；未配置 profiles 时回退主配置（行为与旧版一致）。
 // 限流韧性（v0.9.7）：轮次级 withRetry 短退避（1.5s 序列，主会话的一半——子任务轻量，
 // 快速把结果交回主会话决策优于长等）；轮次重试耗尽后任务级 failover：换下一路 profile
 // 从头重跑一次（无多路配置时直接失败），限流不再死磕单端点
 const SUB_MAX_ROUNDS = 8;
 const SUB_RETRY_BASE_MS = 1500;
 const SUB_RR = { n: 0 }; // 轮转计数器：跨子任务递增，均匀分摊
 const SUB_SYSTEM_BASE = [
   '你是子智能体，负责独立完成一个调研/探索型子任务并返回结论。',
   '规则：1) 直接执行，不要建 todo 清单；2) 结论必须自包含（数字/路径/关键原文），主会话看不到你的中间过程；',
   '3) 只做只读探索（read/search/fetch/memory），除非子任务明确要求写文件；4) 结论 ≤300 字，先给结果再给一句依据；',
   '5) 你的默认工作目录是 Agent 工作区（通常只有日志文件）。调研目标文件不存在时，先用 bash pwd/ls 定位实际路径',
   '（项目源码常在仓库根，如 /workspace/dual-agent），用绝对路径访问，禁止一击不中就宣称"文件不存在"。'
 ].join('\n');
 // 可写版提示（v0.9.12 P1-6）：长任务的独立产出型子任务（改互不相同的文件）可委托子级并行写
 const SUB_SYSTEM_WRITABLE = SUB_SYSTEM_BASE
   .replace('负责独立完成一个调研/探索型子任务并返回结论', '负责独立完成一个产出型子任务（含写文件）并返回执行结果')
   .replace('3) 只做只读探索（read/search/fetch/memory），除非子任务明确要求写文件', '3) 本任务授权写文件：用 write/edit 产出目标文件，写完必须 read 回验关键内容后才算完成')
   + '\n6) 只写子任务指定的目标路径，禁止改动其他文件；产出后结论里报告写入路径与行数。';
 const isTransientErr = e => !!(e && (e.retryable || (e.code && NET_CODES.test(e.code))));
 // 病根教训（v0.9.7 压测抓出）：runSubOnce 独立函数，description 必须显式传参——
 // 闭包只共享模块级变量，外层 spawnSub 的参数不在其作用域内（当时 ReferenceError 致 4 路全灭）
 // writable（v0.9.12 P1-6）：执行层硬拦截——false 时子级 write/edit 调用直接拒绝（系统提示约束之外的保险丝）
  const runSubOnce = async (picked, description, writable, onWrote) => {
    const subMessages = [
      { role: 'system', content: writable ? SUB_SYSTEM_WRITABLE : SUB_SYSTEM_BASE },
      { role: 'user', content: String(description) }
    ];
    const subCallPlugin = async (name, args) => {
      if (!writable && (name === 'write' || name === 'edit')) {
        const msg = `插件 ${name} 调用被拒绝：本子任务为只读探索型（未声明 writable），禁止写文件。如需产出文件，在结论中说明方案由主会话执行。`;
        appendInnerLog({ ts: Date.now(), plugin: name, args, ok: false, result: msg.slice(0, 400), ms: 0, sub: true, profile: picked.name });
        return msg;
      }
      if ((name === 'write' || name === 'edit') && typeof onWrote === 'function') onWrote();
      const t0 = Date.now();
     const result = await plugins.runPlugin(name, args, { cwd: WS_DIR, dataDir: DATA_DIR }); // 无 spawnSub：子级禁止嵌套
     appendInnerLog({ ts: Date.now(), plugin: name, args, ok: !/^(插件 .+?(加载失败|执行出错|调用被拒绝))/.test(result), result: String(result).slice(0, 400), ms: Date.now() - t0, sub: true, profile: picked.name });
     return result;
   };
   const { chatInnerReal } = require('./lib/inner');
   return await chatInnerReal(picked.cfg, subMessages, plugins.toolDefs(), subCallPlugin,
     ev => handleEvent({ ...ev, sub: true, tag: ev.type === 'usage' ? picked.name : ev.tag }),
     { maxRounds: SUB_MAX_ROUNDS, tag: picked.name, retryBaseMs: SUB_RETRY_BASE_MS });
 };
  const spawnSub = async (description, writable) => {
    const picked = pickProfile(cfg, SUB_RR);
    try {
      return await runSubOnce(picked, description, writable, signalWrote);
    } catch (e) {
     if (!isTransientErr(e)) throw e; // 非限流/网络类错误（如 401 配置错）不换路重跑
     const fallback = pickProfile(cfg, SUB_RR); // 换下一路（轮转计数器已前进）
     if (fallback.name === picked.name) throw e; // 无其他路可换
     handleEvent({ type: 'info', text: `子任务@${picked.name} 限流重试耗尽，failover 换路 @${fallback.name} 重跑` });
     return await runSubOnce(fallback, description, writable);
   }
 };
 // 搜索循环止损（v0.9.9 病根：真实调研会话 20 次同质搜索零有效结果，烧 183k prompt）：
 // search 返回文本头部带「相关性 X.XX」，连续 <0.3 计数递增、达标清零；
 // ≥3 次时在结果尾部注入强制策略升级指令（fetch 信源/换英文/subagent），打断重复模式
 let lowSearchStreak = 0;
 const callPlugin = async (name, args) => {
   const t0 = Date.now();
   const result = await plugins.runPlugin(name, args, { cwd: WS_DIR, dataDir: DATA_DIR, spawnSub });
   let final = result;
   if (name === 'search') {
     const m = /相关性 ([0-9.]+)/.exec(String(result));
     if (m) {
       if (Number(m[1]) < 0.3) lowSearchStreak += 1; else lowSearchStreak = 0;
       if (lowSearchStreak >= 3) {
         final = result + `\n\n[止损提醒] 已连续 ${lowSearchStreak} 次低质量搜索——继续换关键词重搜大概率重复失败。` +
           `必须换策略：A) fetch 打开本次最相关结果的页面读正文；B) 换英文关键词；C) 直取权威信源（官方博客/行业报告）；` +
           `D) 多信源调研改用 subagent 派生。禁止再执行第 ${lowSearchStreak + 1} 次同模式 search。`;
         lowSearchStreak = 0; // 提醒一次后重置，避免每条都带
       }
     }
   }
   appendInnerLog({ ts: Date.now(), plugin: name, args, ok: !/^(插件 .+?(加载失败|执行出错|调用被拒绝))/.test(result), result: String(result).slice(0, 400), ms: Date.now() - t0 });
   return final;
 };
 // 动态清单注记：每轮 API 调用前取最新 todo 状态注入发送副本（落盘干净）——
 // 对标 Claude Code TodoList 的「执行中可见」，模型无需 todo.list 也能对齐进度、发现偏差即修订
 const readTodo = () => {
   try {
     const arr = JSON.parse(fs.readFileSync(path.join(WS_DIR, '.todo.json'), 'utf8'));
     return Array.isArray(arr) ? arr : [];
   } catch { return []; }
 };
 const todoNote = () => {
   const arr = readTodo();
   if (!arr.length) return '';
   const open = arr.filter(t => !t.done);
   const done = arr.filter(t => t.done);
   const lines = ['[任务清单] 当前进度（执行中发现计划不适用必须修订：todo.add 加步骤/调整后再继续）：'];
   for (const t of open) lines.push(`- [ ] #${t.id} ${t.text}`);
   const recentDone = done.slice(-3);
   for (const t of recentDone) lines.push(`- [x] #${t.id} ${t.text}`);
   if (done.length > recentDone.length) lines.push(`- （另有 ${done.length - recentDone.length} 项已完成略）`);
   return lines.join('\n');
 };
  // 自动续航判定（v0.9.12 P0-3）：清单存在且有未完成项 → 撞段上限时值得续航
  const shouldContinue = () => readTodo().some(t => !t.done);
  // 黑板模式（与 core.js 逐字对齐）：读取工作区 task-state.md 每轮注入发送副本——
  // 上下文折叠后的浓缩权威状态源，截断 1500 字符控制注记预算
  const readBlackboard = () => {
    try { return fs.readFileSync(path.join(WS_DIR, 'task-state.md'), 'utf8').trim().slice(0, 1500); } catch { return ''; }
  };
  const blackboardNote = () => {
    const s = readBlackboard();
    if (!s) return '';
    return '[任务黑板] 工作区 task-state.md 当前内容（权威状态源，执行中随时用 write/edit 更新：完成后勾改、新发现追加、计划变化修订）：\n' + s;
  };
 // 里程碑记忆（v0.9.12 P1-4）：todo.toggle 把一项从待办变为完成时自动 memory.save
 // 进度摘要——长任务后段上下文被预算折叠时，早期决策依据可从记忆召回。
 // 病根：memory.save 全靠模型自觉，实测长任务后段"忘了自己为什么这么做"
 let prevDoneIds = new Set(readTodo().filter(t => t.done).map(t => t.id));
 const milestoneWatch = (name, args) => {
   if (name !== 'todo' || !args || String(args.action) !== 'toggle') return;
   try {
     const arr = readTodo();
     const nowDone = arr.filter(t => t.done);
     const fresh = nowDone.filter(t => !prevDoneIds.has(t.id));
     prevDoneIds = new Set(nowDone.map(t => t.id));
     for (const t of fresh) {
       plugins.runPlugin('memory', {
         action: 'save', level: 'short',
         content: `里程碑完成：#${t.id} ${t.text}（剩余 ${arr.filter(x => !x.done).length} 项未完成）`,
         tags: ['进度']
       }, { cwd: WS_DIR, dataDir: DATA_DIR }).catch(() => {});
     }
   } catch { /* 记忆失败不阻断任务 */ }
 };
  // 长文执行强制的写入探针（v0.9.18）：callPluginWrapped 里置位，runInner 结束后检查
  let wroteAny = false;
  // P13：子智能体写操作也能置位 wroteAny（通过回调传递）
  const signalWrote = () => { wroteAny = true; };
  const callPluginWrapped = async (name, args) => {
    // 长文执行强制（v0.9.18）：记录本任务是否发生过真实写入（write/edit，或 bash 重定向/heredoc）
    if (name === 'write' || name === 'edit') wroteAny = true;
    else if (name === 'bash' && args && /(>>|>|<<|tee\s)/.test(String(args.command || ''))) wroteAny = true;
    const result = await callPlugin(name, args); // 先执行（toggle 落盘后再对比，否则读到旧状态）
    milestoneWatch(name, args);
    return result;
  };
  // 任务级 wall-clock 超时（v0.9.22 P15）：防无限轮次耗 API 预算
  const TASK_TIMEOUT_MS = Number(process.env.DUAL_AGENT_TASK_TIMEOUT_MS) || 1800000; // 默认 30 分钟
  const taskStartTs = Date.now();
  try {
    // 统一入口：任务级自动重入（v0.9.13）包裹 chatInner——withRetry 耗尽（断网/持续限流
    // 超约 2 分钟）后 30s/60s/120s 退避重入续跑。重入安全：异常抛出点 messages 尾部
    // 必为完整配对，模型看到尾部工具结果自然续跑，已完成步骤不重做
    const runInner = () => chatInner(cfg.inner, innerMessages, plugins.toolDefs(), callPluginWrapped, handleEvent, {
      todoNote,
      blackboardNote,
      shouldContinue,
      intentNote,
      prefetchNote,
      // 流式增量（P0-1）：inner.js 以 onEvent({type:'delta'}) 发出，handleEvent 统一 send 转发前端
      // 轮开始进度（P0-1）：前端执行指示
      onRoundStart: n => send({ type: 'round', round: n }),
      // 每轮落盘（v0.9.12 P0-2）：工具结果入列后立即持久化，崩溃/重启不丢进行中历史
      onRound: () => persistInnerMessages()
    });
    let lastAnswer = await withTaskResume(runInner, { onInfo: send, label: '内层任务' });
    // P15 检查：超时则注入时间耗尽注记
    if (Date.now() - taskStartTs > TASK_TIMEOUT_MS) {
      send({ type: 'info', text: `[时间预警] 任务已运行 ${Math.round((Date.now() - taskStartTs) / 60000)} 分钟，超过 ${TASK_TIMEOUT_MS / 60000} 分钟限制` });
      innerMessages.push({ role: 'user', content: '[框架提示] 任务运行时间已超限，请立即总结已有成果并停止新探索。基于现有证据输出最终结论。' });
      persistInnerMessages();
      lastAnswer = await withTaskResume(runInner, { onInfo: send, label: '时间耗尽' });
    }
   // 长文执行强制（v0.9.18 病根：实测 agnes-2.5-flash 收到创作纪律后仍"讲道理+反问"
   // 空谈一轮零工具调用——能力账本注入后概率降低但不归零，框架必须兜底）。检测：
   // 长文任务 + 全程零写入 → 注入行动令重入执行（P11 改进：允许最多 2 次，防一次失效全放弃）
   let longFormForceCount = 0;
   while (isLongFormTask(message) && !wroteAny && longFormForceCount < 2) {
     longFormForceCount += 1;
     send({ type: 'info', text: `长文任务零写入收场（第 ${longFormForceCount} 次），注入行动令强制重入执行` });
     innerMessages.push({ role: 'user', content: '[框架提示] 你上一条回复仍停留在解释/方案/提问，没有执行任何写入动作，这不是完成任务。现在必须立即开始执行：第一步 todo.add 建章节清单，第二步 write 写入第一章首段，之后逐段 append 直到完成。本条指令生效后禁止再输出任何解释或问题，第一条消息就必须是 todo.add 工具调用。' });
     persistInnerMessages();
     wroteAny = false; // 重置探针，检测重入后是否仍有写入
     lastAnswer = await withTaskResume(runInner, { onInfo: send, label: `长文强制执行${longFormForceCount > 1 ? '-' + longFormForceCount : ''}` });
   }
    // 交付核验 + 自动返修（v0.9.24 解耦为插件）：对照意图契约核验（硬断言先行，语义缺口 judge 补），
    // 发现缺口注入返修指令重入执行，上限 2 轮（防完美主义死循环）
    let repairCount = 0, finalGaps = [];
    const gapsSeen = []; // 全过程缺口（含已修复的中间轮）——教训卡的完整来源（与 core.js 对齐）
    if (hasActiveIntent()) {
      const intent = getCurrentIntent();
      const collectGaps = async () => {
        const gaps = [];
        const hardLines = [];
        // 硬断言：文件类交付物 exists / json_valid
        for (const d of intent.deliverables) {
          if (!d.path) continue;
          const fp = path.join(WS_DIR, d.path);
          const exists = fs.existsSync(fp);
          if (!exists) {
            gaps.push(`交付文件未找到：${d.path}`);
            hardLines.push(`${d.path}：FAIL - 文件不存在`);
          } else {
            hardLines.push(`${d.path}：PASS - 文件存在`);
            if (d.path.endsWith('.json')) {
              try {
                JSON.parse(fs.readFileSync(fp, 'utf8'));
                hardLines.push(`${d.path}：PASS - JSON 格式有效`);
              } catch {
                gaps.push(`交付文件 JSON 格式错误：${d.path}`);
                hardLines.push(`${d.path}：FAIL - JSON 格式无效`);
              }
             }
           }
         }
        // 黑板联动核验（黑板模式收口）：多步任务交付核验时断言黑板已更新——
        // 仍是初始骨架（待更新/无完成标记）即视为缺口，返修指令会要求补记。
        // 没有这层，简单任务模型会跳过黑板更新，折叠保护形同虚设。
        if (multiStep) {
          try {
            const bb = fs.readFileSync(path.join(WS_DIR, 'task-state.md'), 'utf8');
            if (bb.includes('待更新') && !bb.includes('- [x]')) gaps.push('任务黑板 task-state.md 仍是初始骨架未记录执行状态，必须补记：已完成步骤、各产出文件路径与关键发现');
          } catch { gaps.push('任务黑板 task-state.md 丢失，必须重建并补记执行状态'); }
        }
        // LLM judge：核验语义覆盖
        if (!gaps.length) {
          try {
            const verdictText = await plugins.runPlugin('intent', {
              action: 'verify',
              finalAnswer: lastAnswer
            }, { cwd: WS_DIR, dataDir: DATA_DIR, config: CONFIG_PATH });
            const match = verdictText.match(/发现 (\d+) 项缺口/);
            if (match && Number(match[1]) > 0) {
              const gapLines = verdictText.split('\n').filter(l => l.match(/^\d+\./));
              gaps.push(...gapLines.map(l => l.replace(/^\d+\.\s*/, '')));
            }
          } catch { /* judge 通道故障按通过处理 */ }
        }
        return gaps;
      };
      const MAX_REPAIR = 2;
      for (let r = 0; ; r++) {
        const gaps = await collectGaps();
        for (const g of gaps) { const s = String(g).slice(0, 300); if (!gapsSeen.includes(s)) gapsSeen.push(s); }
        appendProcess(`\n### ${fmtClock(Date.now())} ✅ 交付核验（第 ${r + 1} 次）\n\n${gaps.length ? gaps.map((g, i) => `${i + 1}. ${g}`).join('\n') : 'PASS：意图契约全部条款满足'}\n`);
        if (!gaps.length) {
          send({ type: 'info', text: '[交付核验] PASS：交付满足意图契约全部条款' });
          break;
        }
        if (r >= MAX_REPAIR) {
          finalGaps = gaps;
          send({ type: 'info', text: `[交付核验] 返修上限（${MAX_REPAIR} 轮）已到，仍有 ${gaps.length} 项缺口，带缺口标注交付` });
          lastAnswer = `${lastAnswer}\n\n[交付核验缺口标注] 以下要求经 ${MAX_REPAIR + 1} 次核验仍未满足：\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
          break;
        }
        repairCount++;
       const repairMsg = `[交付核验] 对照意图契约发现以下未满足项：\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}\n请立即针对性修复上述缺口（已满足的项不要重做），完成后重新交付总结。`;
       innerMessages.push({ role: 'user', content: repairMsg });
       persistInnerMessages();
       send({ type: 'info', text: `[交付核验] 发现 ${gaps.length} 项缺口，自动返修（第 ${r + 1}/${MAX_REPAIR} 轮）` });
       lastAnswer = await withTaskResume(runInner, { onInfo: send, label: '返修任务' });
     }
   }
    // 自动归档（v0.9.31，对齐 Hermes 会话归档静默写入；与 hwj/core.js 逐字对齐）：
    // 任务结束即把 用户消息+最终交付 归档到 memory-archive.jsonl，供后续任务 archive_search 检索；异步不阻塞交付
    if (String(lastAnswer || '').trim()) {
      if (!String(lastAnswer).includes('[交付核验缺口标注]')) {
        plugins.runPlugin('memory', { action: 'archive_save', user: String(message || ''), finalText: String(lastAnswer || '').slice(0, 4000) }, { cwd: WS_DIR, dataDir: DATA_DIR }).catch(() => {});
      }
      // 成功任务自动进入 Evolution Benchmark Ledger（与 TUI 同一套账本）；
      // 返修后 PASS 的标记 hard 难例；上限仍未过的只进缺口经验池。
      // 这里只记录任务与可观测产出，真正的评分必须在未来 replay 时重新执行。
      const hasUnresolvedGaps = String(lastAnswer).includes('[交付核验缺口标注]');
      try {
        const evolution = require('./lib/evolution');
        const intent = getCurrentIntent();
        if (!hasUnresolvedGaps) {
          // 返修后最终 PASS 的任务是最有价值的难例：repairs>0 会被标记 hard，进化时优先重放
          evolution.recordBenchmark({ task: message, finalText: lastAnswer, ws: currentWorkspace(), intent, artifacts: evolution.artifactManifest(WS_DIR), repairs: repairCount, lastGaps: [], allGaps: gapsSeen.slice(0, 8) });
        } else {
          // 上限仍未过的任务可能本身不可完成，不入 benchmark（避免不可达任务压扁 A/B），
          // 但缺口原文进经验池，供 Meta-Agent 提炼 skill mutation 时参考
          evolution.recordGap({ ts: new Date().toISOString(), task: String(message).slice(0, 2000), acceptance: Array.isArray(intent && intent.acceptance) ? intent.acceptance.slice(0, 8) : [], gaps: finalGaps.map(g => String(g).slice(0, 300)).slice(0, 8), repairs: repairCount });
        }
        // 真正的自进化：任务完成只产生经验，异步启动 Evolution Engine（后台 A/B 实验），
        // Engine 自己负责 candidate sandbox、统计门槛、regression 与 promote。
        if (evolution.shouldAutoEvolve() && process.env.DUAL_AGENT_EVOLUTION_WORKER !== '1') {
          process.env.DUAL_AGENT_EVOLUTION_RUNNING = '1';
          setImmediate(() => require('./lib/evolution').runEvolution({ promote: process.env.DUAL_AGENT_AUTO_PROMOTE !== '0' })
            .catch((e) => console.error('[evolution] 自动进化失败:', (e && e.message) || e))
            .finally(() => { delete process.env.DUAL_AGENT_EVOLUTION_RUNNING; }));
        }
      } catch { /* evolution 记录失败不影响任务交付 */ }
    }
    flushText();
    persistInnerMessages();
    send({ type: 'done' });
 } catch (e) {
   appendProcess(`\n### ${fmtClock(Date.now())} ❌ 错误\n\n${String((e && e.message) || e)}\n`);
   send({ type: 'error', content: String((e && e.message) || e) });
   send({ type: 'done' });
 } finally {
   innerLock = false;
   try { res.end(); } catch { /* closed */ }
   drainInnerQueue();
 }
 return;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  // ---------- 文档上传与查看（v0.9.16：本地文档处理 + 交付物在线查看） ----------
  // 上传：前端 FileReader 读为 base64 JSON POST（避开手写 multipart 解析，保持零依赖）
  if (p === '/api/upload' && req.method === 'POST') {
    lastSeen = Date.now();
    const body = await new Promise((resolve) => {
      let chunks = [];
      let size = 0;
      req.on('data', c => { size += c.length; if (size > 25 * 1024 * 1024) { req.destroy(); resolve(null); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(null));
    });
    if (body === null) { json(res, 413, { success: false, error: '文件过大（上限 20MB）' }); return; }
    let parsed;
    try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
    const b64 = String(parsed.content || '');
    const name = String(parsed.name || '').trim();
    if (!b64 || !name) { json(res, 400, { success: false, error: 'name/content 缺失' }); return; }
    if (!/^[\w\-. \u4e00-\u9fff]+$/.test(name) || name.includes('..')) { json(res, 400, { success: false, error: '文件名不合法（仅允许字母数字连字符下划线点空格中文）' }); return; }
    if (b64.length > 28 * 1024 * 1024) { json(res, 413, { success: false, error: '文件过大（上限 20MB）' }); return; }
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { json(res, 400, { success: false, error: 'base64 解码失败' }); return; }
    if (!buf.length) { json(res, 400, { success: false, error: '解码后为空' }); return; }
    const upDir = path.join(workspaceDir(), 'uploads');
    fs.mkdirSync(upDir, { recursive: true });
    // 重名自动加序号（不覆盖既有上传）
    let final = name;
    let n = 1;
    while (fs.existsSync(path.join(upDir, final))) {
      const ext = path.extname(name);
      final = path.basename(name, ext) + `-${n}` + ext;
      n += 1;
    }
    fs.writeFileSync(path.join(upDir, final), buf);
    appendProcess(`\n### ${fmtClock(Date.now())} 📎 上传\n\n${final}（${(buf.length / 1024).toFixed(1)}KB）\n`);
    json(res, 200, { success: true, name: final, path: `uploads/${final}`, size: buf.length, url: `/files/uploads/${encodeURIComponent(final)}` });
    return;
  }
  // 查看路由：/files/<相对路径> 工作区内任意文件直出（防穿越 + Content-Type）；
  // /view/<相对路径> markdown 渲染页（txt/png/jpg 等浏览器原生直出走 /files 即可）
  const FILE_TYPES = {
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.xml': 'text/xml; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.zip': 'application/zip'
  };
  const serveWsFile = (relPath, res) => {
    const wsRoot = workspaceDir();
    // decodeURIComponent 后 resolve，再校验仍在工作区内（防 %2e%2e 穿越）
    const fp = path.resolve(wsRoot, relPath.replace(/^\/+/, ''));
    if (!fp.startsWith(wsRoot + path.sep) && fp !== wsRoot) {
      res.writeHead(403); res.end('Forbidden：路径越界'); return false;
    }
    if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`文件不存在：${relPath}`); return false;
    }
    return fp;
  };
  if (req.method === 'GET' && (p.startsWith('/files/') || p.startsWith('/view/'))) {
    lastSeen = Date.now();
    let relPath;
    try { relPath = decodeURIComponent(p.replace(/^\/(files|view)\//, '')); } catch { res.writeHead(400); res.end('Bad Request'); return; }
    if (!relPath) { res.writeHead(400); res.end('Bad Request'); return; }
    const fp = serveWsFile(relPath, res);
    if (!fp) return;
    const ext = path.extname(fp).toLowerCase();
    if (p.startsWith('/view/')) {
      // markdown 渲染页：读文件 → mdRender → HTML 包裹（未识别扩展名也按文本渲染）
      let text;
      try { text = fs.readFileSync(fp, 'utf8'); } catch { res.writeHead(500); res.end('读取失败'); return; }
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(relPath)}</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;line-height:1.7;color:#1f2937}` +
        `pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}code{background:#f6f8fa;padding:2px 5px;border-radius:3px}` +
        `pre code{background:none;padding:0}blockquote{border-left:4px solid #d1d5db;margin:8px 0;padding:2px 12px;color:#4b5563}` +
        `table{border-collapse:collapse}th,td{border:1px solid #d1d5db;padding:6px 10px}img{max-width:100%}` +
        `.meta{color:#6b7280;font-size:13px;margin-bottom:16px}a{color:#2563eb}</style></head><body>` +
        `<div class="meta">${esc(relPath)} · <a href="/files/${relPath.split('/').map(encodeURIComponent).join('/')}">原始文件</a></div>${mdRender(text)}</body></html>`);
      return;
    }
    // /files/ 直出（下载型扩展名加 attachment 提示保存；查看型 inline）
    const downloadExts = new Set(['.zip', '.docx', '.xlsx']);
    res.writeHead(200, {
      'Content-Type': FILE_TYPES[ext] || 'application/octet-stream',
      'Content-Disposition': `${downloadExts.has(ext) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(fp))}`
    });
    fs.createReadStream(fp).pipe(res);
    return;
  }

  // ---------- 静态 ----------
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    lastSeen = Date.now(); // 打开/刷新页面也算在线
    fs.readFile(path.join(ROOT, 'public', 'index.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }
  if (req.method === 'GET' && p === '/process') {
    lastSeen = Date.now();
    fs.readFile(path.join(ROOT, 'public', 'process.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }
  if (req.method === 'GET' && p === '/help') {
    lastSeen = Date.now();
    fs.readFile(path.join(ROOT, 'public', 'help.html'), (e, d) => {
      if (e) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(d);
    });
    return;
  }

  try {
    // 网页关闭信号（sendBeacon）：把 lastSeen 拨回"IDLE_MS - 宽限"前，宽限内无新请求即退出
    if (p === '/api/bye' && req.method === 'POST') {
      lastSeen = Date.now() - IDLE_MS + BYE_GRACE_MS;
      json(res, 200, { success: true });
      return;
    }
    if (p.startsWith('/api/')) lastSeen = Date.now();
    // ---------- 健康/配置 ----------
    if (p === '/api/health' && req.method === 'GET') {
      const cfg = getConfig();
      const oc = await opencodeRunner();
      json(res, 200, {
        success: true, version: APP_VERSION,
        mock: process.env.DUAL_AGENT_MOCK === '1',
        innerConfigured: !!(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model),
        profileCount: validProfiles(cfg).length, // 多路 API：子智能体轮转分摊速率限制（0 = 仅主配置）
        opencode: oc ? oc.cmd : '', workspace: currentWorkspace(),
        workspaceDir: workspaceDir(), outerSession: cfg.outerSession || ''
      });
      return;
    }
    if (p === '/api/config' && req.method === 'GET') { json(res, 200, { success: true, config: maskedConfig() }); return; }
     if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      saveConfig(body);
      json(res, 200, { success: true, config: maskedConfig() });
      return;
    }
     // Embedding 连通性测试（v1.0.0：网页设置面板「测试连接」按钮 → memory 插件 emb_test，转发工作区 ctx）
     if (p === '/api/embedding/test' && req.method === 'POST') {
       const out = await plugins.runPlugin('memory', { action: 'emb_test' }, { cwd: workspaceDir(), dataDir: DATA_DIR });
       json(res, 200, { success: true, result: String(out) });
       return;
     }
     // 内层 LLM 连通性测试：body 指定 base_url/api_key/model（缺省回落已存配置），发 max_tokens=4 最小请求
      if (p === '/api/llm/test' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = getConfig();
      const base = String(body.base_url || (cfg.inner && cfg.inner.base_url) || '').trim();
      let key = String(body.api_key || '').trim(); // 空串不回落主配置——先按 base_url+model 匹配 profile（v1.3.9：key 留空不变语义下的单路测试）
      if (!key && base) {
        const prof = validProfiles(cfg).find(q => q.base_url === base && (!body.model || q.model === body.model) && q.api_key);
        if (prof) key = prof.api_key;
      }
      if (!key) key = String((cfg.inner && cfg.inner.api_key) || '').trim();
      const model = String(body.model || (cfg.inner && cfg.inner.model) || '').trim();
       if (!base || !key || !model) { json(res, 200, { ok: false, result: '请先填写 Base URL / API Key / 模型名' }); return; }
       const t0 = Date.now();
       try {
         const proto = base.startsWith('http:') ? require('http') : require('https');
         const reply = await new Promise((resolve, reject) => {
           const reqq = proto.request(`${base.replace(/\/+$/, '')}/chat/completions`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
             timeout: 15000,
           }, r2 => {
             let buf = '';
             r2.on('data', c => { buf += c; });
             r2.on('end', () => {
               if (r2.statusCode >= 200 && r2.statusCode < 300) {
                 try { const j = JSON.parse(buf); const msg = j.choices && j.choices[0] && j.choices[0].message; resolve({ ok: true, text: `连通正常（${Date.now() - t0}ms）：模型 ${j.model || model} 回复「${String((msg && msg.content) || '').slice(0, 40)}」` }); }
                 catch { resolve({ ok: false, text: '响应非 JSON：' + buf.slice(0, 120) }); }
               } else {
                 let hint = `HTTP ${r2.statusCode}`;
                 try { const j = JSON.parse(buf); if (j.error && j.error.message) hint += '：' + j.error.message; } catch { /* 保留状态码 */ }
                 if (r2.statusCode === 401) hint += '（Key 无效或过期）';
                 if (r2.statusCode === 404) hint += '（Base URL 可能少了或多了 /v1）';
                 resolve({ ok: false, text: hint });
               }
             });
           });
           reqq.on('timeout', () => { reqq.destroy(new Error('超时（15s）：地址不可达或网络受限')); });
           reqq.on('error', e => reject(e));
           reqq.end(JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4, stream: false }));
         });
         json(res, 200, { ok: reply.ok, result: reply.text });
       } catch (e) {
         json(res, 200, { ok: false, result: '连接失败：' + String(e.message || e) });
       }
       return;
     }
     // 一键清除历史文件：清各工作区会话/过程/用量 + 审计/快照；保留配置、插件、记忆、技能
     if (p === '/api/cleanup' && req.method === 'POST') {
       let removed = 0, bytes = 0;
       const hit = fp => { try { bytes += fs.statSync(fp).size; } catch { /* ignore */ } removed++; };
       const rm = fp => { try { if (fs.existsSync(fp)) { hit(fp); fs.rmSync(fp, { recursive: true, force: true }); } } catch { /* ignore */ } };
       try {
         for (const ws of listWorkspaces()) {
           const dir = path.join(WS_ROOT, ws);
           rm(path.join(dir, 'inner-messages.json'));
           rm(path.join(dir, 'process.md'));
           rm(path.join(dir, 'inner-usage.json'));
           rm(path.join(dir, 'sessions'));
           rm(path.join(dir, 'sessions-index.json'));
         }
         rm(path.join(DATA_DIR, 'audit.json'));
         rm(path.join(DATA_DIR, 'snapshots'));
         // 清后重载当前会话视图（内存态同步）
         try { loadInnerMessages(); } catch { /* ignore */ }
         json(res, 200, { ok: true, removed, bytes, message: '聊天记录与运行痕迹已清除（配置、插件、记忆、技能保留）' });
       } catch (e) {
         json(res, 200, { ok: false, removed, bytes, error: String(e.message || e) });
       }
       return;
     }

    // ---------- 多工作区 ----------
    if (p === '/api/workspaces' && req.method === 'GET') {
      json(res, 200, { success: true, current: currentWorkspace(), workspaces: listWorkspaces() });
      return;
    }
    if (p === '/api/workspace/switch' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!WS_NAME_RE.test(name)) { json(res, 400, { success: false, error: '工作区名不合法（小写字母/数字/连字符）' }); return; }
      saveConfig({ workspace: name, outerSession: '', reviewMark: getInnerLog().length });
      fs.mkdirSync(path.join(WS_ROOT, name), { recursive: true });
      loadInnerMessages(); // 会话按工作区分片：切换=换载，原工作区历史保留可切回
      json(res, 200, { success: true, current: name, workspaces: listWorkspaces(), workspaceDir: path.join(WS_ROOT, name) });
      return;
    }

    // ---------- 插件 ----------
    if (p === '/api/plugins' && req.method === 'GET') {
      json(res, 200, {
        success: true,
        plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) }))
      });
      return;
    }
    if (p === '/api/plugins/save' && req.method === 'POST') {
      const body = await readBody(req);
      const r = approval.manualSave(String(body.name || '').trim(), String(body.code || ''));
      json(res, 200, { success: r.ok, error: r.error, warns: r.warns || [], plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    if (p === '/api/plugins/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const r = approval.manualDelete(String(body.name || '').trim());
      json(res, 200, { success: r.ok, error: r.error, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    // WSL-RestorePoint：还原点回滚（单个插件 / 全部恢复出厂）
    if (p === '/api/plugins/restore' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const r = name ? plugins.restorePlugin(name) : plugins.restoreAll();
      json(res, 200, { success: !!r.ok, error: r.err || '', message: name ? (r.restored ? `已回滚 ${name} 到内置版本` : `已卸载自造插件 ${name}`) : `已恢复出厂插件集（清除 ${r.removed} 个自造/覆盖版）`, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    // WSL-Solo：App 壳与前端的状态协商（mobile 标记驱动前端隐藏外层/切聊天流布局）
    if (p === '/api/state' && req.method === 'GET') {
      json(res, 200, { success: true, mobile: process.env.DUAL_AGENT_MOBILE === '1', version: APP_VERSION, busy: !!(innerLock || outerLock) });
      return;
    }
    if (p === '/api/plugins/export' && req.method === 'GET') {
      const name = String(parsed.query.name || '').trim();
      if (!plugins.NAME_RE.test(name) || !plugins.readCode(name)) { json(res, 404, { success: false, error: '插件不存在' }); return; }
      const code = plugins.readCode(name);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}.js"`
      });
      res.end(code);
      return;
    }
    if (p === '/api/plugins/usage' && req.method === 'GET') {
      const action = String(parsed.query.action || '').trim();
      const usageMod = require('./plugins/usage');
      const usageCtx = { cwd: workspaceDir() }; // 与内层插件执行同源（inner-usage.json 按工作区落盘）
      if (action === 'get') {
        json(res, 200, { success: true, data: usageMod.getUsage(usageCtx) });
      } else if (action === 'history') {
        json(res, 200, { success: true, data: usageMod.getSessions(usageCtx) });
      } else {
        json(res, 400, { success: false, error: '未知 action，支持 get/history' });
      }
      return;
    }

    // ---------- 内层对话 ----------
    if (p === '/api/inner/chat' && req.method === 'POST') {
      lastSeen = Date.now();
      await handleInnerChat(req, res);
      return;
    }
    // 过程文件内容（/process 页轮询拉取；执行中任务 mtime 变化时增量刷新）
    if (p === '/api/process' && req.method === 'GET') {
      let mtime = 0;
      try { mtime = fs.statSync(processPath()).mtimeMs; } catch { /* 无文件 */ }
      json(res, 200, { success: true, content: readProcess(), path: processPath(), mtime, running: innerLock });
      return;
    }
    if (p === '/api/inner/messages' && req.method === 'GET') {
      json(res, 200, { success: true, messages: innerMessages.filter(m => m.role !== 'system').slice(-60) });
      return;
    }
    // ---------- 会话管理（v1.3.2：延续不清空，明确新建才换新） ----------
    if (p === '/api/sessions' && req.method === 'GET') {
      const idx = sessionMeta();
      json(res, 200, { success: true, current: idx.current, sessions: idx.list.slice().sort((a, b) => b.ts - a.ts) });
      return;
    }
    if (p === '/api/sessions/new' && req.method === 'POST') {
      if (innerLock) { json(res, 409, { success: false, error: '内层执行中，不能切换会话' }); return; }
      const idx = sessionMeta();
      idx.seq = (idx.seq || idx.list.length) + 1;
      const id = `s${idx.seq}`;
      idx.list.push({ id, name: `会话 ${idx.seq}`, ts: Date.now(), n: 0 });
      idx.current = id;
      saveSessionsIndex(idx);
      innerMessages = [];
      persistInnerMessages();
      clearWorkspaceMemory(); // P12: 新会话不带旧任务记忆
      json(res, 200, { success: true, current: id, sessions: idx.list.slice().sort((a, b) => b.ts - a.ts) });
      return;
    }
    if (p === '/api/sessions/switch' && req.method === 'POST') {
      if (innerLock) { json(res, 409, { success: false, error: '内层执行中，不能切换会话' }); return; }
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      const idx = sessionMeta();
      if (!idx.list.some(s => s.id === id)) { json(res, 404, { success: false, error: '会话不存在' }); return; }
      idx.current = id;
      saveSessionsIndex(idx);
      loadInnerMessages();
      json(res, 200, { success: true, current: id, messages: innerMessages.filter(m => m.role !== 'system').slice(-60) });
      return;
    }
    if (p === '/api/sessions/get' && req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      const sid = url.searchParams.get('i') || '';
      if (!sid) { json(res, 400, { success: false, error: '缺少会话ID' }); return; }
      try {
        const msgs = JSON.parse(fs.readFileSync(sessionFilePath(sid), 'utf8')) || [];
        json(res, 200, { success: true, messages: msgs.filter(m => m.role !== 'system') });
      } catch {
        json(res, 404, { success: false, error: '会话不存在' });
      }
      return;
    }
    if (p === '/api/sessions/delete' && req.method === 'POST') {
      if (innerLock) { json(res, 409, { success: false, error: '内层执行中，不能删除会话' }); return; }
      const body = await readBody(req);
      const id = String(body.id || '').trim();
      const idx = sessionMeta();
      const i = idx.list.findIndex(s => s.id === id);
      if (i < 0) { json(res, 404, { success: false, error: '会话不存在' }); return; }
      idx.list.splice(i, 1);
      try { fs.rmSync(sessionFilePath(id), { force: true }); } catch { /* ignore */ }
      // 删的是当前会话 → 切到最新会话；全删光则新建空会话
      if (idx.current === id) {
        if (idx.list.length) {
          idx.list.sort((a, b) => b.ts - a.ts);
          idx.current = idx.list[0].id;
        } else {
          idx.seq = (idx.seq || 0) + 1;
          idx.current = `s${idx.seq}`;
          idx.list.push({ id: idx.current, name: `会话 ${idx.seq}`, ts: Date.now(), n: 0 });
        }
      }
      saveSessionsIndex(idx);
      loadInnerMessages();
      json(res, 200, { success: true, current: idx.current, sessions: idx.list.slice().sort((a, b) => b.ts - a.ts), messages: innerMessages.filter(m => m.role !== 'system').slice(-60) });
      return;
    }
    if (p === '/api/inner/reset' && req.method === 'POST') {
      // v1.3.2 语义升级：清空 = 开启新会话（旧内容留在原会话可从左侧标签找回）
      if (innerLock) { json(res, 409, { success: false, error: '内层执行中，不能清空' }); return; }
      const idx = sessionMeta();
      idx.seq = (idx.seq || idx.list.length) + 1;
      const id = `s${idx.seq}`;
      idx.list.push({ id, name: `会话 ${idx.seq}`, ts: Date.now(), n: 0 });
      idx.current = id;
      saveSessionsIndex(idx);
      innerMessages = [];
      persistInnerMessages();
      clearWorkspaceMemory(); // P12: 同时清除工作区记忆
      json(res, 200, { success: true, current: id, sessions: idx.list.slice().sort((a, b) => b.ts - a.ts) });
      return;
    }

    // ---------- Self-Improving Agent Loop ----------
    if (p === '/api/evolution/status' && req.method === 'GET') {
      const evo = require('./lib/evolution');
      json(res, 200, { success:true, autoEvolve: evo.shouldAutoEvolve(), autoPromote: evo.shouldAutoPromote(), running: process.env.DUAL_AGENT_EVOLUTION_RUNNING === '1' || !!process.env.DUAL_AGENT_EVOLUTION_WORKER, minBenchmarks: Number(process.env.DUAL_AGENT_EVOLUTION_MIN_CASES)||3, ...evo.status() });
      return;
    }
    if (p === '/api/evolution/live' && req.method === 'GET') {
      const evo = require('./lib/evolution');
      json(res, 200, { success:true, ...evo.liveStatus() });
      return;
    }
    if (p === '/api/evolution/history' && req.method === 'GET') {
      const evo = require('./lib/evolution');
      json(res, 200, { success:true, history:evo.history(100) });
      return;
    }
    if (p === '/api/evolution/run' && req.method === 'POST') {
      const body = await readBody(req);
      const evo = require('./lib/evolution');
      if (process.env.DUAL_AGENT_EVOLUTION_RUNNING === '1') { json(res,409,{success:false,error:'Evolution 正在运行'}); return; }
      process.env.DUAL_AGENT_EVOLUTION_RUNNING='1';
      try { const r=await evo.runEvolution({cases:Number(body.cases)||12,promote:!!body.promote}); json(res,200,{success:!!r.ok,result:r}); }
      catch(e){ json(res,500,{success:false,error:String(e.message||e)}); }
      finally { delete process.env.DUAL_AGENT_EVOLUTION_RUNNING; }
      return;
    }
    if (p === '/api/evolution/grow-pool' && req.method === 'POST') {
      const body = await readBody(req);
      const evo = require('./lib/evolution');
      if (process.env.DUAL_AGENT_EVOLUTION_RUNNING === '1') { json(res,409,{success:false,error:'Evolution 正在运行'}); return; }
      process.env.DUAL_AGENT_EVOLUTION_RUNNING='1';
      try { const r=await evo.growPool({count:Number(body.count)||3}); json(res,200,{success:!!r.ok,result:r}); }
      catch(e){ json(res,500,{success:false,error:String(e.message||e)}); }
      finally { delete process.env.DUAL_AGENT_EVOLUTION_RUNNING; }
      return;
    }

    // ---------- 外层对话（opencode 会话续聊：-s ses_xxx，会话 ID 持久化） ----------
    if (p === '/api/outer/chat' && req.method === 'POST') {
      if (outerLock) { json(res, 409, { success: false, error: '外层正在分析上一条指令，请稍候' }); return; }
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      if (!message) { json(res, 400, { success: false, error: '消息为空' }); return; }
      const runner = await opencodeRunner();
      if (process.env.DUAL_AGENT_MOCK !== '1' && !runner) {
        json(res, 400, { success: false, error: '未检测到 opencode。安装：npm install -g opencode-ai，配置登录：opencode auth login；也可在环境变量 DUAL_AGENT_OPENCODE_CMD 指定完整路径' });
        return;
      }
      outerLock = true;
      const cfg = getConfig();
      const sessionId = cfg.outerSession || '';
      const send = sse(req, res);
      send({ type: 'start' });
      // 单向上下文：软约束提示词 + 插件清单（首评附全量源码）+ 审批历史 + 内层日志（失败详/成功简）
      const ctxOpts = { audit: recentAuditLines(5), scores: require('./lib/regression').pluginScores(getInnerLog()) };
      if (!sessionId) {
        // 首次评审（无续聊会话）：全量附带插件源码，杜绝外层"凭描述盲写"
        const codes = new Map();
        for (const pl of plugins.listPlugins()) codes.set(pl.name, plugins.readCode(pl.name));
        ctxOpts.codes = codes;
      }
      const prompt = `${outerMod.SYSTEM_PROMPT}\n\n${outerMod.buildContext(plugins.listPlugins(), getInnerLog(), ctxOpts)}\n\n== 用户指令 ==\n${message}`;
      let fullText = '';
      try {
        const r = await outerMod.runOuter(runner, prompt, ROOT, ev => {
          if (ev.type === 'text') { fullText = ev.text; send(ev); }
          else if (ev.type === 'info') send(ev); // 限流退避提示转发前端
          else if (ev.type === 'session' && ev.sessionId && ev.sessionId !== sessionId) {
            saveConfig({ outerSession: ev.sessionId }); // 首个 sessionID 回填，下次续聊
            send(ev);
          }
        }, sessionId);
        if (r.error) send({ type: 'error', content: r.error });
        // 发起评审即视为已处理评审提示
        saveConfig({ reviewMark: getInnerLog().length });
        // 解析建议 json → 审批队列
        const props = outerMod.parseProposals(fullText);
        const added = [];
        for (const pr of props) {
          const r2 = approval.addProposal(pr, 'outer');
          if (r2.ok) added.push(r2.proposal.id);
          else send({ type: 'notice', content: `建议无效已忽略：${r2.error}` });
        }
        if (!props.length && /```/.test(fullText)) {
          send({ type: 'notice', content: '外层回复含代码块但未解析出任何建议（JSON 格式不合规范）。请在右栏要求其按标准 ```json proposals 格式重发。' });
        }
        send({ type: 'proposals', added, count: added.length });
        send({ type: 'done' });
      } catch (e) {
        send({ type: 'error', content: String((e && e.message) || e) });
        send({ type: 'done' });
      } finally {
        outerLock = false;
        try { res.end(); } catch { /* closed */ }
      }
      return;
    }
    if (p === '/api/outer/new-session' && req.method === 'POST') {
      saveConfig({ outerSession: '' });
      json(res, 200, { success: true });
      return;
    }

    // ---------- 自动评审提示（内层累计调用/失败达到阈值时建议发起外层评审） ----------
    if (p === '/api/review-hint' && req.method === 'GET') {
      const log = getInnerLog();
      const mark = Math.min(Number(getConfig().reviewMark) || 0, log.length);
      const recent = log.slice(mark);
      const calls = recent.length;
      const fails = recent.filter(l => !l.ok).length;
      json(res, 200, { success: true, suggest: calls >= 12 || fails >= 3, calls, fails, outerSession: getConfig().outerSession || '' });
      return;
    }
    if (p === '/api/review-ack' && req.method === 'POST') {
      saveConfig({ reviewMark: getInnerLog().length });
      json(res, 200, { success: true });
      return;
    }

    // ---------- 审批 ----------
    if (p === '/api/proposals' && req.method === 'GET') {
      json(res, 200, { success: true, proposals: approval.listProposals() });
      return;
    }
    if (p === '/api/proposals/decide' && req.method === 'POST') {
      const body = await readBody(req);
      const r = approval.decide(String(body.id || ''), !!body.approve);
      json(res, 200, { success: r.ok, error: r.error, rejected: !!r.rejected, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }
    if (p === '/api/rollback' && req.method === 'POST') {
      const r = approval.rollback();
      json(res, 200, { success: r.ok, error: r.error, restored: r.restored, plugins: plugins.listPlugins().map(pl => ({ ...pl, code: plugins.readCode(pl.name) })) });
      return;
    }

    if (p === '/api/audit' && req.method === 'GET') {
      let list = [];
      try { list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'audit.json'), 'utf8')); } catch { /* ignore */ }
      json(res, 200, { success: true, audit: list.slice(-100).reverse() });
      return;
    }    if (p === '/api/inner-log' && req.method === 'GET') {
      json(res, 200, { success: true, log: getInnerLog().slice(-50).reverse() });
      return;
    }

    // ---------- Channel API（供 Qwen Code Channels 调用） ----------
    // POST /api/channel/chat - 接收 channel 消息，执行后返回结果
    if (p === '/api/channel/chat' && req.method === 'POST') {
      lastSeen = Date.now();
      handleChannelChat(req, res);
      return;
    }

    // GET /api/channel/status - 检查服务状态
    if (p === '/api/channel/status' && req.method === 'GET') {
      lastSeen = Date.now();
      json(res, 200, { 
        success: true, 
        status: 'ok',
        innerConfigured: !!(getConfig().inner.base_url && getConfig().inner.api_key && getConfig().inner.model),
        innerQueueLength: innerQueue.length,
        version: APP_VERSION
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (err) {
    console.log('[api]', err && err.stack || err);
    try { json(res, 500, { success: false, error: String((err && err.message) || err) }); } catch { /* ignore */ }
  }
});

// ---------- Channel API 实现 ----------
// 复用 handleInnerChat 逻辑，但返回 JSON 而非 SSE
async function handleChannelChat(req, res) {
  try {
    const body = await readBody(req);
    const message = String(body.message || '').trim();
    const chatId = String(body.chatId || 'default');
    
    if (!message) { json(res, 400, { success: false, error: '消息为空' }); return; }
    
    const cfg = getConfig();
    if (process.env.DUAL_AGENT_MOCK !== '1' && !(cfg.inner.base_url && cfg.inner.api_key && cfg.inner.model)) {
      json(res, 400, { success: false, error: '内层 API 未配置' });
      return;
    }
    
    // 复用 handleInnerChat 逻辑，但使用同步方式获取结果
    const { text, queued } = await runChannelTask(message, chatId);
    json(res, 200, { success: true, result: text, queued: !!queued });
  } catch (e) {
    json(res, 500, { success: false, error: String((e && e.message) || e) });
  }
}

// Channel 任务执行器：复用 handleInnerChat，捕获其 SSE 事件流还原最终文本。
// 事件流走向：handleInnerChat 内部 send = sse(req, res) → res.write("data: {...}\n\n")，
// 因此 mock res 的 write 必须解析 data: 行收集事件（text 为快照式覆盖，取最后一个）
function runChannelTask(message, chatId) {
  return new Promise((resolve, reject) => {
    const events = [];
    // mock res 用 EventEmitter：end() 时 emit close，让 sse() 内部的心跳 setInterval 得以清理（防泄漏）
    const mockRes = new EventEmitter();
    mockRes.writeHead = () => {};
    mockRes.write = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const t = line.trim();
        if (t.startsWith('data: ')) {
          try { events.push(JSON.parse(t.slice(6))); } catch { /* 非 JSON 行忽略 */ }
        }
      }
    };
    mockRes.end = () => { mockRes.emit('close'); };
    const mockReq = new EventEmitter();
    mockReq.url = '/api/inner/chat';
    mockReq.method = 'POST';
    mockReq.destroy = () => {};
    handleInnerChat(mockReq, mockRes, { message }, false)
      .then(() => {
        const errorEvent = [...events].reverse().find(e => e.type === 'error');
        if (errorEvent) { reject(new Error(errorEvent.content || '任务执行失败')); return; }
        const queuedEvent = events.find(e => e.type === 'queued');
        if (queuedEvent) { resolve({ text: queuedEvent.text || '消息已排队，当前任务完成后自动执行', queued: true }); return; }
        const texts = events.filter(e => e.type === 'text' && e.text && e.text.trim());
        resolve({ text: texts.length ? texts[texts.length - 1].text : '任务完成', queued: false });
      })
      .catch(reject);
  });
}

// 就绪后自动打开浏览器（一键启动体验；无头/CI 环境自动跳过，DUAL_AGENT_NO_BROWSER=1 显式关闭）
function openBrowser(target) {
  if (process.env.DUAL_AGENT_NO_BROWSER === '1') return;
  if (process.platform === 'linux' && !process.env.DISPLAY) return;
  const { exec } = require('child_process');
  const cmd = process.platform === 'win32' ? `start "" "${target}"`
    : process.platform === 'darwin' ? `open "${target}"`
    : `xdg-open "${target}"`;
  exec(cmd, { timeout: 8000 }, () => { /* 打不开不影响服务 */ });
}

server.listen(PORT, '127.0.0.1', () => {
  const url0 = `http://localhost:${PORT}`;
  console.log(`wsl agent v${APP_VERSION} 已启动: ${url0}`);
  console.log(`工作区: ${currentWorkspace()}（${workspaceDir()}）`);
  if (process.env.DUAL_AGENT_MOCK === '1') console.log('演示模式：内层假 LLM + 外层假 opencode（不依赖真实 API）');
  if (AUTOSTOP) console.log(`全部网页关闭且空闲超 ${Math.round(IDLE_MS / 1000)} 秒后自动退出（DUAL_AGENT_AUTOSTOP=0 可常驻）`);
  openBrowser(url0);
});

// 优雅退出：Ctrl+C / 关闭启动窗口；server.close 带 5 秒强制退出兜底（防 keep-alive 连接挂住）
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务器...`);
  const force = setTimeout(() => process.exit(0), 5000);
  server.close(() => { clearTimeout(force); console.log('服务器已关闭'); process.exit(0); });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
