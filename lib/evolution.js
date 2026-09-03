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
function writeJson(fp, v) { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, JSON.stringify(v, null, 2), 'utf8'); }
function nowId(prefix) { return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; }
function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function ci95(a) { if (a.length < 2) return 0; return 1.96 * sd(a) / Math.sqrt(a.length); }
function clamp(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

function currentSignature() {
  const names = plugins.listPlugins().map(p => p.name).sort();
  const files = names.map(n => `${n}\n${plugins.readCode(n) || ''}`).join('\n---\n');
  const promptPatch = process.env.DUAL_AGENT_SYSTEM_PATCH || '';
  const strategy = readJson(path.join(EV_ROOT, 'strategy.json'), {});
  return sha(files + '\nPATCH\n' + promptPatch + '\nSTRATEGY\n' + JSON.stringify(strategy));
}

function listBenchmarks() {
  ensure();
  return fs.readdirSync(CASES).filter(n => n.endsWith('.json')).map(n => readJson(path.join(CASES, n), null)).filter(x => x && x.id && x.task)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, MAX_CASES);
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
  const rec = {
    id, task: task.slice(0, 12000),
    acceptance: Array.isArray(intent && intent.acceptance) ? intent.acceptance.slice(0, 8) : [],
    deliverables: Array.isArray(intent && intent.deliverables) ? intent.deliverables.slice(0, 8) : [],
    baseline: {
      finalText: String(input.finalText || '').slice(0, 8000),
      artifacts,
      signature: currentSignature()
    },
    createdAt: new Date().toISOString(),
    sourceWorkspace: String(input.ws || 'default')
  };
  writeJson(path.join(CASES, `${id}.json`), rec);
  const all = listBenchmarks();
  for (const old of all.slice(MAX_CASES)) { try { fs.unlinkSync(path.join(CASES, `${old.id}.json`)); } catch {} }
  return rec;
}

function artifactManifest(wsDir) {
  const out = [];
  const skip = new Set(['.memory-short.json','.memory-long.json','.memory-vector.json','memory-archive.jsonl','.todo.json','.intent.json','process.md','hwj-messages.json']);
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
  // 历史实验成败沉淀：已被证伪/验证的方向注入上下文，避免重复提出相同 mutation
  const recentExperiments = experience.slice(-8).filter(x=>x && x.experiment && x.mutation).map(x=>({
    experiment:x.experiment,
    mutation:{ type:x.mutation.type, target:x.mutation.target, change:String(x.mutation.change||'').slice(0,200) },
    result:{ meanDelta:Number(x.summary&&x.summary.meanDelta)||0, winRate:Number(x.summary&&x.summary.winRate)||0, pass:!!(x.summary&&x.summary.pass) }
  }));
  return JSON.stringify({ recent, bottlenecks, audit, recentExperiments }, null, 2).slice(0, 16000);
}

const MUTATION_SCHEMA = `{"type":"plugin|prompt|skill|strategy|memory","target":"...","reason":"...","hypothesis":"...","change":"...","expectedDelta":0.05}`;

function buildMutationPrompt(cases) {
  const context = buildHypothesisContext(cases);
  return [
    '你是 Self-Improvement Meta-Agent。你的唯一职责是提出一个可验证、最小、可归因的 Agent mutation。不要输出插件审批 proposals。',
    '',
    '你现在进入 Self-Improvement 实验室。你不是来直接修改生产环境，而是提出一个可证伪的 mutation candidate。',
    '核心原则：修改不等于改进；必须用 benchmark A/B 实验证明 candidate 更好。',
    '只提出一个最小、可归因的变化，禁止一次同时修改多个独立变量。',
    '允许的 type 及 change 的格式要求（change 必须可直接执行，禁止输出"修改 xx 文件中 yy 逻辑"这类描述性文字）：',
    '1. plugin：修改一个 plugins/*.js，change=该插件完整候选源码（必须含 module.exports）。',
    '2. prompt：调整执行策略补丁，change=注入 system 提示的策略文本（直接可用的指令文字）。',
    '3. skill：修改一个 skills 下 SKILL.md，change=该文件完整新内容。',
    '4. strategy：修改可实验的执行策略，change=严格 JSON 对象，仅允许以下键（实测有效的策略层）：',
    '   {"verification":"strong"} 或 {"toolSelection":"conservative"} 或 {"memoryTopK":1~10 的整数}，可组合如 {"verification":"strong","memoryTopK":5}。',
    '5. memory：修改记忆召回参数，change 同 strategy（JSON 对象，如 {"memoryTopK":6}）。',
    '注意：若你的改进想法映射不到上述可执行形态（例如想改未建模的内部逻辑），选 type=none 并说明原因——安慰剂式 mutation 只会浪费实验资源。',
    '实验上下文的 recentExperiments 是历史实验及其真实结果：meanDelta 为负或 pass=false 的方向已被证伪，禁止原样重复提出；要在其基础上给出实质不同的新假设。',
    '如果证据不足，不要为了进化而进化，返回 {"type":"none","reason":"没有足够证据"}。',
    `输出严格 JSON：${MUTATION_SCHEMA} 或 {"type":"none","reason":"..."}`,
    '', '== 实验上下文 ==', context
  ].join('\n');
}

// 直连 LLM 的 Meta-Agent 回退：无 opencode CLI 时用已配置的内层 API 生成 mutation 提议，
// 使自进化闭环只依赖一个 OpenAI 兼容 API（单轮 JSON 生成即可胜任假设提议任务）。
async function proposeMutationViaLLM(cfg, prompt) {
  const text = await callLLMText(cfg, [
    { role: 'system', content: '你是 Self-Improvement Meta-Agent。只输出一个严格 JSON 对象，无解释文字、无 markdown 围栏。' },
    { role: 'user', content: prompt }
  ], { maxTokens: 1400, label: 'Meta-Agent 提议' });
  const j = parseLooseJson(text);
  if (!j || !j.type) throw new Error('Meta-Agent（直连 LLM）没有输出合法 mutation JSON');
  return j;
}

async function proposeMutation(cases, opts={}) {
  if (process.env.DUAL_AGENT_MOCK === '1') {
    return { type:'strategy', target:'verification', reason:'mock fallback', hypothesis:'强化交付验证提示可降低漏交付', change:'verification=strong', expectedDelta:0.03 };
  }
  const prompt = buildMutationPrompt(cases);
  // 优先本机 opencode CLI（可读文件、能力更强）；不可用时回退直连 LLM，保证闭环永远可用
  const runner = opts.runner || await detectOpencode();
  if (runner) {
    const r = await runOuter(runner, prompt, ROOT, () => {}, opts.sessionId || '');
    const j = parseLooseJson(r && r.fullText || r && r.text || '');
    if (!j || !j.type) throw new Error('Meta-Agent 没有输出合法 mutation JSON');
    return j;
  }
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {}).inner || {};
  if (!(cfg.base_url && cfg.api_key && cfg.model)) {
    throw new Error('未检测到 opencode 且内层 LLM 未配置：无法运行 Meta-Agent。请在设置中配置 API（自进化将直连该 API），或安装 opencode。');
  }
  return await proposeMutationViaLLM(cfg, prompt);
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

async function evaluateCase(caseRec, baseRun, candRun, cfg) {
  const baseArtifacts = baseRun.artifacts || [];
  const candArtifacts = candRun.artifacts || [];
  const required = [...(caseRec.deliverables||[]).map(d=>d.path).filter(Boolean)];
  const exists = p => candArtifacts.some(a=>a.path===p);
  const artifactScore = required.length ? required.filter(exists).length/required.length : 1;
  const efficiency = m => clamp(0.55 * (m.toolSuccessRate) + 0.25 * (1 - Math.min(1,(m.toolCalls||0)/12)) + 0.20 * (1 - Math.min(1,(m.durationMs||0)/120000)));
  const processScore = efficiency(candRun.metrics);
  let judge = {score: candRun.ok ? 0.5 : 0, baseScore: baseRun.ok ? 0.5 : 0, reason:'fallback'};
  const msgs = [
    {role:'system',content:'你是严格的 Agent benchmark evaluator。只根据任务要求和两个执行结果评分。不要因为候选更长、更自信就给高分。输出 JSON。'},
    {role:'user',content:[
      `任务：${caseRec.task}`,
      `验收条件：${JSON.stringify(caseRec.acceptance)}`,
      `要求产出：${JSON.stringify(caseRec.deliverables)}`,
      `Baseline 最终回答：${String(baseRun.finalText||'').slice(0,6000)}`,
      `Candidate 最终回答：${String(candRun.finalText||'').slice(0,6000)}`,
      `Baseline 工具指标：${JSON.stringify(baseRun.metrics)}`,
      `Candidate 工具指标：${JSON.stringify(candRun.metrics)}`,
      `Candidate 客观产出存在分：${artifactScore}`,
      '分别给 baseline 与 candidate 0~1 分；评价正确性、任务完成度、约束遵守；返回 {baseline,candidate,reason}。'
    ].join('\n\n')}
  ];
  if (cfg && cfg.base_url && cfg.api_key && cfg.model && process.env.DUAL_AGENT_SKIP_JUDGE !== '1') {
    try {
      const text=await callLLMText(cfg,msgs,{maxTokens:700,label:'Evolution Evaluator'});
      const j=parseLooseJson(text); if (j && Number.isFinite(Number(j.candidate))) judge={score:clamp(j.candidate),baseScore:clamp(j.baseline),reason:String(j.reason||'')};
    } catch (e) { judge.reason='judge unavailable: '+String(e.message||e); }
  }
  // 客观产出是硬下限，防止 evaluator 被“漂亮答案”欺骗。
  const candidateScore = 0.65*judge.score + 0.20*artifactScore + 0.15*processScore;
  const baselineArtifactScore = required.length ? required.filter(p=>baseArtifacts.some(a=>a.path===p)).length/required.length : 1;
  const baselineProcess = efficiency(baseRun.metrics);
  const baselineScore = 0.65*judge.baseScore + 0.20*baselineArtifactScore + 0.15*baselineProcess;
  return {baselineScore,candidateScore,delta:candidateScore-baselineScore,judge,artifactScore,processScore};
}

function aggregate(results) {
  const deltas=results.map(r=>r.evaluation.delta), wins=deltas.filter(x=>x>0).length;
  const regressions=deltas.filter(x=>x < -MAX_REGRESSION).length;
  const m=mean(deltas);
  return { n:deltas.length, meanDelta:m, sd:sd(deltas), ci95:ci95(deltas), winRate:results.length?wins/results.length:0, wins, regressions,
    pass:results.length>=MIN_CASES && m>=MIN_DELTA && (wins/results.length)>=MIN_WIN_RATE && regressions===0 && (m-ci95(deltas))>0 };
}

async function runEvolution(opts={}) {
  ensure();
  const cases=listBenchmarks();
  if (cases.length < MIN_CASES) return {ok:false,stage:'collect',error:`可用 benchmark 只有 ${cases.length} 个，至少需要 ${MIN_CASES} 个真实任务后才能进化。`,benchmarks:cases.length};
  const mutation=opts.mutation || await proposeMutation(cases,opts);
  if (mutation.type==='none') return {ok:true,stage:'no-op',mutation};
  const id=nowId('exp'); const exp=path.join(EXPS,id); fs.mkdirSync(exp,{recursive:true});
  writeJson(path.join(exp,'proposal.json'),mutation);
  const candidateDir=makeCandidate(ROOT,mutation,id);
  const results=[];
  const cfg=(readJson(path.join(DATA_DIR,'config.json'),{})||{}).inner || {};
  // 同一组 benchmark、同一任务顺序、独立进程；baseline 与 candidate 使用同一 data snapshot。
  for (const c of cases.slice(0, Math.min(cases.length, Number(opts.cases)||12))) {
    const caseDir=path.join(exp,'cases',c.id); fs.mkdirSync(caseDir,{recursive:true});
    const baseWs=path.join(caseDir,'baseline','workspace'), candWs=path.join(caseDir,'candidate','workspace');
    const baseData=path.join(caseDir,'baseline','data'), candData=path.join(caseDir,'candidate','data');
    // 干净重放环境：benchmark 任务均为创建类，空工作区提供最大区分度，
    // 并彻底避免生产工作区里历史产物触发 write 覆盖保护、或让存在性验收失去区分度。
    // 限制：依赖既有文件的修改类任务加入 benchmark 前需先扩展 benchmark 格式记录依赖。
    fs.mkdirSync(baseWs,{recursive:true}); fs.mkdirSync(candWs,{recursive:true});
    copyData(DATA_DIR,baseData); copyData(DATA_DIR,candData);
    const common={task:c.task,mode:'build',configPath:path.join(baseData,'config.json'),timeoutMs:Number(opts.timeoutMs)||12*60*1000};
    const b = await runWorker({...common,workspace:baseWs,dataDir:baseData,pluginsDir:process.env.DUAL_AGENT_PLUGINS_DIR||path.join(ROOT,'plugins'),skillsDir:process.env.DUAL_AGENT_SKILLS_SHARED||path.join(ROOT,'skills'),label:'baseline'});
    const cnd = await runWorker({...common,workspace:candWs,dataDir:candData,pluginsDir:path.join(candidateDir,'plugins'),skillsDir:path.join(candidateDir,'skills'),systemPatch:fs.existsSync(path.join(candidateDir,'system-patch.txt'))?fs.readFileSync(path.join(candidateDir,'system-patch.txt'),'utf8'):'',strategy:readJson(path.join(candidateDir,'strategy.json'),{}),label:'candidate'});
    const evaluation=await evaluateCase(c,b,cnd,cfg);
    const row={benchmark:c.id,baseline:b,candidate:cnd,evaluation}; results.push(row); writeJson(path.join(caseDir,'result.json'),row);
  }
  const summary=aggregate(results); const decision={experiment:id,mutation,summary,createdAt:new Date().toISOString()};
  writeJson(path.join(exp,'decision.json'),decision); updateLeaderboard(decision);
  const bestCase = results[0] && results[0].candidate && results[0].candidate.metrics;
  const expLine = { ts:decision.createdAt, experiment:id, mutation, summary, pluginStats:bestCase && bestCase.pluginStats || {} };
  const expLines = []; try { const raw=fs.existsSync(path.join(EV_ROOT,'experience.jsonl')) ? fs.readFileSync(path.join(EV_ROOT,'experience.jsonl'),'utf8') : ''; expLines.push(...raw.split('\n').filter(Boolean).slice(-199)); } catch {}
  expLines.push(JSON.stringify(expLine)); try { fs.writeFileSync(path.join(EV_ROOT,'experience.jsonl'),expLines.join('\n')+'\n','utf8'); } catch {}
  if (summary.pass && opts.promote) {
    const pr=promoteMutation(mutation,id); decision.promotion=pr; writeJson(path.join(exp,'decision.json'),decision);
  }
  return {ok:true,stage:summary.pass?(opts.promote?'promoted':'ready'):'rejected',experiment:id,mutation,summary,results:results.map(r=>({benchmark:r.benchmark,evaluation:r.evaluation}))};
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
    // prompt/skill/strategy/memory 的 Promote 使用 evolution state，而非偷偷改生产核心。
    const state=readJson(STATE,{});
    state.version=(Number(state.version)||0)+1; state.activeMutation=mutation; state.experimentId=experimentId; state.updatedAt=new Date().toISOString();
    if (mutation.type==='prompt') {
      const fp=path.join(EV_ROOT,'system-patch.txt'); fs.writeFileSync(fp,String(mutation.change||''),'utf8');
    } else if (mutation.type==='strategy'||mutation.type==='memory') writeJson(path.join(EV_ROOT,'strategy.json'),typeof mutation.change==='string'?JSON.parse(mutation.change):(mutation.change||{}));
    else if (mutation.type==='skill') {
      const rel=String(mutation.target||'').replace(/^skills[\\/]/,''); const skillRoot=process.env.DUAL_AGENT_SKILLS_SHARED || path.join(ROOT,'skills'); const fp=path.join(skillRoot,rel); fs.mkdirSync(path.dirname(fp),{recursive:true}); fs.writeFileSync(fp,String(mutation.change||''),'utf8');
    }
    writeJson(STATE,state); approval.audit('evolution-promote',{experimentId,type:mutation.type,target:mutation.target}); return {ok:true,version:state.version};
  } catch(e) { return {ok:false,error:String(e.message||e)}; }
}

function updateLeaderboard(decision) {
  const list=readJson(LEADERBOARD,[]); list.push({experiment:decision.experiment,mutation:decision.mutation,summary:decision.summary,ts:decision.createdAt});
  list.sort((a,b)=>(b.summary.meanDelta||0)-(a.summary.meanDelta||0)); writeJson(LEADERBOARD,list.slice(0,100));
}

function mutationExplanation(mutation, summary, promotion) {
  const type = String(mutation && mutation.type || '');
  const target = String(mutation && mutation.target || '');
  const labels = { plugin:'插件', prompt:'执行提示策略', skill:'技能', strategy:'执行策略', memory:'记忆召回' };
  const action = labels[type] || type || '系统策略';
  let whatChanged = String(mutation && mutation.change || '').trim();
  if (type === 'plugin') whatChanged = `更新插件「${target.replace(/\.js$/,'')}」的实现逻辑`;
  else if (type === 'skill') whatChanged = `更新技能「${target}」的指导内容`;
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

module.exports={recordBenchmark,artifactManifest,runEvolution,status,history,liveStatus,currentSignature,shouldAutoEvolve,shouldAutoPromote,EV_ROOT};
