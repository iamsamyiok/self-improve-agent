const assert=require('assert');
const fs=require('fs'); const os=require('os'); const path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dual-agent-evo-test-'));
process.env.DUAL_AGENT_MOCK='1';
process.env.DUAL_AGENT_DATA=path.join(root,'data');
process.env.DUAL_AGENT_WS_ROOT=path.join(root,'workspaces');
fs.mkdirSync(path.join(root,'workspaces','default'),{recursive:true});
const evo=require('../lib/evolution');
for(let i=0;i<3;i++) evo.recordBenchmark({task:`evolution smoke task ${i}`,finalText:'完成',ws:'default',intent:{acceptance:['完成任务'],deliverables:[]},artifacts:[]});
const st=evo.status(); assert.strictEqual(st.benchmarks,3);
(async()=>{
  const r=await evo.runEvolution({cases:3,promote:false,mutation:{type:'strategy',target:'verification',reason:'test',hypothesis:'test',change:{verification:'strong'}}});
  assert.strictEqual(r.ok,true); assert.strictEqual(r.stage,'rejected'); assert.strictEqual(r.summary.n,3);
  assert(fs.existsSync(path.join(evo.EV_ROOT,'experience.jsonl')));
  console.log('evolution smoke: ok — benchmark/worker/A-B/evaluator/regression/ledger');
})().catch(e=>{console.error(e);process.exit(1)});
