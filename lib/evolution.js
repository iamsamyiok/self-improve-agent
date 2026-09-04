// Self-Improving Agent Loop
// 核心原则：修改 != 改进；只有在可重放 benchmark 上优于 baseline，且没有明显 regression，才允许晋级。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { runOuter, detectOpencode } = require('./outer');
const { lintCode } = require('./lint');
const { callLLMText, parseLooseJson } = require('./intent');
const plugins = require('./plugins');
const approval = require('./approval');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DUAL_AGENT_DATA || path.join(ROOT, '.data');
const EV_ROOT = path.join(DATA_DIR, 'evolution');
const CASES = path.join(EV_ROOT, 'benchmarks');
const EXPS = path.join(EV_ROOT, 'experiments');
const STATE = path.join(EV_ROOT, 'state.json');
const LEADERBOARD = path.join(EV_ROOT, 'leaderboard.json');
const WS_ROOT = process.env.DUAL_AGENT_WS_ROOT || path.join(ROOT, 'workspaces');
const MAX_CASES = Number(process.env.DUAL_AGENT_EVOLUTION_MAX_CASES) || 50;
const MIN_CASES = Number(process.env.DUAL_AGENT_EVOLUTION_MIN_CASES) || 3;
const MIN_DELTA = Number(process.env.DUAL_AGENT_EVOLUTION_MIN_DELTA) || 0.03;
const MIN_WIN_RATE = Number(process.env.DUAL_AGENT_EVOLUTION_MIN_WIN_RATE) || 0.6;
const MAX_REGRESSION = Number(process.env.DUAL_AGENT_EVOLUTION_MAX_REGRESSION) || 0.08;

function ensure() { fs.mkdirSync(CASES, { recursive: true }); fs.mkdirSync(EXPS, { recursive: true }); }
function readJson(fp, fallback) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; } }
// 原子写（短板高3）：tmp + rename 同目录原子替换——写中途崩溃不再留下半截 JSON
// （rename 在同一文件系统上是原子操作）；并发写同一文件时后完成者整体生效，读者
// 永远看到完整 JSON（此前直接覆盖，崩溃窗口内读到半截文件只能靠 .bak 兜底）。
// 注：本模块的读-改-写均为同步体（单线程下天然原子，无 await 穿插窗口），跨进程
// 并发不存在（单实例部署），故不加进程内互斥——此前评估为高估，见短板复核。
function writeJson(fp, v) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}
function nowId(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function ci95(a) { if (a.length < 2) return 0; return 1.96 * sd(a) / Math.sqrt(a.length); }
// bootstrap 置信区间（短板高2）：小样本（3-12 case）下正态近似偏乐观，重采样分位数
// 对偏斜/重尾的 delta 分布更稳健。DUAL_AGENT_EVOLUTION_BOOTSTRAP_B 控制重采样次数（默认 2000）
function bootstrapCI(a) {
  const B = Number(process.env.DUAL_AGENT_EVOLUTION_BOOTSTRAP_B) || 2000;
  if (a.length < 2 || B <= 0) return null;
  const n = a.length;
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[(Math.random() * n) | 0];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  return { low: means[Math.floor(B * 0.025)], high: means[Math.ceil(B * 0.975) - 1] };
}
function clamp(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

// ===== 进化专用 LLM 配置（v3.4）=====
// 病根：进化全链路（Meta-Agent/judge/课程生成）与执行 Agent 共用 config.inner 的同一
// key+model——一轮实验上百次 LLM 调用与用户聊天抢同一账号配额，限流互踩；跑量型评审
// 无法单独换便宜快模型；key 欠费/失效双向拖累。
// 方案：config.json 增加可选 evolution 段（base_url/api_key/model），配置齐全时进化走
// 独立配置；缺省回退 inner 段（向后兼容：老配置零改动可跑）。
function evoConfig() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const e = cfg.evolution || {};
  return (e.base_url && e.api_key && e.model) ? e : (cfg.inner || {});
}
function evoLlmSource() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}) || {};
  const e = cfg.evolution || {};
  return (e.base_url && e.api_key && e.model) ? 'evolution' : 'inner';
}
// 限流特征判定（纯函数，worker error 与 judge 异常共用）：429/限流/quota/过载/5xx
const RATE_LIMIT_RE = /429|rate.?limit|限流|配额|quota|too many requests|overloaded|50[23]/i;
function isRateLimitText(t) { return RATE_LIMIT_RE.test(String(t || '')); }

// ===== 效果评估系统（v3.4）：任务级信号采集 + 健康分聚合 + 退化触发 =====
// 闭环：生产任务结束 → recordTaskOutcome 落 eval-events.jsonl → healthScore 聚合成
// 0-100 健康分（status/抽屉展示「系统效果」）→ healthDropping 检测退化 → 跳过攒批
// 门槛立即触发靶向实验。效果归因到 version + activeMutation（对照实验前后）。
const EVAL_EVENTS = path.join(EV_ROOT, 'eval-events.jsonl');
const EVAL_EVENTS_MAX = 2000; // 容量上限：只留最近 N 条（滑动窗口语义，超限截断旧数据）
function recordTaskOutcome(rec) {
  try {
    const state = readJson(STATE, {});
    const row = { ts: Date.now(),
      version: Number(state.version) || 0,
      mutationId: state.activeMutation ? (state.activeMutation.id || state.activeMutation.type || 'active') : null,
      success: !!rec.success, repairs: Number(rec.repairs) || 0, hard: !!rec.hard,
      aborted: !!rec.aborted, undone: !!rec.undone,
      durationMs: Number(rec.durationMs) || 0,
      task: String(rec.task || '').slice(0, 200) };
    fs.appendFileSync(EVAL_EVENTS, JSON.stringify(row) + '\n');
    let lines = fs.readFileSync(EVAL_EVENTS, 'utf8').split('\n').filter(Boolean);
    if (lines.length > EVAL_EVENTS_MAX) fs.writeFileSync(EVAL_EVENTS, lines.slice(-EVAL_EVENTS_MAX).join('\n') + '\n');
  } catch { /* 评估采集失败不影响任务交付 */ }
}
function parseEvalEvents() {
  let lines = []; try { lines = fs.readFileSync(EVAL_EVENTS, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
// 单窗口打分：一次通过 70 分 + 返修后通过 18 分 + 无用户中断 12 分 = 0-100
function evalWindowScore(rows) {
  const n = rows.length;
  if (!n) return null;
  const firstPass = rows.filter(r => r.success && !r.repairs).length / n;
  const fixed = rows.filter(r => r.success && r.repairs > 0).length / n;
  const aborted = rows.filter(r => r.aborted).length / n;
  const undone = rows.filter(r => r.undone).length / n;
  const failed = rows.filter(r => !r.success && !r.aborted && !r.undone).length / n;
  const avgRepairs = rows.reduce((s, r) => s + (r.repairs || 0), 0) / n;
  const score = Math.round(100 * (0.70 * firstPass + 0.18 * fixed + 0.12 * Math.max(0, 1 - aborted - undone)));
  return { n, score, firstPass, fixed, failed, aborted, undone, avgRepairs: Math.round(avgRepairs * 100) / 100 };
}
// 健康分：最近 windowN 条生产任务的效果快照（status()/进化抽屉「系统健康分」数据源）
function healthScore(windowN) {
  const w = Number(windowN) || 50;
  const rows = parseEvalEvents();
  if (!rows.length) return null;
  return evalWindowScore(rows.slice(-w));
}
// 版本对比：按 version 切片，最近两个有数据的版本各打分——进化有效果吗就看这里
function healthTrend() {
  const rows = parseEvalEvents();
  const byVer = new Map();
  for (const r of rows) { if (!byVer.has(r.version)) byVer.set(r.version, []); byVer.get(r.version).push(r); }
  const vers = Array.from(byVer.keys()).sort((a, b) => a - b).slice(-2);
  return vers.map(v => ({ version: v, ...(evalWindowScore(byVer.get(v)) || {}) }));
}
// 经验资产计数（成长指标）：版本号要实验晋级才变，这些随每次任务持续增长——
// 「系统在越来越好」的快速表征：教训/套路/基因/技能/样本池
function assetCounts() {
  const countLines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const genes = readJson(GENES_PATH, { genes: [] });
  const geneList = Array.isArray(genes.genes) ? genes.genes : [];
  let skills = 0;
  try { skills = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => { try { return fs.statSync(path.join(ROOT, 'skills', n)).isDirectory(); } catch { return false; } }).length; } catch { /* 无技能目录 */ }
  return {
    lessons: countLines(LESSONS),
    playbooks: countLines(PLAYBOOKS),
    genes: geneList.length,
    enabledGenes: geneList.filter(g => g.enabled).length,
    skills,
    benchmarks: listBenchmarks().length
  };
}
// 资产明细（点击「经验资产」格展开）：四类资产各取最新条目，供前端展示具体内容
function listAssets(limit) {
  const n = Number(limit) || 8;
  const readLines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const lessons = readLines(LESSONS).slice(-n).reverse().map(l => { try { const j = JSON.parse(l); return { id: j.id, task: String(j.task || '').slice(0, 80), lesson: String(j.lesson || '').slice(0, 160), createdAt: j.createdAt || '' }; } catch { return null; } }).filter(Boolean);
  const playbooks = readLines(PLAYBOOKS).slice(-n).reverse().map(l => { try { const j = JSON.parse(l); return { id: j.id, task: String(j.task || '').slice(0, 80), steps: String(j.steps || '').split(',').filter(Boolean).length, createdAt: j.createdAt || j.ts || '' }; } catch { return null; } }).filter(Boolean);
  const geneList = (readJson(GENES_PATH, { genes: [] }).genes || []).slice(0, n).map(g => ({ id: g.id, text: String(g.text || '').slice(0, 160), enabled: !!g.enabled, stats: g.stats || { trials: 0, wins: 0, losses: 0 } }));
  let skills = [];
  try { skills = fs.readdirSync(path.join(ROOT, 'skills')).filter(name => { try { return fs.statSync(path.join(ROOT, 'skills', name)).isDirectory(); } catch { return false; } }).slice(0, n); } catch { /* 无技能目录 */ }
  return { lessons, playbooks, genes: geneList, skills };
}

// ===== 垃圾文件自动清理（v3.4.1）=====
// 「垃圾」= 实验执行痕迹（cases/ 每 case 的双工作区+双 data 快照，单实验可达数百 MB；
// exp-*/run/ 课程生成的临时沙箱）。完结实验的结论已在 decision.json/holdout-decision.json，
// 历史视图有 experience.jsonl 兜底——执行痕迹过期即垃圾。
// 「有用资产」永不清：state/genes/lessons/playbooks/benchmarks/experience/gaps/
// decision/proposal/eval-events/watchdog-log/llm-usage 等结论与知识文件。
const CLEANUP_DAYS = Math.max(7, Number(process.env.DUAL_AGENT_EVOLUTION_CLEANUP_DAYS) || 30);
function cleanupStale(days) {
  const maxAge = (Number(days) || CLEANUP_DAYS) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const isStale = p => { try { return now - fs.statSync(p).mtimeMs > maxAge; } catch { return false; } };
  const removed = [];
  let dirs = []; try { dirs = fs.readdirSync(EXPS).filter(d => d.startsWith('exp-') || d.startsWith('pool-')); } catch { return removed; }
  for (const name of dirs) {
    const dir = path.join(EXPS, name);
    try {
      const done = fs.existsSync(path.join(dir, 'decision.json')); // 完结实验：结论已落盘
      if (name.startsWith('pool-')) { // 课程生成临时沙箱：pool 目录整体为执行痕迹
        if (isStale(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(name + '/'); }
        continue;
      }
      if (done) {
        const casesDir = path.join(dir, 'cases');
        if (fs.existsSync(casesDir) && isStale(casesDir)) { fs.rmSync(casesDir, { recursive: true, force: true }); removed.push(name + '/cases'); }
      } else if (isStale(dir)) {
        // 未完结且远超断点续跑窗口（24h ≪ 30 天）：整个实验作废清理
        fs.rmSync(dir, { recursive: true, force: true }); removed.push(name);
      }
    } catch (e) { console.error('[evolution-cleanup]', name, (e && e.message) || e); }
  }
  if (removed.length) {
    try { fs.appendFileSync(path.join(EV_ROOT, 'cleanup-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), days: days || CLEANUP_DAYS, removed }) + '\n'); } catch { /* 日志失败不影响 */ }
    console.log('[evolution-cleanup] 清理过期实验痕迹', removed.length, '处（>' + (days || CLEANUP_DAYS) + ' 天）');
  }
  return removed;
}
// 退化触发判定（闭环触发线 A）：相邻两个半窗（各 25 条）健康分跌幅 ≥ 阈值视为退化，
// 调用方据此跳过攒批门槛立即触发靶向实验
function healthDropping() {
  const half = Number(process.env.DUAL_AGENT_EVOLUTION_HEALTH_HALF) || 25;
  const rows = parseEvalEvents();
  if (rows.length < half * 2) return false;
  const recent = evalWindowScore(rows.slice(-half));
  const before = evalWindowScore(rows.slice(-half * 2, -half));
  if (!recent || !before) return false;
  return (before.score - recent.score) >= (Number(process.env.DUAL_AGENT_EVOLUTION_HEALTH_DROP) || 10);
}


function currentSignature() {
  const names = plugins.listPlugins().map(p => p.name).sort();
  const files = names.map(n => `${n}\n${plugins.readCode(n) || ''}`).join('\n---\n');
  const promptPatch = process.env.DUAL_AGENT_SYSTEM_PATCH || '';
  const strategy = readJson(path.join(EV_ROOT, 'strategy.json'), {});
  const genes = process.env.DUAL_AGENT_EVOLUTION_GENES || JSON.stringify(readJson(GENES_PATH, { genes: [] }));
  return sha(files + '\nPATCH\n' + promptPatch + '\nSTRATEGY\n' + JSON.stringify(strategy) + '\nGENES\n' + genes);
}

function listBenchmarks() {
  ensure();
  return fs.readdirSync(CASES).filter(n => n.endsWith('.json')).map(n => readJson(path.join(CASES, n), null)).filter(x => x && x.id && x.task)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, MAX_CASES);
}

// 难例排序：触发过返修（repairs>0）或带缺口标注的任务区分度最高——
// baseline 在这些任务上暴露过真实短板，A/B 才有提升空间（8 轮实验 delta 挤在 ±2% 的
// 根因就是等量选入接近满分的简单任务，天花板效应压扁了所有 mutation 的表现）。
function rankHardFirst(cases, usage) {
  // hard 轮换（2026-09-04 优化 9）：24h 内已被实验用过的 hard 降入次段，
  // 让新鲜 hard 优先入选——防每轮实验反复重放同一小撮难例而过拟合。
  // 语义重复 case（duplicateOf，M3-1）与已用同级降次：换说法的同一道题不再挤占选样名额。
  const now = Date.now();
  const isFresh = c => { const t = usage && usage[c.id]; return !(t && now - Number(t) < 24 * 3600 * 1000); };
  const hardFresh = [], hardUsed = [], rest = [];
  for (const c of cases) {
    const h = (c.repairs > 0 || c.hard) ? 1 : 0;
    if (c.duplicateOf) { (h ? hardUsed : rest).push(c); continue; }
    if (h && isFresh(c)) hardFresh.push(c);
    else if (h) hardUsed.push(c);
    else rest.push(c);
  }
  const byTime = arr => arr.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return [...byTime(hardFresh), ...byTime(hardUsed), ...byTime(rest)];
}

// 序列统计早期停止（改进 3）：delta ∈ [-1,1]，"剩余 case 全部 +1"是均值的数学上限。
// 当该上限仍追不到 MIN_DELTA 时结论必然 rejected，立即终止省下后续真实 API 开销。
// 只做负向早停（只可能省成本，不会误杀可能通过的实验）；MIN_CASES 前证据不足不判。
function checkEarlyStop(results, totalCases) {
  if (results.length < MIN_CASES || results.length >= totalCases) return null;
  const m = mean(results.map(r => r.evaluation.delta));
  const rest = totalCases - results.length;
  const bestPossible = (m * results.length + rest * 1) / totalCases;
  if (bestPossible >= MIN_DELTA) return null;
  return { at: results.length, of: totalCases, meanDeltaNow: m, reason: `剩余 ${rest} 个 case 全部满分也无法达到 MIN_DELTA=${MIN_DELTA}，提前终止` };
}

// 缺口经验池：交付核验未一次通过的任务连同缺口原文一起沉淀，
// 供 Meta-Agent 提议时把"显式知识缺口"提炼成 skill mutation（技能是可审查的语义知识，
// 信息量远大于 memoryTopK 这类参数微调）。
function recordGap(entry) {
  ensure();
  const fp = path.join(EV_ROOT, 'gaps.jsonl');
  let lines = []; try { lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).slice(-199); } catch {}
  lines.push(JSON.stringify(entry));
  try { fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8'); } catch {}
}

function listGaps(limit = 6) {
  let lines = []; try { lines = fs.readFileSync(path.join(EV_ROOT, 'gaps.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
  return lines.slice(-limit).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
}

// ---------- 教训卡（缺口经验运行时化）----------
// gaps.jsonl 只喂 Meta-Agent 提议上下文，经验要等 A/B 晋级才生效，周期太长。
// 教训卡把核验 FAIL 的缺口即时转成可检索知识，任务开始时按相似度注入内层提示——
// 与 A/B 通道并行、零门槛生效。dataDir 隔离保证实验沙箱内为空集，不影响 A/B 归因。
const LESSONS = path.join(EV_ROOT, 'lessons.jsonl');
const GENES_PATH = path.join(EV_ROOT, 'genes.json');
const PLAYBOOKS = path.join(EV_ROOT, 'playbooks.jsonl');
const SKILLS_SHARED = () => process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT, 'skills');

// 经验检索层注入槽：server 启动时注入 ExperienceStore（zvec/FTS 或 file 降级实现，
// 见 lib/experience.js）。未注入（进化 worker 沙箱、移动端、旧路径）时一切走内置
// bigram 扫描——zvec 只在注入侧存在，本文件对它零依赖，移动端打包安全。
let EXPERIENCE_STORE = null;
let SEMANTIC_RECALL_COUNT = 0;
function setExperienceStore(store) { EXPERIENCE_STORE = store || null; }

function recordLessons(entry) {
  ensure();
  const gaps = (Array.isArray(entry.gaps) ? entry.gaps : []).map(g => String(g).trim()).filter(Boolean).slice(0, 6);
  const task = String(entry.task || '').trim();
  if (!gaps.length || !task) return null;
  let existing = []; try { existing = fs.readFileSync(LESSONS, 'utf8').split('\n').filter(Boolean); } catch {}
  // 同一任务同一缺口只记一次（防反复返修刷屏教训库）
  const key = sha(task.slice(0, 500) + '|' + gaps.join('|'));
  if (existing.some(l => { try { return JSON.parse(l).key === key; } catch { return false; } })) return null;
  const lesson = {
    id: nowId('ls'), key,
    task: task.slice(0, 600),
    lesson: gaps.map(g => g.slice(0, 200)).join('；').slice(0, 600),
    createdAt: new Date().toISOString()
  };
  try { fs.writeFileSync(LESSONS, existing.concat(JSON.stringify(lesson)).slice(-199).join('\n') + '\n', 'utf8'); } catch {}
  if (EXPERIENCE_STORE) { try { EXPERIENCE_STORE.indexLesson(lesson); } catch { /* 索引失败不影响经验落盘 */ } }
  return lesson;
}

function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function listRelevantLessons(taskText, k = 3) {
  let lines = []; try { lines = fs.readFileSync(LESSONS, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const q = bigrams(taskText);
  if (!q.size) return [];
  return lines.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean)
    .map(l => {
      const b = bigrams(l.task);
      let inter = 0; for (const g of b) if (q.has(g)) inter++;
      const uni = b.size + q.size;
      return { lesson: l, sim: uni ? inter / uni : 0 };
    })
    .filter(x => x.sim >= 0.08)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, Math.max(1, k))
    .map(x => x.lesson);
}

// 教训/套路检索缓存（P2-6）：相同任务文本（重试路径、同任务多轮注入）30s 内复用检索结果，
// 避免每次全量读 jsonl 扫描（FileStore bigram 慢路径）；TTL 短保证新教训快速可见
const _secCache = new Map(); // key -> { ts, section }
function cachedSection(key, compute) {
  const hit = _secCache.get(key);
  if (hit && Date.now() - hit.ts < 30000) return hit.section;
  const section = compute();
  _secCache.set(key, { ts: Date.now(), section });
  if (_secCache.size > 20) _secCache.delete(_secCache.keys().next().value);
  return section;
}

function lessonsPromptSection(taskText, k = 3) {
  return cachedSection(`ls:${taskText}:${k}`, () => {
    let ls = null;
    if (EXPERIENCE_STORE) {
      try { ls = EXPERIENCE_STORE.searchLessons(taskText, k); } catch { ls = null; }
    }
    if (!ls) ls = listRelevantLessons(taskText, k); // 未注入或检索失败 → 内置 bigram 扫描
    if (!ls.length) return '';
    return '\n\n[框架预取·相关教训] 以下是历史任务因同类失误被交付核验打回的教训记录，相似任务必须直接规避、禁止重蹈：\n' +
      ls.map((l, i) => `${i + 1}. 历史任务「${String(l.task).slice(0, 80)}」的教训：${l.lesson}`).join('\n');
  });
}

// ---------- Prompt 基因库 ----------
// 每条基因是一段可独立启停、可归因的系统提示片段（进化最小单元）。
// 相比整段 system-patch（不可组合、不可归因），基因让 mutation 从"改千行源码/整段提示"
// 降为"增/改/停一条 ≤400 字的指令"，A/B 可解释性与晋级率显著更高。
const GENE_MAX_ENABLED = 8;
const GENE_MAX_TEXT = 400;

// 读取生效基因集：worker 沙箱注入（DUAL_AGENT_EVOLUTION_GENES，candidate/baseline 对等注入）优先，
// 生产与 data 快照回退到 genes.json 文件。
function readGenesSource() {
  const envRaw = process.env.DUAL_AGENT_EVOLUTION_GENES;
  if (envRaw) { try { const j = JSON.parse(envRaw); if (Array.isArray(j)) return j; } catch { /* 非法注入按无基因 */ } }
  const j = readJson(GENES_PATH, { genes: [] });
  return Array.isArray(j && j.genes) ? j.genes : [];
}

function listGenes() { return readGenesSource(); }

function enabledGenes() { return readGenesSource().filter(g => g && g.enabled !== false && String(g.text || '').trim()); }

function genesPromptSection() {
  const genes = enabledGenes();
  if (!genes.length) return '';
  const lines = genes.slice(0, GENE_MAX_ENABLED)
    .map((g, i) => `${i + 1}. ${String(g.text).trim().slice(0, GENE_MAX_TEXT)}`);
  return '\n\n[进化基因·执行增强] 以下是经 A/B 实验验证有效的执行增强指令，与本任务直接相关时必须遵守：\n' + lines.join('\n');
}

// 进化自身 LLM 开销记账（2026-09-04 优化 7）：judge/课程生成/Meta-Agent 的 usage 落盘，
// 让每轮实验的 token 成本可审计（内层 worker 的用量已有 usage 插件体系，此处补齐框架侧）
function recordLlmUsage(label, usage) {
  try {
    const rec = { ts: new Date().toISOString(), label: String(label || '').slice(0, 60), prompt: Number(usage && usage.prompt_tokens) || 0, completion: Number(usage && usage.completion_tokens) || 0, total: Number(usage && usage.total_tokens) || 0 };
    let lines = []; try { lines = fs.readFileSync(path.join(EV_ROOT, 'llm-usage.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
    fs.writeFileSync(path.join(EV_ROOT, 'llm-usage.jsonl'), lines.concat(JSON.stringify(rec)).slice(-499).join('\n') + '\n', 'utf8');
  } catch { /* 计量失败不影响主流程 */ }
}

// 基因库最小操作（纯函数）：add/modify/enable/disable/remove。
// 安慰剂防线：非法 op/重复文本/未知 id 直接拒绝（makeCandidate 阶段拦截，省整轮 A/B 开销）。
function applyGeneOp(baseGenes, op) {
  const genes = (Array.isArray(baseGenes) ? baseGenes : []).map(g => ({
    id: String(g.id || ''), text: String(g.text || ''), category: String(g.category || ''),
    enabled: g.enabled !== false, origin: String(g.origin || ''), createdAt: String(g.createdAt || ''),
    ...(g.stats ? { stats: g.stats } : {})
  }));
  const action = String(op && op.action || '');
  const text = String(op && op.text || '').trim();
  const id = String(op && op.id || '');
  if (!['add', 'modify', 'enable', 'disable', 'remove'].includes(action)) return { error: `非法基因操作 action：${action || '（空）'}（仅允许 add/modify/enable/disable/remove）` };
  if (action === 'add') {
    if (!text) return { error: 'add 操作必须提供非空 text' };
    if (text.length > GENE_MAX_TEXT) return { error: `基因文本过长（${text.length} > ${GENE_MAX_TEXT} 字符），必须保持最小可归因` };
    const dup = genes.find(g => g.text.trim() === text);
    if (dup) return { error: `基因库已存在相同文本（id=${dup.id}），禁止重复添加` };
    const enabledCount = genes.filter(g => g.enabled).length;
    if (enabledCount >= GENE_MAX_ENABLED) return { error: `启用基因已达上限（${GENE_MAX_ENABLED}），先 disable 低价值基因再 add` };
    genes.push({ id: 'g-' + sha(text).slice(0, 10), text, category: String(op && op.category || 'general'), enabled: true, origin: String(op && op.origin || 'evolution'), createdAt: new Date().toISOString() });
    return { genes };
  }
  const target = genes.find(g => g.id === id);
  if (!target) return { error: `未找到 id=${id || '（空）'} 的基因` };
  if (action === 'modify') {
    if (!text) return { error: 'modify 操作必须提供非空 text' };
    if (text.length > GENE_MAX_TEXT) return { error: `基因文本过长（${text.length} > ${GENE_MAX_TEXT} 字符）` };
    if (genes.some(g => g.id !== id && g.text.trim() === text)) return { error: '其他基因已存在相同文本' };
    target.text = text;
  } else if (action === 'enable') {
    if (target.enabled) return { error: `基因 ${id} 已处于启用状态（安慰剂操作）` };
    target.enabled = true;
  } else if (action === 'disable') {
    if (!target.enabled) return { error: `基因 ${id} 已处于停用状态（安慰剂操作）` };
    target.enabled = false;
  } else if (action === 'remove') {
    genes.splice(genes.indexOf(target), 1);
  }
  return { genes };
}

// ---------- 失败驱动 mutation ----------
// 从缺口池与教训池聚类出近期高频失败模式，作为 mutation 提议的靶向输入，
// 让 Meta-Agent 从"盲目找改进点"变为"修复已证实的短板"。
function analyzeFailureModes(n = 3) {
  const entries = [];
  try {
    const raw = fs.readFileSync(path.join(EV_ROOT, 'gaps.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-60);
    for (const line of raw) { try { const g = JSON.parse(line); if (g && g.task) entries.push({ text: String(g.task).slice(0, 400), gaps: (g.gaps || []).map(x => String(x).slice(0, 120)) }); } catch {} }
  } catch {}
  try {
    const raw = fs.readFileSync(LESSONS, 'utf8').split('\n').filter(Boolean).slice(-60);
    for (const line of raw) { try { const l = JSON.parse(line); if (l && l.task) entries.push({ text: String(l.task).slice(0, 400), gaps: String(l.lesson || '').split('；').map(x => x.slice(0, 120)) }); } catch {} }
  } catch {}
  // 跨源去重：hard 任务会同时写入 gaps 与 lessons，同一失败被计 2 次会让 Top 模式排序失真
  const seen = new Set();
  const deduped = entries.filter(e => {
    const k = e.text.slice(0, 100);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // 贪心聚类：与已有组代表相似度 ≥0.18 归同组，否则自立新组
  const clusters = [];
  for (const e of deduped) {
    const gapText = (e.gaps.filter(Boolean)[0] || '').slice(0, 120);
    const sig = bigrams(gapText || e.text);
    let hit = null;
    for (const c of clusters) {
      const rep = bigrams(c.representative);
      let inter = 0; for (const g of sig) if (rep.has(g)) inter++;
      const uni = rep.size + sig.size;
      if (uni && inter / uni >= 0.18) { hit = c; break; }
    }
    if (hit) { hit.count++; if (hit.samples.length < 3) hit.samples.push(e.text.slice(0, 60)); }
    else clusters.push({ representative: gapText || e.text.slice(0, 120), count: 1, samples: [e.text.slice(0, 60)] });
  }
  return clusters.sort((a, b) => b.count - a.count).slice(0, Math.max(1, Math.min(5, Number(n) || 3)));
}

// ---------- 成功套路库 ----------
// 把"一次通过交付核验"的成功任务的工具调用序列沉淀为 playbook，
// 相似新任务开始前注入序列参考，减少探索性试错。
function recordPlaybook(task, toolTrace) {
  const steps = (Array.isArray(toolTrace) ? toolTrace : []).slice(0, 40).map(s => ({ plugin: String(s && s.plugin || ''), ok: !!(s && s.ok) }));
  const t = String(task || '').trim().slice(0, 500);
  if (!t || steps.length < 3) return null;
  const okRate = steps.filter(s => s.ok).length / steps.length;
  if (okRate < 0.8) return null;
  let lines = []; try { lines = fs.readFileSync(PLAYBOOKS, 'utf8').split('\n').filter(Boolean); } catch {}
  const digest = steps.map(s => s.plugin + (s.ok ? '+' : '-')).join(',');
  // 同一任务同一序列只记一次
  const key = sha(t + '|' + digest);
  if (lines.some(l => { try { return JSON.parse(l).key === key; } catch { return false; } })) return null;
  const rec = { id: nowId('pb'), key, task: t, steps: digest, plugins: [...new Set(steps.map(s => s.plugin))], ts: new Date().toISOString() };
  try { fs.writeFileSync(PLAYBOOKS, lines.concat(JSON.stringify(rec)).slice(-199).join('\n') + '\n', 'utf8'); } catch {}
  if (EXPERIENCE_STORE) { try { EXPERIENCE_STORE.indexPlaybook(rec); } catch { /* 索引失败不影响经验落盘 */ } }
  return rec;
}

function listRelevantPlaybooks(taskText, k = 2) {
  let lines = []; try { lines = fs.readFileSync(PLAYBOOKS, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const q = bigrams(taskText);
  if (!q.size) return [];
  return lines.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean)
    .map(p => {
      const b = bigrams(p.task);
      let inter = 0; for (const g of b) if (q.has(g)) inter++;
      const uni = b.size + q.size;
      return { p, sim: uni ? inter / uni : 0 };
    })
    .filter(x => x.sim >= 0.12)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, Math.max(1, k))
    .map(x => x.p);
}

function playbooksPromptSection(taskText, k = 2) {
  return cachedSection(`pb:${taskText}:${k}`, () => {
    let ps = null;
    if (EXPERIENCE_STORE) {
      try { ps = EXPERIENCE_STORE.searchPlaybooks(taskText, k); } catch { ps = null; }
    }
    if (!ps) ps = listRelevantPlaybooks(taskText, k); // 未注入或检索失败 → 内置 bigram 扫描
    if (!ps.length) return '';
    return '\n\n[框架预取·成功套路] 以下是历史相似任务一次通过交付核验的工具调用序列，可作为执行顺序参考（禁止向用户复述本段）：\n' +
      ps.map((p, i) => `${i + 1}. 「${String(p.task).slice(0, 60)}」：${p.steps}`).join('\n');
  });
}

// ---------- 客观断言评估器 ----------
// benchmark 的 objective 数组是可程序化判定的验收断言；断言优先、LLM judge 兜底，
// 把评估信噪比从"LLM 主观印象"拉向"文件系统事实"。
function parseAcceptanceObjective(acceptance) {
  const out = [];
  for (const raw of (Array.isArray(acceptance) ? acceptance : []).slice(0, 8)) {
    const s = String(raw || '').trim();
    if (!s) continue;
    let m = s.match(/^(.{1,120}?)\s*(文件|file)?\s*(存在|已存在|exists)$/i);
    if (m) { out.push({ check: 'file_exists', path: m[1].trim() }); continue; }
    m = s.match(/包含|含有|出现|包括/);
    if (m) {
      const vm = s.match(/["'「『]([^"'」』]{1,200})["'」』]/) || s.match(/(?:包含|含有|出现|包括)[：:]?\s*(.{1,200})$/);
      if (vm) {
        const pathM = s.match(/[\w./\\-]+\.[a-zA-Z0-9]{1,8}/);
        out.push({ check: 'content_contains', path: pathM ? pathM[0] : '*', value: vm[1].trim() });
        continue;
      }
    }    m = s.match(/第\s*(\d+)\s*行为\s*(.{1,200})$/);
    if (m) { const pathM = s.match(/[\w./\\-]+\.[a-zA-Z0-9]{1,8}/); if (pathM) { out.push({ check: 'content_contains', path: pathM[0], value: m[2].trim() }); continue; } }
    m = s.match(/不少于\s*(\d+)\s*行|至少\s*(\d+)\s*行/);
    if (m) { const pathM = s.match(/[\w./\\-]+\.[a-zA-Z0-9]{1,8}/); if (pathM) { out.push({ check: 'line_count_gte', path: pathM[0], value: Number(m[1] || m[2]) }); continue; } }
    // 解析不出的开放条款跳过，交给 LLM judge 兜底
  }
  return out;
}

function evaluateObjectives(wsDir, objective) {
  // path='*' 表示验收条款未指明文件：在工作区全部产物中找任意满足条件的文件
  function wsFiles(dir, rel, out) {
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const fp = path.join(dir, e.name), rp = path.join(rel, e.name);
      if (e.isDirectory()) wsFiles(fp, rp, out);
      else if (e.isFile() && e.name !== 'process.md' && e.name !== 'hwj-messages.json') out.push({ fp, rp: rp.replace(/\\/g, '/') });
    }
  }
  function matchFile(fp, o) {
    const content = fs.readFileSync(fp, 'utf8');
    if (o.check === 'content_contains') return content.includes(String(o.value));
    if (o.check === 'content_regex') return new RegExp(String(o.value)).test(content);
    if (o.check === 'line_count_gte') return content.split('\n').filter(l => l.trim()).length >= Number(o.value);
    if (o.check === 'line_count_eq') return content.split('\n').filter(l => l.trim()).length === Number(o.value);
    if (o.check === 'json_valid') { JSON.parse(content); return true; }
    return false;
  }
  const details = [];
  let passed = 0;
  for (const o of (Array.isArray(objective) ? objective : []).slice(0, 12)) {
    let ok = false;
    const rel = String(o.path || '*');
    try {
      if (o.check === 'file_exists') ok = rel !== '*' && fs.existsSync(path.join(wsDir, rel)) && fs.statSync(path.join(wsDir, rel)).isFile();
      else if (rel === '*') {
        const files = []; wsFiles(wsDir, '', files);
        for (const f of files) { if (matchFile(f.fp, o)) { ok = true; break; } }
      } else {
        const fp = path.join(wsDir, rel);
        if (fs.existsSync(fp)) ok = matchFile(fp, o);
      }
    } catch { ok = false; }
    if (ok) passed++;
    details.push({ check: o.check, path: rel, ok });
  }
  const total = details.length;
  return { score: total ? passed / total : 1, passed, total, details };
}

// ---------- 教训卡升格技能 ----------
// 同类教训反复命中（聚类组内 ≥2 条）时，把散落的教训卡合并为一条显式技能
// （skills/auto-evolved/ 下，Agent Skills 标准格式），让规避知识从"检索式预警"
// 升级为"清单式方法论"。promoted 记录保证幂等：已升格的教训不重复生成。
function promoteLessonsToSkill(opts = {}) {
  const threshold = Number(opts.threshold) || 2;
  const simThreshold = Number(opts.simThreshold) || 0.22;
  let lines = []; try { lines = fs.readFileSync(LESSONS, 'utf8').split('\n').filter(Boolean); } catch { return { promoted: 0 } }
  const lessons = lines.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
  if (!lessons.length) return { promoted: 0 };
  const promotedLog = readJson(path.join(EV_ROOT, 'lessons-promoted.json'), []);
  const doneKeys = new Set(promotedLog.flatMap(p => p.lessonKeys || []));
  // 贪心聚类（按教训文本）
  const clusters = [];
  for (const l of lessons) {
    if (doneKeys.has(l.key)) continue;
    const sig = bigrams(l.lesson || l.task);
    let hit = null;
    for (const c of clusters) {
      const rep = bigrams(c.representative);
      let inter = 0; for (const g of sig) if (rep.has(g)) inter++;
      const uni = rep.size + sig.size;
      if (uni && inter / uni >= simThreshold) { hit = c; break; }
    }
    if (hit) { hit.items.push(l); if (hit.items.length === threshold) hit.representative = l.lesson || l.task; }
    else clusters.push({ representative: l.lesson || l.task, items: [l] });
  }
  const ready = clusters.filter(c => c.items.length >= threshold);
  if (!ready.length) return { promoted: 0 };
  const skillRoot = SKILLS_SHARED();
  const outDir = path.join(skillRoot, 'auto-evolved');
  fs.mkdirSync(outDir, { recursive: true });
  let promoted = 0;
  for (const c of ready) {
    const keys = c.items.map(l => l.key);
    const hash = sha(keys.join('|')).slice(0, 8);
    const name = `lesson-fix-${hash}`;
    const fp = path.join(outDir, `${name}.md`);
    if (fs.existsSync(fp)) { promotedLog.push({ skill: `auto-evolved/${name}.md`, lessonKeys: keys, createdAt: new Date().toISOString() }); continue; }
    const lessonsText = c.items.map((l, i) => `${i + 1}. 场景「${String(l.task).slice(0, 60)}」：${l.lesson}`).join('\n');
    const content = [
      '---',
      `name: ${name}`,
      'description: 由历史任务交付核验教训自动沉淀的规避方法论（同类任务必须先按本技能步骤自查）',
      '---',
      '',
      '# 自动沉淀教训技能',
      '',
      '以下教训来自多个相似任务被交付核验打回的真实记录。执行相似任务前逐条对照规避：',
      '',
      lessonsText,
      '',
      '## 执行要求',
      '',
      '- 任务开始前先对照上述教训检查本次方案是否踩同一类坑',
      '- 涉及产出文件时，交付前用 verify 插件对教训涉及的特征（存在性/内容/行数）显式断言',
      '- 若教训与本次任务明显无关，跳过即可，禁止生搬硬套'
    ].join('\n');
    fs.writeFileSync(fp, content, 'utf8');
    promotedLog.push({ skill: `auto-evolved/${name}.md`, lessonKeys: keys, createdAt: new Date().toISOString() });
    approval.audit('lessons-promoted-to-skill', { skill: `auto-evolved/${name}.md`, lessons: c.items.length });
    promoted++;
  }
  writeJson(path.join(EV_ROOT, 'lessons-promoted.json'), promotedLog.slice(-100));
  return { promoted, skills: ready.length };
}



// 每个成功任务都可以成为可重放 benchmark；不要求用户额外写测试。
// benchmark 的“真值”不是 baseline 文本，而是 task + acceptance + 可观测产出。
function recordBenchmark(input) {
  ensure();
  const task = String(input.task || '').trim();
  if (!task) return null;
  const id = nowId('b');
  const intent = input.intent || null;
  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  // 语义判重（zvec 融合，改进 M3-1）：与池内既有 case 高相似 → 标记 duplicateOf，
  // "换了说法的同一道题"不再虚增 case 池；选样时与已用 hard 同级降次。
  // store 不可用/未注入时回退 bigram 相似度扫描（阈值同源，行为可预期）。
  let duplicateOf = null;
  const DUP_THRESHOLD = 0.62;
  if (EXPERIENCE_STORE && EXPERIENCE_STORE.findSimilarBenchmarks) {
    const sims = EXPERIENCE_STORE.findSimilarBenchmarks(task, 2);
    if (Array.isArray(sims) && sims.length) {
      const q = bigrams(task);
      let best = 0, bestId = null;
      for (const s of sims) {
        if (!s || s.id === id) continue;
        const b = bigrams(s.task);
        const inter = [...q].filter(g => b.has(g)).length;
        const uni = q.size + b.size - inter;
        const sim = uni ? inter / uni : 0;
        if (sim > best) { best = sim; bestId = s.id; }
      }
      if (best >= DUP_THRESHOLD) duplicateOf = bestId;
    }
  } else {
    let best = 0, bestId = null;
    const q = bigrams(task);
    let cases = []; try { cases = fs.readdirSync(CASES).filter(f => f.endsWith('.json')); } catch {}
    for (const f of cases) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8'));
        if (!c || !c.task) continue;
        const b = bigrams(c.task);
        const inter = [...q].filter(g => b.has(g)).length;
        const uni = q.size + b.size - inter;
        const sim = uni ? inter / uni : 0;
        if (sim > best) { best = sim; bestId = c.id; }
      } catch {}
    }
    if (best >= DUP_THRESHOLD) duplicateOf = bestId;
  }
  const rec = {
    id, task: task.slice(0, 12000),
    acceptance: Array.isArray(intent && intent.acceptance) ? intent.acceptance.slice(0, 8) : [],
    deliverables: Array.isArray(intent && intent.deliverables) ? intent.deliverables.slice(0, 8) : [],
    objective: Array.isArray(input.objective) && input.objective.length ? input.objective.slice(0, 8) : parseAcceptanceObjective(Array.isArray(intent && intent.acceptance) ? intent.acceptance : []),
    baseline: {
      finalText: String(input.finalText || '').slice(0, 8000),
      artifacts,
      signature: currentSignature()
    },
    createdAt: new Date().toISOString(),
    sourceWorkspace: String(input.ws || 'default')
  };
  if (duplicateOf) rec.duplicateOf = duplicateOf;
  // 难例标注：交付核验触发过返修或最终仍带缺口的任务标记为 hard，
  // 是进化选样时优先重放的对象（改进 2：难例驱动任务池）。
  const repairs = Number(input.repairs) || 0;
  const lastGaps = Array.isArray(input.lastGaps) ? input.lastGaps.map(g => String(g).slice(0, 300)).slice(0, 8) : [];
  if (repairs > 0 || lastGaps.length) {
    rec.hard = true; rec.repairs = repairs; rec.lastGaps = lastGaps;
  }
  writeJson(path.join(CASES, `${id}.json`), rec);
  if (EXPERIENCE_STORE && EXPERIENCE_STORE.indexBenchmark) { try { EXPERIENCE_STORE.indexBenchmark(rec); } catch { /* 索引失败不影响 case 落盘 */ } }
  checkMutationWatchdog(rec); // 晋级后退化看门狗（短板高4）：生产任务质量喂给观察窗口
  if (rec.hard) {
    recordGap({ ts: rec.createdAt, task: rec.task.slice(0, 2000), acceptance: rec.acceptance, gaps: lastGaps, repairs });
    // 教训卡用全过程缺口（allGaps，含已修复的中间轮）优先——最终 PASS 只说明坑被填了，
    // "曾踩过的坑"对相似任务仍有预警价值；无 allGaps 时退回最终缺口
    const lessonGaps = (Array.isArray(input.allGaps) && input.allGaps.length ? input.allGaps : lastGaps).map(g => String(g).slice(0, 300)).slice(0, 8);
    recordLessons({ task: rec.task, gaps: lessonGaps });
    // 教训聚类升格：相似教训反复出现时自动沉淀为技能（显式知识），幂等增量
    try { promoteLessonsToSkill(); } catch { /* 升格失败不影响主流程 */ }
  }
  // 成功套路沉淀：真实任务完成即尝试记录工具序列（worker 沙箱路径不经过此处）
  try {
    const logFile = path.join(DATA_DIR, 'inner-log.jsonl');
    let rows = []; try { rows = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch {}
    if (rows.length) recordPlaybook(rec.task, rows.slice(-40).map(x => ({ plugin: x.plugin, ok: !!x.ok })));
  } catch { /* 套路沉淀失败不影响主流程 */ }
  const all = listBenchmarks();
  // 淘汰策略（2026-09-04 优化 8）：非 hard 最旧先淘汰，hard 尽量存活——
  // 暴露过真实短板的难例是进化选样的核心信号，与普通任务同权 FIFO 会把它静默丢掉
  const evictionOrder = [...all.filter(x => !x.hard), ...all.filter(x => x.hard)].reverse();
  for (const old of evictionOrder.slice(MAX_CASES)) { try { fs.unlinkSync(path.join(CASES, `${old.id}.json`)); } catch {} }
  return rec;
}

function artifactManifest(wsDir) {
  const out = [];
  const skip = new Set(['.memory-short.json','.memory-long.json','.memory-vector.json','memory-archive.jsonl','.todo.json','.intent.json','process.md','hwj-messages.json','task-state.md']);
  function walk(dir, rel='') {
    let ents=[]; try { ents=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.evolution-keep') continue;
      if (skip.has(e.name)) continue;
      const fp=path.join(dir,e.name), rp=path.join(rel,e.name);
      if (e.isDirectory()) walk(fp,rp); else if (e.isFile()) {
        try { const st=fs.statSync(fp); if (st.size <= 1024*1024) out.push({path:rp.replace(/\\/g,'/'), size:st.size, sha256:sha(fs.readFileSync(fp))}); } catch {}
      }
    }
  }
  walk(wsDir); return out.slice(0,200);
}

function buildHypothesisContext(cases) {
  const recent = cases.slice(0, 12).map(c => ({ id:c.id, task:c.task.slice(0,500), acceptance:c.acceptance, baseline:c.baseline && {finalText:String(c.baseline.finalText||'').slice(0,500), artifacts:(c.baseline.artifacts||[]).map(a=>a.path)} }));
  let experience=[]; try { experience=fs.readFileSync(path.join(EV_ROOT,'experience.jsonl'),'utf8').split('\n').filter(Boolean).slice(-100).map(x=>JSON.parse(x)); } catch {}
  const bottlenecks = experience.slice(-30).filter(x=>x && x.pluginStats).flatMap(x=>Object.entries(x.pluginStats).map(([name,v])=>({name,failures:v.failures||0,calls:v.calls||0})))
    .reduce((m,x)=>{const z=m[x.name]||{calls:0,failures:0}; z.calls+=x.calls; z.failures+=x.failures; m[x.name]=z; return m;},{});
  const audit = readJson(path.join(DATA_DIR,'audit.json'),[]).slice(-12);
  // 缺口经验池：真实短板任务（触发过返修/带缺口标注）优先作为证据来源，
  // 引导 Meta-Agent 从缺口中提炼可复用的显式知识（skill），而非停留在参数层打转。
  const gapTasks = listGaps(6).map(g => ({ task:String(g.task||'').slice(0,600), gaps:(g.gaps||[]).slice(0,6), repairs:g.repairs||0 }));
  // 历史实验成败沉淀：已被证伪/验证的方向注入上下文，避免重复提出相同 mutation
  const recentExperiments = experience.slice(-8).filter(x=>x && x.experiment && x.mutation).map(x=>({
    experiment:x.experiment,
    mutation:{ type:x.mutation.type, target:x.mutation.target, change:String(x.mutation.change||'').slice(0,200) },
    result:{ meanDelta:Number(x.summary&&x.summary.meanDelta)||0, winRate:Number(x.summary&&x.summary.winRate)||0, pass:!!(x.summary&&x.summary.pass) }
  }));
  return JSON.stringify({ recent, gapTasks, bottlenecks, audit, recentExperiments }, null, 2).slice(0, 18000);
}

const MUTATION_SCHEMA = `{"type":"plugin|prompt|gene|skill|strategy|memory","target":"...","reason":"...","hypothesis":"...","change":"...","expectedDelta":0.05}`;

function buildMutationPrompt(cases, emphasizeFailureTargeting, experienceSection) {
  const context = buildHypothesisContext(cases);
  const failureModes = analyzeFailureModes(3);
  const failureSection = failureModes.length ? [
    '', '== 近期失败模式 Top' + failureModes.length + '（本轮 mutation 必须靶向其中至少一条，reason 中点名引用）==',
    failureModes.map((f, i) => `${i + 1}. [出现 ${f.count} 次] ${f.representative}\n   典型任务：${f.samples.join(' / ')}`).join('\n'),
    '靶向原则：优先把失败模式对应的正确做法固化为一条 prompt 基因或技能；证据不足时才考虑其他类型。',
    ...(emphasizeFailureTargeting ? ['【重要】上一次提议未引用任何失败模式已被退回：本次 reason/hypothesis 必须明确点名上述模式之一，并说明 mutation 如何靶向它，否则提议无效。'] : [])
  ].join('\n') : '';
  return [
    '你是 Self-Improvement Meta-Agent。你的唯一职责是提出一个可验证、最小、可归因的 Agent mutation。不要输出插件审批 proposals。',
    '',
    '你现在进入 Self-Improvement 实验室。你不是来直接修改生产环境，而是提出一个可证伪的 mutation candidate。',
    '核心原则：修改不等于改进；必须用 benchmark A/B 实验证明 candidate 更好。',
    '只提出一个最小、可归因的变化，禁止一次同时修改多个独立变量。',
    '允许的 type 及 change 的格式要求（change 必须可直接执行，禁止输出"修改 xx 文件中 yy 逻辑"这类描述性文字）：',
    '1. gene（首选）：对 Prompt 基因库做一次最小操作，change=严格 JSON 对象：',
    '   {"action":"add","text":"一条 ≤400 字符的执行增强指令","category":"verification|planning|tool_use|style|general"}',
    '   也支持 {"action":"modify|enable|disable|remove","id":"g-xxxx"}（对现有基因的操作）。基因是可独立启停、可归因的系统提示片段，累积成库后组合生效——这是最小、最可解释的 mutation 形态。',
    '2. prompt：整段执行策略补丁，change=注入 system 提示的策略文本（仅在单一基因无法表达时使用）。',
    '3. plugin：修改一个 plugins/*.js，change=该插件完整候选源码（必须含 module.exports）。',
    '4. skill：修改或新建 skills 下的技能文件，target=skills/<目录>/<文件>.md（新建目录也可），change=该文件完整新内容。技能是显式知识，语义清晰、可直接审查——这是信息量最大的 mutation 类型。',
    '   优先审查实验上下文的 gapTasks（触发过返修、带缺口标注的真实短板任务）：若缺口反映的是可复用的方法论或流程缺失（例如某类交付总是漏步骤），把正确做法提炼成一个新技能或修补现有技能。缺口 → 显式知识 → A/B 验证，是本系统的首选进化路径。',
    '5. strategy：修改可实验的执行策略，change=严格 JSON 对象，仅允许以下键（实测有效的策略层）：',
    '   {"verification":"strong"} 或 {"toolSelection":"conservative"} 或 {"memoryTopK":1~10 的整数}，可组合如 {"verification":"strong","memoryTopK":5}。',
    '6. memory：修改记忆召回参数，change 同 strategy（JSON 对象，如 {"memoryTopK":6}）。',
    '注意：若你的改进想法映射不到上述可执行形态（例如想改未建模的内部逻辑），选 type=none 并说明原因——安慰剂式 mutation 只会浪费实验资源。',
    '实验上下文的 recentExperiments 是历史实验及其真实结果：meanDelta 为负或 pass=false 的方向已被证伪，禁止原样重复提出；要在其基础上给出实质不同的新假设。',
    '如果证据不足，不要为了进化而进化，返回 {"type":"none","reason":"没有足够证据"}。',
    `输出严格 JSON：${MUTATION_SCHEMA} 或 {"type":"none","reason":"..."}`,
    failureSection,
    experienceSection || '',
    '', '== 实验上下文 ==', context
  ].filter(Boolean).join('\n');
}

// 语义召回历史经验拼入 mutation prompt：按失败模式文本召回相似教训（含已验证的规避做法），
// Meta-Agent 从"凭空想 mutation"升级为"参考同类历史教训提 mutation"。
// store 未注入时返回空段（FileStore 的 Semantic 实现兜底为 bigram 召回，仍有效）。
async function buildSimilarExperienceSection(failureModes) {
  if (!EXPERIENCE_STORE || !EXPERIENCE_STORE.searchLessonsSemantic) return '';
  const seen = {}; const out = [];
  for (const f of (failureModes || []).slice(0, 3)) {
    try {
      const hits = await EXPERIENCE_STORE.searchLessonsSemantic(f.representative || '', 2);
      for (const h of (hits || [])) {
        if (!h || seen[h.id]) continue;
        seen[h.id] = 1;
        out.push(h);
        if (out.length >= 4) break;
      }
    } catch { /* 召回失败不影响提议 */ }
    if (out.length >= 4) break;
  }
  SEMANTIC_RECALL_COUNT = out.length; // 可观测性：随 decision.json 落盘
  if (!out.length) return '';
  return ['', '== 历史相似经验（按失败模式语义召回，已验证的规避做法）==',
    out.map((l, i) => `${i + 1}. 「${String(l.task || '').slice(0, 60)}」→ ${l.lesson}`).join('\n')].join('\n');
}

// 直连 LLM 的 Meta-Agent 回退：无 opencode CLI 时用已配置的内层 API 生成 mutation 提议，
// 使自进化闭环只依赖一个 OpenAI 兼容 API（单轮 JSON 生成即可胜任假设提议任务）。
async function proposeMutationViaLLM(cfg, prompt) {
  const text = await callLLMText(cfg, [
    { role: 'system', content: '你是 Self-Improvement Meta-Agent。只输出一个严格 JSON 对象，无解释文字、无 markdown 围栏。' },
    { role: 'user', content: prompt }
  ], { maxTokens: 1400, label: 'Meta-Agent 提议', onUsage: u => recordLlmUsage('Meta-Agent 提议', u) });
  const j = parseLooseJson(text);
  if (!j || !j.type) throw new Error('Meta-Agent（直连 LLM）没有输出合法 mutation JSON');
  return j;
}

// 靶向命中判定：mutation 的 reason/hypothesis/change 是否引用了任一失败模式。
// 用"模式 bigram 在 mutation 文本中的覆盖率"衡量（中文短句引用通常复用大部分词汇），≥0.25 视为命中。
function targetsFailureModes(mutation, modes) {
  const text = bigrams([mutation && mutation.reason, mutation && mutation.hypothesis, String(mutation && mutation.change || '').slice(0, 500)].filter(Boolean).join(' '));
  if (!text.size) return false;
  return modes.some(m => {
    const pat = bigrams(m.representative);
    if (!pat.size) return false;
    let inter = 0; for (const g of pat) if (text.has(g)) inter++;
    return inter / pat.size >= 0.25;
  });
}

async function proposeMutation(cases, opts={}) {
  if (process.env.DUAL_AGENT_MOCK === '1') {
    return { type:'strategy', target:'verification', reason:'mock fallback', hypothesis:'强化交付验证提示可降低漏交付', change:'verification=strong', expectedDelta:0.03 };
  }
  // 靶向轻校验（2026-09-04）：失败模式存在时，mutation 必须引用其中一条；
  // 未引用 → 强调后重试一次，二次仍不达标接受原提议（柔性，避免循环浪费 API）
  const failureModes = analyzeFailureModes(3);
  const similarExperience = await buildSimilarExperienceSection(failureModes);
  let runnerCache;
  const gen = async (prompt) => {
    const runner = opts.runner || runnerCache || await detectOpencode();
    runnerCache = runner;
    if (runner) {
      const r = await runOuter(runner, prompt, ROOT, () => {}, opts.sessionId || '');
      const j = parseLooseJson(r && r.fullText || r && r.text || '');
      if (!j || !j.type) throw new Error('Meta-Agent 没有输出合法 mutation JSON');
      return j;
    }
    const cfg = evoConfig();
    if (!(cfg.base_url && cfg.api_key && cfg.model)) {
      throw new Error('未检测到 opencode 且进化 LLM 未配置：无法运行 Meta-Agent。请在设置中配置 API（自进化将直连该 API），或安装 opencode。');
    }
    return await proposeMutationViaLLM(cfg, prompt);
  };
  let mutation = await gen(buildMutationPrompt(cases, false, similarExperience));
  if (failureModes.length && mutation.type && mutation.type !== 'none' && !targetsFailureModes(mutation, failureModes)) {
    mutation = await gen(buildMutationPrompt(cases, true, similarExperience));
  }
  return mutation;
}

function makeCandidate(baseDir, mutation, id) {
  const dir = path.join(EXPS, id, 'candidate');
  fs.mkdirSync(dir, {recursive:true});
  // 候选目录继承生产插件/skills；workspace/data 由 worker 另建。
  const srcPlugins = process.env.DUAL_AGENT_PLUGINS_DIR || path.join(ROOT,'plugins');
  const dstPlugins = path.join(dir,'plugins'); fs.mkdirSync(dstPlugins,{recursive:true});
  for (const f of fs.readdirSync(srcPlugins)) if (f.endsWith('.js')) fs.copyFileSync(path.join(srcPlugins,f),path.join(dstPlugins,f));
  const srcSkills = process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT,'skills');
  const dstSkills = path.join(dir,'skills');
  if (fs.existsSync(srcSkills)) fs.cpSync(srcSkills,dstSkills,{recursive:true});

  const type = mutation.type;
  if (type === 'plugin') {
    const name = String(mutation.target||'').replace(/\.js$/,'');
    if (!plugins.NAME_RE.test(name)) throw new Error('mutation target 不是合法插件名');
    const code = String(mutation.change||'');
    if (!code.includes('module.exports')) throw new Error('plugin mutation 必须提供完整候选源码');
    const lint=lintCode(code); if(lint.syntax) throw new Error('candidate plugin 语法错误：'+lint.syntax);
    if(lint.warns && lint.warns.length) fs.writeFileSync(path.join(dir,'mutation-warnings.json'),JSON.stringify(lint.warns,null,2));
    fs.writeFileSync(path.join(dstPlugins,`${name}.js`),code,'utf8');
  } else if (type === 'skill') {
    const rel = String(mutation.target||'').replace(/^skills[\\/]/,'');
    if (!rel || rel.includes('..') || !rel.endsWith('.md')) throw new Error('非法 skill mutation target');
    const fp=path.join(dstSkills,rel); fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,String(mutation.change||''),'utf8');
  } else if (type === 'prompt') {
    fs.writeFileSync(path.join(dir,'system-patch.txt'),String(mutation.change||''),'utf8');
  } else if (type === 'gene') {
    let op = mutation.change;
    try { op = typeof mutation.change === 'string' ? JSON.parse(mutation.change) : mutation.change; } catch { op = null; }
    if (!op || typeof op !== 'object') throw new Error('gene mutation 的 change 必须是严格 JSON 对象（如 {"action":"add","text":"..."}）：' + String(mutation.change||'').slice(0, 200));
    const applied = applyGeneOp(listGenes(), op);
    if (applied.error) throw new Error('gene mutation 被拒绝：' + applied.error);
    writeJson(path.join(dir, 'genes.json'), { genes: applied.genes });
  } else if (type === 'strategy' || type === 'memory') {
    let patch = {};
    try { patch = typeof mutation.change === 'string' ? JSON.parse(mutation.change) : (mutation.change||{}); } catch { patch = { patch: String(mutation.change||'') }; }
    // 安慰剂防线：strategy/memory 层只有含已知可执行键才会真实改变 Agent 行为；
    // 自然语言描述在 A/B 中与 baseline 完全等价（实测 exp-mtkpa1gp：3 case delta≈0 全废），
    // 在提议阶段直接拒绝，省下整轮重放的真实 API 开销。
    const EXECUTABLE_KEYS = ['verification','toolSelection','memoryTopK'];
    if (!EXECUTABLE_KEYS.some(k => k in (patch && typeof patch === 'object' ? patch : {}))) {
      throw new Error(`strategy/memory mutation 缺少可执行策略键（${EXECUTABLE_KEYS.join('/')}），change 必须是如 {"memoryTopK":5} 的 JSON 对象：${String(mutation.change||'').slice(0,200)}`);
    }
    writeJson(path.join(dir,'strategy.json'),patch);
  } else throw new Error(`未知 mutation type：${type}`);
  return dir;
}

function copyWorkspace(src, dst) {
  fs.mkdirSync(dst,{recursive:true});
  if (!fs.existsSync(src)) return;
  fs.cpSync(src,dst,{recursive:true,filter:(s)=>{ const rel=path.relative(src,s); return !rel.startsWith('.data') && !rel.includes(`${path.sep}node_modules${path.sep}`); }});
}
function copyData(src,dst) {
  fs.mkdirSync(dst,{recursive:true});
  if (!fs.existsSync(src)) return;
  for (const f of fs.readdirSync(src)) {
    if (['audit.json','proposals.json','evolution'].includes(f)) continue;
    const s=path.join(src,f), d=path.join(dst,f);
    try { fs.cpSync(s,d,{recursive:true}); } catch {}
  }
}

// 异步 worker：spawn 而非 spawnSync——spawnSync 会冻结 Node 事件循环，
// Web 服务在 A/B 实验期间（可达数分钟）将无法响应任何请求。async 化后逐 case 顺序
// await，实验吞吐不变，主进程事件循环保持响应。
function runWorker(payload) {
  return new Promise((resolve) => {
    const worker = path.join(__dirname, 'evolution-worker.js');
    let child;
    try { child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, error: String(e.message || e) }); }
    let out = '', err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ ok: false, error: `worker 执行超时（${Math.round((payload.timeoutMs || 15 * 60 * 1000) / 60000)} 分钟）` });
    }, payload.timeoutMs || 15 * 60 * 1000);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, error: String(e.message || e) }));
    child.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(String(out || '').trim().split('\n').pop()); } catch { /* 非 JSON 输出 */ }
      if (!parsed) return finish({ ok: false, error: String(err || out || 'worker 无输出').slice(-2000) });
      finish(parsed);
    });
  });
}

async function evaluateCase(caseRec, baseRun, candRun, cfg, paths) {
  const baseArtifacts = baseRun.artifacts || [];
  const candArtifacts = candRun.artifacts || [];
  const required = [...(caseRec.deliverables||[]).map(d=>d.path).filter(Boolean)];
  const exists = p => candArtifacts.some(a=>a.path===p);
  const artifactScore = required.length ? required.filter(exists).length/required.length : 1;
  const efficiency = m => m ? clamp(0.55 * (m.toolSuccessRate) + 0.25 * (1 - Math.min(1,(m.toolCalls||0)/12)) + 0.20 * (1 - Math.min(1,(m.durationMs||0)/120000))) : 0;
  const processScore = efficiency(candRun.metrics);
  // 客观断言：可程序化判定的验收条款在本地文件系统直接判分（零噪声），
  // 断言结果同时作为证据喂给 LLM judge。无断言的 case 保持原公式。
  const objective = Array.isArray(caseRec.objective) ? caseRec.objective : [];
  let objCand = null, objBase = null;
  if (objective.length && paths && paths.baseWs && paths.candWs) {
    objCand = evaluateObjectives(paths.candWs, objective);
    objBase = evaluateObjectives(paths.baseWs, objective);
  }
  let judge = {score: candRun.ok ? 0.5 : 0, baseScore: baseRun.ok ? 0.5 : 0, reason:'fallback'};
  // judge 输入瘦身（2026-09-04 优化 6）：finalText 6000→3000（截断的是收尾重复段）；
  // metrics 只保留决策相关四指标，pluginStats 明细（每插件调用计数）只进 outcome 记账不进 judge
  const slimMetrics = m => m ? { toolCalls:m.toolCalls, toolSuccessRate:m.toolSuccessRate, durationMs:m.durationMs, failures:m.failures } : {};
  // judge 展示顺序随机化（短板高1）：恒定 baseline 在前会让 LLM judge 的位置偏差
  // （首因/近因效应）系统性偏向某一方；随机交换后按记录反解，偏差在样本间互相抵消。
  // 返回的 evaluation.judgeOrder 落盘便于审计；DUAL_AGENT_EVOLUTION_JUDGE_RANDOMIZE=0 可固定顺序复现
  const flip = process.env.DUAL_AGENT_EVOLUTION_JUDGE_RANDOMIZE !== '0' && Math.random() < 0.5;
  const runA = flip ? candRun : baseRun;
  const runB = flip ? baseRun : candRun;
  const objA = flip ? objCand : objBase, objB = flip ? objBase : objCand;
  const msgs = [
    {role:'system',content:'你是严格的 Agent benchmark evaluator。只根据任务要求和两个执行结果评分。不要因为候选更长、更自信就给高分。输出 JSON。'},
    {role:'user',content:[
      `任务：${caseRec.task}`,
      `验收条件：${JSON.stringify(caseRec.acceptance)}`,
      `要求产出：${JSON.stringify(caseRec.deliverables)}`,
      objCand ? `客观断言核验（文件系统事实，可信度最高）：A 通过 ${objA.passed}/${objA.total}，B 通过 ${objB.passed}/${objB.total}。明细：${JSON.stringify(objCand.details)}` : '',
      `A 最终回答：${String(runA.finalText||'').slice(0,3000)}`,
      `B 最终回答：${String(runB.finalText||'').slice(0,3000)}`,
      `A 工具指标：${JSON.stringify(slimMetrics(runA.metrics))}`,
      `B 工具指标：${JSON.stringify(slimMetrics(runB.metrics))}`,
      `A 客观产出存在分：${flip ? artifactScore : (()=>{ const r=required.length?required.filter(p=>baseArtifacts.some(a=>a.path===p)).length/required.length:1; return r; })()}`,
      `B 客观产出存在分：${flip ? (()=>{ const r=required.length?required.filter(p=>baseArtifacts.some(a=>a.path===p)).length/required.length:1; return r; })() : artifactScore}`,
      '分别给 A 与 B 0~1 分；评价正确性、任务完成度、约束遵守；返回 {A,B,reason}。'
    ].filter(Boolean).join('\n\n')}
  ];
  if (cfg && cfg.base_url && cfg.api_key && cfg.model && process.env.DUAL_AGENT_SKIP_JUDGE !== '1') {
    try {
      const text=await callLLMText(cfg,msgs,{maxTokens:700,label:'Evolution Evaluator',onUsage:u=>recordLlmUsage('Evolution Evaluator',u)});
      const j=parseLooseJson(text);
      if (j && Number.isFinite(Number(j.A)) && Number.isFinite(Number(j.B))) {
        // 反解：A/B 标签还原为 baseline/candidate
        judge = flip
          ? {score:clamp(Number(j.A)),baseScore:clamp(Number(j.B)),reason:String(j.reason||'')}
          : {score:clamp(Number(j.B)),baseScore:clamp(Number(j.A)),reason:String(j.reason||'')};
      } else if (j && Number.isFinite(Number(j.candidate))) {
        judge={score:clamp(j.candidate),baseScore:clamp(j.baseline),reason:String(j.reason||'')};
      }
    } catch (e) { judge.reason='judge unavailable: '+String(e.message||e); }
  }
  // 客观产出是硬下限，防止 evaluator 被“漂亮答案”欺骗。
  // 有 objective 断言时：客观分权重 0.45（文件系统事实优先），judge 降至 0.35。
  const w = objCand ? {judge:0.35, obj:0.45, proc:0.20} : {judge:0.65, obj:0.20, proc:0.15};
  const candidateScore = w.judge*judge.score + w.obj*(objCand ? objCand.score : artifactScore) + w.proc*processScore;
  const baselineArtifactScore = required.length ? required.filter(p=>baseArtifacts.some(a=>a.path===p)).length/required.length : 1;
  const baselineProcess = efficiency(baseRun.metrics);
  const baselineScore = w.judge*judge.baseScore + w.obj*(objBase ? objBase.score : baselineArtifactScore) + w.proc*baselineProcess;
  const evaluation = {baselineScore,candidateScore,delta:candidateScore-baselineScore,judge,judgeOrder:flip?'cand-first':'base-first',artifactScore,processScore};
  if (objCand) evaluation.objective = {candidate:{score:objCand.score,passed:objCand.passed,total:objCand.total},baseline:{score:objBase.score,passed:objBase.passed,total:objBase.total},details:objCand.details};
  return evaluation;
}

function aggregate(results) {
  const deltas=results.map(r=>r.evaluation.delta), wins=deltas.filter(x=>x>0).length;
  const regressions=deltas.filter(x=>x < -MAX_REGRESSION).length;
  const m=mean(deltas);
  const bci=bootstrapCI(deltas);
  const pass=results.length>=MIN_CASES && m>=MIN_DELTA && (wins/results.length)>=MIN_WIN_RATE && regressions===0 && (m-ci95(deltas))>0;
  const agg={ n:deltas.length, meanDelta:m, sd:sd(deltas), ci95:ci95(deltas), bootstrapCI:bci, winRate:results.length?wins/results.length:0, wins, regressions,
    pass };
  // low-confidence 标记（短板高2）：结论落在统计边缘时显性化，提醒晋级决策参考 holdout
  // 与样本量局限；不阻断晋级（保留原判定语义），但 decision.json/leaderboard 可审计
  if (bci) {
    if (pass && bci.low <= 0.01) agg.lowConfidence = true;
    if (!pass && m >= MIN_DELTA * 0.5 && bci.high > MIN_DELTA) agg.lowConfidence = true;
  }
  return agg;
}

// 单个 benchmark case 的 A/B 重放：独立沙箱工作区 + data 快照，baseline/candidate 同环境执行。
// 供主实验与 holdout 复验复用。
async function runCase(exp, c, candidateDir, opts) {
  const caseDir=path.join(exp,'cases',c.id); fs.mkdirSync(caseDir,{recursive:true});
  const baseWs=path.join(caseDir,'baseline','workspace'), candWs=path.join(caseDir,'candidate','workspace');
  const baseData=path.join(caseDir,'baseline','data'), candData=path.join(caseDir,'candidate','data');
  // 干净重放环境：benchmark 任务均为创建类，空工作区提供最大区分度，
  // 并彻底避免生产工作区里历史产物触发 write 覆盖保护、或让存在性验收失去区分度。
  // 限制：依赖既有文件的修改类任务加入 benchmark 前需先扩展 benchmark 格式记录依赖。
  fs.mkdirSync(baseWs,{recursive:true}); fs.mkdirSync(candWs,{recursive:true});
  copyData(DATA_DIR,baseData); copyData(DATA_DIR,candData);
  const common={task:c.task,mode:'build',configPath:path.join(baseData,'config.json'),timeoutMs:Number(opts.timeoutMs)||12*60*1000};
  // 基因库对等注入：baseline 带生产启用集，candidate 带变更集——A/B 测的是单条基因操作的
  // 边际价值，而非"有无基因库"的整体差异（环境不对等会把整套基因库的价值错算进单次实验）。
  const baseGenes=readJson(GENES_PATH,{genes:[]}).genes;
  const candGenes=readJson(path.join(candidateDir,'genes.json'),null);
  // case 内 A/B 并行（2026-09-04 优化 5）：baseline/candidate 环境独立（独立进程/工作区/data 快照），
  // 并行把单 case 时长近乎减半，整轮实验（12 case）预计省约 50%。case 间保持串行——
  // 早停与 3-case 快筛依赖逐 case 的顺序判定。API 并发翻倍由 withRetry 限流退避兜底。
  const [b, cnd] = await Promise.all([
    runWorker({...common,workspace:baseWs,dataDir:baseData,pluginsDir:process.env.DUAL_AGENT_PLUGINS_DIR||path.join(ROOT,'plugins'),skillsDir:process.env.DUAL_AGENT_SKILLS_SHARED||path.join(ROOT,'skills'),genes:Array.isArray(baseGenes)?baseGenes:[],label:'baseline'}),
    runWorker({...common,workspace:candWs,dataDir:candData,pluginsDir:path.join(candidateDir,'plugins'),skillsDir:path.join(candidateDir,'skills'),systemPatch:fs.existsSync(path.join(candidateDir,'system-patch.txt'))?fs.readFileSync(path.join(candidateDir,'system-patch.txt'),'utf8'):'',strategy:readJson(path.join(candidateDir,'strategy.json'),{}),genes:Array.isArray(candGenes&&candGenes.genes)?candGenes.genes:baseGenes,label:'candidate'})
  ]);
  return {benchmark:c.id,baseline:b,candidate:cnd,baseWs,candWs};
}

// train/holdout 拆分（纯函数便于测试）：2/3 进化选样 + 1/3 晋级复验。A/B 在训练池上赢的
// mutation 可能只是过拟合了特定任务，晋级前必须在未参与选样的 holdout 上复验。
// 池 < 15 时 holdout 不足 MIN_CASES，退化为直接晋级（与旧逻辑一致）。
function splitPool(ranked) {
  const holdoutN = ranked.length >= 15 ? Math.max(MIN_CASES, Math.floor(ranked.length / 3)) : 0;
  return {
    train: holdoutN ? ranked.slice(0, ranked.length - holdoutN) : ranked,
    holdout: holdoutN ? ranked.slice(ranked.length - holdoutN) : []
  };
}

// ===== 断点续跑（进化进度延续）=====
// 病根：runEvolution 无 checkpoint，实验中途服务器重启/崩溃/空闲自动退出，整个实验作废，
// 半截 exp-xxx 目录无人消费，下次全部 case 重跑——白烧 API。
// 方案：新实验落盘 state.json（mutation + 选中的 case 清单）；case 结果已有 result.json
// （逐 case 落盘）；runEvolution 启动时发现「有 state 无 decision 且 24h 内」的实验 →
// 复用 mutation 与 candidate 目录，已完成 case 直接读结果，从断点继续。
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
function findResumableExperiment() {
  let dirs = []; try { dirs = fs.readdirSync(EXPS).filter(n => n.startsWith('exp-')).sort(); } catch { return null; }
  for (let i = dirs.length - 1; i >= 0; i--) {
    const exp = path.join(EXPS, dirs[i]);
    const stateP = path.join(exp, 'state.json');
    if (!fs.existsSync(stateP) || fs.existsSync(path.join(exp, 'decision.json'))) continue;
    try {
      const st = JSON.parse(fs.readFileSync(stateP, 'utf8'));
      if (!st || !st.mutation || !Array.isArray(st.selected)) continue;
      if (Date.now() - (Date.parse(st.createdAt) || 0) > RESUME_WINDOW_MS) return null; // 太旧：证据过期，放弃
      const done = [];
      for (const cid of st.selected) {
        const rp = path.join(exp, 'cases', cid, 'result.json');
        if (fs.existsSync(rp)) { try { done.push(JSON.parse(fs.readFileSync(rp, 'utf8'))); } catch { /* 坏结果当未完成 */ } }
      }
      return { exp, state: st, done };
    } catch { return null; }
  }
  return null;
}

// 攒批触发（多次聊天合并分析）：自动实验需要自上次实验完成以来积累 ≥N 个新 benchmark
// （DUAL_AGENT_EVOLUTION_MIN_NEW_CASES，默认 3）才触发；手动「立即触发」不受限。
// 从未跑过实验时返回 Infinity（首个实验保持原行为：池子够就跑）。
function newBenchmarksSinceLastExp() {
  const st = readJson(STATE, {});
  const lastTs = Date.parse(st.evolution && st.evolution.lastExpAt) || 0;
  if (!lastTs) return Infinity;
  let n = 0;
  let files = []; try { files = fs.readdirSync(CASES).filter(f => f.endsWith('.json')); } catch { /* 无池 */ }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CASES, f), 'utf8'));
      if ((Date.parse(j.createdAt) || 0) > lastTs) n++;
    } catch { /* 坏文件跳过 */ }
  }
  return n;
}
// 实验结束（decision 落盘）时刷新起点：这批证据已被消耗
function markExperimentFinished(id) {
  try {
    const cur = readJson(STATE, {});
    cur.evolution = { ...(cur.evolution || {}), lastExpAt: new Date().toISOString(), lastExperiment: id };
    writeJson(STATE, cur);
  } catch { /* 失败不影响实验结论 */ }
}

async function runEvolution(opts={}) {
  ensure();
  const cases=listBenchmarks();
  if (cases.length < MIN_CASES) return {ok:false,stage:'collect',error:`可用 benchmark 只有 ${cases.length} 个，至少需要 ${MIN_CASES} 个真实任务后才能进化。`,benchmarks:cases.length};
  const cfg = evoConfig(); // 进化专用配置（缺省回退 inner），judge/Meta-Agent/课程统一走此路
  // 断点续跑：手动指定 mutation（一次性实验）或 opts.resume===false 时开新实验；
  // 其余情况优先续跑最近的未完成实验
  const resumable = (!opts.mutation && opts.resume !== false) ? findResumableExperiment() : null;
  let id, exp, mutation, selected, holdoutCases, candidateDir, results=[];
  if (resumable) {
    const byId = new Map(cases.map(c => [c.id, c]));
    id = resumable.state.id || path.basename(resumable.exp).slice(4);
    exp = resumable.exp;
    mutation = resumable.state.mutation;
    selected = (resumable.state.selected || []).map(cid => byId.get(cid)).filter(Boolean);
    holdoutCases = (resumable.state.holdout || []).map(cid => byId.get(cid)).filter(Boolean);
    candidateDir = path.join(exp, 'candidate');
    results = resumable.done.filter(r => r && r.benchmark && r.evaluation);
    if (!selected.length || !fs.existsSync(path.join(candidateDir, 'plugins'))) {
      // case 清单失效或候选目录缺失（被清理等）→ 无法续跑，当新实验处理
      resumable.invalid = true;
    }
  }
  if (resumable && !resumable.invalid) {
    for (const c of [...selected, ...holdoutCases]) fs.mkdirSync(path.join(exp,'cases',c.id),{recursive:true});
  } else {
    // 难例驱动：优先把暴露过真实短板的任务放进 A/B（改进 2）；hard 轮换降权防过拟合小撮难例（优化 9）
    const stateForUsage = readJson(STATE, {});
    const ranked = rankHardFirst(cases, stateForUsage.caseUsage);
    const { train: trainCases, holdout: holdoutSplit } = splitPool(ranked);
    selected = trainCases.slice(0, Math.min(trainCases.length, Number(opts.cases)||12));
    mutation=opts.mutation || await proposeMutation(ranked,opts);
    if (mutation.type==='none') return {ok:true,stage:'no-op',mutation};
    id=nowId('exp'); exp=path.join(EXPS,id); fs.mkdirSync(exp,{recursive:true});
    writeJson(path.join(exp,'proposal.json'),mutation);
    // 实验元数据落盘：中断后 findResumableExperiment 据此续跑（断点续跑）
    writeJson(path.join(exp,'state.json'),{ id, mutation, selected: selected.map(c=>c.id), holdout: holdoutSplit.map(c=>c.id), createdAt: new Date().toISOString() });
    // 记录本轮实际参与实验（含 holdout 潜在集）的 case，供 rankHardFirst 24h 轮换降权
    // （读-改-写互斥：与并行实验/生产 recordBenchmark 的 STATE 更新防丢失更新）
    try {
      const usedNow = {};
      const now = Date.now();
      for (const c of [...selected, ...holdoutSplit]) usedNow[c.id] = now;
      const cur = readJson(STATE, {});
      writeJson(STATE, { ...cur, caseUsage: { ...(cur.caseUsage || {}), ...usedNow } });  } catch { /* 轮换记录失败不影响实验 */ }
    holdoutCases = holdoutSplit;
    candidateDir=makeCandidate(ROOT,mutation,id);
    // 预建全部 case 目录：liveStatus 以目录数为准，预建后进度一开始就显示真实总量（12/12 而非渐进 1→12）
    for (const c of [...selected, ...holdoutCases]) fs.mkdirSync(path.join(exp,'cases',c.id),{recursive:true});
  }
  // 同一组 benchmark、同一任务顺序、独立进程；baseline 与 candidate 使用同一 data snapshot。
  const totalCases = selected.length;
  let earlyStop = null;
  let prefilterReject = null;
  // P2-5 case 级并行：分批（wave）并行跑，批间判定早停/快筛——早停灵敏度从"每 case"降为
  // "每批"（最多多跑一批），换取实验时长近并发度倍缩短。并发度可配（1=串行，默认 2，上限 4，
  // 防真实 LLM 并发限流）；case 间无共享状态（各自独立 worker 子进程 + 独立 case 工作区），
  // A/B 公平性已由 worker 路径温度 0 保证；结果按 case 提交顺序回填，aggregate 可复现。
  const PAR_MAX = Math.max(1, Math.min(4, Number(process.env.DUAL_AGENT_EVOLUTION_PARALLELISM) || 2));
  // v3.4 限流自适应并行：持续限流时自动降并发（PAR_MAX→1）+ 全局冷却，连续 3 波干净后回升。
  // 被限流的 case 不写 result.json——断点续跑机制天然补跑；重试上限 2 次，超限跳过留给
  // 下次续跑（决策仍可基于已完成 case 产出）。限流事件随 decision 落盘供观测。
  const RL_COOLDOWN_MS = Math.max(10000, Number(process.env.DUAL_AGENT_EVOLUTION_COOLDOWN_MS) || 60000);
  let par = PAR_MAX;
  let cooldownUntil = 0;
  let cleanWaves = 0;
  const rateLimitEvents = [];
  const rlAttempts = {};
  // 断点续跑时已完成 case 已过快筛窗口，不重复快筛
  let prefilterChecked = results.length >= 3;
  // 只跑尚无 result.json 的 case（续跑跳过已完成部分）
  const pendingQueue = selected.filter(c => !results.some(r => r.benchmark === c.id));
  while (pendingQueue.length && !earlyStop && !prefilterReject) {
    if (Date.now() < cooldownUntil) await new Promise(r => setTimeout(r, cooldownUntil - Date.now()));
    const wave = pendingQueue.splice(0, par);
    const outcomes = await Promise.all(wave.map(async c => {
      try {
        const row = await runCase(exp, c, candidateDir, opts);
        // worker 级限流检测：worker 内 LLM 限流耗尽重试后返回 {ok:false,error:特征词}
        const rlSrc = [row.baseline && row.baseline.error, row.candidate && row.candidate.error, row.baseline && row.baseline.finalText, row.candidate && row.candidate.finalText].find(t => isRateLimitText(t));
        if (rlSrc) return { c, rateLimited: String(rlSrc).slice(0, 150) };
        row.evaluation = await evaluateCase(c, row.baseline, row.candidate, cfg, { baseWs: row.baseWs, candWs: row.candWs });
        writeJson(path.join(exp, 'cases', c.id, 'result.json'), row);
        return { c, row };
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (isRateLimitText(msg)) return { c, rateLimited: msg.slice(0, 150) };
        return { c, failed: msg.slice(0, 150) };
      }
    }));
    let waveLimited = false;
    for (const o of outcomes) {
      if (o.row) { results.push(o.row); continue; }
      if (o.rateLimited) {
        waveLimited = true;
        rateLimitEvents.push({ ts: Date.now(), case: o.c.id, msg: o.rateLimited });
        rlAttempts[o.c.id] = (rlAttempts[o.c.id] || 0) + 1;
        if (rlAttempts[o.c.id] <= 2) pendingQueue.push(o.c); // 挪回队尾：冷却降档后补跑
        continue;
      }
      // 普通失败：跳过该 case（不写 result → 续跑可补），不再炸掉整个实验
      rateLimitEvents.push({ ts: Date.now(), case: o.c.id, msg: 'error: ' + o.failed });
    }
    if (waveLimited) {
      par = Math.max(1, par - 1); // 降档
      cooldownUntil = Date.now() + RL_COOLDOWN_MS;
      cleanWaves = 0;
    } else {
      cleanWaves++;
      if (cleanWaves >= 3 && par < PAR_MAX) { par++; cleanWaves = 0; } // 连续干净回升
    }
    earlyStop = checkEarlyStop(results, totalCases);
    if (earlyStop) break;
    // 3-case 快筛：证据强烈的坏候选提前终止——meanDelta<0 且胜率≤1/3 时，全量通过
    // （需 meanDelta≥0.03 且胜率≥0.6）概率极低，省下剩余 case 的真实 API 开销。
    // 与数学早停互补：早停只认"必然失败"，快筛认"极大概率失败"，可用 env 关闭。
    // 并行后 results 按批跳变（2,4,6…），故判定改为 >=3 且只判一次（原为 ===3）
    if (results.length >= 3 && totalCases > 3 && !prefilterChecked && process.env.DUAL_AGENT_EVOLUTION_PREFILTER !== '0') {
      prefilterChecked = true;
      const m3 = mean(results.slice(0, 3).map(r=>r.evaluation.delta));
      const wr3 = results.slice(0, 3).filter(r=>r.evaluation.delta>0).length / 3;
      if (m3 < 0 && wr3 <= 1/3) prefilterReject = { at: results.length, meanDelta: m3, winRate: wr3, reason: '3-case 快筛：均值与胜率双双落后，剩余 case 翻盘概率极低，提前拒绝' };
    }
  }
  const summary=aggregate(results);
  let holdout = null;
  // holdout 复验：A/B 通过且候选要晋级时，在未参与选样的 holdout 池上重放。
  // holdout 也必须赢（同一判定标准），否则视为过拟合训练池，拒绝晋级。
  if (summary.pass && opts.promote && holdoutCases.length >= MIN_CASES) {
    // holdout 断点：已落盘 result 的 case 直接读，只跑缺失部分（与训练池同策略）
    const holdoutRows = await Promise.all(holdoutCases.map(async c => {
      const rp = path.join(exp, 'cases', c.id, 'result.json');
      if (fs.existsSync(rp)) { try { return JSON.parse(fs.readFileSync(rp, 'utf8')); } catch { /* 坏结果重跑 */ } }
      const row = await runCase(exp, c, candidateDir, opts);
      row.evaluation = await evaluateCase(c, row.baseline, row.candidate, cfg, { baseWs: row.baseWs, candWs: row.candWs });
      writeJson(rp, row);
      return row;
    }));
    holdoutResults.push(...holdoutRows);
    holdout = aggregate(holdoutResults);
    writeJson(path.join(exp,'holdout-decision.json'),holdout);
    if (!holdout.pass) summary.holdoutReject = true;
  }
  const decision={experiment:id,mutation,targetedPatterns:analyzeFailureModes(3),summary,holdout,earlyStop,prefilterReject,semanticRecall:SEMANTIC_RECALL_COUNT,createdAt:new Date().toISOString(),resumed:!!(resumable&&!resumable.invalid),
    llmSource:evoLlmSource(), // 观测：本轮进化用的是独立配置还是回退执行配置
    rateLimitEvents:rateLimitEvents.slice(0,20)}; // 限流/失败事件（截 20 条）供配额调优
  writeJson(path.join(exp,'decision.json'),decision); updateLeaderboard(decision);
  markExperimentFinished(id); // 刷新攒批起点：自此刻起的新任务进入下一批分析
  const bestCase = results[0] && results[0].candidate && results[0].candidate.metrics;
  const expLine = { ts:decision.createdAt, experiment:id, mutation, summary, pluginStats:bestCase && bestCase.pluginStats || {} };
  // 追加防条目丢失：同步读改写（单线程原子）+ tmp/rename 原子落盘
  {
    const expLines = []; try { const raw=fs.existsSync(path.join(EV_ROOT,'experience.jsonl')) ? fs.readFileSync(path.join(EV_ROOT,'experience.jsonl'),'utf8') : ''; expLines.push(...raw.split('\n').filter(Boolean).slice(-199)); } catch {}
    expLines.push(JSON.stringify(expLine));
    try { const tmp = path.join(EV_ROOT, `experience.${process.pid}.tmp`); fs.writeFileSync(tmp, expLines.join('\n')+'\n','utf8'); fs.renameSync(tmp, path.join(EV_ROOT,'experience.jsonl')); } catch {}
  }
  if (summary.pass && opts.promote && !summary.holdoutReject) {
    const pr=promoteMutation(mutation,id); decision.promotion=pr; writeJson(path.join(exp,'decision.json'),decision);
  }
  updateGeneStats(mutation, summary.pass && (!opts.promote || !summary.holdoutReject));
  const promoted = !!(summary.pass && opts.promote && !summary.holdoutReject && decision.promotion && decision.promotion.ok);
  return {ok:true,stage:promoted?'promoted':(summary.pass?(opts.promote?'holdout-rejected':'ready'):'rejected'),experiment:id,mutation,summary,holdout,earlyStop,prefilterReject,results:results.map(r=>({benchmark:r.benchmark,evaluation:r.evaluation}))};
}

// 自动课程（任务池增长）：池子里任务太简单时任何 mutation 都测不出差异（天花板效应），
// 任务生成能力本身就是进化系统的一部分。生成 → 真实执行验证 → 跑通才入池，
// 任务必须为"创建类"（空工作区可重放、可客观核验），并显式避开现有任务。
async function growPool(opts={}) {
  ensure();
  const n = Math.max(1, Math.min(5, Number(opts.count) || 3));
  const cfg = evoConfig();
  const configured = !!(cfg.base_url && cfg.api_key && cfg.model);
  if (!configured && process.env.DUAL_AGENT_MOCK !== '1') throw new Error('进化 LLM 未配置：自动课程需要调用 LLM 生成新任务');
  let taskList;
  if (process.env.DUAL_AGENT_MOCK === '1') {
    taskList = [{ task: `创建 curriculum-mock.txt，写入 3 行自动课程生成内容（第 1 行固定为 curriculum-ok）`, acceptance: ['文件存在', '第 1 行为 curriculum-ok'], objective: [{ check: 'file_exists', path: 'curriculum-mock.txt' }, { check: 'content_contains', path: 'curriculum-mock.txt', value: 'curriculum-ok' }] }];
  } else {
    const existing = listBenchmarks().slice(0, 20).map(c => `- ${c.task.slice(0, 100)}`);
    const prompt = [
      '你是 Self-Improvement 课程生成器。为 Agent 生成新的练习任务（benchmark），用于扩充任务池。',
      '要求：',
      '1. 任务必须是"创建类"：从零创建文件/内容，禁止依赖已有文件状态（必须可在空工作区重放）；',
      '2. 任务必须可客观核验：有明确的文件路径和内容特征（行数/关键词/格式）；',
      '3. 难度设定为"Agent 大约一半概率做不好"：需要多步操作、多文件协作、精确格式约束或跨源内容整合；',
      '4. 与现有任务明显不同（领域/形式/约束），禁止重复；',
      `5. 生成 ${n} 个任务。`,
      '6. 每个任务必须给出 objective 数组：可程序化判定的验收断言，check 仅允许 file_exists/content_contains/content_regex/line_count_gte/line_count_eq/json_valid，path 相对工作区根，value 为断言参数（file_exists 不需要 value）。至少 2 条，全部断言通过才算交付合格。',
      '输出严格 JSON 数组：[{"task":"任务描述","acceptance":["验收条件1","验收条件2"],"objective":[{"check":"file_exists","path":"report.md"},{"check":"content_contains","path":"report.md","value":"结论"}]}]',
      '', '== 现有任务（禁止重复）==', existing.join('\n') || '（空）'
    ].join('\n');
    const text = await callLLMText(cfg, [
      { role: 'system', content: '只输出严格 JSON 数组，无解释文字、无 markdown 围栏。' },
      { role: 'user', content: prompt }
    ], { maxTokens: 2000, label: '课程生成', onUsage: u => recordLlmUsage('课程生成', u) });
    const j = parseLooseJson(text);
    taskList = Array.isArray(j) ? j : (j && Array.isArray(j.tasks) ? j.tasks : []);
  }
  const id = nowId('pool'); const exp = path.join(EXPS, id); fs.mkdirSync(exp, { recursive: true });
  const created = [];
  for (const t of taskList.slice(0, n)) {
    const task = String(t && t.task || '').trim().slice(0, 2000);
    if (!task) continue;
    // 生成即验证：真实执行一次（空沙箱工作区 + 主 data 快照，LLM 凭据可用），跑通才入池
    const ws = path.join(exp, 'run', `ws-${created.length}`);
    const dataDir = path.join(exp, 'run', `data-${created.length}`);
    fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
    copyData(DATA_DIR, dataDir);
    const r = await runWorker({ task, mode: 'build', configPath: path.join(dataDir, 'config.json'), timeoutMs: Number(opts.timeoutMs) || 8 * 60 * 1000, workspace: ws, dataDir, pluginsDir: process.env.DUAL_AGENT_PLUGINS_DIR || path.join(ROOT, 'plugins'), skillsDir: process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT, 'skills'), label: 'curriculum' });
    // 沙箱工作区的意图契约（worker 执行时抽取）作为 benchmark 元数据
    let intent = null; try { intent = JSON.parse(fs.readFileSync(path.join(ws, '.intent.json'), 'utf8')); } catch { /* 无契约按裸任务入池 */ }
    const rec = recordBenchmark({ task, intent, objective: Array.isArray(t.objective) ? t.objective : undefined, finalText: r.finalText, artifacts: r.artifacts || [], ws: 'auto-curriculum' });
    if (rec) created.push({ id: rec.id, task: rec.task.slice(0, 120), ranOk: !!r.ok });
  }
  return { ok: true, requested: n, generated: taskList.length, created };
}

// 基因胜负统计（2026-09-04 优化 10）：多轮实验后可识别失效基因。
// 只统计使基因生效的操作（add/modify/enable）；实验结束即对生产库中该基因记一次 trial，
// pass→wins，fail→losses。add 的基因未晋级前不在生产库——首次 stats 在 promote 时初始化。
function updateGeneStats(mutation, pass) {
  try {
    if (!mutation || mutation.type !== 'gene') return;
    let op = mutation.change;
    try { op = typeof op === 'string' ? JSON.parse(op) : op; } catch { return; }
    if (!op || typeof op !== 'object') return;
    if (!['modify', 'enable'].includes(op.action)) return; // add 在 promote 时初始化
    // 同步读改写：单线程下天然原子（无 await 穿插窗口）
    const j = readJson(GENES_PATH, { genes: [] });
    const g = (j.genes || []).find(x => x.id === op.id);
    if (!g) return;
    g.stats = g.stats || { trials: 0, wins: 0, losses: 0 };
    g.stats.trials++;
    if (pass) g.stats.wins++; else g.stats.losses++;
    writeJson(GENES_PATH, j);
  } catch { /* 统计失败不影响主流程 */ }
}

// ---- 晋级后退化看门狗（短板高4）----
// activeMutation 晋级后跟踪生产任务质量（hard/返修占比），相比晋级前基线恶化超容差时
// 自动停用该 mutation 并写审计日志——进化系统的信任闭环：坏变异能被自动发现并撤销。
// 覆盖 prompt/gene/strategy/memory（STATE 路径）；plugin/skill 仅记录不自动回滚。
// 阈值：观察 window 个任务后，hard 率比基线高 WATCHDOG_TOLERANCE 即触发。
// DUAL_AGENT_EVOLUTION_WATCHDOG=0 关闭。
const WATCHDOG_TOLERANCE = Number(process.env.DUAL_AGENT_EVOLUTION_WATCHDOG_TOLERANCE) || 0.25;
function watchdogBaselineHardRate() {
  try {
    const cases = listBenchmarks().slice(-20);
    if (!cases.length) return 0;
    return cases.filter(c => c.hard).length / cases.length;
  } catch { return 0; }
}
function checkMutationWatchdog(rec) {
  try {
    if (process.env.DUAL_AGENT_EVOLUTION_WATCHDOG === '0') return;
    const state = readJson(STATE, {});
    const wd = state.watchdog;
    if (!wd || wd.done) return;
    wd.tasks = (wd.tasks || 0) + 1;
    if (rec && (rec.hard || (Number(rec.repairs) || 0) > 0)) wd.hardCount = (wd.hardCount || 0) + 1;
    const finish = (action, rate) => {
      wd.done = true; wd.finalRate = rate; wd.action = action;
      { const cur = readJson(STATE, {}); cur.watchdog = wd; writeJson(STATE, cur); }
      try {
        fs.appendFileSync(path.join(EV_ROOT, 'watchdog-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), experiment: wd.experimentId, mutation: wd.mutation, baselineHardRate: wd.baseline, regressionRate: rate, window: wd.tasks, action }) + '\n');
      } catch { /* 审计日志失败不影响 */ }
      // 回归自动取证（效果评估闭环 B）：退化确认后把观察窗口内的失败/返修任务重新以缺口
      // 形式入池（标记 regression），analyzeFailureModes 提炼后成为下一轮实验的靶向燃料——
      // 「评估发现退化」直接变成「进化优先修它」
      if (action !== 'healthy') {
        try {
          const wins = parseEvalEvents().slice(-wd.tasks).filter(r => !r.success || r.repairs > 0);
          for (const w of wins.slice(0, 8)) {
            recordGap({ ts: new Date().toISOString(), task: w.task, acceptance: [], gaps: [`晋级退化取证（${action}）：该任务在退化观察窗口内失败/返修，需针对性强化`], repairs: w.repairs || 0, regression: true });
          }
        } catch { /* 取证失败不影响看门狗处置 */ }
      }
      console.log('[evolution-watchdog] 晋级后质量观察完成:', action, `(hard 率 ${wd.baseline} → ${rate})`);
    };
    if (wd.tasks < wd.window) { { const cur = readJson(STATE, {}); cur.watchdog = wd; writeJson(STATE, cur); } return; }
    const rate = wd.hardCount / wd.tasks;
    if (wd.baseline === 0 && rate === 0 || rate <= wd.baseline + WATCHDOG_TOLERANCE) { finish('healthy', rate); return; }
    // 退化确认：按 mutation 类型自动处置
    const mut = state.activeMutation;
    let action = 'logged-unsupported-type';
    if (mut && mut.type === 'gene') {
      try {
        let op = mut.change; try { op = typeof op === 'string' ? JSON.parse(op) : op; } catch {}
        if (op && op.id) {
          const applied = applyGeneOp(readJson(GENES_PATH, { genes: [] }).genes, { action: 'disable', id: op.id });
          if (!applied.error) { writeJson(GENES_PATH, { genes: applied.genes, updatedAt: new Date().toISOString() }); action = 'gene-disabled:' + op.id; }
        }
      } catch { action = 'logged-gene-disable-failed'; }
    } else if (mut && ['prompt', 'strategy', 'memory'].includes(mut.type)) {
      const cur = readJson(STATE, {});
      cur.activeMutation = null; cur.version = (Number(cur.version) || 0) + 1; writeJson(STATE, cur);
      if (mut.type === 'prompt') { try { fs.unlinkSync(path.join(EV_ROOT, 'system-patch.txt')); } catch { /* 本就不存在 */ } }
      action = 'mutation-revoked:' + mut.type;
    }
    finish(action, rate);
  } catch { /* 看门狗失败不影响主流程 */ }
}

function promoteMutation(mutation, experimentId) {
  try {
    if (mutation.type==='plugin') {
      const name=String(mutation.target||'').replace(/\.js$/,'');
      const code=String(mutation.change||'');
      const exists=!!plugins.readCode(name);
      const p={id:`e-${Date.now().toString(36)}`,action:exists?'update':'create',plugin:name,code,reason:`evolution promote ${experimentId}`};
      return approval.applyForEvolution ? approval.applyForEvolution(p,experimentId) : approval.manualSave(name,code);
    }
    // prompt/skill/strategy/memory/gene 的 Promote 使用 evolution state，而非偷偷改生产核心。
    const state=readJson(STATE,{});
    state.version=(Number(state.version)||0)+1; state.activeMutation=mutation; state.experimentId=experimentId; state.updatedAt=new Date().toISOString();
    if (mutation.type==='prompt') {
      const fp=path.join(EV_ROOT,'system-patch.txt'); fs.writeFileSync(fp,String(mutation.change||''),'utf8');
    } else if (mutation.type==='gene') {
      let op = mutation.change;
      try { op = typeof mutation.change === 'string' ? JSON.parse(mutation.change) : mutation.change; } catch { op = null; }
      const applied = applyGeneOp(readJson(GENES_PATH, { genes: [] }).genes, op);
      if (applied.error) throw new Error('gene promote 被拒绝：' + applied.error);
      for (const g of applied.genes) {
        if (g.origin === 'evolution' || !g.origin) g.origin = 'evolution:' + experimentId;
        // add 晋级即首次生效：初始化 stats（modify/enable 的胜负由 updateGeneStats 统一记，避免双计）
        if (op && op.action === 'add' && g.id.startsWith('g-') && !g.stats) g.stats = { trials: 1, wins: 1, losses: 0 };
      }
      writeJson(GENES_PATH, { genes: applied.genes, updatedAt: new Date().toISOString() });
    } else if (mutation.type==='strategy'||mutation.type==='memory') writeJson(path.join(EV_ROOT,'strategy.json'),typeof mutation.change==='string'?JSON.parse(mutation.change):(mutation.change||{}));
    else if (mutation.type==='skill') {
      const rel=String(mutation.target||'').replace(/^skills[\\/]/,''); const skillRoot=process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT,'skills'); const fp=path.join(skillRoot,rel); fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,String(mutation.change||''),'utf8');
    }
    // 晋级后退化看门狗（短板高4）：记录晋级时刻的质量基线（近期 hard 占比）+ 观察窗口，
    // 生产任务经 recordBenchmark 逐个喂给 checkMutationWatchdog；plugin/skill 类型涉及
    // 交付文件不自动回滚，仅记录观察（告警人工介入）
    if (!['plugin','skill'].includes(mutation.type)) {
      state.watchdog = { experimentId, startedAt: new Date().toISOString(), mutation: { type: mutation.type, target: mutation.target }, baseline: watchdogBaselineHardRate(), window: Number(process.env.DUAL_AGENT_EVOLUTION_WATCHDOG_WINDOW) || 10, tasks: 0, hardCount: 0 };
    }
    writeJson(STATE,state); approval.audit('evolution-promote',{experimentId,type:mutation.type,target:mutation.target}); return {ok:true,version:state.version};
  } catch(e) { return {ok:false,error:String(e.message||e)}; }
}

function updateLeaderboard(decision) {
  // 同步读改写：单线程下天然原子；writeJson 已原子化（tmp+rename）
  const list=readJson(LEADERBOARD,[]); list.push({experiment:decision.experiment,mutation:decision.mutation,summary:decision.summary,ts:decision.createdAt});
  list.sort((a,b)=>(b.summary.meanDelta||0)-(a.summary.meanDelta||0)); writeJson(LEADERBOARD,list.slice(0,100));
}

function mutationExplanation(mutation, summary, promotion) {
  const type = String(mutation && mutation.type || '');
  const target = String(mutation && mutation.target || '');
  const labels = { plugin:'插件', prompt:'执行提示策略', gene:'Prompt 基因', skill:'技能', strategy:'执行策略', memory:'记忆召回' };
  const action = labels[type] || type || '系统策略';
  let whatChanged = String(mutation && mutation.change || '').trim();
  if (type === 'plugin') whatChanged = `更新插件「${target.replace(/\.js$/,'')}」的实现逻辑`;
  else if (type === 'skill') whatChanged = `更新技能「${target}」的指导内容`;
  else if (type === 'gene') {
    let op = null; try { op = typeof mutation.change === 'string' ? JSON.parse(mutation.change) : mutation.change; } catch { op = null; }
    const opLabel = { add:'新增', modify:'修改', enable:'启用', disable:'停用', remove:'移除' };
    whatChanged = `${opLabel[op && op.action] || '更新'}执行提示基因${op && op.id ? `（${op.id}）` : ''}：${String(op && op.text || '').slice(0, 200)}`;
  }
  else if (type === 'prompt') whatChanged = '调整 Agent 的执行提示与行为约束';
  else if (type === 'strategy') whatChanged = `调整「${target || '执行'}」策略参数`;
  else if (type === 'memory') whatChanged = `调整「${target || '记忆召回'}」策略`;
  if (whatChanged.length > 900) whatChanged = whatChanged.slice(0, 900) + '…';
  const pass = !!(summary && summary.pass);
  return {
    action,
    target,
    whatChanged,
    why: String(mutation && (mutation.reason || mutation.hypothesis) || '根据历史任务表现自动寻找改进机会。').slice(0, 1600),
    hypothesis: String(mutation && mutation.hypothesis || '').slice(0, 1600),
    expectedDelta: Number(mutation && mutation.expectedDelta) || 0,
    result: pass ? '验证通过，候选版本优于当前版本' : '验证未通过，保留当前版本',
    promoted: !!(promotion && promotion.ok),
    promotedVersion: promotion && promotion.version || null
  };
}

function history(limit=50) {
  ensure();
  const rows = [];
  const seen = new Set();
  try {
    const files = fs.readdirSync(EXPS).filter(n => n.startsWith('exp-'));
    for (const name of files) {
      const exp = path.join(EXPS, name);
      const decision = readJson(path.join(exp,'decision.json'), null);
      if (!decision || !decision.createdAt) continue;
      seen.add(decision.experiment || name);
      rows.push({
        experiment: decision.experiment || name,
        createdAt: decision.createdAt,
        mutation: decision.mutation || {},
        summary: decision.summary || {},
        promotion: decision.promotion || null,
        explanation: mutationExplanation(decision.mutation || {}, decision.summary || {}, decision.promotion || null)
      });
    }
  } catch {}
  // 归档（净化）或目录缺失的实验从 experience.jsonl 补齐，保证进化史完整可见
  try {
    const raw = fs.readFileSync(path.join(EV_ROOT,'experience.jsonl'),'utf8');
    for (const line of raw.split('\n').filter(Boolean)) {
      let x; try { x=JSON.parse(line); } catch { continue; }
      if (!x || !x.experiment || seen.has(x.experiment)) continue;
      seen.add(x.experiment);
      rows.push({
        experiment: x.experiment,
        createdAt: x.ts || '',
        mutation: x.mutation || {},
        summary: x.summary || {},
        promotion: x.promotion || null,
        explanation: mutationExplanation(x.mutation || {}, x.summary || {}, x.promotion || null)
      });
    }
  } catch {}
  rows.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows.slice(0, Math.max(1, Math.min(200, Number(limit)||50)));
}

function status() {
  const state=readJson(STATE,{});
  const hist=history(50);
  return {
    benchmarks:listBenchmarks().length,
    // 攒批进度：自上次实验完成以来的新任务数 / 自动触发门槛（前端展示"距下次自动实验"）
    newSinceLastExp:newBenchmarksSinceLastExp(),
    minNewCases:Number(process.env.DUAL_AGENT_EVOLUTION_MIN_NEW_CASES) || 3,
    resumable:!!findResumableExperiment(),
    llmSource:evoLlmSource(), // evolution=独立进化 API；inner=回退共用执行 API
    health:healthScore(50),   // 系统健康分（0-100，最近 50 任务效果快照）
    healthTrend:healthTrend(),// 版本间效果对比：进化是否真的有效
    healthDropping:healthDropping(), // 退化触发线状态（供观测）
    assets:assetCounts(),     // 经验资产计数（随任务持续增长的快速成长指标）
    state,
    leaderboard:readJson(LEADERBOARD,[]).slice(0,10),
    history:hist,
    latest:hist[0] || null  };
}
// 进化实验实时进度：供前端"进化过程"视图轮询展示动态进程
function liveStatus() {
  let dirs=[]; try { dirs=fs.readdirSync(EXPS).filter(n=>n.startsWith('exp-')).sort(); } catch {}
  if (!dirs.length) return { active:false, phase:'idle' };
  const name=dirs[dirs.length-1];
  const exp=path.join(EXPS,name);
  const decision=readJson(path.join(exp,'decision.json'),null);
  if (decision) return { active:false, phase:'done', experiment:name, summary:decision.summary||{}, promoted:decision.promotion||null };
  const proposal=readJson(path.join(exp,'proposal.json'),null);
  if (!proposal) return { active:false, phase:'idle' };
  const casesDir=path.join(exp,'cases');
  let caseIds=[]; try { caseIds=fs.readdirSync(casesDir).filter(n=>!n.startsWith('.')).sort(); } catch {}
  const cases=caseIds.map(id=>({ id, done:fs.existsSync(path.join(casesDir,id,'result.json')) }));
  const doneCount=cases.filter(c=>c.done).length;
  const startedAt=(()=>{ try { return fs.statSync(path.join(exp,'proposal.json')).mtimeMs; } catch { return Date.now(); } })();
  return {
    active:true, phase:'running', experiment:name,
    mutation:{ type:proposal.type, target:proposal.target },
    startedAt, elapsedSec:Math.round((Date.now()-startedAt)/1000),
    cases, total:cases.length, done:doneCount
  };
}
function shouldAutoEvolve() { return process.env.DUAL_AGENT_AUTO_EVOLVE !== '0' && !process.env.DUAL_AGENT_EVOLUTION_RUNNING; }
function shouldAutoPromote() { return process.env.DUAL_AGENT_AUTO_PROMOTE !== '0'; }

module.exports={recordBenchmark,artifactManifest,runEvolution,status,history,liveStatus,currentSignature,shouldAutoEvolve,shouldAutoPromote,EV_ROOT,listGaps,rankHardFirst,recordGap,checkEarlyStop,recordLessons,listRelevantLessons,lessonsPromptSection,growPool,splitPool,listGenes,enabledGenes,applyGeneOp,genesPromptSection,analyzeFailureModes,targetsFailureModes,recordLlmUsage,recordPlaybook,listRelevantPlaybooks,playbooksPromptSection,parseAcceptanceObjective,evaluateObjectives,promoteLessonsToSkill,updateGeneStats,setExperienceStore,buildSimilarExperienceSection,newBenchmarksSinceLastExp,findResumableExperiment,evoConfig,evoLlmSource,isRateLimitText,recordTaskOutcome,healthScore,healthTrend,healthDropping,assetCounts,listAssets,cleanupStale};
