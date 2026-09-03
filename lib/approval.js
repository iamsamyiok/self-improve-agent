// 审批与快照：统一管线（手动操作与外层建议共用）——先快照、后应用、热加载、审计
const fs = require('fs');
const path = require('path');
const plugins = require('./plugins');
const { lintCode } = require('./lint');
const { preflight } = require('./regression');

const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data');
const SNAP_ROOT = path.join(DATA_DIR, 'snapshots');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.json');
const PROPOSALS_PATH = path.join(DATA_DIR, 'proposals.json');
const KEEP_SNAPSHOTS = 2; // 快照仅保留最近 2 个版本

// ---------- 审计日志（append，环形最近 500 条） ----------
function audit(op, detail) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')); } catch { /* ignore */ }
  list.push({ ts: new Date().toISOString(), op, ...detail });
  if (list.length > 500) list = list.slice(-500);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(AUDIT_PATH, JSON.stringify(list, null, 2)); }
  catch (e) { console.error('[audit] 审计落盘失败（操作已生效但无记录）:', e && e.message || e); }
}

// ---------- 快照 ----------
// 受影响文件复制到 .data/snapshots/<ts>/，附带 manifest；随后裁剪只留最近 2 个
// 目录名 = 时间36进制 + 进程内单调序号（定宽），保证字符串排序 = 创建顺序
let snapSeq = 0;
function makeSnapshot(op, names) {
  const ts = Date.now().toString(36) + '-' + snapSeq.toString(36).padStart(4, '0');
  snapSeq++;
  const dir = path.join(SNAP_ROOT, ts);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of names) {
    // overlay 语义：快照「现役版本」——锻造区优先，其次内置（restorePlugin 同源逻辑）
    const live = plugins.resolvePluginPath ? plugins.resolvePluginPath(name).file : path.join(plugins.PLUGINS_DIR, `${name}.js`);
    if (fs.existsSync(live)) {
      fs.copyFileSync(live, path.join(dir, `${name}.js`));
      files.push({ name, existed: true });
    } else {
      files.push({ name, existed: false }); // 删除/覆盖场景回滚需要知道「原本不存在」
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ts, op, files }, null, 2));
  // 裁剪：按目录名（时间基36）排序保留最近 KEEP_SNAPSHOTS 个
  const all = fs.readdirSync(SNAP_ROOT).filter(d => /^[0-9a-z-]+$/.test(d)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS))) {
    try { fs.rmSync(path.join(SNAP_ROOT, old), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return ts;
}

// 回滚：恢复最新快照（先选定目标，再对现状打保护快照——保护快照=「回滚前状态」，
// 下次回滚的目标即它，回滚本身可回滚；连续回滚在两个状态间交替，语义自洽）
function rollback() {
  const all = fs.readdirSync(SNAP_ROOT).filter(d => /^[0-9a-z-]+$/.test(d)).sort();
  if (!all.length) return { ok: false, error: '没有可回滚的快照' };
  const dir = path.join(SNAP_ROOT, all[all.length - 1]);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return { ok: false, error: '快照清单损坏，无法回滚' }; }
  const names = manifest.files.map(f => f.name);
  makeSnapshot('rollback-protect', names); // 保护现状（此刻最新快照变为保护快照，供下次回滚）
  const restored = [];
  for (const f of manifest.files) {
    const forgeDst = path.join(plugins.FORGE_DIR, `${f.name}.js`);
    const src = path.join(dir, `${f.name}.js`);
    if (f.existed && fs.existsSync(src)) {
      // 恢复快照内容：写入锻造区（内置目录只读；锻造区覆盖即现役）
      fs.mkdirSync(plugins.FORGE_DIR, { recursive: true });
      fs.copyFileSync(src, forgeDst);
      plugins.hotReload(f.name);
      restored.push(f.name + '（恢复）');
    } else if (!f.existed) {
      // 恢复到「不存在」：清除锻造区现役文件（内置本无此文件，existed=false 已保证）
      try { fs.unlinkSync(forgeDst); } catch { /* ignore */ }
      plugins.hotUnload(f.name);
      restored.push(f.name + '（删除，恢复到不存在的状态）');
    }
  }
  audit('rollback', { snapshot: manifest.ts, restored });
  return { ok: true, restored };
}

// ---------- 审批队列（落盘持久化：重启后待审批项不丢） ----------
const proposals = new Map();
let seq = 0;

// 启动时从磁盘恢复待审批队列
function restoreProposals() {
  try {
    const arr = JSON.parse(fs.readFileSync(PROPOSALS_PATH, 'utf8'));
    for (const p of arr) {
      if (p && p.id && p.action) proposals.set(p.id, p);
      const m = (String(p && p.id || '').match(/-([0-9a-z]+)$/));
      if (m) { const n = parseInt(m[1], 36); if (Number.isFinite(n) && n >= seq) seq = n + 1; }
    }
  } catch { /* 无存档 */ }
}
function persistProposals() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PROPOSALS_PATH, JSON.stringify([...proposals.values()], null, 2)); }
  catch (e) { console.error('[approval] 审批队列落盘失败（重启将丢失待审建议）:', e && e.message || e); }
}
restoreProposals();

function addProposal(p, source) {
  const id = 'p-' + Date.now().toString(36) + '-' + (seq++).toString(36);
  const old = (p.action === 'update' || p.action === 'delete') ? plugins.readCode(p.plugin) : '';
  if ((p.action === 'update' || p.action === 'delete') && !old) {
    return { ok: false, error: `插件 ${p.plugin} 不存在，update/delete 建议无效` };
  }
  if (p.action === 'create' && old) {
    return { ok: false, error: `插件 ${p.plugin} 已存在，create 建议无效（应为 update）` };
  }
  if (p.action !== 'delete' && !String(p.code).trim()) {
    return { ok: false, error: 'create/update 必须提供代码' };
  }
  // 静态预检：语法错误直接拒绝入队（热加载必炸）；危险模式转为警告随审批展示
  let warns = [];
  if (p.action !== 'delete') {
    const lint = lintCode(p.code);
    if (lint.syntax) return { ok: false, error: `插件代码语法错误，已拒绝：${lint.syntax}` };
    warns = lint.warns;
  }
  const rec = { id, ...p, source: source || 'outer', old, warns, createdAt: new Date().toISOString() };
  proposals.set(id, rec);
  persistProposals();
  audit('proposal', { id, source: rec.source, action: p.action, plugin: p.plugin, reason: p.reason });
  return { ok: true, proposal: rec };
}

function listProposals() { return [...proposals.values()]; }

// 应用一项修改：预检回归 → 快照 → 写/删 → 热加载（失败自动回滚该文件）→ 审计
// 预检失败直接拦截（坏插件进不了运行时）；delete 建议也走全量回归（防破坏依赖）
function apply(p, source) {
  if (process.env.DUAL_AGENT_MOCK === '1' || process.env.DUAL_AGENT_NO_PREFLIGHT === '1') {
    return applyNoGuard(p, source); // 演示模式跳过预检（沙盒无真实插件环境）
  }
  const pf = preflight([p]);
  if (!pf.ok) {
    audit('preflight-blocked', { id: p.id, source, action: p.action, plugin: p.plugin, stage: pf.stage, error: pf.error.slice(0, 400) });
    return { ok: false, error: `预检未通过（${pf.stage === 'syntax' ? '结构冒烟' : '回归测试'}），已拦截未应用：\n${pf.error}` };
  }
  return applyNoGuard(p, source);
}

function applyNoGuard(p, source) {
  const snap = makeSnapshot(`${source}:${p.action} ${p.plugin}`, [p.plugin]);
  try {
    if (p.action === 'delete') {
      plugins.deleteCode(p.plugin);
    } else {
      plugins.writeCode(p.plugin, p.code);
    }
    const err = p.action === 'delete' ? '' : plugins.hotReload(p.plugin);
    if (err) throw new Error(`热加载失败：${err}`);
    audit('apply', { id: p.id, source, action: p.action, plugin: p.plugin, snapshot: snap });
    return { ok: true, snapshot: snap };
  } catch (e) {
    // 应用失败：从快照恢复现役状态（恢复目标=锻造区；内置目录只读）
    const dir = path.join(SNAP_ROOT, snap);
    const src = path.join(dir, `${p.plugin}.js`);
    const dst = path.join(plugins.FORGE_DIR, `${p.plugin}.js`);
    const existed = fs.existsSync(src);
    if (existed) { fs.mkdirSync(plugins.FORGE_DIR, { recursive: true }); fs.copyFileSync(src, dst); plugins.hotReload(p.plugin); }
    else { try { fs.unlinkSync(dst); } catch { /* ignore */ } plugins.hotUnload(p.plugin); }
    audit('apply-failed', { id: p.id, source, action: p.action, plugin: p.plugin, error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  }
}

function decide(id, approve) {
  const p = proposals.get(id);
  if (!p) return { ok: false, error: '审批项不存在或已处理' };
  proposals.delete(id);
  persistProposals();
  if (!approve) {
    audit('reject', { id, source: p.source, action: p.action, plugin: p.plugin });
    return { ok: true, rejected: true };
  }
  return apply(p, p.source);
}

// 手动保存/删除：用户亲手操作 = 自我批准，复用同一管线（先快照；语法错拒绝，危险模式仅警告）
function manualSave(name, code) {
  if (!plugins.NAME_RE.test(name)) return { ok: false, error: '插件名不合法（小写字母/数字/连字符）' };
  const lint = lintCode(code);
  if (lint.syntax) return { ok: false, error: `插件代码语法错误：${lint.syntax}` };
  const exists = !!plugins.readCode(name);
  const p = { id: 'm-' + Date.now().toString(36), action: exists ? 'update' : 'create', plugin: name, code, reason: '手动编辑', old: exists ? plugins.readCode(name) : '' };
  const r = apply(p, 'manual');
  return { ...r, warns: lint.warns };
}
function manualDelete(name) {
  if (!plugins.readCode(name)) return { ok: false, error: '插件不存在' };
  const p = { id: 'm-' + Date.now().toString(36), action: 'delete', plugin: name, code: '', reason: '手动删除', old: plugins.readCode(name) };
  return apply(p, 'manual');
}

// Evolution 专用应用入口：仍复用同一 preflight/snapshot/hot-reload 管线，但审计 source 单独标识。
function applyForEvolution(p, source) {
  if (!p || !p.action || !p.plugin) return { ok: false, error: 'evolution proposal 非法' };
  const old = (p.action === 'update' || p.action === 'delete') ? plugins.readCode(p.plugin) : '';
  if ((p.action === 'update' || p.action === 'delete') && !old) return { ok:false, error:'目标插件不存在' };
  if (p.action !== 'delete' && !String(p.code||'').trim()) return { ok:false,error:'候选源码为空' };
  return apply({ ...p, old }, `evolution:${source || 'unknown'}`);
}

module.exports = { addProposal, listProposals, decide, rollback, manualSave, manualDelete, audit, applyForEvolution };
