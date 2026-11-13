import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { OwnedResourceLifecycle } from '../src/services/owned-resource-task.js';
import { ShellExecutor } from '../src/services/shell-executor.js';

// This script cannot use a developer or production daemon. It runs inside its own file-backed VM.
assert.equal(process.env.CDS_NATIVE_RESOURCE_DRILL,'1');assert.equal(process.getuid?.(),0);
assert.equal((await fs.readFile('/sys/block/vda/serial','utf8')).trim(),'codex-cow-fixture-01');
console.log('NATIVE_DRILL_STAGE','guest-identity-confirmed');
const raw=new ShellExecutor();const shell={exec:async(...args:Parameters<ShellExecutor['exec']>)=>{
  const result=await raw.exec(...args);if(result.exitCode && result.exitCode!==3)console.error('native fixture diagnostic',result.stderr.slice(-2000));return result;
}};
const native=async(command:string)=>{const result=await shell.exec(command,{timeout:120000});assert.equal(result.exitCode,0,result.stderr);return result.stdout.trim();};
const info=JSON.parse(await native("docker info --format '{{json .}}'"));assert.equal(info.DockerRootDir,'/data/docker');
console.log('NATIVE_DRILL_STAGE','outer-daemon-confirmed');
const options={shell,instanceId:'native-resource-drill',workspaceBase:'/data/workspaces',catalog:'/data/catalog',reserveBytes:32*1024**2,maxBytes:256*1024**2,projectBudgetBytes:4*1024**3,globalBudgetBytes:6*1024**3,historyLimit:8};
const lifecycle=new OwnedResourceLifecycle(options),payload='x'.repeat(4*1024**2),hash=createHash('sha256').update(payload).digest('hex');
const projectId=process.env.CDS_DRILL_PROJECT||'fixed-project';
const begin=()=>lifecycle.begin({projectId,owner:'resource-lifecycle-drill',createdBy:'native-vm-integration',ttlSeconds:3600,dataDisposition:'ephemeral-test'});
const sample=async()=>{await native('sync');const s=await fs.statfs('/data');return s.bavail*s.bsize;};
const writeData=async(task:Awaited<ReturnType<typeof begin>>)=>{
 const volume=await task.createVolume('synthetic-test-data');const container=await task.createContainer({image:'alpine:3.21',role:'fixed-fixture',mounts:[{kind:'volume',source:volume.identity,target:'/data'}],command:['sleep','3600']});
 const write=await task.exec(container.identity,['sh','-c','cat >/data/payload; sync'],payload);assert.equal(write.exitCode,0,write.stderr);
 const checksum=await task.exec(container.identity,['sha256sum','/data/payload']);assert.equal(checksum.stdout.split(' ')[0],hash);
 return {volume:volume.identity as string,container:container.identity as string};
};
const reclaim=async(id:string)=>{
 for(let attempt=0;attempt<5;attempt++){
  const result:any=await lifecycle.inspect(false,id);console.log('RETIREMENT_BATCH',JSON.stringify(result));
  if(result.held?.length||result.pending?.length){
   const task=JSON.parse(await fs.readFile('/data/catalog/tasks.json','utf8')).tasks[id];
   for(const resource of task.resources.filter((row:any)=>row.kind==='private-daemon')){
    const response=await shell.exec(`docker --host '${resource.endpoint}' info --format '{{json .}}'`,{timeout:10000});
    if(response.exitCode===0){const actual=JSON.parse(response.stdout);console.log('PRIVATE_DAEMON_IDENTITY_DIAGNOSTIC',JSON.stringify({expectedID:resource.daemonId,actualID:actual.ID,expectedRoot:resource.dataRoot,actualRoot:actual.DockerRootDir,responseKeys:Object.keys(actual),serverErrors:actual.ServerErrors}));}
   }
  }
  if(result.removed?.some((r:any)=>r.kind==='workspace'))return result;
  if(result.held?.length||result.failed?.length)throw new Error('Native retirement remains held: '+JSON.stringify(result));
 }
 throw new Error('Native retirement did not settle within five bounded batches');
};
if(process.argv.includes('--crash-producer')){
 const task=await begin();const data=await writeData(task);const daemon=await task.startPrivateDaemon();
 for(const args of [['load','-i','/alpine.tar'],['volume','create','nested-data'],['run','-d','--network','none','--name','nested-fixture','--mount','type=volume,source=nested-data,target=/data','alpine:3.21','sh','-c','dd if=/dev/zero of=/data/nested bs=1M count=4; sleep 3600']]){const r=await daemon.exec(args);assert.equal(r.exitCode,0,r.stderr);}
 const renewed=await task.heartbeat(10);await fs.writeFile('/data/crash-task.json',JSON.stringify({taskId:task.handle.taskId,workspace:task.handle.workspace,leaseUntil:renewed.leaseUntil,...data}),{mode:0o600});
 await native('sync');console.log('CRASH_PRODUCER_READY');setInterval(()=>{},1000);
}else if(process.argv.includes('--after-reboot')){
 const checkpoint=JSON.parse(await fs.readFile('/data/reboot-checkpoint.json','utf8'));
 assert.equal(info.ID,checkpoint.daemonId);assert.notEqual((await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),checkpoint.bootId);
 await native(`docker start ${checkpoint.protected.container}`);
 const protectedView=JSON.parse(await native(`docker volume inspect ${checkpoint.protected.volume}`))[0];assert.equal(createHash('sha256').update(await fs.readFile(path.join(protectedView.Mountpoint,'payload'))).digest('hex'),hash);
 const result=await reclaim(checkpoint.crash.taskId);assert(!JSON.stringify(result.removed).includes(checkpoint.protected.taskId));
 const preview=await lifecycle.inspect(true,checkpoint.protected.taskId);console.log('PROTECTED_RESOURCE_AFTER_REBOOT',JSON.stringify(preview));assert(preview.held.some((r:any)=>r.taskId===checkpoint.protected.taskId&&r.reason==='active-lease'));
 await lifecycle.request('finish',{taskId:checkpoint.protected.taskId,token:checkpoint.protected.token,outcome:'completed'});await reclaim(checkpoint.protected.taskId);
 const report={provenance:'integration-live',scope:'native Docker and XFS in a private file-backed Linux VM; actual producer SIGKILL and abrupt host reboot; synthetic data',producerSIGKILLRecovered:true,actualHostRebootRecovered:true,nestedDaemonRetiredThroughNativeAPIs:true,protectedDataChecksumPreserved:true,...checkpoint.evidence};
 await fs.writeFile('/data/resource-lifecycle-result.json',JSON.stringify(report));console.log('RESOURCE_LIFECYCLE_RESULT',JSON.stringify(report));console.log('DRILL_COMPLETE');
}else{
 const resume=process.argv.includes('--resume-crash-only');
 const evidence:any=resume?JSON.parse(await fs.readFile('/prior-continuous-evidence.json','utf8')):{};
 const core=await begin();console.log('NATIVE_DRILL_STAGE','protected-task-born');const protectedData=await writeData(core);const before=await sample();console.log('NATIVE_DRILL_STAGE','protected-data-confirmed');
 const active=await lifecycle.inspect();assert(active.held.some((r:any)=>r.taskId===core.handle.taskId&&r.reason==='active-lease'));evidence.activeLeaseProtected=true;
 if(!resume){
 const ordinary=await begin();await fs.symlink(path.join(JSON.parse(await native(`docker volume inspect ${protectedData.volume}`))[0].Mountpoint,'payload'),path.join(ordinary.handle.workspace,'outside-link'));
 await ordinary.finish('completed');assert.equal((await core.exec(protectedData.container,['sha256sum','/data/payload'])).stdout.split(' ')[0],hash);evidence.symlinkTargetPreserved=true;
 const stopped=await begin();const volume=await stopped.createVolume('foreign-reference-guard');
 const foreign=await native(`docker create --label cds.acceptance.owner=resource-lifecycle-drill-reference --mount type=volume,source=${volume.identity},target=/data alpine:3.21 sleep 3600`);
 const held:any=await stopped.finish('failed');assert(held.held.some((r:any)=>r.reason==='volume-still-referenced'));assert((await native('docker ps -aq --no-trunc')).split('\n').includes(foreign));
 await native(`docker rm ${foreign}`);await reclaim(stopped.handle.taskId);evidence.stoppedForeignContainerProtected=true;
 const replaced=await begin(),original=replaced.handle.workspace+'-original';await fs.rename(replaced.handle.workspace,original);await fs.mkdir(replaced.handle.workspace);await fs.writeFile(path.join(replaced.handle.workspace,'foreign-data'),'preserve');
 const replacementHeld:any=await replaced.finish('failed');assert(replacementHeld.held.some((r:any)=>r.reason==='workspace-replaced'));assert.equal(await fs.readFile(path.join(replaced.handle.workspace,'foreign-data'),'utf8'),'preserve');
 await fs.rename(replaced.handle.workspace,replaced.handle.workspace+'-replacement');await fs.rename(original,replaced.handle.workspace);await reclaim(replaced.handle.taskId);evidence.replacedDirectoryPreserved=true;
 // Baseline intentionally leaves five failed/ended tasks, using exactly the same fixed resources.
 const baselineStart=await sample(),backlog:Array<Awaited<ReturnType<typeof begin>>>=[];
 for(let i=0;i<5;i++){const task=await begin(),data=await writeData(task);await native(`docker stop --time 1 ${data.container}`);backlog.push(task);}
 evidence.baselineFiveEndedTasksIncrementBytes=baselineStart-await sample();
 for(const task of backlog)await task.finish('failed');evidence.backlogRetired=true;
 const increments:number[]=[],timings:number[]=[];const cycles=Number(process.env.CDS_DRILL_CYCLES||40);
 for(let i=0;i<cycles;i++){
  const started=Date.now(),task=await begin();await writeData(task);
  if(i%5===0){const failed=await task.exec((JSON.parse(await fs.readFile('/data/catalog/tasks.json','utf8'))).tasks[task.handle.taskId].resources.find((r:any)=>r.kind==='container').identity,['sh','-c','exit 17']);assert.equal(failed.exitCode,17);}
  const r:any=await task.finish(i%5===0?'failed':'completed');assert(r.removed.some((v:any)=>v.kind==='workspace'));timings.push(Date.now()-started);increments.push(before-await sample());
  console.log('FIXED_RESOURCE_CYCLE',JSON.stringify({cycle:i+1,physicalIncrementBytes:increments.at(-1),elapsedMs:timings.at(-1)}));
 }
 const catalog=JSON.parse(await fs.readFile('/data/catalog/tasks.json','utf8'));assert(Object.values(catalog.tasks).filter((t:any)=>t.state==='retired').length<=8);
 evidence.cycles=cycles;evidence.physicalIncrements= increments;evidence.cycleElapsedMs=timings;evidence.boundedRetirementHistory=true;
 await fs.writeFile('/data/continuous-deploy-result.json',JSON.stringify(evidence));
 }
 const special=await begin();await native(`mkfifo '${path.join(special.handle.workspace,'unknown.fifo')}'`);
 const specialHeld:any=await special.finish('failed');assert(specialHeld.held.some((row:any)=>row.reason==='unknown-special-file-retained'));
 await fs.unlink(path.join(special.handle.workspace,'unknown.fifo'));await reclaim(special.handle.taskId);evidence.unknownSpecialFileProtected=true;
 const child=spawn(process.execPath,[process.argv[1],'--crash-producer'],{stdio:['ignore','pipe','inherit'],env:process.env});let ready='';child.stdout.on('data',chunk=>{ready+=chunk;process.stdout.write(chunk);});
 const deadline=Date.now()+180000;while(!ready.includes('CRASH_PRODUCER_READY')){if(child.exitCode!==null)throw new Error('Crash producer exited before checkpoint');if(Date.now()>deadline)throw new Error('Crash producer startup timeout');await new Promise(r=>setTimeout(r,100));}
 const exit=once(child,'exit');child.kill('SIGKILL');await exit;const crash=JSON.parse(await fs.readFile('/data/crash-task.json','utf8'));
 const checkpoint={daemonId:info.ID,bootId:(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),protected:{...protectedData,taskId:core.handle.taskId,token:core.handle.token},crash,evidence};
 // The sole capability stays in this fixture's private file, never in console/artifacts.
 await fs.writeFile('/data/reboot-checkpoint.json',JSON.stringify(checkpoint),{mode:0o600});await native('sync');console.log('REBOOT_READY');setInterval(()=>{},1000);
}
