// lib/scout.js — 外部侦察（v3.4.2）：每日从 GitHub 热门 agent 项目学习运行机制，
// 迁移改造为本程序资产（技能直接入库 / 基因入池待 A/B 验证）。
// 设计原则：知识类资产（技能=显式知识 markdown）校验通过即入库，无需人工审批；
// 行为类资产（基因）只入 pending 池，必须经进化实验 A/B 验证胜出才启用。
// 「真适用」硬校验：落地技能必须引用本程序真实存在的工具名，否则重写一次、再失败丢弃。

const fs = require('fs');
const path = require('path');
const { callLLMText, parseLooseJson } = require('./intent');
const { evoConfig, recordLlmUsage, EV_ROOT } = require('./evolution');

const ROOT = path.join(__dirname, '..');
const SKILLS_ROOT = () => process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT, 'skills');
const SCOUT_DIR = path.join(EV_ROOT, 'scout');
const SEEN_FP = path.join(SCOUT_DIR, 'seen-projects.json');
const MECH_LOG = path.join(SCOUT_DIR, 'mechanisms.jsonl');
const PENDING_FP = path.join(SCOUT_DIR, 'pending-genes.json');
const STATE_FP = path.join(SCOUT_DIR, 'state.json');

const DAILY_GOAL = Math.max(1, Number(process.env.DUAL_AGENT_SCOUT_DAILY_GOAL) || 5);   // 每日资产目标
const MAX_REPOS = Math.max(DAILY_GOAL, Number(process.env.DUAL_AGENT_SCOUT_MAX_REPOS) || 8); // 每日最多侦察项目数
const README_MAX = Number(process.env.DUAL_AGENT_SCOUT_README_MAX) || 24000; // README 截断：机制信息集中在头部，
                                                                             // 24K 字符（≈17K tokens）远小于上下文预算
                                                                             // （Agnes 窗口 80%，见 lib/limits.js），多带全量特性列表
const MECHS_PER_REPO = 3;    // 每项目最多提炼机制数
const USAGE_LABEL = '外部学习 Scout';

function ensure() { fs.mkdirSync(SCOUT_DIR, { recursive: true }); }
function readJson(fp, fallback) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; } }
function writeJson(fp, obj) { ensure(); fs.writeFileSync(fp, JSON.stringify(obj, null, 1), 'utf8'); }
function nowId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

// 本程序工具清单（plugins/*.js 文件名）：适配校验与架构摘要共用
function toolNames() {
  try { return fs.readdirSync(path.join(ROOT, 'plugins')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)); } catch { return []; }
}

// ===== 发现：GitHub Search API 拉热门 agent 项目（匿名 10 req/min，每日只需 1-2 次）=====
async function discovery(limit) {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const q = `topic:ai-agents stars:>500 pushed:>${since}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'dual-agent-scout', 'Accept': 'application/vnd.github+json' } });
  if (!resp.ok) throw new Error(`GitHub Search 失败（HTTP ${resp.status}）`);
  const data = await resp.json();
  const seen = readJson(SEEN_FP, { repos: {} }).repos || {};
  return (data.items || [])
    .filter(r => r.stargazers_count >= 500)
    .map(r => ({ repo: r.full_name, stars: r.stargazers_count, desc: String(r.description || '').slice(0, 200) }))
    .filter(r => !seen[r.repo])
    .slice(0, limit);
}

// ===== 抓取 README（raw 域名，不占 API 配额）=====
async function fetchReadme(repo) {
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README.zh-CN.md']) {
    try {
      const resp = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${name}`, { headers: { 'User-Agent': 'dual-agent-scout' } });
      if (resp.ok) return String(await resp.text()).slice(0, README_MAX);
    } catch { /* 试下一个变体 */ }
  }
  return '';
}

// ===== 提炼：README → 机制卡（LLM，严格 JSON）=====
async function extractMechanisms(repo, readme) {
  const text = await callLLMText(evoConfig(), [
    { role: 'system', content: '只输出严格 JSON 对象，无解释文字、无 markdown 围栏。' },
    { role: 'user', content: [
      '你是 Agent 架构分析师。阅读下面的开源 agent 项目 README，提炼出「可迁移的运行机制」——即该项目让 agent 更可靠/更强的工作方式（如反思回路、计划执行分离、工具结果裁剪、技能动态加载、多智能体协作等）。',
      '要求：',
      '1. 只提炼机制层面的知识，忽略安装方法、许可证、star 数等无关信息；',
      `2. 最多 ${MECHS_PER_REPO} 个机制，按对本类 agent 的价值排序；没有真有价值的机制就返回空数组；`,
      '3. 每个机制的 idea 必须具体到"怎么运作"（触发条件、流程、效果），禁止空话。',
      '输出严格 JSON：{"mechanisms":[{"name":"机制名","idea":"运作方式（100字内）","value":"对单进程工具型 agent 的适用价值（50字内）"}]}',
      '', `== 项目 ${repo} README ==`, readme || '（README 抓取失败，仅凭项目名判断）'
    ].join('\n') }
  ], { maxTokens: 1200, label: USAGE_LABEL, onUsage: u => recordLlmUsage(USAGE_LABEL, u) });
  const j = parseLooseJson(text);
  return (j && Array.isArray(j.mechanisms)) ? j.mechanisms.slice(0, MECHS_PER_REPO) : [];
}

// ===== 改造：机制卡 + 本程序架构摘要 → 落地提案（skill / gene / none）=====
function architectureSummary() {
  const tools = toolNames();
  let skills = []; try { skills = fs.readdirSync(SKILLS_ROOT()).slice(0, 30); } catch { /* 无技能目录 */ }
  return [
    '本程序是一个单进程 Node.js 工具型 agent（内层循环）：LLM + 工具调用循环执行任务，外层程序核验交付质量。',
    `可用工具（工具调用名即文件名）：${tools.join(', ')}。`,
    `任务循环能力：todo 清单、memory 检索、verify 自校验、subagent 子任务分派、skill 技能库（渐进式加载）。`,
    `现有技能（skills 目录，markdown 指南，agent 按描述匹配后读全文遵循）：${skills.join(', ') || '（空）'}。`
  ].join('\n');
}

async function adaptMechanism(mech) {
  const text = await callLLMText(evoConfig(), [
    { role: 'system', content: '只输出严格 JSON 对象，无解释文字、无 markdown 围栏。' },
    { role: 'user', content: [
      '你是 Agent 机制迁移工程师。把外部项目的运行机制改造为本程序可直接适用的资产，二选一：',
      'A. form="skill"：写成一份技能文件（markdown 操作指南）——适合「方法论/流程/纪律」类机制（如调试流程、计划纪律、核验清单）。技能必须引用上面工具清单中的真实工具名（如 todo.add、verify、read、write），给出可执行的步骤，agent 读了就能照做。',
      'B. form="gene"：提炼为一条行为基因（一句话规则，50字内）——适合「可 A/B 验证的行为开关」类机制（如工具选择偏好、验证强度）。基因将进入实验池，A/B 胜出才启用。',
      '若机制与本程序架构明显不适用（依赖多进程/容器/外部服务/模型微调），返回 form="none" 并说明原因。',
      '技能内容硬性要求：必须至少引用 1 个真实工具名（从工具清单里选），必须是「怎么做」的步骤而非「是什么」的介绍；长度 200-2000 字。',
      '输出严格 JSON：{"form":"skill","name":"技能名-slug","description":"一句话描述（何时用，80字内）","content":"完整技能 markdown"} 或 {"form":"gene","text":"基因规则"} 或 {"form":"none","reason":"原因"}',
      '', '== 本程序架构 ==', architectureSummary(),
      '', '== 待迁移机制 ==', JSON.stringify(mech)
    ].join('\n') }
  ], { maxTokens: 2200, label: USAGE_LABEL, onUsage: u => recordLlmUsage(USAGE_LABEL, u) });
  return parseLooseJson(text) || { form: 'none', reason: 'LLM 输出解析失败' };
}

// 适配硬校验：技能必须引用真实工具名 + 内容达标；不满足可重写一次
function validateSkill(adapt) {
  if (!adapt || adapt.form !== 'skill') return false;
  const content = String(adapt.content || '');
  if (content.length < 200 || content.length > 4000) return false;
  const tools = toolNames();
  return tools.some(t => content.includes(t));
}

function toSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || nowId('scout');
}

function saveSkill(repo, mech, adapt) {
  const slug = 'scout-' + toSlug(adapt.name || mech.name);
  const dir = path.join(SKILLS_ROOT(), slug);
  fs.mkdirSync(dir, { recursive: true });
  const front = `---\nname: ${slug}\ndescription: ${String(adapt.description || mech.name || '').replace(/\n/g, ' ').slice(0, 160)}\nsource: github:${repo}\nmechanism: ${String(mech.name || '').replace(/\n/g, ' ').slice(0, 80)}\nlearnedAt: ${new Date().toISOString()}\n---\n\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), front + String(adapt.content).trim() + '\n', 'utf8');
  return slug;
}

function savePendingGene(repo, mech, adapt) {
  const text = String(adapt.text || '').trim().slice(0, 200);
  if (!text) return null;
  return addPendingGene(text, `github:${repo}`, String(mech.name || '').slice(0, 80));
}

// 共享入池接口：外部学习（scout）与强化处理（reinforce）的基因候选统一入 pending 池，
// 由进化实验 A/B 验证胜出后才启用（markGeneValidated 翻转状态）
function addPendingGene(text, source, mechanism) {
  const db = readJson(PENDING_FP, { genes: [] });
  text = String(text || '').trim().slice(0, 400);
  if (!text) return null;
  if (db.genes.some(g => g.text === text)) return null; // 去重
  const gene = { id: nowId('sg'), text, source: String(source || '').slice(0, 120), mechanism: String(mechanism || '').slice(0, 80), status: 'pending', createdAt: new Date().toISOString() };
  db.genes.push(gene);
  writeJson(PENDING_FP, db);
  return gene.id;
}

function logMechanism(entry) {
  ensure();
  fs.appendFileSync(MECH_LOG, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, entry)) + '\n', 'utf8');
}

function markSeen(repo) {
  const db = readJson(SEEN_FP, { repos: {} });
  db.repos[repo] = Date.now();
  writeJson(SEEN_FP, db);
}

// ===== 主流程：每日目标 DAILY_GOAL 个资产 =====
async function runScout(opts = {}) {
  const state = readJson(STATE_FP, { lastRunAt: null, lastSuccessAt: null, days: {} });
  const today = new Date().toISOString().slice(0, 10);
  state.days[today] = state.days[today] || { assets: 0, repos: 0 };
  state.lastRunAt = new Date().toISOString();
  writeJson(STATE_FP, state);

  const mock = process.env.DUAL_AGENT_MOCK === '1';
  const stats = { reposScanned: 0, assets: 0, skills: 0, genes: 0, rejected: 0, errors: [] };
  const goal = Number(opts.goal) || DAILY_GOAL;

  // MOCK：固定项目与机制卡，验证端到端入库（不触网、不调 LLM）
  const candidates = mock
    ? [{ repo: 'mock-agent/alpha', stars: 4200, desc: 'mock' }, { repo: 'mock-agent/beta', stars: 3100, desc: 'mock' }]
    : await discovery(MAX_REPOS);
  if (mock) for (const c of candidates) { c.readme = 'mock readme：反思回路与计划执行分离'; c.mechs = [
    { name: '反思回路', idea: '执行失败后自评原因，带原因重试', value: '强化 verify 纪律' },
    { name: '计划执行分离', idea: '先产出计划清单再逐步执行', value: '强化 todo 纪律' }
  ]; }

  for (const c of candidates) {
    if (stats.assets >= goal) break;
    try {
      if (!c.mechs) {
        c.readme = await fetchReadme(c.repo);
        c.mechs = await extractMechanisms(c.repo, c.readme);
      }
      stats.reposScanned++;
      for (const mech of c.mechs) {
        if (stats.assets >= goal) break;
        let adapt = mock
          ? (mech.name === '反思回路'
            ? { form: 'skill', name: 'reflection-loop', description: '任务执行失败或 verify 未过时，先自评失败原因再带因重试', content: '# 反思回路\n\n当 verify 校验未通过或任务返修时，禁止直接重试，必须先完成结构化自评：\n1. 用 read 工具查看失败产物与目标差距，列出具体差异点；\n2. 用 todo.add 登记「失败原因 → 对策」清单，逐项对应；\n3. 按清单逐项修复，每项修复后必须再次用 verify 工具确认该项通过；\n4. 全部清单项通过后才允许交付，交付说明中附上自评结论；\n5. 同一原因第二次触发时，先检索 memory 中相关教训，避免重复踩坑。' }
            : { form: 'gene', text: '复杂任务开始前必须先用 todo.add 建立计划清单，再逐步执行（计划执行分离）' })
          : await adaptMechanism(mech);
        if (adapt.form === 'skill' && !validateSkill(adapt)) {
          stats.rejected++;
          if (mock) { adapt.form = 'none'; adapt.reason = '校验失败'; }
          else adapt = await adaptMechanism(mech); // 重写一次
        }
        if (adapt.form === 'skill' && validateSkill(adapt)) {
          const slug = saveSkill(c.repo, mech, adapt);
          stats.skills++; stats.assets++;
          logMechanism({ date: today, repo: c.repo, mechanism: mech.name, form: 'skill', target: slug });
        } else if (adapt.form === 'gene') {
          const gid = savePendingGene(c.repo, mech, adapt);
          if (gid) { stats.genes++; stats.assets++; logMechanism({ date: today, repo: c.repo, mechanism: mech.name, form: 'gene', target: gid }); }
          else stats.rejected++;
        } else {
          stats.rejected++;
          logMechanism({ date: today, repo: c.repo, mechanism: mech.name, form: 'none', reason: String(adapt.reason || '校验失败').slice(0, 200) });
        }
      }
      markSeen(c.repo);
    } catch (e) {
      stats.errors.push(`${c.repo}: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }

  state.days[today].assets += stats.assets;
  state.days[today].repos += stats.reposScanned;
  state.lastSuccessAt = new Date().toISOString();
  writeJson(STATE_FP, state);
  return Object.assign({ ok: true, date: today }, stats);
}

// 调度判定：今日资产未达标 + 距上次成功 ≥24h
function scoutDue() {
  const state = readJson(STATE_FP, {});
  const today = new Date().toISOString().slice(0, 10);
  const todayAssets = (state.days && state.days[today] && state.days[today].assets) || 0;
  if (todayAssets >= DAILY_GOAL) return false;
  if (!state.lastSuccessAt) return true;
  return Date.now() - new Date(state.lastSuccessAt).getTime() >= 24 * 3600 * 1000;
}

function scoutStatus() {
  const state = readJson(STATE_FP, {});
  const today = new Date().toISOString().slice(0, 10);
  const pending = readJson(PENDING_FP, { genes: [] }).genes || [];
  let totalMechanisms = 0, totalSkills = 0, totalGenes = 0;
  try { for (const line of fs.readFileSync(MECH_LOG, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(line);
    totalMechanisms++;
    if (j.form === 'skill') totalSkills++;
    if (j.form === 'gene') totalGenes++;
  } } catch { /* 无账本 */ }
  const recent = [];
  try { for (const line of fs.readFileSync(MECH_LOG, 'utf8').split('\n').filter(Boolean).slice(-8).reverse()) recent.push(JSON.parse(line)); } catch { /* 无账本 */ }
  return {
    success: true,
    dailyGoal: DAILY_GOAL,
    todayAssets: (state.days && state.days[today] && state.days[today].assets) || 0,
    lastRunAt: state.lastRunAt || null,
    lastSuccessAt: state.lastSuccessAt || null,
    due: scoutDue(),
    totals: { mechanisms: totalMechanisms, skills: totalSkills, genes: totalGenes, pendingGenes: pending.filter(g => g.status === 'pending').length },
    recent
  };
}

// pending 基因注入进化实验的 gene mutation 上下文（evolution.js 调用）
function pendingGenesPromptSection() {
  const db = readJson(PENDING_FP, { genes: [] });
  const pending = (db.genes || []).filter(g => g.status === 'pending').slice(0, 5);
  if (!pending.length) return '';
  return [
    '== 外部学习候选基因（来源：GitHub 热门项目机制迁移，尚未验证）==',
    ...pending.map((g, i) => `${i + 1}. ${g.text}（来源 ${g.source}，机制：${g.mechanism}）`),
    '以上候选基因若有价值，可优先作为 gene mutation 的 change.text；实验验证胜出后将自动启用。'
  ].join('\n');
}

function markGeneValidated(geneId, promoted) {
  const db = readJson(PENDING_FP, { genes: [] });
  const g = (db.genes || []).find(x => x.id === geneId);
  if (g) { g.status = promoted ? 'validated' : 'falsified'; g.validatedAt = new Date().toISOString(); writeJson(PENDING_FP, db); }
}

module.exports = { runScout, scoutStatus, scoutDue, discovery, fetchReadme, extractMechanisms, adaptMechanism, validateSkill, pendingGenesPromptSection, markGeneValidated, addPendingGene, DAILY_GOAL };
