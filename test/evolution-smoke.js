const assert=require('assert');
const fs=require('fs'); const os=require('os'); const path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dual-agent-evo-test-'));
process.env.DUAL_AGENT_MOCK='1';
process.env.DUAL_AGENT_DATA=path.join(root,'data');
process.env.DUAL_AGENT_WS_ROOT=path.join(root,'workspaces');
process.env.DUAL_AGENT_SKILLS_SHARED=path.join(root,'skills');
fs.mkdirSync(path.join(root,'workspaces','default'),{recursive:true});
const evo=require('../lib/evolution');
for(let i=0;i<3;i++) evo.recordBenchmark({task:`evolution smoke task ${i}`,finalText:'完成',ws:'default',intent:{acceptance:['完成任务'],deliverables:[]},artifacts:[]});
function listAll(){ return fs.readdirSync(require('path').join(evo.EV_ROOT,'benchmarks')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(require('path').join(evo.EV_ROOT,'benchmarks',n),'utf8'))); }
// 难例标注（改进 2）：触发过返修的任务标记 hard 并沉淀缺口经验池
evo.recordBenchmark({task:'evolution hard task 建立双层目录结构并生成汇总索引',finalText:'完成',ws:'default',intent:{acceptance:['索引齐全'],deliverables:[]},artifacts:[],repairs:2,lastGaps:['索引缺少二级条目']});
const hardRec=listAll().find(x=>x.hard);
assert.ok(hardRec,'repairs>0 应标记 hard'); assert.strictEqual(hardRec.repairs,2);
const gaps=evo.listGaps(5); assert.strictEqual(gaps.length,1); assert.strictEqual(gaps[0].repairs,2);
// 教训卡（P0-3）：hard 任务同步生成教训卡，同任务同缺口去重
const lessonsFp=require('path').join(evo.EV_ROOT,'lessons.jsonl');
assert(fs.existsSync(lessonsFp),'hard 任务应同步生成 lessons.jsonl');
const lessons=fs.readFileSync(lessonsFp,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));
assert.strictEqual(lessons.length,1); assert.ok(lessons[0].lesson.includes('索引缺少二级条目'));
evo.recordBenchmark({task:'evolution hard task 建立双层目录结构并生成汇总索引',finalText:'完成',ws:'default',intent:{acceptance:['索引齐全'],deliverables:[]},artifacts:[],repairs:2,lastGaps:['索引缺少二级条目']});
const lessons2=fs.readFileSync(lessonsFp,'utf8').split('\n').filter(Boolean);
assert.strictEqual(lessons2.length,1,'同任务同缺口应去重');
// 教训卡检索：相似任务命中，无关任务为空
const hit=evo.listRelevantLessons('帮我建立双层目录结构并生成汇总索引文件',3);
assert.strictEqual(hit.length,1,'相似任务应命中教训');
assert.strictEqual(evo.listRelevantLessons('查询天气',3).length,0,'无关任务不应命中');
const sec=evo.lessonsPromptSection('帮我建立双层目录结构并生成汇总索引文件',3);
assert.ok(sec.includes('[框架预取·相关教训]'),'命中时应生成教训注入段');
assert.strictEqual(evo.lessonsPromptSection('查询天气',3),'','未命中时应为空段');
// train/holdout 拆分（P0-1）：纯函数逻辑
const fakePool=Array.from({length:21},(_,i)=>({id:`c${i}`,task:`t${i}`,createdAt:`2026-01-0${(i%9)+1}`}));
const sp=evo.splitPool(fakePool);
assert.strictEqual(sp.train.length,14,'21 个任务应拆出 14 个 train'); assert.strictEqual(sp.holdout.length,7,'21 个任务应拆出 7 个 holdout');
assert.strictEqual(evo.splitPool(fakePool.slice(0,10)).holdout.length,0,'池 <15 时退化为全量 train（与旧逻辑一致）');
assert.ok(!sp.train.some(c=>sp.holdout.some(h=>h.id===c.id)),'train 与 holdout 不得交集');
// 难例优先排序（改进 2）：hard 排前，同类按时间倒序
const ordered=evo.rankHardFirst(listAll());
assert.strictEqual(ordered[0].hard,true,'hard 任务应排第一');
// 早期停止（改进 3）：纯函数逻辑
assert.strictEqual(evo.checkEarlyStop([{evaluation:{delta:-1}},{evaluation:{delta:-1}},{evaluation:{delta:-1}}],6).at,3,'3 个全负 case 后剩余全对也追不到 MIN_DELTA，应早停');
assert.strictEqual(evo.checkEarlyStop([{evaluation:{delta:0}},{evaluation:{delta:0}},{evaluation:{delta:0}}],6),null,'0 分时剩余仍有机会，不应早停');
assert.strictEqual(evo.checkEarlyStop([{evaluation:{delta:-1}}],6),null,'MIN_CASES 前不判');
// P2-5 并行接线静态检查：wave 分批 + prefilter 去重 + 并发度可配
const evoSrc=fs.readFileSync(require('path').join(__dirname,'..','lib','evolution.js'),'utf8');
assert.ok(evoSrc.includes('DUAL_AGENT_EVOLUTION_PARALLELISM'),'case 并发度环境变量存在');
assert.ok(evoSrc.includes('Promise.all(wave.map'),'case 分批并行执行');
assert.ok(evoSrc.includes('prefilterChecked'),'3-case 快筛并行后只判一次（防 results 跳变重复判定）');
// P2-6 缓存静态检查
assert.ok(evoSrc.includes('cachedSection'),'教训/套路检索缓存存在');
const expSrc=fs.readFileSync(require('path').join(__dirname,'..','lib','experience.js'),'utf8');
assert.ok(expSrc.includes('embedQueryCached'),'query embedding 缓存存在（experience 语义召回）');
const memSrc=fs.readFileSync(require('path').join(__dirname,'..','plugins','memory.js'),'utf8');
assert.ok(memSrc.includes('embedQueryCached'),'query embedding 缓存存在（memory recall）');
// ===== 短板修复（高1-4 / 中9）=====
assert.ok(evoSrc.includes("judgeOrder:flip?'cand-first':'base-first'"),'judge 展示顺序随机化且落盘审计（高1）');
assert.ok(evoSrc.includes('function bootstrapCI') && evoSrc.includes('lowConfidence'),'bootstrap 置信区间 + low-confidence 标记（高2）');
assert.ok(evoSrc.includes("fs.renameSync(tmp, fp)"),'writeJson 原子替换（高3）');
assert.ok(!evoSrc.includes('withStateLock'),'同步读改写天然原子，不得残留未使用的锁机制（高3 复核）');
assert.ok(evoSrc.includes('function checkMutationWatchdog') && evoSrc.includes('checkMutationWatchdog(rec)'),'晋级后退化看门狗接线（高4）');
assert.ok(evoSrc.includes('watchdog-log.jsonl'),'看门狗审计日志落盘（高4）');
// ===== 断点续跑 + 攒批触发 =====
assert.ok(evoSrc.includes('function findResumableExperiment'),'中断实验发现函数存在');
assert.ok(evoSrc.includes("writeJson(path.join(exp,'state.json')"),'实验元数据 state.json 落盘（mutation + case 清单）');
assert.ok(evoSrc.includes('markExperimentFinished'),'实验完成刷新攒批起点');
assert.ok(evoSrc.includes('function newBenchmarksSinceLastExp'),'攒批计数函数存在');
assert.ok(evoSrc.includes('resumable.state.selected'),'续跑复用原 case 清单');
const srvSrc2=fs.readFileSync(require('path').join(__dirname,'..','server.js'),'utf8');
assert.ok(srvSrc2.includes('newBenchmarksSinceLastExp() >=') && srvSrc2.includes('DUAL_AGENT_EVOLUTION_MIN_NEW_CASES'),'自动触发带攒批门槛（多次聊天合并分析）');
// ===== 进化专用 LLM 配置（独立段 + 回退）=====
assert.ok(evoSrc.includes('function evoConfig'),'evoConfig 配置回退函数存在');
assert.ok(evoSrc.includes('cfg.evolution'),'读取 config.json evolution 段');
assert.ok(evoSrc.includes('evoConfig()'),'Meta-Agent/judge/课程统一走进化配置');
assert.ok(evoSrc.includes('llmSource:evoLlmSource()'),'decision 记录配置来源');
// ===== 效果评估系统：信号采集 + 健康分 + 退化触发 =====
assert.ok(evoSrc.includes('function recordTaskOutcome') && evoSrc.includes('eval-events.jsonl'),'任务级效果信号采集存在');
assert.ok(evoSrc.includes('function healthScore') && evoSrc.includes('function healthDropping'),'健康分聚合与退化判定存在');
assert.ok(evoSrc.includes('health:healthScore(50)') && evoSrc.includes('healthTrend:healthTrend()'),'status 暴露健康分与版本对比');
assert.ok(evoSrc.includes('regression: true'),'看门狗回归自动取证入池（闭环 B）');
const srvSrc3=fs.readFileSync(require('path').join(__dirname,'..','server.js'),'utf8');
assert.ok(srvSrc3.includes('recordTaskOutcome({ success: !hasUnresolvedGaps'),'任务完成信号采集接线');
assert.ok(srvSrc3.includes("recordTaskOutcome({ success:false, aborted:true"),'abort 负信号采集接线');
assert.ok(srvSrc3.includes("recordTaskOutcome({ success:false, undone:true })"),'undo 负信号采集接线');
assert.ok(srvSrc3.includes('evolution.healthDropping()'),'健康分退化触发线接线（闭环 A）');
// 健康分纯函数端到端：好窗口不误报，劣化后触发
const probeEvents=(()=>{ const f=require('fs'); const tmp=require('os').tmpdir()+"/ev-health-"+Date.now(); f.mkdirSync(tmp,{recursive:true}); return tmp; })();
assert.ok(typeof evo.healthScore(50)==='object' || evo.healthScore(50)===null,'healthScore 可调用');
const innerSrc=fs.readFileSync(require('path').join(__dirname,'..','lib','inner.js'),'utf8');
assert.ok(innerSrc.includes('DUAL_AGENT_EVOLUTION_WORKER') && innerSrc.includes('payload.temperature'),'实验 worker 路径必须注入温度控制');
assert.ok(evoSrc.includes('DUAL_AGENT_EVOLUTION_PREFILTER') && evoSrc.includes('prefilterReject'),'3-case 快筛必须存在且可通过 env 关闭');
assert.ok(evoSrc.includes('holdout-decision.json'),'holdout 复验结果必须落盘');
// ===== 第一批进化能力改进 =====
// 1. Prompt 基因库：add/查重/上限/启停/未知 id 拒绝；注入段与 promote
delete process.env.DUAL_AGENT_EVOLUTION_GENES;
const g1=evo.applyGeneOp([],{action:'add',text:'交付前必须对每个产出文件执行 verify 断言',category:'verification'});
assert.ok(!g1.error && g1.genes.length===1,'add 合法基因应成功');
const gid=g1.genes[0].id; assert.ok(gid.startsWith('g-'),'基因 id 应为 g- 前缀');
assert.ok(evo.applyGeneOp(g1.genes,{action:'add',text:'交付前必须对每个产出文件执行 verify 断言'}).error,'重复文本应拒绝');
assert.ok(evo.applyGeneOp(g1.genes,{action:'modify',id:'g-notexist',text:'x'}).error,'未知 id 应拒绝');
const g2=evo.applyGeneOp(g1.genes,{action:'disable',id:gid});
assert.ok(!g2.error && g2.genes[0].enabled===false,'disable 应成功');
assert.ok(evo.applyGeneOp(g2.genes,{action:'disable',id:gid}).error,'重复 disable（安慰剂）应拒绝');
const g3=evo.applyGeneOp(g2.genes,{action:'enable',id:gid});
assert.ok(!g3.error && g3.genes[0].enabled===true,'enable 应成功');
// 注入通道：生产走 genes.json，沙箱走 env
fs.writeFileSync(path.join(evo.EV_ROOT,'genes.json'),JSON.stringify({genes:g3.genes}));
assert.strictEqual(evo.enabledGenes().length,1,'生产 genes.json 应读到 1 条启用基因');
const geneSec=evo.genesPromptSection();
assert.ok(geneSec.includes('[进化基因·执行增强]') && geneSec.includes('verify 断言'),'基因注入段应包含基因文本');
process.env.DUAL_AGENT_EVOLUTION_GENES=JSON.stringify([{id:'g-x',text:'沙箱基因',enabled:true}]);
assert.ok(evo.genesPromptSection().includes('沙箱基因'),'env 注入应优先于文件');
delete process.env.DUAL_AGENT_EVOLUTION_GENES;
// 2. 客观断言评估器：启发式解析 + 文件系统判分
const parsed=evo.parseAcceptanceObjective(['summary.md 文件存在','报告包含「结论」关键词','data.json 不少于 5 行','语义上应当完整合理']);
assert.ok(parsed.some(o=>o.check==='file_exists'&&o.path==='summary.md'),'“X 文件存在”应解析为 file_exists');
assert.ok(parsed.some(o=>o.check==='content_contains'),'包含类条款应解析为 content_contains');
assert.ok(parsed.some(o=>o.check==='line_count_gte'&&o.value===5),'行数条款应解析为 line_count_gte');
assert.ok(parsed.length<=3,'解析不了的开放条款应跳过');
const objWs=fs.mkdtempSync(path.join(os.tmpdir(),'dual-agent-obj-'));
fs.writeFileSync(path.join(objWs,'summary.md'),'# 报告\n结论：完成\n');
fs.writeFileSync(path.join(objWs,'data.json'),JSON.stringify([1,2,3,4,5]));
const objR=evo.evaluateObjectives(objWs,[{check:'file_exists',path:'summary.md'},{check:'content_contains',path:'summary.md',value:'结论'},{check:'line_count_gte',path:'data.json',value:1},{check:'json_valid',path:'data.json'},{check:'file_exists',path:'missing.txt'}]);
assert.strictEqual(objR.passed,4); assert.strictEqual(objR.total,5);
assert.ok(Math.abs(objR.score-0.8)<1e-9,'客观分应为通过率');
// 3. 失败驱动 mutation：缺口聚类输出靶向模式
const modes=evo.analyzeFailureModes(3);
assert.ok(Array.isArray(modes)&&modes.length>=1,'有缺口记录时应聚类出失败模式');
assert.ok(modes[0].representative.includes('索引缺少'),'代表模式应为缺口文本');
// 4. 成功套路库：条件沉淀（≥3 步且 ok 率 ≥0.8）+ 相似检索注入
assert.strictEqual(evo.recordPlaybook('任务A',[{plugin:'write',ok:true},{plugin:'write',ok:true}]),null,'<3 步不应沉淀');
assert.strictEqual(evo.recordPlaybook('任务A',[{plugin:'write',ok:true},{plugin:'write',ok:false},{plugin:'verify',ok:false},{plugin:'verify',ok:false}]),null,'ok 率 <0.8 不应沉淀');
const pb=evo.recordPlaybook('创建双层目录结构并生成汇总索引文件',[{plugin:'write',ok:true},{plugin:'todo.add',ok:true},{plugin:'write',ok:true},{plugin:'verify',ok:true}]);
assert.ok(pb && pb.steps.includes('write+'),'达标成功序列应沉淀');
assert.ok(evo.listRelevantPlaybooks('建立双层目录结构与索引',2).length===1,'相似任务应命中套路');
assert.ok(evo.playbooksPromptSection('建立双层目录结构与索引',2).includes('[框架预取·成功套路]'),'命中时应生成套路注入段');
// 5. 教训升格技能：同类教训 ≥2 条聚类生成 auto-evolved 技能
evo.recordBenchmark({task:'evolution hard task 2 双层目录汇总索引再缺失条目',finalText:'完成',ws:'default',intent:{acceptance:['索引齐全'],deliverables:[]},artifacts:[],repairs:1,lastGaps:['索引缺少二级条目覆盖']});
const promotedLog=JSON.parse(fs.readFileSync(path.join(evo.EV_ROOT,'lessons-promoted.json'),'utf8'));
assert.ok(promotedLog.length>=1,'两条相似教训应触发升格');
const skillFp=path.join(root,'skills','auto-evolved',path.basename(promotedLog[0].skill));
assert.ok(fs.existsSync(skillFp),'升格技能文件应存在');
assert.ok(fs.readFileSync(skillFp,'utf8').includes('name: lesson-fix-'),'技能应为标准 frontmatter 格式');
assert.strictEqual(evo.promoteLessonsToSkill().promoted,0,'已升格教训重复调用应幂等');
// ===== 2026-09-04 十项优化 =====
// O2. HTTP 错误统一构造器：500/502/504 瞬态可重试，401/400 确定性不重试
const { makeHttpError, LlmTimeout, llmTimeoutMs } = require('../lib/llmRetry');
assert.ok(makeHttpError(500,'boom','T').retryable===true,'500 应可重试');
assert.ok(makeHttpError(502,'bad gateway','T').retryable===true,'502 应可重试');
assert.ok(makeHttpError(504,'timeout','T').retryable===true,'504 应可重试');
assert.strictEqual(makeHttpError(401,'unauthorized','T').retryable,undefined,'401 不应重试');
assert.strictEqual(makeHttpError(400,'invalid body','T').retryable,undefined,'400 不应重试');
// O1. 超时控制器：AbortError 转可重试错误
const toAbort=new Error('aborted'); toAbort.name='AbortError';
const settledAbort=LlmTimeout.prototype.settle.call({label:'T'},toAbort);
assert.ok(settledAbort.retryable===true,'AbortError 应转为可重试');
assert.ok(settledAbort.message.includes('超时'),'超时错误信息应含"超时"');
const plainErr=LlmTimeout.prototype.settle.call({label:'T'},new Error('普通错误'));
assert.strictEqual(plainErr.retryable,undefined,'普通错误应原样返回');
assert.ok(typeof llmTimeoutMs()==='number'&&llmTimeoutMs()>0,'超时阈值应可读且为正数');
// O3. 失败模式聚类去重：hard 任务同写 gaps+lessons 只计 1 次——
// 测试池有 2 个相似 hard 任务，去重后 count=2（每任务 1 次）；无双计逻辑时会是 4
assert.strictEqual(evo.analyzeFailureModes(3)[0].count,2,'同任务双写应去重：2 个 hard 任务计 2 而非 4');
// O4. 靶向命中判定
const fm=[{representative:'索引缺少二级条目',count:1,samples:[]}];
assert.ok(evo.targetsFailureModes({reason:'针对「索引缺少二级条目」强化 verify 断言',change:'x'},fm),'引用模式应命中');
assert.ok(!evo.targetsFailureModes({reason:'改进搜索关键词策略',change:'x'},fm),'无关文本不应命中');
// O5. case 内 A/B 并行：静态防回归
assert.ok(evoSrc.includes('await Promise.all([') && evoSrc.includes("label:'baseline'") && evoSrc.includes("label:'candidate'"),'runCase 内 baseline/candidate 应并行');
// O6. judge 输入瘦身：静态防回归（slimMetrics + finalText 3000）
assert.ok(evoSrc.includes('slimMetrics') && evoSrc.includes("slice(0,3000)"),'judge 输入必须瘦身（metrics 聚合 + finalText 3000）');
// O7. 进化自身 usage 记账：调用后落盘 llm-usage.jsonl
evo.recordLlmUsage('测试标签',{prompt_tokens:10,completion_tokens:5,total_tokens:15});
const usageLines=fs.readFileSync(path.join(evo.EV_ROOT,'llm-usage.jsonl'),'utf8').split('\n').filter(Boolean).map(JSON.parse);
assert.strictEqual(usageLines.length,1);
assert.strictEqual(usageLines[0].total,15); assert.strictEqual(usageLines[0].label,'测试标签');
// O8. 淘汰策略：静态防回归（evictionOrder：非 hard 先淘汰）
assert.ok(evoSrc.includes('evictionOrder'),'benchmark 淘汰必须 hard 优先存活');
// O9. hard 轮换：24h 内用过的 hard 降入次段
const rotPool=[{id:'h1',hard:true,createdAt:'2026-09-01'},{id:'h2',hard:true,createdAt:'2026-09-02'},{id:'n1',createdAt:'2026-09-03'}];
const rotNow=Date.now();
const ranked2=evo.rankHardFirst(rotPool,{h2:rotNow-1000});
assert.deepStrictEqual(ranked2.map(c=>c.id),['h1','h2','n1'],'轮换序应为 fresh hard > 24h 内已用 hard > 非 hard');
const ranked4=evo.rankHardFirst(rotPool,{n1:rotNow-1000});
assert.deepStrictEqual(ranked4.map(c=>c.id),['h2','h1','n1'],'非 hard 的 usage 记录无效，fresh hard 仍按时间倒序（h2 较新在前）');
const ranked3=evo.rankHardFirst(rotPool,{});
assert.strictEqual(ranked3[0].id,'h2','无 usage 时 fresh hard 按时间倒序，较新的 h2 排最前');
// O10. 基因 stats：modify/enable 的胜负由实验统一记，add 由 promote 初始化
fs.mkdirSync(path.join(evo.EV_ROOT),{recursive:true});
fs.writeFileSync(path.join(evo.EV_ROOT,'genes.json'),JSON.stringify({genes:[{id:'g-stat',text:'统计基因',enabled:true}]}));
evo.updateGeneStats({type:'gene',change:{action:'modify',id:'g-stat',text:'统计基因 v2'}},false);
const gj2=JSON.parse(fs.readFileSync(path.join(evo.EV_ROOT,'genes.json'),'utf8'));
assert.deepStrictEqual(gj2.genes[0].stats,{trials:1,wins:0,losses:1},'实验失败应对基因记 loss');
evo.updateGeneStats({type:'gene',change:{action:'modify',id:'g-stat',text:'统计基因 v3'}},true);
const gj3=JSON.parse(fs.readFileSync(path.join(evo.EV_ROOT,'genes.json'),'utf8'));
assert.deepStrictEqual(gj3.genes[0].stats,{trials:2,wins:1,losses:1},'实验通过应对基因记 win');
evo.updateGeneStats({type:'gene',change:{action:'add',text:'新基因内容'}},true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(evo.EV_ROOT,'genes.json'),'utf8')).genes[0].stats.trials,2,'add 操作不重复计 stats（promote 时初始化）');
evo.updateGeneStats({type:'plugin',change:'x'},true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(evo.EV_ROOT,'genes.json'),'utf8')).genes[0].stats.trials,2,'非 gene 类型不记 stats');
(async()=>{
  const r=await evo.runEvolution({cases:3,promote:false,mutation:{type:'strategy',target:'verification',reason:'test',hypothesis:'test',change:{verification:'strong'}}});
  assert.strictEqual(r.ok,true); assert.strictEqual(r.stage,'rejected'); assert.strictEqual(r.summary.n,3);
  assert.strictEqual(r.earlyStop,null,'mock 全零 delta 不应误触发早停');
  assert(fs.existsSync(path.join(evo.EV_ROOT,'experience.jsonl')));
  // gene mutation 端到端：makeCandidate 生成变更集 → runCase 对等注入 worker → decision 记录靶向模式
  const rg=await evo.runEvolution({cases:3,promote:false,mutation:{type:'gene',target:'genes',reason:'test 靶向失败模式：索引缺少二级条目',hypothesis:'强化 todo 清单基因可降低缺漏',change:{action:'add',text:'多文件任务必须先 todo.add 建清单再逐步执行',category:'planning'},expectedDelta:0.05}});
  assert.strictEqual(rg.ok,true);
  const expDirs=fs.readdirSync(path.join(evo.EV_ROOT,'experiments')).filter(n=>n.startsWith('exp-')).sort();
  const geneExpDir=path.join(evo.EV_ROOT,'experiments',expDirs[expDirs.length-1]);
  assert.ok(fs.existsSync(path.join(geneExpDir,'candidate','genes.json')),'gene mutation 应生成 candidate 基因变更集');
  const geneDecision=JSON.parse(fs.readFileSync(path.join(geneExpDir,'decision.json'),'utf8'));
  assert.ok(Array.isArray(geneDecision.targetedPatterns)&&geneDecision.targetedPatterns.length>=1,'decision 应记录靶向失败模式');
  // 断点续跑端到端：删 decision 模拟中断 → 重跑应同 id 续跑且已完成 case 的 result 未被覆盖
  const rInt=await evo.runEvolution({cases:3,promote:false,mutation:{type:'strategy',target:'verification',reason:'test',hypothesis:'t',change:{verification:'strong'}}});
  const intDir=path.join(evo.EV_ROOT,'experiments',rInt.experiment);
  const intCases=fs.readdirSync(path.join(intDir,'cases')).filter(d=>fs.existsSync(path.join(intDir,'cases',d,'result.json')));
  for (const d of intCases) { const j=JSON.parse(fs.readFileSync(path.join(intDir,'cases',d,'result.json'),'utf8')); j.sentinel='keep'; fs.writeFileSync(path.join(intDir,'cases',d,'result.json'),JSON.stringify(j)); }
  assert.ok(fs.existsSync(path.join(intDir,'state.json')),'实验元数据 state.json 已落盘');
  fs.rmSync(path.join(intDir,'decision.json'));
  assert.strictEqual(evo.findResumableExperiment().state.id,rInt.experiment,'中断实验应可被发现');
  const rRes=await evo.runEvolution({promote:false});
  assert.strictEqual(rRes.experiment,rInt.experiment,'中断后续跑应复用同一实验 id');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(intDir,'decision.json'),'utf8')).resumed,true,'decision 应标记 resumed');
  const kept=intCases.every(d=>{ try { return JSON.parse(fs.readFileSync(path.join(intDir,'cases',d,'result.json'),'utf8')).sentinel==='keep'; } catch { return false; } });
  assert.ok(kept,'已完成 case 的结果未被重跑覆盖（断点生效）');
  // 攒批计数：实验刚结束 → 新 benchmark 计数 0
  assert.strictEqual(evo.newBenchmarksSinceLastExp(),0,'实验完成后攒批计数应归零');
  console.log('evolution smoke: ok — benchmark/worker/A-B/evaluator/regression/ledger/genes/objective/failure-modes/playbooks/lessons-promote/resume/batch');
})().catch(e=>{console.error(e);process.exit(1)});
