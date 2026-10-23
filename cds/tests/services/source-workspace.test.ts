import {describe,it,expect,afterEach,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {profileStoragePlan,withRuntimeTmpfs,withReadOnlyTools,stableStorageVolumeName,resolveStorageImage} from '../../src/services/deployment-storage-plan.js';
import {withWritableSourceLayer,sourceWorkspaceCommand,SOURCE_STAGING_TARGET} from '../../src/services/source-workspace.js';
import {ContainerService} from '../../src/services/container.js';
import type {BranchEntry,BuildProfile,CdsConfig,StorageBinding,IShellExecutor} from '../../src/types.js';
const config:CdsConfig={repoRoot:'/unused',worktreeBase:'/unused',storageInstanceId:'test',masterPort:9900,workerPort:5500,dockerNetwork:'test',portStart:10001,sharedEnv:{},jwt:{secret:'test',issuer:'test'}};
const profile:BuildProfile={id:'app',projectId:'p',name:'app',workDir:'.',dockerImage:'node:20',containerWorkDir:'/app',containerPort:8080,command:'pnpm install && node app.js'};
const entry=(p:string)=>({id:'b',projectId:'p',branch:'b',worktreePath:p,status:'idle',services:{},createdAt:'2026-10-23'} as BranchEntry);
const roots:string[]=[];
const temp=()=>{const p=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'source-workspace-')));roots.push(p);return p;};
const plan=(root:string,extra:Partial<BuildProfile>={})=>withWritableSourceLayer(withRuntimeTmpfs(profileStoragePlan(entry(root),{...profile,...extra},config)));
const q=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
afterEach(()=>{vi.restoreAllMocks();for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true});});

describe('ordinary source uses only the new writable container layer',()=>{
 it('retains readonly host source, physical staging target, exact logical workspace and idempotent plan',()=>{
  const p=plan(temp());expect(p.mounts.find(m=>m.purpose==='source')).toMatchObject({target:SOURCE_STAGING_TARGET,workspaceTarget:'/app',readOnly:true});
  expect(withWritableSourceLayer(p)).toBe(p);expect(sourceWorkspaceCommand(p,'pnpm install')).toContain('cp -RP --');
 });
 it('rejects a file used as a source workspace before Docker or old service actions',async()=>{
  const root=temp();fs.writeFileSync(root+'/not-directory','source');const calls:string[]=[];
  const shell:IShellExecutor={exec:async c=>{calls.push(c);return{exitCode:0,stdout:'',stderr:''}}};
  await expect(new ContainerService(shell,config).preflightDeploymentStorage(entry(root),[{...profile,workDir:'not-directory'}])).rejects.toThrow('storage-bind-identity-unconfirmed');expect(calls).toEqual([]);
 });
 it('prebuilt artifacts keep their original command and have no source copy',()=>{
  const p=plan(temp(),{prebuiltImage:true});expect(p.mounts.some(m=>m.purpose==='source')).toBe(false);expect(sourceWorkspaceCommand(p,'node app.js')).toBe('node app.js');
 });
 it.each(['/app','/app/node_modules','/app/data','/'])('fails closed for a stable mount overlapping source workspace: %s',target=>{
  const owner:StorageBinding={version:1,instanceId:'test',projectId:'p',scope:'branch-private',branchId:'b',serviceId:'app',mountKey:'data',purpose:'cache'};
  expect(()=>plan(temp(),{cacheMounts:[{kind:'volume',hostPath:stableStorageVolumeName(owner),containerPath:target,storage:owner}]})).toThrow(target==='/app'?'storage-target-duplicate':'storage-source-workspace-overlap');
 });
 it('also rejects a parent mount, runtime tmpfs and server-tool overlap',()=>{
  const owner:StorageBinding={version:1,instanceId:'test',projectId:'p',scope:'branch-private',branchId:'b',serviceId:'app',mountKey:'data',purpose:'persistent'};
  expect(()=>plan(temp(),{containerWorkDir:'/app/code',cacheMounts:[{kind:'volume',hostPath:stableStorageVolumeName(owner),containerPath:'/app',storage:owner}]})).toThrow('storage-source-workspace-overlap');
  expect(()=>plan(temp(),{containerWorkDir:'/tmp/app'})).toThrow('storage-source-workspace-overlap');
  expect(()=>withWritableSourceLayer(withReadOnlyTools(plan(temp()),[{source:'/server/ffmpeg',target:'/app/ffmpeg'}]))).toThrow('storage-source-workspace-overlap');
 });
 it('rejects image-declared workspace VOLUME rather than permitting an anonymous volume',async()=>{
  const p=plan(temp()),shell:IShellExecutor={exec:async()=>({exitCode:0,stdout:JSON.stringify(['sha256:'+'a'.repeat(64),{'/app':{}}]),stderr:''})};
  await expect(resolveStorageImage(shell,'node:20',p)).rejects.toThrow('storage-image-volume-unbound');
 });
 it('actual full-graph preflight rejects a source/data overlap before any shell or old service action',async()=>{
  const p=temp(),calls:string[]=[],shell:IShellExecutor={exec:async c=>{calls.push(c);return{exitCode:0,stdout:'',stderr:''}}};
  const owner:StorageBinding={version:1,instanceId:'test',projectId:'p',scope:'branch-private',branchId:'b',serviceId:'app',mountKey:'data',purpose:'persistent'};
  await expect(new ContainerService(shell,config).preflightDeploymentStorage(entry(p),[{...profile,cacheMounts:[{kind:'volume',hostPath:stableStorageVolumeName(owner),containerPath:'/app/data',storage:owner}]}])).rejects.toThrow('storage-source-workspace-overlap');
  expect(calls).toEqual([]);
 });
 it('real local POSIX primitives build node_modules/obj/bin in the private layer without changing source or following an old image symlink',()=>{
  const p=temp(),source=path.join(p,'source'),workspace=path.join(p,'workspace'),protectedDir=path.join(p,'protected');
  fs.mkdirSync(source);fs.mkdirSync(workspace);fs.mkdirSync(protectedDir);fs.writeFileSync(source+'/tracked','original');fs.writeFileSync(source+'/.config','config');fs.writeFileSync(protectedDir+'/keep','protected');
  fs.symlinkSync(protectedDir,workspace+'/old-link');fs.writeFileSync(workspace+'/old-image-file','old');
  fs.symlinkSync('tracked',source+'/tracked-link');fs.writeFileSync(source+'/executable','#!/bin/sh\n');fs.chmodSync(source+'/executable',0o755);
  const pplan=plan(source,{containerWorkDir:workspace});
  const command=sourceWorkspaceCommand(pplan,"mkdir -p node_modules obj bin; printf built > node_modules/build; test -x executable; test -L tracked-link; test \"$(cat .config)\" = config; printf changed > tracked");
  // Only the fixed container staging prefix is remapped into this owned host fixture.
  // This validates actual sh/cp primitives, not an Alpine/Docker execution claim.
  const mapped=command.replace(q(SOURCE_STAGING_TARGET+'/.'),q(source+'/.'));
  const result=spawnSync('/bin/sh',['-c',mapped],{encoding:'utf8',timeout:5000});expect(result.status,result.stderr).toBe(0);
  expect(fs.readFileSync(source+'/tracked','utf8')).toBe('original');expect(fs.readFileSync(workspace+'/tracked','utf8')).toBe('changed');
  expect(fs.readFileSync(workspace+'/node_modules/build','utf8')).toBe('built');expect(fs.existsSync(workspace+'/obj')).toBe(true);expect(fs.existsSync(workspace+'/bin')).toBe(true);
  expect(fs.existsSync(workspace+'/old-image-file')).toBe(false);expect(fs.readFileSync(protectedDir+'/keep','utf8')).toBe('protected');
 });
 it.each(['workspace','ancestor'])('refuses an actual image %s symlink before copying or deleting any protected data',kind=>{
  const p=temp(),source=p+'/source',protectedDir=p+'/protected';fs.mkdirSync(source);fs.mkdirSync(protectedDir);fs.writeFileSync(source+'/file','source');fs.writeFileSync(protectedDir+'/keep','protected');
  const link=p+'/link';fs.symlinkSync(protectedDir,link);const workspace=kind==='workspace'?link:link+'/nested';
  const command=sourceWorkspaceCommand(plan(source,{containerWorkDir:workspace}),'true').replace(q(SOURCE_STAGING_TARGET+'/.'),q(source+'/.'));
  const result=spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:5000});expect(result.status).toBe(126);expect(result.stderr).toContain('storage-source-workspace-symlink');expect(fs.readFileSync(protectedDir+'/keep','utf8')).toBe('protected');expect(fs.existsSync(protectedDir+'/nested')).toBe(false);
 });
});

it.each(['job','app'] as const)('actual Container %s emits RO staging and executes the copied command in its private layer',async kind=>{
 const p=temp(),source=p+'/source',workspace=p+'/workspace';fs.mkdirSync(source);fs.mkdirSync(workspace);fs.writeFileSync(source+'/tracked','original');let launched=0;
 const shell:IShellExecutor={exec:async(command,options)=>{
  options?.beforeStart?.();
  if(command.startsWith('docker run --rm ')||command.startsWith('docker run -d ')){
   expect(command).toContain('dst='+SOURCE_STAGING_TARGET+',readonly');
   // Shell's real argv parser, but a local function replaces Docker; no daemon runs.
   const parsed=spawnSync('/bin/sh',['-c',`docker() { for cds_arg in "$@"; do printf '%s\\000' "$cds_arg"; done; }; ${command}`],{encoding:'utf8',timeout:5000});
   expect(parsed.status,parsed.stderr).toBe(0);const args=parsed.stdout.split('\0').filter(Boolean),script=args[args.length-1];
   expect(script).toContain('cp -RP --');
   const mapped=script.replace(q(SOURCE_STAGING_TARGET+'/.'),q(source+'/.'));
   const result=spawnSync('/bin/sh',['-c',mapped],{encoding:'utf8',timeout:5000});launched++;
   return{exitCode:result.status??1,stdout:kind==='app'&&result.status===0?'c'.repeat(64):result.stdout,stderr:result.stderr};
  }
  return{exitCode:0,stdout:command.includes('json .Id')?JSON.stringify(['sha256:'+'a'.repeat(64),null]):'',stderr:''};
 }};
 const previous=process.env.CDS_BRANCH_NETWORK_ISOLATION;process.env.CDS_BRANCH_NETWORK_ISOLATION='0';
 try{
  const container=new ContainerService(shell,config),command='test "$(cat tracked)" = original; mkdir -p node_modules obj bin; printf built > node_modules/result';
  for(const method of ['ensureNetwork','pruneStaleAppContainersForProfile','remove','waitForContainerAlive'])vi.spyOn(container as any,method).mockResolvedValue(undefined);
  const pprofile={...profile,dockerImage:'alpine:3',containerWorkDir:workspace,command};
  const result=kind==='job'?await container.runProfileCommand(entry(source),pprofile,command):await container.runService(entry(source),pprofile,{profileId:'app',containerName:'owned-app',hostPort:10001,status:'building'});
  if(kind==='job')expect(result).toMatchObject({exitCode:0});else expect(result).toBeUndefined();expect(launched).toBe(1);expect(fs.readFileSync(workspace+'/node_modules/result','utf8')).toBe('built');expect(fs.readFileSync(source+'/tracked','utf8')).toBe('original');
 }finally{if(previous===undefined)delete process.env.CDS_BRANCH_NETWORK_ISOLATION;else process.env.CDS_BRANCH_NETWORK_ISOLATION=previous;}
});
