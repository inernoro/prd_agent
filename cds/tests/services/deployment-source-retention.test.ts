import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor } from '../../src/types.js';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => fs.rm(p, {recursive:true,force:true}))); });
async function fixture() {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'cds-source-retention-')));roots.push(root);
 const repo=path.join(root,'repo');await fs.mkdir(repo);
 const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.email','test@example.invalid');git('config','user.name','Test');
 await fs.writeFile(path.join(repo,'source.txt'),'immutable source');git('add','.');git('commit','-m','fixture');
 git('remote','add','origin',repo);const sha=git('rev-parse','HEAD');
 const shell:IShellExecutor={exec:async(command,opts)=>{try{const r=await exec('/bin/sh',['-c',command],{cwd:opts?.cwd,timeout:10000});return{...r,exitCode:0};}catch(e:any){return{stdout:e.stdout??'',stderr:e.stderr??'',exitCode:e.code??1};}}};
 return{root,repo,git,sha,service:new WorktreeService(shell)};
}
describe('actual Git image-only source preparation',()=>{
 it('resolves latest full SHA without allocating a detached worktree or copying tracked evidence',async()=>{
  const f=await fixture();const result=await f.service.resolveDeploymentCommit('main',f.repo);
  expect(result.afterFull).toBe(f.sha);
  expect('sourcePath' in result).toBe(false);
  expect(f.git('worktree','list','--porcelain').match(/^worktree /gm)).toHaveLength(1);
  await expect(fs.access(WorktreeService.deploymentSourceRootFor(f.repo))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('resolves a new remote B while the existing canonical worktree remains at A',async()=>{
  const f=await fixture();const canonical=path.join(f.root,'canonical');f.git('worktree','add','--detach',canonical,f.sha);
  await fs.writeFile(path.join(f.repo,'source.txt'),'new B');f.git('commit','-am','new remote');const b=f.git('rev-parse','HEAD');
  const result=await f.service.resolveDeploymentCommit('main',canonical);
  expect(result.before).toBe(f.sha);expect(result.afterFull).toBe(b);expect('sourcePath' in result).toBe(false);
  expect(execFileSync('/usr/bin/git',['-C',canonical,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(f.sha);
  expect((await f.service.resolveDeploymentCommit('main',canonical,f.sha)).afterFull).toBe(f.sha);
 });
 it('source deployments still get distinct, exact worktrees for the same SHA',async()=>{
  const f=await fixture();const a=await f.service.prepareDeploymentSource('main',f.repo,f.sha);const b=await f.service.prepareDeploymentSource('main',f.repo,f.sha);
  expect(a.sourcePath).not.toBe(b.sourcePath);expect(await fs.readFile(path.join(a.sourcePath,'source.txt'),'utf8')).toBe('immutable source');
  expect(execFileSync('/usr/bin/git',['-C',b.sourcePath,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(f.sha);
 });
});

import { JanitorService, defaultOrphanWorktreeFs } from '../../src/services/janitor.js';
import { StateService } from '../../src/services/state.js';
import { removeOwnedDirectory } from '../../src/services/worktree-directory-removal-process.js';
import { readWorktreeDirectoryIdentity, WorktreeClaimHeldError } from '../../src/services/worktree-path-activity.js';
import { reclaimDeploymentSources } from '../../src/services/deployment-source-retention.js';
import { deploymentNeedsSourceCheckout } from '../../src/services/worktree.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';

async function sourceFixture() {
 const f=await fixture(),base=path.join(f.root,'worktrees'),canonical=path.join(base,'proj','branch');
 f.git('worktree','add','--detach',canonical,f.sha);
 const branch:BranchEntry={id:'branch',projectId:'proj',branch:'main',worktreePath:canonical,services:{},status:'running',createdAt:new Date().toISOString()};
 const make=async()=>{const s=await f.service.prepareDeploymentSource('main',canonical,f.sha);const old=new Date(Date.now()-4*3600_000);await fs.utimes(s.sourcePath,old,old);return s.sourcePath;};
 const remove=async(dir:string,options:any)=>{options.beforeStart();const status=await removeOwnedDirectory({...options,dir});if(status==='held')throw new WorktreeClaimHeldError();return null;};
 const files={...defaultOrphanWorktreeFs,listMountedHostPaths:async()=>[] as string[]|null,removeDir:remove};
 const sweep=(afterPath?:string)=>reclaimDeploymentSources({base,projectIds:['proj'],branches:()=>[branch],files,nowMs:Date.now(),afterPath});
 return{...f,base,canonical,branch,make,files,sweep};
}
describe('safe detached source retention on real Git and files',()=>{
 it('hourly Janitor reclaims an old clean leaf inside a live branch bucket, unregistering Git metadata',async()=>{
  const f=await sourceFixture();const stale=await f.make();const used=await f.make();
  f.branch.services={source:{profileId:'source',status:'stopped',sourceCheckoutPath:used}as any};
  const state=new StateService(path.join(f.root,'state.json'));state.addProject({id:'proj',slug:'proj',name:'Test',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}as any);state.addBranch(f.branch);
  const janitor=new JanitorService(state,{enabled:true,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},f.base,undefined,()=>null,undefined,undefined,f.files);
  const report=await janitor.sweep();expect(report.deploymentSources?.removed).toContain(stale);expect(await fs.readFile(path.join(used,'source.txt'),'utf8')).toBe('immutable source');
  expect(janitor.getSnapshot().lastSweep?.deploymentSources).toMatchObject({scanned:2,attempted:1,removed:1,held:1,deferred:0});
  expect(f.git('worktree','list','--porcelain')).not.toContain(stale);expect(await fs.stat(f.canonical)).toBeTruthy();
 });
 it.each(['child','parent'])('retains a snapshot covered by a %s bind, including stopped containers',async kind=>{
  const f=await sourceFixture();const dir=await f.make();f.files.listMountedHostPaths=async()=>[kind==='child'?path.join(dir,'some-data'):path.dirname(dir)];
  expect((await f.sweep()).removed).toEqual([]);expect(await fs.readFile(path.join(dir,'source.txt'),'utf8')).toBe('immutable source');
 });
 it.each(['.cds-data','.cds-run-data','.opaque-cache'])('preserves unmounted persistent or unknown content in %s',async name=>{
  const f=await sourceFixture();const dir=await f.make();await fs.mkdir(path.join(dir,name));await fs.writeFile(path.join(dir,name,'database.bin'),'irreplaceable data');
  const old=new Date(Date.now()-4*3600_000);await fs.utimes(dir,old,old);
  expect((await f.sweep()).removed).toEqual([]);expect(await fs.readFile(path.join(dir,name,'database.bin'),'utf8')).toBe('irreplaceable data');
 });
 it('preserves ignored runtime content as well as normal untracked files',async()=>{
  const f=await sourceFixture();const dir=await f.make();await fs.writeFile(path.join(dir,'.gitignore'),'private-store/\n');
  // Commit only the ignore rule in this isolated worktree; data itself stays ignored.
  execFileSync('/usr/bin/git',['-C',dir,'add','.gitignore']);execFileSync('/usr/bin/git',['-C',dir,'commit','-m','ignore fixture']);
  await fs.mkdir(path.join(dir,'private-store'));await fs.writeFile(path.join(dir,'private-store','db'),'keep');const old=new Date(Date.now()-4*3600_000);await fs.utimes(dir,old,old);
  expect((await f.sweep()).removed).toEqual([]);expect(await fs.readFile(path.join(dir,'private-store','db'),'utf8')).toBe('keep');
 });
 it('holds data appearing after deletion dispatch',async()=>{
  const f=await sourceFixture();const dir=await f.make();const identity=await readWorktreeDirectoryIdentity(dir);await fs.mkdir(path.join(dir,'.cds-data'));await fs.writeFile(path.join(dir,'.cds-data','db'),'new data');
  expect(await removeOwnedDirectory({dir,allowedBase:f.base,identity:identity!,entryOnly:false,sourceOnly:true})).toBe('held');expect(await fs.readFile(path.join(dir,'.cds-data','db'),'utf8')).toBe('new data');
 });
 it('does not remove when all-container mount enumeration is unavailable',async()=>{
  const f=await sourceFixture();const dir=await f.make();f.files.listMountedHostPaths=async()=>null;
  expect((await f.sweep()).removed).toEqual([]);expect(await fs.stat(dir)).toBeTruthy();
 });
 it('rechecks new branch deployment ownership after asynchronous mount observation',async()=>{
  const f=await sourceFixture();const dir=await f.make();let reads=0;f.files.listMountedHostPaths=async()=>{if(++reads===2)f.branch.status='building';return[];};
  expect((await f.sweep()).removed).toEqual([]);expect(await fs.stat(dir)).toBeTruthy();
 });
 it('bounds every dispatched removal, including held attempts, to twenty per sweep',async()=>{
  const f=await sourceFixture();const first=await f.make();
  for(let i=0;i<20;i++)await fs.mkdir(path.join(path.dirname(first),randomUUID()));
  f.files.statDirMtimeMs=async()=>0;
  let attempts=0;f.files.removeDir=async()=>{attempts++;throw new WorktreeClaimHeldError();};
  const report=await f.sweep();expect(attempts).toBe(20);expect(report.attempted).toBe(20);
  expect(report.deferred).toBe(1);expect(report.removed).toEqual([]);
 });
 it('hourly Janitor advances past held leaves across bounded sweeps',async()=>{
  const f=await sourceFixture();const first=await f.make();
  for(let i=0;i<20;i++)await fs.mkdir(path.join(path.dirname(first),randomUUID()));
  f.files.statDirMtimeMs=async()=>0;
  const seen=new Set<string>();f.files.removeDir=async dir=>{seen.add(dir);throw new WorktreeClaimHeldError();};
  const state=new StateService(path.join(f.root,'state.json'));
  state.addProject({id:'proj',slug:'proj',name:'Test',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}as any);state.addBranch(f.branch);
  const janitor=new JanitorService(state,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},f.base,undefined,()=>null,undefined,undefined,f.files);
  expect((await janitor.sweep()).deploymentSources?.attempted).toBe(20);expect(seen.size).toBe(20);
  expect((await janitor.sweep()).deploymentSources?.attempted).toBe(20);expect(seen.size).toBe(21);
 });
 it('rejects a parent swapped to a foreign directory inside the same base before identity capture',async()=>{
  const f=await sourceFixture();const dir=await f.make(),bucket=path.dirname(dir);
  const sourceRoot=path.dirname(bucket),foreignRoot=path.join(f.base,'proj','foreign');
  const foreign=path.join(foreignRoot,path.basename(bucket),path.basename(dir));
  f.git('worktree','add','--detach',foreign,f.sha);
  const originalRead=f.files.readDirectoryIdentity!;let swapped=false;
  f.files.readDirectoryIdentity=async p=>{
   if(!swapped){swapped=true;f.git('worktree','move',dir,path.join(f.root,'retained-original'));await fs.rmdir(bucket);await fs.rmdir(sourceRoot);await fs.symlink(foreignRoot,sourceRoot,'dir');}
   return originalRead(p);
  };
  f.files.statDirMtimeMs=async()=>0;
  const report=await f.sweep();expect(report.attempted).toBe(0);expect(report.held[dir]).toBeTruthy();
  const identity=await readWorktreeDirectoryIdentity(dir);
  expect(await removeOwnedDirectory({dir,allowedBase:f.base,identity:identity!,entryOnly:false,sourceOnly:true})).toBe('held');
  expect(await fs.readFile(path.join(foreign,'source.txt'),'utf8')).toBe('immutable source');
  expect(f.git('worktree','list','--porcelain')).toContain(foreign);
 });
 it('does not expose a source bucket to generic orphan deletion',async()=>{
  const f=await sourceFixture();await f.make();const result=await defaultOrphanWorktreeFs.listWorktreeDirs(f.base,['proj']);
  expect(result.dirs.some(p=>p.path.includes('.deployment-sources'))).toBe(false);
 });
});
describe('source requirement uses actual effective profile shape',()=>{
 const image={id:'api',workDir:'.',dockerImage:'example/api:sha-test',prebuiltImage:true,command:'',containerPort:8080}as BuildProfile;
 it('only pure image graphs skip source checkout',()=>{
  expect(deploymentNeedsSourceCheckout([image])).toBe(false);
  expect(deploymentNeedsSourceCheckout([{...image,cacheMounts:[{kind:'volume',hostPath:'cache',containerPath:'/cache'}]}])).toBe(false);
  expect(deploymentNeedsSourceCheckout([{...image,command:'sh ./start.sh'}])).toBe(true);
  expect(deploymentNeedsSourceCheckout([{...image,prebuiltImage:false}])).toBe(true);
  expect(deploymentNeedsSourceCheckout([{...image,cacheMounts:[{hostPath:'/host/config',containerPath:'/config'}]}])).toBe(true);
 });
});
