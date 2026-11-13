import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeService } from '../../src/services/worktree.js';
import { defaultOrphanWorktreeFs, JanitorService, createJanitorDockerAdapters } from '../../src/services/janitor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import { inspectDeploymentSource } from '../../src/services/deployment-source-inspection.js';
import { readWorktreeDirectoryIdentity } from '../../src/services/worktree-path-activity.js';
import { reclaimDeploymentSources } from '../../src/services/deployment-source-retention.js';
const exec = promisify(execFile), roots: string[] = [], containers: string[] = [];
const docker = (...args: string[]) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { encoding: 'utf8' }).trim();
afterEach(async () => {
 for (const id of containers.splice(0)) docker('rm', '-f', id);
 await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true })));
});
async function fixture() {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'cds-source-preview-'))); roots.push(root);
 const repo=path.join(root,'repo'),base=path.join(root,'worktrees'),canonical=path.join(base,'owned','feature');await fs.mkdir(repo);
 const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','Fixture');
 await fs.writeFile(path.join(repo,'payload.bin'),randomBytes(8*1048576));git('add','.');git('commit','-m','固定资源');git('remote','add','origin',repo);
 const sha=git('rev-parse','HEAD');git('worktree','add','--detach',canonical,sha);
 const worktrees=new WorktreeService({exec:async(command,options)=>{
  try{const r=await exec('/bin/sh',['-c',command],{cwd:options?.cwd,timeout:10000});return{...r,exitCode:0};}
  catch(e:any){return{stdout:e.stdout||'',stderr:e.stderr||'',exitCode:Number(e.code)||1};}
 }});
 const source=async()=>{const {sourcePath}=await worktrees.prepareDeploymentSource('main',canonical,sha);const old=new Date(Date.now()-3*3600000);await fs.utimes(sourcePath,old,old);return sourcePath;};
 const files={...defaultOrphanWorktreeFs,listMountedHostPaths:async()=>[] as string[]|null};
 const input={base,projectIds:['owned'],branches:()=>[] as any[],files,nowMs:Date.now()};
 return{root,repo,base,canonical,sha,git,worktrees,source,input,files};
}
describe('source preview uses actual Git and allocated blocks',()=>{
 it('previews clean sources while retaining persistent and unknown content without deletion',async()=>{
  const f=await fixture(),clean=await f.source(),data=await f.source(),unknown=await f.source();
  await fs.mkdir(path.join(data,'.cds-data'));await fs.writeFile(path.join(data,'.cds-data','mysql.ibd'),'business-data');
  await fs.writeFile(path.join(unknown,'unknown.db'),'unknown-owner');const old=new Date(Date.now()-3*3600000);for(const p of [data,unknown])await fs.utimes(p,old,old);
  const r=await reclaimDeploymentSources({...f.input,dryRun:true});
  expect(r.preview).toEqual([{path:clean,allocatedBytes:8*1048576}]);expect(r.attempted).toBe(0);expect(r.removed).toEqual([]);
  expect(r.held[data]).toBe('persistent-data');expect(r.held[unknown]).toBe('modified-or-unknown-files');
  expect(await fs.readFile(path.join(data,'.cds-data','mysql.ibd'),'utf8')).toBe('business-data');expect(f.git('worktree','list','--porcelain')).toContain(clean);
 });
 it('retains query failures, symbolic links and replacement objects',async()=>{
  const f=await fixture(),clean=await f.source(),original=await readWorktreeDirectoryIdentity(clean);
  await fs.rename(clean,clean+'-original');await fs.mkdir(clean);await fs.writeFile(path.join(clean,'new'),'new-data');
  expect((await inspectDeploymentSource(clean,original!,true)).reason).toBeTruthy();
  const linked=path.join(path.dirname(clean),randomUUID());await fs.symlink(clean+'-original',linked);
  expect((await reclaimDeploymentSources({...f.input,dryRun:true})).held[linked]).toBe('目录归属无法确认');
  f.files.listMountedHostPaths=async()=>null;
  const old=new Date(Date.now()-3*3600000);await fs.utimes(clean,old,old);
  expect(Object.values((await reclaimDeploymentSources({...f.input,dryRun:true})).held)).toContain('容器挂载枚举未完整确认，本轮不回收部署源码');
  expect(await fs.readFile(path.join(clean,'new'),'utf8')).toBe('new-data');
 });
 it('rechecks references instead of treating a preview as deletion authorization',async()=>{
  const f=await fixture(),clean=await f.source();expect((await reclaimDeploymentSources({...f.input,dryRun:true})).preview).toHaveLength(1);
  const r=await reclaimDeploymentSources({...f.input,branches:()=>[{id:'new',status:'running',services:{api:{sourceCheckoutPath:clean}}}as any]});
  expect(r.removed).toEqual([]);expect(r.held[clean]).toBeTruthy();
 });
 it('separates estimates from filesystem changes with external hard links and open deleted files',async()=>{
  const f=await fixture(),clean=await f.source(),payload=path.join(clean,'payload.bin');await fs.link(payload,path.join(f.root,'external-link'));const open=await fs.open(payload,'r');
  try{
   expect((await reclaimDeploymentSources({...f.input,dryRun:true})).preview![0].allocatedBytes).toBe(8*1048576);
   const r=await reclaimDeploymentSources(f.input);expect(r.removed).toEqual([clean]);expect(r.filesystem!.measurement).toBe('filesystem-net-change');
   expect(r.filesystem!.netAvailableBytesDelta).toBe(r.filesystem!.afterAvailableBytes!-r.filesystem!.beforeAvailableBytes!);
   expect((await open.stat()).size).toBe(8*1048576);expect((await fs.stat(path.join(f.root,'external-link'))).size).toBe(8*1048576);
  }finally{await open.close();}
 });
 it('cancels before any destructive dispatch',async()=>{
  const f=await fixture();await f.source();const ctrl=new AbortController();ctrl.abort();
  const r=await reclaimDeploymentSources({...f.input,dryRun:true,signal:ctrl.signal});expect(r.cancelled).toBe(true);expect(r.attempted).toBe(0);expect(r.deferred).toBe(1);
 });
 it('reloads stopped service references and exposes only project-relative identities',async()=>{
  const f=await fixture(),clean=await f.source(),stateFile=path.join(f.root,'state.json'),state=new StateService(stateFile),date=new Date().toISOString();
  state.addProject({id:'owned',name:'Own',slug:'owned',kind:'git',createdAt:date,updatedAt:date});
  state.addBranch({id:'stopped',projectId:'owned',branch:'feature',status:'idle',worktreePath:f.canonical,createdAt:date,services:{api:{profileId:'api',status:'stopped',sourceCheckoutPath:clean}}}as any);await state.flush();
  const reloaded=new StateService(stateFile);reloaded.load();
  const janitor=new JanitorService(reloaded,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},f.base,undefined,()=>null,undefined,undefined,f.files);
  const r=await janitor.previewDeploymentSources('owned');expect(r.candidates).toEqual([]);expect(r.held).toHaveLength(1);expect(JSON.stringify(r)).not.toContain(f.root);
  expect(r.scanStatus).toBe('complete');
  f.files.listMountedHostPaths=async()=>null;
  // A claimed leaf needs no mount query; remove the claim to exercise the actual unknown result.
  reloaded.removeBranch('stopped');
  expect((await janitor.previewDeploymentSources('owned')).scanStatus).toBe('partial');
  expect((await janitor.previewDeploymentSources('foreign')).scanned).toBe(0);await reloaded.flush();
 });
 it('reuses the merged image-only optimization in a fixed-resource continuous deployment experiment',async()=>{
  const f=await fixture(),before=await fs.statfs(f.base),sourceMs:number[]=[],prebuiltMs:number[]=[];
  for(let n=0;n<6;n++){const t=Date.now();await f.source();sourceMs.push(Date.now()-t);}
  const old=await fs.statfs(f.base),count=f.git('worktree','list','--porcelain').match(/^worktree /gm)!.length;
  for(let n=0;n<12;n++){const t=Date.now();expect((await f.worktrees.resolveDeploymentCommit('main',f.canonical,f.sha)).afterFull).toBe(f.sha);prebuiltMs.push(Date.now()-t);}
  expect(f.git('worktree','list','--porcelain').match(/^worktree /gm)!.length).toBe(count);
  const r=await reclaimDeploymentSources(f.input);expect(r.removed).toHaveLength(6);expect((await reclaimDeploymentSources(f.input)).scanned).toBe(0);
  const evidence={sourceCopies:6,prebuiltResolutions:12,sourceAllocatedNetBytes:(before.bavail-old.bavail)*before.bsize,sourceMs,prebuiltMs,reclamation:r.filesystem,longTermObserved:false};
  console.info('fixed-commit-lifecycle',JSON.stringify(evidence));if(process.env.CDS_DISK_EXPERIMENT_OUTPUT)await fs.writeFile(process.env.CDS_DISK_EXPERIMENT_OUTPUT,JSON.stringify(evidence,null,2));
 },20000);
});
describe.runIf(process.env.CDS_DISK_REAL_DOCKER==='1')('real isolated Docker bind references',()=>{
 it('transports a persistent-data hold from the actual owned worker without treating it as a deletion failure',async()=>{
  const f=await fixture(),clean=await f.source(),data=await f.source();
  await fs.mkdir(path.join(data,'.cds-data'));await fs.writeFile(path.join(data,'.cds-data','keep'),'persistent');
  const old=new Date(Date.now()-3*3600000);await fs.utimes(data,old,old);
  const pool=new IsolatedShellExecutor(new ShellExecutor(),{isolatedLane:'operation',concurrency:2,maxQueued:4,maxBytes:256*1024,reservedCleanup:1,reservedCleanupBytes:64*1024});
  await pool.start();
  try{
   f.input.files=createJanitorDockerAdapters(pool).orphanWorktreeFs;
   const r=await reclaimDeploymentSources(f.input);expect(r.removed).toContain(clean);expect(r.failed).toEqual([]);expect(r.held[data]).toBe('persistent-data');
   expect(await fs.readFile(path.join(data,'.cds-data','keep'),'utf8')).toBe('persistent');
  }finally{
   try{await pool.close();}catch(error){roots.splice(roots.indexOf(f.root),1);throw error;}
  }
  expect(pool.getStats()).toMatchObject({active:0,queued:0,bytes:0});
 },20000);
 it('protects running and stopped containers until the exact fixture container is removed',async()=>{
  const f=await fixture(),clean=await f.source();f.input.files=defaultOrphanWorktreeFs;
  const id=docker('create','--name','cds-disk-proof-'+randomUUID(),'--mount',`type=bind,src=${clean},dst=/source,readonly`,'alpine:3.21','sleep','60');containers.push(id);docker('start',id);
  expect((await reclaimDeploymentSources({...f.input,dryRun:true})).held[clean]).toContain('容器仍挂载');docker('stop','--time','1',id);
  expect((await reclaimDeploymentSources(f.input)).held[clean]).toContain('容器仍挂载');docker('rm',id);containers.splice(containers.indexOf(id),1);
  expect((await reclaimDeploymentSources(f.input)).removed).toContain(clean);
 },15000);
});
