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
// 难例优先排序（改进 2）：hard 排前，同类按时间倒序
const ordered=evo.rankHardFirst(listAll());
assert.strictEqual(ordered[0].hard,true,'hard 任务应排第一');
// 早期停止（改进 3）：纯函数逻辑
assert.strictEqual(evo.checkEarlyStop([{evaluation:{delta:-1}},{evaluation:{delta:-1}},{evaluation:{delta:-1}}],6).at,3,'3 个全负 case 后剩余全对也追不到 MIN_DELTA，应早停');
assert.strictEqual(evo.checkEarlyStop([{evaluation:{delta:0}},{evaluation:{delta:0}},{evaluation:{delta:0}}],6),null,'0 分时剩余仍有机会，不应早停');
assert.strictEqual(evo.checkEarlyStop([{evaluation:{delta:-1}}],6),null,'MIN_CASES 前不判');
const st=evo.status(); assert.strictEqual(st.benchmarks,4);
(async()=>{
  const r=await evo.runEvolution({cases:3,promote:false,mutation:{type:'strategy',target:'verification',reason:'test',hypothesis:'test',change:{verification:'strong'}}});
  assert.strictEqual(r.ok,true); assert.strictEqual(r.stage,'rejected'); assert.strictEqual(r.summary.n,3);
  assert.strictEqual(r.earlyStop,null,'mock 全零 delta 不应误触发早停');
  assert(fs.existsSync(path.join(evo.EV_ROOT,'experience.jsonl')));
  console.log('evolution smoke: ok — benchmark/worker/A-B/evaluator/regression/ledger');
})().catch(e=>{console.error(e);process.exit(1)});
