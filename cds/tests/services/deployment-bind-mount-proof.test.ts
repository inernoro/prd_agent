import {describe, it, expect, afterEach, vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {profileStoragePlan, infraStoragePlan, withReadOnlyTools} from '../../src/services/deployment-storage-plan.js';
import {nativeBindMountInspector, guardBindMountShell} from '../../src/services/deployment-bind-mount-proof.js';
import {ContainerService} from '../../src/services/container.js';
import type {BuildProfile, CdsConfig, BranchEntry, IShellExecutor} from '../../src/types.js';
const dirs:string[]=[];
const root=()=>{const p=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cds-bind-proof-')));dirs.push(p);return p;};
const profile:BuildProfile={id:'app',name:'app',dockerImage:'alpine:3',workDir:'.',containerPort:8080,command:'echo ok'};
const entry=(p:string)=>({id:'b',projectId:'p',worktreePath:p,branch:'b',services:{},status:'idle',createdAt:'2026-10-23'} as BranchEntry);
const config:CdsConfig={repoRoot:'/unused',worktreeBase:'/unused',storageInstanceId:'test',masterPort:9900,workerPort:5500,dockerNetwork:'test',portStart:10001,sharedEnv:{},jwt:{secret:'test',issuer:'test'}};
const plan=(p:string, workDir='.')=>profileStoragePlan(entry(p),{...profile,workDir},config);
afterEach(()=>{vi.restoreAllMocks();for(const p of dirs.splice(0))fs.rmSync(p,{recursive:true,force:true});});

describe('real host bind identity',()=>{
 it('retains an ordinary source directory and regular source file without host-wide config authority',()=>{
  const p=root();fs.writeFileSync(path.join(p,'config.txt'),'owned');
  const dir=nativeBindMountInspector(plan(p));dir();
  const file=nativeBindMountInspector(plan(p,'config.txt'));file();
 });
 it.each(['/','/var/run/docker.sock','./local-config'])('rejects user readonly config bind %s before any native operation',source=>{
  const p=root();
  expect(()=>profileStoragePlan(entry(p),{...profile,prebuiltImage:true,cacheMounts:[{kind:'bind',hostPath:source,containerPath:'/config',readOnly:true}]},config)).toThrow('storage-bind-pin-required');
  expect(()=>infraStoragePlan({id:'db',projectId:'p',volumes:[{type:'bind',name:source,containerPath:'/config',readOnly:true}]},config)).toThrow('storage-bind-pin-required');
 });
 it.each(['leaf','ancestor','anchor'])('rejects %s symlink without reading outside contents',kind=>{
  const p=root(),outside=root();fs.mkdirSync(path.join(p,'dir'));
  if(kind==='leaf')fs.symlinkSync(outside,path.join(p,'link'));
  if(kind==='ancestor'){fs.symlinkSync(outside,path.join(p,'link'));fs.mkdirSync(path.join(outside,'child'));}
  if(kind==='anchor'){fs.symlinkSync(p,path.join(outside,'link'));expect(()=>nativeBindMountInspector(plan(path.join(outside,'link')))).toThrow('storage-bind-identity-unconfirmed');return;}
  expect(()=>nativeBindMountInspector(plan(p,kind==='leaf'?'link':'link/child'))).toThrow('storage-bind-identity-unconfirmed');
 });
 it('rejects an actual Unix socket even with a source readonly declaration',async()=>{
  const p=root(),socket=path.join(p,'daemon.sock'),server=net.createServer();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve)});
  try{expect(()=>nativeBindMountInspector(plan(p,'daemon.sock'))).toThrow('storage-bind-identity-unconfirmed');}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it('rejects an actual hardlinked regular file and unknown/missing IO',()=>{
  const p=root();fs.writeFileSync(path.join(p,'one'),'owned');fs.linkSync(path.join(p,'one'),path.join(p,'two'));
  expect(()=>nativeBindMountInspector(plan(p,'one'))).toThrow('storage-bind-identity-unconfirmed');
  expect(()=>nativeBindMountInspector(plan(p,'missing'))).toThrow('storage-bind-identity-unconfirmed');
 });
 it('server-added tools need real regular non-symlink identity and retain the source proof',()=>{
  const p=root(),tools=root();fs.writeFileSync(path.join(tools,'ffmpeg'),'owned');
  const combined=withReadOnlyTools(plan(p),[{source:path.join(tools,'ffmpeg'),target:'/usr/bin/ffmpeg'}]);
  const check=nativeBindMountInspector(combined);check();
  fs.renameSync(path.join(tools,'ffmpeg'),path.join(tools,'old'));fs.writeFileSync(path.join(tools,'ffmpeg'),'replacement');
  expect(check).toThrow('storage-bind-identity-unconfirmed');
 });
 it('a directory replaced with another real directory at queue time cannot launch',async()=>{
  const p=root();fs.mkdirSync(path.join(p,'src'));const check=nativeBindMountInspector(plan(p,'src'));let launched=0;
  const shell:IShellExecutor={exec:async(_cmd,options)=>{fs.renameSync(path.join(p,'src'),path.join(p,'old'));fs.mkdirSync(path.join(p,'src'));options?.beforeStart?.();launched++;return{exitCode:0,stdout:'',stderr:''};}};
  await expect(guardBindMountShell(shell,check).exec('docker create image')).rejects.toThrow('storage-bind-identity-unconfirmed');expect(launched).toBe(0);
 });
 it.each(['stable','replaced'])('actual Container public job uses the real synchronous slot proof: %s',async mode=>{
  const p=root();fs.mkdirSync(path.join(p,'src'));let launched=0;
  const shell:IShellExecutor={exec:async(command,options)=>{
   if(command.startsWith('docker run ')){
    if(mode==='replaced'){fs.renameSync(path.join(p,'src'),path.join(p,'old'));fs.mkdirSync(path.join(p,'src'));}
    options?.beforeStart?.();launched++;return{exitCode:0,stdout:'done',stderr:''};
   }
   options?.beforeStart?.();return{exitCode:0,stdout:command.includes('json .Id')?JSON.stringify(['sha256:'+'a'.repeat(64),null]):'',stderr:''};
  }};
  const container=new ContainerService(shell,config);
  vi.spyOn(container as any,'ensureNetwork').mockResolvedValue(undefined);
  const previous=process.env.CDS_BRANCH_NETWORK_ISOLATION;process.env.CDS_BRANCH_NETWORK_ISOLATION='0';
  try{
   const result=container.runProfileCommand(entry(p),{...profile,workDir:'src'},'echo ok');
   if(mode==='replaced'){await expect(result).rejects.toThrow('storage-bind-identity-unconfirmed');expect(launched).toBe(0);}
   else{await expect(result).resolves.toMatchObject({exitCode:0});expect(launched).toBe(1);}
  }finally{if(previous===undefined)delete process.env.CDS_BRANCH_NETWORK_ISOLATION;else process.env.CDS_BRANCH_NETWORK_ISOLATION=previous;}
 });
});

describe('actual app and managed source dispatch',()=>{
 it.each(['stable','replaced'])('public runService protects the queued ordinary source mount: %s',async mode=>{
  const p=root();fs.mkdirSync(path.join(p,'src'));let launches=0;
  const shell:IShellExecutor={exec:async(command,options)=>{
   if(command.startsWith('docker run ')){
    if(mode==='replaced'){fs.renameSync(path.join(p,'src'),path.join(p,'old'));fs.mkdirSync(path.join(p,'src'));}
    options?.beforeStart?.();launches++;return{exitCode:0,stdout:'c'.repeat(64),stderr:''};
   }
   options?.beforeStart?.();return{exitCode:0,stdout:command.includes('json .Id')?JSON.stringify(['sha256:'+'a'.repeat(64),null]):'',stderr:''};
  }};
  const container=new ContainerService(shell,config);
  for(const method of ['ensureNetwork','pruneStaleAppContainersForProfile','remove','waitForContainerAlive'])vi.spyOn(container as any,method).mockResolvedValue(undefined);
  const previous=process.env.CDS_BRANCH_NETWORK_ISOLATION;process.env.CDS_BRANCH_NETWORK_ISOLATION='0';
  try{
   const result=container.runService(entry(p),{...profile,workDir:'src'}, {profileId:'app',containerName:'new-app',hostPort:10001,status:'building'});
   if(mode==='replaced'){await expect(result).rejects.toThrow('storage-bind-identity-unconfirmed');expect(launches).toBe(0);}
   else{await expect(result).resolves.toBeUndefined();expect(launches).toBe(1);}
  }finally{if(previous===undefined)delete process.env.CDS_BRANCH_NETWORK_ISOLATION;else process.env.CDS_BRANCH_NETWORK_ISOLATION=previous;}
 });
 it('actual managed builder copy rechecks native source after the queue wait, with zero copy/start on replacement',async()=>{
  const p=root();fs.mkdirSync(path.join(p,'src'));const target='b'.repeat(40),cid='c'.repeat(64),image='sha256:'+'a'.repeat(64);let name='',copies=0,starts=0;
  const shell:IShellExecutor={exec:async(command,options)=>{
   if(command.startsWith('docker cp ')){
    fs.renameSync(path.join(p,'src'),path.join(p,'old'));fs.mkdirSync(path.join(p,'src'));options?.beforeStart?.();copies++;return{exitCode:0,stdout:'',stderr:''};
   }
   options?.beforeStart?.();
   if(command==='git rev-parse HEAD')return{exitCode:0,stdout:target,stderr:''};
   if(command.startsWith('docker image inspect ')&&!command.includes('json .Id'))return{exitCode:1,stdout:'',stderr:'No such image'};
   if(command.includes('json .Id')&&command.startsWith('docker image inspect '))return{exitCode:0,stdout:JSON.stringify([image,null]),stderr:''};
   if(command.startsWith('docker create ')){name=command.match(/--name '([^']+)'/)?.[1]||'';return{exitCode:0,stdout:cid,stderr:''};}
   if(command.startsWith('docker inspect '))return{exitCode:0,stdout:JSON.stringify([cid,'/'+name,image,0,'created',[],null]),stderr:''};
   if(command.startsWith('docker start '))starts++;
   return{exitCode:0,stdout:'',stderr:''};
  }};
  const container=new ContainerService(shell,config),cleanup=vi.spyOn(container as any,'cleanupTemporaryContainer').mockResolvedValue(undefined);
  const managed={...profile,workDir:'src',managedBuild:{stack:'node' as const,installCommand:'',buildCommand:'echo ok',startCommand:'node app.js',artifactImage:'artifact:target'}};
  await expect((container as any).buildManagedArtifact(entry(p),managed,{profileId:'app',containerName:'builder',hostPort:0,status:'building'},target,'network')).rejects.toThrow('storage-bind-identity-unconfirmed');
  expect(copies).toBe(0);expect(starts).toBe(0);expect(cleanup).toHaveBeenCalledWith(cid,expect.anything(),'app');
 });
});
