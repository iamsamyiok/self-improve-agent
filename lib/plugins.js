// 插件运行时：清单扫描（注释头元信息）+ 启动全量加载 + 热插拔
// 插件文件约定（元信息在注释头，系统无需执行即可列清单）：
//   // @name read
//   // @desc 读取文本文件内容
//   // @essential true
//   module.exports = { params: <JSON Schema>, run: async (args, ctx) => string }
// 全量加载：所有插件启动即 require 验证，损坏立即标红（曾用懒加载黄点，易被误解为故障）
//
// WSL-SelfForge 双目录 overlay（v1.3.0）：
//   内置还原点（只读）：nodejs-project/plugins 或仓库 plugins/ —— 版本化，永不被写/删
//   锻造区（可写）：    <DUAL_AGENT_DATA>/plugins-forged/ —— 内层自造/自改插件落盘处
//   同名插件：锻造区覆盖内置（可随时 restore 回滚到还原点）
const fs = require('fs');
const path = require('path');

// 主（内置）插件目录：可经 DUAL_AGENT_PLUGINS_DIR 覆盖（测试隔离用），默认随代码库
const PLUGINS_DIR = process.env.DUAL_AGENT_PLUGINS_DIR || path.join(__dirname, '..', 'plugins');
// 锻造区：数据目录下（移动端 App 私有 / 桌面 .data/），可经 DUAL_AGENT_FORGE_DIR 覆盖
const FORGE_DIR = process.env.DUAL_AGENT_FORGE_DIR || path.join(
  process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data'), 'plugins-forged');
const NAME_RE = /^[a-z0-9-]{1,40}$/;
// 单次插件执行兜底超时（防业务插件挂起卡死内层循环；bash 内部另有 30s 细粒度超时）
const RUN_TIMEOUT_MS = Number(process.env.DUAL_AGENT_PLUGIN_TIMEOUT_MS) > 0 ? Number(process.env.DUAL_AGENT_PLUGIN_TIMEOUT_MS) : 60000;

// 插件解析路径：锻造区存在同名文件则锻造区优先（overlay 覆盖语义）
function resolvePluginPath(name) {
  const forged = path.join(FORGE_DIR, `${name}.js`);
  try { fs.accessSync(forged); return { file: forged, source: 'forged' }; } catch { /* 无锻造版 */ }
  return { file: path.join(PLUGINS_DIR, `${name}.js`), source: 'builtin' };
}

// 解析注释头元信息（不执行插件代码）
function parseMeta(file) {
  const src = fs.readFileSync(file, 'utf8');
  const head = src.split(/\r?\n/).slice(0, 12).join('\n');
  const name = (head.match(/^\/\/\s*@name\s+(.+)$/m) || [])[1];
  const desc = (head.match(/^\/\/\s*@desc\s+(.+)$/m) || [])[1];
  const essential = /^\/\/\s*@essential\s+true/m.test(head);
  return { name: (name || '').trim(), desc: (desc || '').trim(), essential };
}

// 单目录扫描（返回半成品条目）
function scanDir(dir, source) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); } catch { /* 目录不存在 */ }
  const out = [];
  for (const f of files) {
    const base = f.slice(0, -3);
    const abs = path.join(dir, f);
    let meta = { name: base, desc: '', essential: false };
    let broken = '';
    try { meta = { ...meta, ...parseMeta(abs) }; } catch (e) { broken = String(e.message || e); }
    if (!meta.name) meta.name = base;
    if (!NAME_RE.test(meta.name)) { out.push({ name: base, desc: meta.desc, essential: false, status: 'broken', err: `插件名 "${meta.name}" 不合法（限小写字母/数字/连字符）`, source }); continue; }
    if (broken) { out.push({ name: meta.name, desc: meta.desc, essential: false, status: 'broken', err: broken, source }); continue; }
    out.push({ name: meta.name, desc: meta.desc, essential: !!meta.essential, status: 'loaded', err: '', source });
  }
  return out;
}

// 插件清单：内置 + 锻造区 overlay（锻造区同名覆盖内置；broken 不影响他者）
function listPlugins() {
  const merged = new Map();
  for (const p of [...scanDir(PLUGINS_DIR, 'builtin'), ...scanDir(FORGE_DIR, 'forged')]) {
    merged.set(p.name, p); // 后扫锻造区 → 同名覆盖
  }
  // 全部插件启动即加载验证（小模块开销可忽略；曾用懒加载显示黄点，用户易误解为故障）
  for (const p of merged.values()) {
    if (p.status === 'broken') continue;
    if (!loaded.has(p.name)) {
      const err = tryLoad(p.name);
      if (err) { p.status = 'broken'; p.err = err; }
    }
  }
  return [...merged.values()].sort((a, b) => (b.essential - a.essential) || a.name.localeCompare(b.name));
}

// ---------- 加载与执行 ----------
const loaded = new Map(); // name -> { params, run }
const loadedMtime = new Map(); // name -> 文件 mtimeMs（SelfForge：文件变更自动热重载）

function pluginPath(name) { return resolvePluginPath(name).file; }

// require 加载（捕获语法/顶层错误），成功返回 ''，失败返回错误信息
function tryLoad(name) {
  try {
    const p = pluginPath(name);
    delete require.cache[require.resolve(p)];
    const mod = require(p);
    if (!mod || typeof mod.run !== 'function') return '插件必须导出 run 函数';
    loaded.set(name, mod);
    try { loadedMtime.set(name, fs.statSync(p).mtimeMs); } catch { /* ignore */ }
    return '';
  } catch (e) {
    loaded.delete(name);
    return String((e && e.message) || e);
  }
}

// WSL-SelfForge：执行前比对 mtime——内层覆盖/修改插件文件后无需重启即生效
function autoReloadIfChanged(name) {
  try {
    const p = pluginPath(name);
    const mt = fs.statSync(p).mtimeMs;
    if (loadedMtime.has(name) && loadedMtime.get(name) !== mt) {
      const err = tryLoad(name);
      if (err) return `插件 ${name} 重载失败（保留旧版本）：${err}`;
    }
  } catch { /* 文件不存在等，交由原流程处理 */ }
  return '';
}

// 热加载：清缓存重新加载（审批应用/手动保存后调用；失败保留旧版本并返回错误）
function hotReload(name) {
  const err = tryLoad(name);
  return err; // '' = 成功
}
function hotUnload(name) { loaded.delete(name); }

// 统一必填参数校验：用插件 params.required（JSON Schema）在执行前兜底。
// 缺参时返回明确的可重试错误（LLM 看到后会按 schema 重新调用），避免插件拿到残缺参数
// 炸出 EISDIR / undefined 这类费解错误（曾发生：write 空参数 → path.resolve(cwd,'') → 写目录 EISDIR）
function checkRequired(mod, args) {
  const req = mod && mod.params && Array.isArray(mod.params.required) ? mod.params.required : [];
  const missing = req.filter(k => args[k] === undefined || args[k] === null || (typeof args[k] === 'string' && !args[k].trim()));
  if (!missing.length) return '';
  return `插件调用缺少必填参数：${missing.join('、')}。请按参数说明（JSON Schema）重新调用并提供完整参数；` +
    `若你确认上一轮已提供参数，说明超长输出在传输中被截断，请大幅缩短单次写入内容（如分多次写入文件的相邻片段）。`;
}

// 执行插件：mtime 热重载 → 懒加载 → 参数校验 → run（带兜底超时，防挂起）→ 异常/超时转错误字符串回传 LLM（不中断会话）
async function runPlugin(name, args, ctx) {
  if (loaded.has(name)) {
    const rl = autoReloadIfChanged(name);
    if (rl) return `插件 ${name} ${rl}`;
  }
  if (!loaded.has(name)) {
    const err = tryLoad(name);
    if (err) return `插件 ${name} 加载失败：${err}`;
  }
  const mod = loaded.get(name);
  // 参数形态校验：必须是对象（LLM 偶发发字符串/数组/null）
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return `插件 ${name} 调用被拒绝：参数必须是 JSON 对象（本次收到 ${args === null ? 'null' : typeof args}），请重新调用。`;
  }
  const missErr = checkRequired(mod, args);
  if (missErr) return `插件 ${name} 调用被拒绝：${missErr}`;
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(`__DA_TIMEOUT__`), RUN_TIMEOUT_MS);
    });
    const r = await Promise.race([Promise.resolve(mod.run(args || {}, ctx)), timeout]);
    if (r === '__DA_TIMEOUT__') return `插件 ${name} 执行出错：超过 ${Math.round(RUN_TIMEOUT_MS / 1000)} 秒未返回，已放弃等待（插件可能仍在后台运行）`;
    const s = String(r ?? '');
    return s.length > 8192 ? s.slice(0, 8192) + '\n…（输出过长已截断）' : s;
  } catch (e) {
    return `插件 ${name} 执行出错：${String((e && e.message) || e)}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// OpenAI tools 定义（broken 插件不进列表）
function toolDefs() {
  return listPlugins()
    .filter(p => p.status !== 'broken')
    .map(p => ({
      type: 'function',
      function: {
        name: p.name,
        description: (p.source === 'forged' ? '[自锻造] ' : '') + (p.desc || p.name),
        parameters: (loaded.has(p.name) && loaded.get(p.name).params) || { type: 'object', properties: {} }
      }
    }));
}

// 读取插件源码（前端查看/diff 用）
function readCode(name) {
  try { return fs.readFileSync(pluginPath(name), 'utf8'); } catch { return ''; }
}
// 写插件：一律落锻造区（内置还原点只读，保障随时回滚）
function writeCode(name, code) {
  fs.mkdirSync(FORGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(FORGE_DIR, `${name}.js`), String(code || ''), 'utf8');
}
// 删插件：仅允许删锻造区文件（内置还原点不可删）
function deleteCode(name) {
  try { fs.unlinkSync(path.join(FORGE_DIR, `${name}.js`)); hotUnload(name); return true; } catch { return false; }
}

// WSL-RestorePoint：还原点回滚
//  单个：删锻造区同名文件 → 恢复内置版本（无内置版本则等于卸载）
//  全部：清空锻造区 → 完整恢复出厂插件集
function restorePlugin(name) {
  try { fs.unlinkSync(path.join(FORGE_DIR, `${name}.js`)); } catch { /* 无锻造版 */ }
  const builtinExists = fs.existsSync(path.join(PLUGINS_DIR, `${name}.js`));
  if (builtinExists) { const err = tryLoad(name); return { ok: !err, err: err || '', restored: true }; }
  hotUnload(name);
  return { ok: true, err: '', restored: false };
}
function restoreAll() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(FORGE_DIR).filter(f => f.endsWith('.js'))) { fs.unlinkSync(path.join(FORGE_DIR, f)); n++; }
  } catch { /* 目录不存在 */ }
  loaded.clear(); // 全量重扫重载
  return { ok: true, removed: n };
}

module.exports = { listPlugins, toolDefs, runPlugin, hotReload, hotUnload, readCode, writeCode, deleteCode, restorePlugin, restoreAll, resolvePluginPath, PLUGINS_DIR, FORGE_DIR, NAME_RE };
