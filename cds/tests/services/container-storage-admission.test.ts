import { describe, it, expect, vi } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { stableStorageVolumeName, storageOwnerLabels, profileStoragePlan, withRuntimeTmpfs } from '../../src/services/deployment-storage-plan.js';
import type { CdsConfig, BranchEntry, BuildProfile, StorageBinding } from '../../src/types.js';
const config: CdsConfig = {repoRoot:'/repo',worktreeBase:'/wt',storageInstanceId:'instance',masterPort:9900,workerPort:5500,dockerNetwork:'cds-network',portStart:10001,sharedEnv:{},jwt:{secret:'test',issuer:'test'}};
const entry: BranchEntry = {id:'branch',projectId:'project',branch:'branch',worktreePath:'/wt/project/.deployment-sources/branch/uuid',services:{},status:'idle',createdAt:'2026-10-23'};
const profile: BuildProfile = {id:'app',projectId:'project',name:'app',dockerImage:'fixture:image',prebuiltImage:true,workDir:'.',command:'',containerPort:8080};
const binding: StorageBinding = {version:1,instanceId:'instance',projectId:'project',scope:'branch-private',branchId:'branch',serviceId:'app',mountKey:'data',purpose:'persistent'};
describe('actual container storage admission',()=>{
 it.each(['app','job'])('refuses dangerous %s mounts before any network or old runtime command',async kind=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config);
  const p={...profile,cacheMounts:[{kind:'bind' as const,hostPath:entry.worktreePath+'/data',containerPath:'/data'}]};
  await expect(kind==='app'?container.runService(entry,p,{profileId:'app',containerName:'old-app',hostPort:10001,status:'running'}):container.runProfileCommand(entry,p,'check')).rejects.toThrow('unsafe_deployment_storage');
  expect(shell.commands).toEqual([]);
 });
 it.each(['app','job'])('a missing stable %s volume is held before any network/create/old removal',async kind=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config);
  const name=stableStorageVolumeName(binding);
  shell.addResponsePattern(/^docker volume inspect /,()=>({exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+name+': no such volume'}));
  const p={...profile,cacheMounts:[{kind:'volume' as const,hostPath:name,containerPath:'/data',storage:binding}]};
  await expect(kind==='app'?container.runService(entry,p,{profileId:'app',containerName:'old-app',hostPort:10001,status:'running'}):container.runProfileCommand(entry,p,'check')).rejects.toThrow('storage-existing-volume-required');
  expect(shell.commands).toHaveLength(1);expect(shell.commands[0]).toMatch(/^docker volume inspect /);
 });
 it('actual unbound image VOLUME refuses before pruning or removing the old app',async()=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config),id='sha256:'+'a'.repeat(64);
  shell.addResponsePattern(/^docker network inspect /,()=>({exitCode:0,stdout:'[]',stderr:''}));
  shell.addResponsePattern(/^docker pull /,()=>({exitCode:0,stdout:'',stderr:''}));
  shell.addResponsePattern(/docker image inspect.*json .Id/,()=>({exitCode:0,stdout:JSON.stringify([id,{'/data':{}}]),stderr:''}));
  vi.spyOn(container as any,'waitForContainerAlive').mockResolvedValue(undefined);
  const prune=vi.spyOn(container as any,'pruneStaleAppContainersForProfile').mockResolvedValue(undefined);
  try {
   await expect(container.runService(entry,profile,{profileId:'app',containerName:'old-app',hostPort:10001,status:'running'})).rejects.toThrow('storage-image-volume-unbound');
   expect(prune).not.toHaveBeenCalled();expect(shell.commands.some(c=>/^docker (rm|stop|run|create|start) /.test(c))).toBe(false);
  }finally{vi.restoreAllMocks()}
 });
});

describe('created runtime identity and native storage recheck',()=>{
 it.each(['app','job','infra'] as const)('starts only the real created immutable %s ID after native mount recheck',async kind=>{
  const {shell,container,run,cid,createName}=setupNative(kind);
  const cleanup=vi.spyOn(container as any,'cleanupTemporaryContainer').mockResolvedValue(undefined);
  try{
   await run();
   const create=shell.commands.findIndex(c=>c.startsWith('docker create ')),start=shell.commands.findIndex(c=>c.startsWith('docker start '));
   expect(create).toBeGreaterThanOrEqual(0);expect(start).toBeGreaterThan(create);
   expect(shell.commands.slice(create+1,start).some(c=>c.includes('json .Mounts'))).toBe(true);
   expect(shell.commands[start]).toBe('docker start '+cid);
   expect(shell.commands[create]).toContain('volume-nocopy');
   expect(shell.commands.some(c=>c.startsWith('docker run '))).toBe(false);
   if(kind==='job'){
    expect(cleanup).toHaveBeenCalledWith(cid,expect.anything(),'app');
    expect(shell.commands).toContain('docker wait '+cid);expect(shell.commands).toContain('docker logs '+cid);
    expect(shell.commands.some(c=>c.startsWith('docker network connect')&&c.includes(createName()))).toBe(false);
   }
  }finally{vi.restoreAllMocks()}
 });
 it.each(['id','image','mount','status','birth'] as const)('rejects changed %s after create without starting a process',async drift=>{
  const {shell,run}=setupNative('app',drift);
  try{await expect(run()).rejects.toThrow('unsafe_deployment_storage');expect(shell.commands.some(c=>c.startsWith('docker start '))).toBe(false)}finally{vi.restoreAllMocks()}
 });
 function setupNative(kind:'app'|'job'|'infra',drift?:'id'|'image'|'mount'|'status'|'birth'){
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config),cid='c'.repeat(64),imageId='sha256:'+'d'.repeat(64);
  let made=false,name='new-app';
  const owner=kind==='infra'?{...binding,scope:'project-shared' as const,branchId:undefined}:binding;
  const volume=stableStorageVolumeName(owner),mountpoint='/var/lib/docker/volumes/'+volume+'/_data';
  shell.addResponsePattern(/^docker volume inspect /,()=>({exitCode:0,stdout:JSON.stringify([{Name:volume,Driver:'local',Options:null,Mountpoint:mountpoint,Labels:drift==='birth'&&made?{}:storageOwnerLabels(owner)}]),stderr:''}));
  shell.addResponsePattern(/docker image inspect.*json .Id/,()=>({exitCode:0,stdout:JSON.stringify([imageId,null]),stderr:''}));
  shell.addResponsePattern(/docker inspect.*json .Mounts/,()=>({exitCode:0,stdout:JSON.stringify([cid,'/'+name,drift==='image'?'sha256:'+'e'.repeat(64):imageId,drift==='status'?42:0,drift==='status'?'running':'created',[{Type:'volume',Name:drift==='mount'?'foreign':volume,Source:mountpoint,Destination:'/data',RW:true}],kind==='infra'?null:{'/tmp':''}]),stderr:''}));
  shell.addResponsePattern(/docker inspect --format=.*json .State.Status/,()=>({exitCode:1,stdout:'',stderr:'Error: No such object: new-infra'}));
  shell.addResponsePattern(/^docker pull /,()=>({exitCode:0,stdout:'',stderr:''}));
  shell.addResponsePattern(/^docker create (.*)$/,m=>{made=true;name=m[0].match(/--name (?:'([^']+)'|([^ ]+))/)?.slice(1).find(Boolean)||'';return {exitCode:0,stdout:drift==='id'?'short':cid,stderr:''}});
  shell.addResponsePattern(/^docker (start|rm|network connect|logs) /,()=>({exitCode:0,stdout:'',stderr:''}));
  shell.addResponsePattern(/^docker wait /,()=>({exitCode:0,stdout:'0',stderr:''}));
  vi.spyOn(container as any,'ensureNetwork').mockResolvedValue(undefined);
  vi.spyOn(container as any,'waitForContainerAlive').mockResolvedValue(undefined);
  vi.spyOn(container as any,'pruneStaleAppContainersForProfile').mockResolvedValue(undefined);
  const p={...profile,cacheMounts:[{kind:'volume' as const,hostPath:volume,containerPath:'/data',storage:owner}]};
  return {shell,container,cid,createName:()=>name,run:()=>kind==='app'?container.runService(entry,p,{profileId:'app',containerName:name,hostPort:10001,status:'running'}):kind==='job'?container.runProfileCommand(entry,p,'check'):container.startInfraService({id:'app',projectId:'project',name:'app',dockerImage:'fixture:image',containerName:'new-infra',containerPort:8080,hostPort:10001,status:'stopped',env:{},createdAt:'2026-10-23',volumes:[{name:volume,containerPath:'/data',storage:owner}]})};
 }
});

it('native JSON projection preserves a legal readonly bind path containing a pipe',async()=>{
 const shell=new MockShellExecutor(),container=new ContainerService(shell,config),cid='c'.repeat(64),image='sha256:'+'d'.repeat(64);
 const source='/stable/config|one.yml',target='/etc/config|one.yml';
 const plan=withRuntimeTmpfs(profileStoragePlan(entry,{...profile,cacheMounts:[{kind:'bind',hostPath:source,containerPath:target,readOnly:true}]},config));
 shell.addResponsePattern(/docker inspect.*json .Mounts/,()=>({exitCode:0,stdout:JSON.stringify([cid,'/new-app',image,0,'created',[{Type:'bind',Source:source,Destination:target,RW:false}],{'/tmp':''}]),stderr:''}));
 await expect((container as any).inspectCreatedStorageContainer(shell,cid,'new-app',image,plan)).resolves.toBeUndefined();
 expect(shell.commands).toHaveLength(1);
});

describe('historical infrastructure preserves its exact original runtime',()=>{
 it.each(['running','wake','failed-wake','wrong-name','short-id','paused'] as const)('legacy mapping: %s',async scenario=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config),cid='e'.repeat(64);
  shell.addResponsePattern(/docker inspect --format=.*json .State.Status/,()=>({exitCode:0,stdout:[scenario==='short-id'?'short':cid,scenario==='running'?'running':scenario==='paused'?'paused':'exited',scenario==='wrong-name'?'/foreign':'/legacy-db'].map(v=>JSON.stringify(v)).join('|'),stderr:''}));
  shell.addResponse('docker start '+cid,{exitCode:scenario==='failed-wake'?1:0,stdout:cid,stderr:''});
  for(const method of ['ensureNetwork','ensureInfraOnNetwork','auditInfraLogLimit','auditMysqlConnectionLimit'])vi.spyOn(container as any,method).mockResolvedValue(undefined);
  try{
   const run=container.startInfraService({id:'db',projectId:'project',name:'legacy',dockerImage:'fixture:image',containerName:'legacy-db',containerPort:8080,hostPort:10001,status:'stopped',env:{},createdAt:'2026-10-23',volumes:[{type:'bind',name:'/wt/project/.deployment-sources/old/database',containerPath:'/data'}]});
   if(['running','wake'].includes(scenario))await expect(run).resolves.toBeUndefined();else await expect(run).rejects.toThrow('unsafe_deployment_storage');
   expect(shell.commands.some(c=>/^docker (rm|run|create|volume create) /.test(c))).toBe(false);
   if(scenario==='running')expect(shell.commands).toHaveLength(1);
   if(['wake','failed-wake'].includes(scenario))expect(shell.commands[1]).toBe('docker start '+cid);
   if(['wrong-name','short-id','paused'].includes(scenario))expect((container as any).ensureNetwork).not.toHaveBeenCalled();
  }finally{vi.restoreAllMocks()}
 });
});

describe('preflight receipt freezes the actual admitted image and storage plan',()=>{
 it('revalidation uses the accepted image ID even when the tag now resolves to another image',async()=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config);
  const imageA='sha256:'+'a'.repeat(64),imageB='sha256:'+'b'.repeat(64);
  let moved=false;
  shell.addResponsePattern(/docker image inspect.*json .Id/,m=>({exitCode:0,stdout:JSON.stringify([m[0].includes(imageA)?imageA:moved?imageB:imageA,null]),stderr:''}));
  const accepted=await container.preflightProfileStorage(entry,{...profile,localArtifact:true});
  moved=true;
  await container.preflightProfileStorage(entry,accepted);
  expect(shell.commands).toHaveLength(2);
  expect(shell.commands[1]).toContain(imageA);
  expect(shell.commands.some(c=>/^docker (pull|create|start|run|rm|stop) /.test(c))).toBe(false);
 });
 it.each(['image','mount','entry'] as const)('a changed accepted %s is rejected before a business action',async drift=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config),image='sha256:'+'a'.repeat(64);
  shell.addResponsePattern(/docker image inspect.*json .Id/,()=>({exitCode:0,stdout:JSON.stringify([image,null]),stderr:''}));
  const accepted=await container.preflightProfileStorage(entry,{...profile,prebuiltImage:false});
  const changedEntry={...entry};
  if(drift==='image')accepted.dockerImage='other:latest';
  if(drift==='mount')accepted.cacheMounts=[{kind:'bind',hostPath:'/etc/a',containerPath:'/etc/a',readOnly:true}];
  if(drift==='entry')changedEntry.worktreePath='/other/source';
  await expect(container.runService(changedEntry,accepted,{profileId:'app',containerName:'old-app',hostPort:10001,status:'running'})).rejects.toThrow('storage-admission-changed');
  expect(shell.commands.some(c=>/^docker (network|pull|create|start|run|rm|stop) /.test(c))).toBe(false);
 });
});

describe('graph infrastructure admission permits only original runtime reuse',()=>{
 const legacy={id:'db',projectId:'project',name:'legacy',dockerImage:'fixture:image',containerName:'legacy.db',containerPort:8080,hostPort:10001,status:'stopped' as const,env:{},createdAt:'2026-10-23',volumes:[{type:'bind' as const,name:'/old/database',containerPath:'/data'}]};
 it.each(['running','exited','failed-wake','changed-id'] as const)('retains immutable original runtime: %s',async scenario=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config),cid='f'.repeat(64);let calls=0;
  shell.addResponsePattern(/docker inspect --format=.*json .State.Status/,()=>({exitCode:0,stdout:[scenario==='changed-id'&&calls++>0?'e'.repeat(64):cid,scenario==='running'?'running':'exited','/legacy.db'].map(x=>JSON.stringify(x)).join('|'),stderr:''}));
  shell.addResponse('docker start '+cid,{exitCode:scenario==='failed-wake'?1:0,stdout:cid,stderr:''});
  for(const method of ['ensureNetwork','ensureInfraOnNetwork','auditInfraLogLimit','auditMysqlConnectionLimit'])vi.spyOn(container as any,method).mockResolvedValue(undefined);
  try{
   const accepted=await container.preflightInfraStorage(legacy,{allowOriginalRuntime:true});
   if(['running','exited'].includes(scenario))await expect(container.startInfraService(accepted)).resolves.toBeUndefined();
   else await expect(container.startInfraService(accepted)).rejects.toThrow('unsafe_deployment_storage');
   expect(shell.commands.some(c=>/^docker (rm|run|create|volume create|pull) /.test(c))).toBe(false);
   if(scenario==='changed-id')expect(shell.commands.some(c=>c.startsWith('docker start '))).toBe(false);
  }finally{vi.restoreAllMocks()}
 });
 it.each([124,130,-1,'wrong-name'] as const)('unknown or mismatched absence is held: %s',async scenario=>{
  const shell=new MockShellExecutor(),container=new ContainerService(shell,config);
  shell.addResponsePattern(/^docker inspect /,()=>({exitCode:typeof scenario==='number'?scenario:1,stdout:'',stderr:'Error: No such object: '+(scenario==='wrong-name'?'legacy-db':'legacy.db')}));
  await expect(container.preflightInfraStorage(legacy,{allowOriginalRuntime:true})).rejects.toThrow('storage-original-container-unknown');
  expect(shell.commands).toHaveLength(1);
 });
});
