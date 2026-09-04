const assert=require('assert');
const fs=require('fs'); const os=require('os'); const path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dual-agent-evo-test-'));
process.env.DUAL_AGENT_MOCK='1';
process.env.DUAL_AGENT_DATA=path.join(root,'data');
process.env.DUAL_AGENT_WS_ROOT=path.join(root,'workspaces');
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
(async()=>{
  const r=await evo.runEvolution({cases:3,promote:false,mutation:{type:'strategy',target:'verification',reason:'test',hypothesis:'test',change:{verification:'strong'}}});
  assert.strictEqual(r.ok,true); assert.strictEqual(r.stage,'rejected'); assert.strictEqual(r.summary.n,3);
  assert.strictEqual(r.earlyStop,null,'mock 全零 delta 不应误触发早停');
  assert(fs.existsSync(path.join(evo.EV_ROOT,'experience.jsonl')));
  console.log('evolution smoke: ok — benchmark/worker/A-B/evaluator/regression/ledger');
})().catch(e=>{console.error(e);process.exit(1)});
