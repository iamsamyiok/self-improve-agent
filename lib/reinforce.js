// lib/reinforce.js — 强化处理（v3.5）：失败/困难任务的错题本闭环。
// 一期：失败任务自动入补练队列 → 空闲时段 LLM 失败分析（根因分类 + 强化简报）→
//       沙箱重做（简报以 systemPatch 注入，与原失败唯一差异即这份针对性提示）→ 核验。
// 二期：补练通过的简报自动沉淀（规则性 → 基因候选入池走 A/B；流程性 → 技能文件）；
//       同根因失败 ≥3 次聚类为靶向实验提案，注入 Meta-Agent prompt 优先处理。
// 设计原则：补练是单任务针对性训练（快速反馈层），沉淀物必须过 A/B 才成为通用能力（严谨验证层）。

const fs = require('fs');
const path = require('path');
const { callLLMText, parseLooseJson } = require('./intent');
const { evoConfig, recordLlmUsage, EV_ROOT, runWorker, copyData, DATA_DIR, ROOT, listBenchmarks } = require('./evolution');

const REINFORCE_DIR = path.join(EV_ROOT, 'reinforce');
const QUEUE_FP = path.join(REINFORCE_DIR, 'queue.json');
const LOG_FP = path.join(REINFORCE_DIR, 'reinforce.jsonl');
const CLUSTERS_FP = path.join(REINFORCE_DIR, 'clusters.json');
const STATE_FP = path.join(REINFORCE_DIR, 'state.json');

const QUEUE_MAX = 20;                 // 队列上限：防失败风暴挤爆
const MAX_ATTEMPTS = 3;               // 单任务最多补练次数，全败升级为聚类提案
const DAILY_BUDGET = Math.max(1, Number(process.env.DUAL_AGENT_REINFORCE_DAILY_BUDGET) || 5);
const USAGE_LABEL = '强化补练';
const ROOT_CAUSES = ['tool_misuse', 'knowledge_gap', 'planning_flaw', 'acceptance_misread', 'external_dependency'];

function ensure() { fs.mkdirSync(REINFORCE_DIR, { recursive: true }); }
function readJson(fp, fallback) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; } }
function writeJson(fp, obj) { ensure(); fs.writeFileSync(fp, JSON.stringify(obj, null, 1), 'utf8'); }
function nowId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function sha(s) { return require('crypto').createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
function today() { return new Date().toISOString().slice(0, 10); }

// ===== 一期：失败任务入队 =====
// 判定：任务失败 / 返修≥2 / 难例标记 / 中断 / 未完成——任一命中即需要强化
function needsReinforce(outcome) {
  if (!outcome) return false;
  return !outcome.success || (Number(outcome.repairs) >= 2) || !!outcome.hard || !!outcome.aborted || !!outcome.undone;
}

function enqueue(task, outcome) {
  const db = readJson(QUEUE_FP, { items: [] });
  task = String(task || '').trim().slice(0, 600);
  if (!task) return null;
  const key = sha(task.slice(0, 300));
  if (db.items.some(i => i.key === key && i.status !== 'escalated')) return null; // 同任务去重（已升级的允许重新入队）
  if (db.items.filter(i => i.status === 'pending').length >= QUEUE_MAX) return null; // 队列满：丢弃最旧的 pending
  const item = {
    id: nowId('rf'), key, task: task.slice(0, 600),
    outcome: { success: !!(outcome && outcome.success), repairs: Number(outcome && outcome.repairs) || 0, hard: !!(outcome && outcome.hard), aborted: !!(outcome && outcome.aborted), undone: !!(outcome && outcome.undone) },
    attempts: 0, rootCause: null, status: 'pending', createdAt: new Date().toISOString()
  };
  db.items.push(item);
  if (db.items.length > QUEUE_MAX * 2) db.items = db.items.filter(i => i.status === 'pending').concat(db.items.filter(i => i.status !== 'pending').slice(-QUEUE_MAX));
  writeJson(QUEUE_FP, db);
  return item.id;
}

// recordTaskOutcome 采集点钩子（evolution.js 运行时 try-require 调用；容错不抛）
function onTaskOutcome(outcome) {
  try { if (needsReinforce(outcome)) enqueue(outcome.task, outcome); } catch { /* 入队失败不影响 */ }
}

// ===== 失败分析：根因分类 + 强化简报 =====
async function analyzeFailure(item) {
  // 带上相关历史教训上下文（若有）：分析不凭空想
  let lessonsCtx = '';
  try {
    const { listRelevantLessons } = require('./evolution');
    const hits = listRelevantLessons(item.task, 2);
    if (hits && hits.length) lessonsCtx = '\n== 相关历史教训 ==\n' + hits.map(l => `- ${l.lesson}`).join('\n');
  } catch { /* 教训召回失败不影响 */ }
  const retryHint = item.attempts > 0 ? `\n注意：本任务已补练 ${item.attempts} 次仍未通过，请换一个角度分析根因，避免重复无效建议。` : '';
  const text = await callLLMText(evoConfig(), [
    { role: 'system', content: '只输出严格 JSON 对象，无解释文字、无 markdown 围栏。' },
    { role: 'user', content: [
      '你是 Agent 教练。下面的任务执行失败或非常困难（多次返修/中断），请分析根因并生成一份「强化简报」——给 Agent 下次重做这份任务时的针对性做法提示。',
      '要求：',
      '1. rootCause 从五类中选一：tool_misuse（工具用错/用坏）、knowledge_gap（缺领域知识）、planning_flaw（规划/顺序缺陷）、acceptance_misread（理解错验收要求）、external_dependency（依赖外部不可控因素）；',
      '2. 强化简报 ≤200 字，必须具体可执行（怎么做），与任务描述一起注入后能让 Agent 避开本次失败点；禁止空话（如「要更仔细」）；',
      '3. 若根因是 external_dependency（任务本身不可控），简报写明降级策略。',
      '输出严格 JSON：{"rootCause":"五类之一","brief":"强化简报"}',
      '', `== 任务 ==`, item.task,
      `== 失败情况 ==`, JSON.stringify(item.outcome), retryHint, lessonsCtx
    ].filter(Boolean).join('\n') }
  ], { maxTokens: 600, label: USAGE_LABEL, onUsage: u => recordLlmUsage(USAGE_LABEL, u) });
  const j = parseLooseJson(text) || {};
  const rootCause = ROOT_CAUSES.includes(j.rootCause) ? j.rootCause : 'planning_flaw';
  const brief = String(j.brief || '').trim().slice(0, 400);
  return { rootCause, brief };
}

// ===== 沙箱补练：同一任务 + 强化简报（systemPatch 注入）重做 =====
async function replay(item, brief) {
  const runRoot = path.join(REINFORCE_DIR, 'runs', item.id + '-' + item.attempts);
  const ws = path.join(runRoot, 'workspace'), dataDir = path.join(runRoot, 'data');
  fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
  copyData(DATA_DIR, dataDir);
  const r = await runWorker({
    task: item.task, mode: 'build', configPath: path.join(dataDir, 'config.json'),
    timeoutMs: 8 * 60 * 1000, workspace: ws, dataDir,
    pluginsDir: process.env.DUAL_AGENT_PLUGINS_DIR || path.join(ROOT, 'plugins'),
    skillsDir: process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT, 'skills'),
    systemPatch: brief, genes: [], label: 'reinforce'
  });
  const passed = await verifyReplay(item, r, ws);
  return { passed, result: r, ws };
}

// 补练核验：有 objective 断言（来自 benchmark 的任务）→ 程序化判定；
// 真实任务无断言 → LLM judge（对照任务描述与产物判定是否达成）
async function verifyReplay(item, r, ws) {
  if (item.objective && Array.isArray(item.objective) && item.objective.length) {
    try {
      const { evaluateObjectives } = require('./evolution');
      return evaluateObjectives(ws, item.objective).every(x => x.ok);
    } catch { /* 断言失败走 LLM judge 兜底 */ }
  }
  const arts = (r && r.artifacts || []).map(a => String(a.path || a)).join('、') || '（无产物清单）';
  const text = await callLLMText(evoConfig(), [
    { role: 'system', content: '只输出严格 JSON 对象，无解释文字。' },
    { role: 'user', content: [
      '判定 Agent 重做任务是否达成。依据任务描述与产物清单判断，宁缺勿滥（产物无法证明达成就判 false）。',
      '输出严格 JSON：{"pass":true/false,"reason":"一句话依据"}',
      '', `== 任务 ==`, item.task, `== 产物清单 ==`, arts, `== 交付说明（截断）==`, String((r && r.finalText) || '').slice(0, 600)
    ].join('\n') }
  ], { maxTokens: 200, label: USAGE_LABEL, onUsage: u => recordLlmUsage(USAGE_LABEL, u) });
  const j = parseLooseJson(text) || {};
  return !!j.pass;
}

// ===== 主流程：处理补练队列（受每日预算约束）=====
async function processQueue(opts = {}) {
  const state = readJson(STATE_FP, { days: {} });
  const day = today();
  state.days[day] = state.days[day] || { processed: 0, passed: 0 };
  state.lastRunAt = new Date().toISOString();
  writeJson(STATE_FP, state);

  const db = readJson(QUEUE_FP, { items: [] });
  const budget = Number(opts.budget) || DAILY_BUDGET;
  const quota = Math.max(0, budget - (state.days[day].processed || 0));
  const pending = db.items.filter(i => i.status === 'pending').slice(0, quota);
  const stats = { processed: 0, passed: 0, failed: 0, escalated: 0, promoted: 0 };

  for (const item of pending) {
    // MOCK 模式：固定分析与成功重放（端到端验证管线，不触网不调 LLM）
    const analysis = process.env.DUAL_AGENT_MOCK === '1'
      ? { rootCause: 'planning_flaw', brief: '复杂任务开始前必须先用 todo.add 建立计划清单，把验收要求拆成逐条清单项，每完成一项用 verify 工具核对一项，全部通过后才交付交付说明。' }
      : await analyzeFailure(item);
    item.rootCause = analysis.rootCause;
    const run = process.env.DUAL_AGENT_MOCK === '1'
      ? { passed: true, result: { finalText: 'mock reinforce ok', artifacts: [] }, ws: path.join(REINFORCE_DIR, 'runs', 'mock') }
      : await replay(item, analysis.brief);
    stats.processed++;
    state.days[day].processed = (state.days[day].processed || 0) + 1;
    item.attempts++;
    log({ ts: new Date().toISOString(), itemId: item.id, task: item.task.slice(0, 120), attempt: item.attempts, rootCause: analysis.rootCause, passed: run.passed });
    if (run.passed) {
      item.status = 'reinforced';
      stats.passed++; state.days[day].passed = (state.days[day].passed || 0) + 1;
      // 二期：有效简报沉淀（规则性 → 基因候选；流程性 → 技能文件）
      const promo = promoteBrief(item, analysis.brief);
      if (promo) stats.promoted++;
      log({ ts: new Date().toISOString(), itemId: item.id, event: 'reinforced', promoted: promo || null });
    } else if (item.attempts >= MAX_ATTEMPTS) {
      item.status = 'escalated';
      stats.escalated++;
      bumpCluster(item.rootCause, item.task);
      log({ ts: new Date().toISOString(), itemId: item.id, event: 'escalated', rootCause: analysis.rootCause });
    } else {
      stats.failed++; // 留在队列，下次换角度分析
    }
    writeJson(QUEUE_FP, db); // 持久化 item 状态更新（db.items 与 pending 共享引用）
  }
  writeJson(STATE_FP, state);
  return Object.assign({ ok: true, date: day, remaining: readJson(QUEUE_FP, { items: [] }).items.filter(i => i.status === 'pending').length }, stats);
}

// ===== 二期：有效简报沉淀 =====
// 简报性质自动分派：含步骤编号或偏流程 → 技能文件（显式知识，scout 前缀同款规范）；
// 一句话规则 → 基因候选入 pending 池（必须过进化实验 A/B 才启用）
function promoteBrief(item, brief) {
  if (!brief || brief.length < 20) return null;
  const sc = require('./scout');
  if (/^\s*\d+[.、)]/m.test(brief) || brief.length > 150) {
    const slug = 'reinforce-' + sha(item.task).slice(0, 8);
    const dir = path.join(process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT, 'skills'), slug);
    fs.mkdirSync(dir, { recursive: true });
    const front = `---\nname: ${slug}\ndescription: ${String(item.task).replace(/\n/g, ' ').slice(0, 80)} 类任务的强化做法（补练验证有效）\nsource: reinforce\nlearnedAt: ${new Date().toISOString()}\n---\n\n# 强化做法（来自失败任务补练）\n\n原任务：${item.task}\n\n${brief}\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), front, 'utf8');
    return { form: 'skill', target: slug };
  }
  const gid = sc.addPendingGene(brief, 'reinforce', item.rootCause || '');
  return gid ? { form: 'gene', target: gid } : null;
}

// ===== 二期：同类失败聚类 → 靶向实验提案 =====
// 同根因累计 ≥3 个任务升级（escalated）→ 聚类标记 proposal，注入 Meta-Agent prompt
function bumpCluster(rootCause, task) {
  if (!rootCause) return;
  const db = readJson(CLUSTERS_FP, { causes: {} });
  const c = db.causes[rootCause] || { count: 0, tasks: [], status: 'watch' };
  c.count++;
  c.tasks = [...new Set([...c.tasks, String(task).slice(0, 100)])].slice(-5);
  if (c.count >= 3) c.status = 'proposal';
  db.causes[rootCause] = c;
  writeJson(CLUSTERS_FP, db);
}

function clustersPromptSection() {
  const db = readJson(CLUSTERS_FP, { causes: {} });
  const proposals = Object.entries(db.causes || {}).filter(([, c]) => c.status === 'proposal');
  if (!proposals.length) return '';
  const label = { tool_misuse: '工具误用', knowledge_gap: '知识缺失', planning_flaw: '规划缺陷', acceptance_misread: '验收误解', external_dependency: '外部依赖' };
  return [
    '== 强化处理聚类提案（补练反复失败的同类任务根因，优先靶向）==',
    ...proposals.map(([cause, c]) => `- [${label[cause] || cause}] 累计 ${c.count} 个任务补练 ${MAX_ATTEMPTS} 次仍失败。典型任务：${c.tasks.slice(-2).join(' / ')}`),
    '上述根因靠单任务补练已无法解决，需要结构化 mutation（技能/基因/插件层面）。'
  ].join('\n');
}

function log(entry) {
  ensure();
  fs.appendFileSync(LOG_FP, JSON.stringify(entry) + '\n', 'utf8');
}

// 队列是否有待处理（空闲调度判定：补练优先于 scout）
function reinforceDue() {
  const db = readJson(QUEUE_FP, { items: [] });
  const state = readJson(STATE_FP, { days: {} });
  const used = (state.days && state.days[today()] && state.days[today()].processed) || 0;
  return db.items.some(i => i.status === 'pending') && used < DAILY_BUDGET;
}

function reinforceStatus() {
  const db = readJson(QUEUE_FP, { items: [] });
  const state = readJson(STATE_FP, { days: {} });
  const clusters = readJson(CLUSTERS_FP, { causes: {} });
  const day = today();
  let total = 0, passed = 0;
  try { for (const line of fs.readFileSync(LOG_FP, 'utf8').split('\n').filter(Boolean)) { const j = JSON.parse(line); if (j.passed !== undefined) { total++; if (j.passed) passed++; } } } catch { /* 无账本 */ }
  const items = db.items || [];
  return {
    success: true,
    dailyBudget: DAILY_BUDGET,
    todayProcessed: (state.days && state.days[day] && state.days[day].processed) || 0,
    queue: { pending: items.filter(i => i.status === 'pending').length, reinforced: items.filter(i => i.status === 'reinforced').length, escalated: items.filter(i => i.status === 'escalated').length },
    due: reinforceDue(),
    totals: { attempts: total, passed, successRate: total ? Math.round(passed / total * 100) : null, proposals: Object.values(clauses(clusters)).filter(c => c.status === 'proposal').length },
    recent: recentLog(3)
  };
}
function clauses(c) { return c.causes || {}; }
function recentLog(n) {
  try { return fs.readFileSync(LOG_FP, 'utf8').split('\n').filter(Boolean).slice(-n).reverse().map(l => JSON.parse(l)); } catch { return []; }
}

module.exports = { needsReinforce, enqueue, onTaskOutcome, processQueue, analyzeFailure, replay, promoteBrief, bumpCluster, clustersPromptSection, reinforceDue, reinforceStatus, ROOT_CAUSES, DAILY_BUDGET };
