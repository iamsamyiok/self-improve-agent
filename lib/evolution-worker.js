// Evolution experiment worker：每个 case 独立 Node 进程，防止 candidate 污染生产 require cache。
const fs=require('fs');
const path=require('path');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
process.env.DUAL_AGENT_DATA=input.dataDir;
process.env.DUAL_AGENT_WS_ROOT=path.dirname(input.workspace);
process.env.DUAL_AGENT_PLUGINS_DIR=input.pluginsDir;
process.env.DUAL_AGENT_AUTO_EVOLVE='0';
process.env.DUAL_AGENT_EVOLUTION_WORKER='1';
process.env.DUAL_AGENT_SKILLS_SHARED=input.skillsDir;
// 配对比较：实验路径 LLM 温度默认 0（可用 payload.temperature 覆盖），降低 A/B 执行噪声
process.env.DUAL_AGENT_EVOLUTION_LLM_TEMPERATURE = input.temperature != null ? String(input.temperature) : '0';
if(input.systemPatch) process.env.DUAL_AGENT_SYSTEM_PATCH=input.systemPatch;
if(input.strategy) process.env.DUAL_AGENT_EVOLUTION_STRATEGY=JSON.stringify(input.strategy);
const core=require('../hwj/core');
const evo=require('./evolution');
const ui=new Proxy({}, {get:(t,p)=>p==='recentTools'?()=>[]:(...a)=>{ if(process.env.DUAL_AGENT_EVOLUTION_VERBOSE==='1' && a[0]) process.stderr.write(String(a[0])+'\n'); }});
(async()=>{
  try{
    const started=Date.now();
    const r=await core.runTask(input.task,{ws:path.basename(input.workspace),mode:'build',ui,abort:()=>false});
    const artifacts=evo.artifactManifest(input.workspace);
    const logFile=path.join(input.dataDir,'inner-log.jsonl'); let rows=[]; try{rows=fs.readFileSync(logFile,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{}
    const used=rows;
    const ok=used.filter(x=>x.ok).length, total=used.length;
    const byPlugin={};
    for(const x of used){ const n=String(x.plugin||'unknown'); const z=byPlugin[n]||{calls:0,ok:0,failures:0}; z.calls++; if(x.ok)z.ok++; else z.failures++; byPlugin[n]=z; }
    const metrics={toolCalls:total,toolSuccessRate:total?ok/total:1,durationMs:Date.now()-started,failures:total-ok,pluginStats:byPlugin};
    process.stdout.write(JSON.stringify({ok:!!r.ok,finalText:r.finalText||'',aborted:!!r.aborted,artifacts,metrics})+'\n');
  }catch(e){ process.stdout.write(JSON.stringify({ok:false,finalText:'',artifacts:evo.artifactManifest(input.workspace),metrics:{toolCalls:0,toolSuccessRate:0,durationMs:0,failures:1},error:String(e.message||e)})+'\n'); process.exitCode=0; }
})();
