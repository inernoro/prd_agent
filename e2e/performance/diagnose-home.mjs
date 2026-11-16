// Collection-only experiment. This does not produce a performance acceptance verdict.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
const ref=process.argv[2];if(!/^[a-f0-9]{40}$/.test(ref??''))throw Error('Use an immutable application SHA');
const out='work/home-diagnostic';await fs.mkdir(out,{recursive:true});
try{await fs.access(path.join(out,'summary.json'));throw Error('Refuse to overwrite diagnostic evidence');}catch(e){if(e.code!=='ENOENT')throw e;}
const cases=[{cpu:'1',delay:0},{cpu:'1',delay:10000},{cpu:'2',delay:0},{cpu:'2',delay:10000}];
const host={cpuCount:os.cpus().length,availableParallelism:os.availableParallelism(),memoryBytes:os.totalmem(),
 cpuMax:await fs.readFile('/sys/fs/cgroup/cpu.max','utf8').catch(e=>'unavailable:'+e.code),memoryMax:await fs.readFile('/sys/fs/cgroup/memory.max','utf8').catch(e=>'unavailable:'+e.code)};
const plan={purpose:'CPU quota and browser-delay controlled diagnosis; no acceptance verdict',appCommit:ref,host,
 cases:[...cases.map(c=>({...c,attempt:1})),...cases.toReversed().map(c=>({...c,attempt:2}))]};
// Node20 supports toReversed; both orders reduce simple time/order confounding.
await fs.writeFile(path.join(out,'plan.json'),JSON.stringify(plan,null,2));
const summary=[];
for(const c of plan.cases){
 const name=`cpu-${c.cpu}-delay-${c.delay}-attempt-${c.attempt}`,dir=path.join(out,name);
 console.log(new Date().toISOString(),name);
 const status=await new Promise((resolve,reject)=>{const p=spawn('node',['e2e/performance/run.mjs','--ref',ref,'--profile','normal','--inject-browser-ms',String(c.delay),'--out',dir],{env:{...process.env,PERF_DIAGNOSTIC_API_CPUS:c.cpu},stdio:'inherit'});p.on('error',reject);p.on('close',resolve);});
 try{
  const r=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));
  const normal=r.phases.find(p=>p.name==='normal');
  const points=r.resources.flatMap(t=>t.samples.filter(s=>s.role==='api').map(s=>({at:t.at,...s.cgroupCpu})));
  const valid=points.filter(p=>p.available),first=valid[0],last=valid.at(-1);
  const row={...c,name,status,execution:r.execution,failure:r.failure??null,identity:r.buildIdentity,normal:normal?.metrics,
   browserPass:r.browser.pass,homeBrowserSamples:r.browser.samples.home,injectionHits:r.browserInjection.applied,
   effectiveCgroups:r.contract.effectiveCgroups,limitsEnforced:r.resourceAccounting.requestedLimitsEnforced,
   cpuCountersComplete:points.length>1&&valid.length===points.length,
   throttledPeriods:first?last.nr_throttled-first.nr_throttled:null,
   throttledUsec:first?last.throttled_usec-first.throttled_usec:null};
  summary.push(row);
 }catch(e){summary.push({...c,name,status,error:e.message});}
 await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({acceptanceVerdict:'NOT_EVALUATED_DIAGNOSTIC_ONLY',cases:summary},null,2));
}
const complete=summary.length===8&&summary.every(r=>r.status===0&&r.execution?.state==='complete'&&r.cpuCountersComplete&&r.limitsEnforced&&r.browserPass);
console.log('Diagnostic collection complete:',complete,'; this is not performance acceptance.');
if(process.env.GITHUB_STEP_SUMMARY){let text='### 首页延迟与CPU配额诊断\n\n仅诊断采集，不代表性能验收通过。正式阈值与原失败均未修改。\n\n| API核数 | 首页脚本延迟 | 次数 | 首页API p95毫秒 | 节流次数增量 | 节流毫秒增量 |\n|---|---|---|---|---|---|\n';for(const r of summary)text+=`| ${r.cpu} | ${r.delay} | ${r.attempt} | ${r.normal?.home?.client?.p95??'缺失'} | ${r.throttledPeriods??'缺失'} | ${r.throttledUsec===null?'缺失':r.throttledUsec/1000} |\n`;await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,text);}
if(!complete)process.exitCode=1;
