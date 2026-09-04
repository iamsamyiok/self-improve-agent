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
const st=evo.status(); assert.strictEqual(st.benchmarks,5);
// 静态防回归：配对比较温度（worker 路径必须默认 0）与 3-case 快筛逻辑存在
const innerSrc=fs.readFileSync(require('path').join(__dirname,'..','lib','inner.js'),'utf8');
assert.ok(innerSrc.includes('DUAL_AGENT_EVOLUTION_WORKER') && innerSrc.includes('payload.temperature'),'实验 worker 路径必须注入温度控制');
const evoSrc=fs.readFileSync(require('path').join(__dirname,'..','lib','evolution.js'),'utf8');
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
  console.log('evolution smoke: ok — benchmark/worker/A-B/evaluator/regression/ledger/genes/objective/failure-modes/playbooks/lessons-promote');
})().catch(e=>{console.error(e);process.exit(1)});
