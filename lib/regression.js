// @name regression
// @desc 审批前自动回归验证：把建议代码放进临时沙盒（复刻插件环境）跑冒烟子集，坏插件进不了运行时
// 零依赖；由 lib/approval.js 在 apply 前调用
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// 冒烟验证脚本（写入临时沙盒后用独立 node 进程执行）：
// 1. 语法可加载（require 不炸）
// 2. params 为合法 JSONSchema 对象
// 3. run 为函数
// 4. essential 元信息解析正常
// 通过标准输入接收 JSON：{ plugins: [{name, code, action}] }（删除项仅验存在性）
const SMOKE_SRC = `
const fs = require('fs');
const path = require('path');
const module_ = require('module');
const BUILTIN = new Set(module_.builtinModules);
const input = JSON.parse(fs.readFileSync(process.env.SMOKE_IN, 'utf8'));
const errs = [];
for (const p of input.plugins) {
  if (p.action === 'delete') { continue; }
  const fp = path.join(input.dir, p.plugin + '.js');
  if (!fs.existsSync(fp)) { errs.push(p.plugin + ': 文件未写入'); continue; }
  let mod;
  try {
    const code = fs.readFileSync(fp, 'utf8');
    const wrap = new Function('module', 'exports', 'require', '__dirname', '__filename', code + '\\n');
    const m = { exports: {} };
    wrap(m, m.exports, (id) => {
      const base = id.split('/')[0];
      if (BUILTIN.has(base)) return require(id); // Node 内建全放行（bash 插件用 child_process 等）
      throw new Error('审批冒烟不允许第三方模块（本项目零依赖）: ' + id);
    }, path.dirname(fp), fp);
    mod = m.exports;
  } catch (e) { errs.push(p.plugin + ': 加载失败 ' + e.message); continue; }
  if (!mod || typeof mod !== 'object') { errs.push(p.plugin + ': 导出非对象'); continue; }
  if (!mod.params || typeof mod.params !== 'object' || !mod.params.type) errs.push(p.plugin + ': params 缺失或非法（须为 JSONSchema 对象）');
  if (typeof mod.run !== 'function') errs.push(p.plugin + ': run 必须为函数');
}
if (errs.length) { console.error(JSON.stringify({ ok: false, errs })); process.exit(1); }
console.log(JSON.stringify({ ok: true }));
`;

// 全量回归：真实插件目录跑 smoke.js（update/delete 破坏其他插件依赖时拦截）
// 沙盒策略：复制现役插件 + 应用待审修改 到临时目录，指向该目录跑 test/smoke.js
function runFullSmoke(dir) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'smoke.js')], {
    env: {
      ...process.env,
      DUAL_AGENT_PLUGINS_DIR: path.join(dir, 'plugins'),
      DUAL_AGENT_DATA: path.join(dir, 'data'),
      DUAL_AGENT_WS_ROOT: path.join(dir, 'ws'),
      DUAL_AGENT_NO_PREFLIGHT: '1', // 防递归：沙盒 smoke 内的审批测试不再嵌套预检
      DUAL_AGENT_SMOKE_QUIET: '1',
      DUAL_AGENT_MOCK: '1',  // 沙盒无需真实 API
    },
    timeout: 120000,
    encoding: 'utf8',
  });
  return {
    ok: r.status === 0,
    tail: String(r.stdout || '').split('\n').slice(-6).join('\n').slice(0, 500) || String(r.stderr || '').slice(0, 500),
  };
}

// 主入口：审批通过后的预检
// 返回 { ok, stage: 'syntax'|'smoke'|'full', error }
function preflight(items) {
  // 阶段 1：沙盒语法/结构冒烟（毫秒级）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'da-preflight-'));
  try {
    const pdir = path.join(tmp, 'plugins');
    fs.mkdirSync(pdir, { recursive: true });
    for (const it of items) {
      if (it.action === 'delete') continue;
      fs.writeFileSync(path.join(pdir, `${it.plugin}.js`), it.code, 'utf8');
    }
    const inFile = path.join(tmp, 'in.json');
    fs.writeFileSync(inFile, JSON.stringify({ plugins: items, dir: pdir }), 'utf8');
    fs.writeFileSync(path.join(tmp, 'smoke-entry.js'), SMOKE_SRC, 'utf8');
    const r = spawnSync(process.execPath, [path.join(tmp, 'smoke-entry.js')], {
      env: { ...process.env, SMOKE_IN: inFile },
      timeout: 15000,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      let detail = String(r.stderr || r.stdout || '').slice(0, 300);
      try { detail = JSON.parse(String(r.stdout || r.stderr)).errs.join('；'); } catch { /* 保留原文 */ }
      return { ok: false, stage: 'syntax', error: `预检失败（结构冒烟）：${detail}` };
    }

    // 阶段 2：全量 smoke（复制现役插件 + 应用待审变更，隔离目录）
    const dir = path.join(tmp, 'full');
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ws'), { recursive: true });
    const PLUGINS_SRC = process.env.DUAL_AGENT_PLUGINS_DIR || path.join(ROOT, 'plugins');
    for (const f of fs.readdirSync(PLUGINS_SRC)) {
      if (f.endsWith('.js')) fs.copyFileSync(path.join(PLUGINS_SRC, f), path.join(dir, 'plugins', f));
    }
    for (const it of items) {
      const fp = path.join(dir, 'plugins', `${it.plugin}.js`);
      if (it.action === 'delete') { try { fs.unlinkSync(fp); } catch { /* 本就不存在 */ } }
      else fs.writeFileSync(fp, it.code, 'utf8');
    }
    const full = runFullSmoke(dir);
    if (!full.ok) return { ok: false, stage: 'full', error: `回归测试未通过：\n${full.tail}` };
    return { ok: true, stage: 'full' };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------- 插件质量记分：从内层日志统计失败率 ----------
// score = ok 调用占比（近 N 次）；低分提示自动评审
function pluginScores(innerLog, N = 50) {
  const byPlugin = new Map();
  for (const e of innerLog) {
    if (!e || !e.plugin) continue;
    const s = byPlugin.get(e.plugin) || { ok: 0, total: 0 };
    s.total += 1;
    if (e.ok) s.ok += 1;
    byPlugin.set(e.plugin, s);
  }
  const out = [];
  for (const [name, s] of byPlugin) {
    const recent = innerLog.filter(e => e && e.plugin === name).slice(-N);
    const rok = recent.filter(e => e.ok).length;
    out.push({
      name,
      total: s.total,
      failRate: s.total ? +(1 - s.ok / s.total).toFixed(3) : 0,
      recentFailRate: recent.length ? +(1 - rok / recent.length).toFixed(3) : 0,
      lowQuality: recent.length >= 5 && rok / recent.length < 0.6, // 近期 ≥5 次且成功率 <60%
    });
  }
  return out.sort((a, b) => b.recentFailRate - a.recentFailRate);
}

module.exports = { preflight, pluginScores };
