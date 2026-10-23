import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { WorktreeService } from '../../src/services/worktree.js';
import type { IShellExecutor } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { await flushAllJsonStateStores(); await Promise.all(roots.splice(0).map(p => fs.rm(p, {recursive:true,force:true}))); });
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
  const f=await fixture();const result=await f.service.resolveDeploymentCommit(f.repo,'main',f.repo);
  expect(result.afterFull).toBe(f.sha);
  expect('sourcePath' in result).toBe(false);
  expect(f.git('worktree','list','--porcelain').match(/^worktree /gm)).toHaveLength(1);
  await expect(fs.access(WorktreeService.deploymentSourceRootFor(f.repo))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('resolves a new remote B while the existing canonical worktree remains at A',async()=>{
  const f=await fixture();const canonical=path.join(f.root,'canonical');f.git('worktree','add','--detach',canonical,f.sha);
  await fs.writeFile(path.join(f.repo,'source.txt'),'new B');f.git('commit','-am','new remote');const b=f.git('rev-parse','HEAD');
  const result=await f.service.resolveDeploymentCommit(f.repo,'main',canonical);
  expect(result.before).toBe(f.sha);expect(result.afterFull).toBe(b);expect('sourcePath' in result).toBe(false);
  expect(execFileSync('/usr/bin/git',['-C',canonical,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(f.sha);
  expect((await f.service.resolveDeploymentCommit(f.repo,'main',canonical,f.sha)).afterFull).toBe(f.sha);
 });
 it('source deployments still get distinct, exact worktrees for the same SHA',async()=>{
  const f=await fixture();const a=await f.service.prepareDeploymentSource(f.repo,'main',f.repo,f.sha);const b=await f.service.prepareDeploymentSource(f.repo,'main',f.repo,f.sha);
  expect(a.sourcePath).not.toBe(b.sourcePath);expect(await fs.readFile(path.join(a.sourcePath,'source.txt'),'utf8')).toBe('immutable source');
  expect(execFileSync('/usr/bin/git',['-C',b.sourcePath,'rev-parse','HEAD'],{encoding:'utf8'}).trim()).toBe(f.sha);
 });
 it('database source decisions and initialization files follow target A or C while canonical stays at B',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.repo,'init.sql'),'select 1; -- A');f.git('add','.');f.git('commit','-m','init A');const a=f.git('rev-parse','HEAD');
  await fs.writeFile(path.join(f.repo,'init.sql'),'select 2; -- B');f.git('commit','-am','init B');const b=f.git('rev-parse','HEAD');
  const canonical=path.join(f.root,'canonical');f.git('worktree','add','--detach',canonical,b);
  await fs.unlink(path.join(f.repo,'init.sql'));f.git('commit','-am','remove init');const c=f.git('rev-parse','HEAD');
  expect(await f.service.needsDatabaseInitializationSource(canonical,a,['.'])).toBe(true);
  expect(await f.service.needsDatabaseInitializationSource(canonical,c,['.'])).toBe(false);
  const source=await f.service.prepareDeploymentSource(f.repo,'main',canonical,a);
  expect(await fs.readFile(path.join(source.sourcePath,'init.sql'),'utf8')).toBe('select 1; -- A');
  expect(await fs.readFile(path.join(canonical,'init.sql'),'utf8')).toBe('select 2; -- B');
 });
});

import { JanitorService, defaultOrphanWorktreeFs } from '../../src/services/janitor.js';
import { StateService } from '../../src/services/state.js';
import { removeOwnedDirectory } from '../../src/services/worktree-directory-removal-process.js';
import { readWorktreeDirectoryIdentity, WorktreeClaimHeldError } from '../../src/services/worktree-path-activity.js';
import { reclaimDeploymentSources, summarizeDeploymentSourceHolds } from '../../src/services/deployment-source-retention.js';
import { deploymentNeedsSourceCheckout } from '../../src/services/worktree.js';
import type { BranchEntry, BuildProfile } from '../../src/types.js';
import { detectDatabaseInitialization, hasDatabaseInitializationSource } from '../../src/services/stack-detector.js';

async function sourceFixture() {
 const f=await fixture(),base=path.join(f.root,'worktrees'),canonical=path.join(base,'proj','branch');
 f.git('worktree','add','--detach',canonical,f.sha);
 const branch:BranchEntry={id:'branch',projectId:'proj',branch:'main',worktreePath:canonical,services:{},status:'running',createdAt:new Date().toISOString()};
 const make=async()=>{const s=await f.service.prepareDeploymentSource(f.repo,'main',canonical,f.sha);const old=new Date(Date.now()-4*3600_000);await fs.utimes(s.sourcePath,old,old);return s.sourcePath;};
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
 it('keeps a deleted project discoverable while source data is held, then retires it after cleanup',async()=>{
  const f=await sourceFixture();const dir=await f.make(),data=path.join(dir,'.cds-data');
  await fs.mkdir(data);await fs.writeFile(path.join(data,'db'),'keep');f.git('worktree','remove',f.canonical);
  const old=new Date(Date.now()-4*3600_000);await fs.utimes(dir,old,old);
  const state=new StateService(path.join(f.root,'state.json'));state.addDeletedProjectWorktreeBucket('proj');
  const janitor=new JanitorService(state,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},f.base,undefined,()=>null,undefined,undefined,f.files);
  const first=await janitor.sweep();expect(first.deploymentSources?.held[dir]).toBeTruthy();
  expect(state.getDeletedProjectWorktreeBuckets().map(t=>t.projectId)).toEqual(['proj']);
  await flushAllJsonStateStores();
  expect(JSON.parse(await fs.readFile(path.join(f.root,'state.json'),'utf8')).deletedProjectWorktreeBuckets.map((t:any)=>t.projectId)).toEqual(['proj']);
  expect(await fs.readFile(path.join(data,'db'),'utf8')).toBe('keep');
  await fs.rm(data,{recursive:true});await fs.utimes(dir,old,old);
  expect((await janitor.sweep()).deploymentSources?.removed).toContain(dir);
  expect(state.getDeletedProjectWorktreeBuckets()).toEqual([]);
  expect(f.git('worktree','list','--porcelain')).not.toContain(dir);
 });
 it('reports unreadable source buckets even when no leaf was scanned',async()=>{
  const f=await sourceFixture();await f.make();const root=path.join(f.base,'proj','.deployment-sources');
  const original=fs.readdir.bind(fs);const read=vi.spyOn(fs,'readdir').mockImplementation(((p:any,...args:any[])=>
    String(p)===root?Promise.reject(Object.assign(new Error('denied'),{code:'EACCES'})):(original as any)(p,...args))as any);
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  try{
   const state=new StateService(path.join(f.root,'state.json'));state.addProject({id:'proj',slug:'proj',name:'Test',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}as any);state.addBranch(f.branch);
   const janitor=new JanitorService(state,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},f.base,undefined,()=>null,undefined,undefined,f.files);
   const report=await janitor.sweep();expect(report.deploymentSources?.held[root]).toBeTruthy();
   expect(janitor.getSnapshot().lastSweep?.deploymentSources).toMatchObject({scanned:0,attempted:0,held:1});
   expect(log.mock.calls.some(args=>String(args[0]).includes('部署源码回收'))).toBe(true);
  }finally{read.mockRestore();log.mockRestore();}
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
 it('advances dispatch inside a 2048-leaf scan even when both windows begin with worker-held data',async()=>{
  const f=await sourceFixture(),original=await f.make(),bucket=path.dirname(original);
  const leaf=(i:number)=>path.join(bucket,`${i.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`);
  const clean=leaf(20);f.git('worktree','move',original,clean);
  await Promise.all(Array.from({length:2048},async(_,i)=>{
   if(i===20)return;const dir=leaf(i);await fs.mkdir(path.join(dir,'.cds-data'),{recursive:true});await fs.writeFile(path.join(dir,'.cds-data','keep'),'persistent');
  }));
  f.files.statDirMtimeMs=async()=>0;
  const state=new StateService(path.join(f.root,'state.json'));state.addProject({id:'proj',slug:'proj',name:'Test',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}as any);state.addBranch(f.branch);
  const janitor=new JanitorService(state,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},f.base,undefined,()=>null,undefined,undefined,f.files);
  const removed:string[]=[];
  for(let round=0;round<4;round++){
   const report=(await janitor.sweep()).deploymentSources!;expect(report.scanned).toBeLessThanOrEqual(1024);expect(report.attempted).toBe(20);removed.push(...report.removed);
  }
  expect(removed).toContain(clean);expect(f.git('worktree','list','--porcelain')).not.toContain(clean);
  for(const i of [0,19,21,1024,1043,2047])expect(await fs.readFile(path.join(leaf(i),'.cds-data','keep'),'utf8')).toBe('persistent');
 },20000);
 it.each([false,true])('scans beyond retained prefixes even when the previous scan leaf disappeared: %s',async removeCursor=>{
  const f=await sourceFixture(),original=await f.make(),bucket=path.dirname(original);
  const clean=path.join(bucket,'ffffffff-ffff-4fff-8fff-ffffffffffff');f.git('worktree','move',original,clean);
  const young:string[]=[];
  for(let i=0;i<(removeCursor?1025:1024);i++){
   const dir=path.join(bucket,`${i.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`);
   await fs.mkdir(dir);await fs.writeFile(path.join(dir,'keep'),'young');young.push(dir);
  }
  const state=new StateService(path.join(f.root,'state.json'));state.addProject({id:'proj',slug:'proj',name:'Test',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}as any);state.addBranch(f.branch);
  const janitor=new JanitorService(state,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,dockerPrune:false,imageRetention:false},f.base,undefined,()=>null,undefined,undefined,f.files);
  const first=(await janitor.sweep()).deploymentSources!;
  expect(first.scanned).toBe(1024);expect(first.attempted).toBe(0);expect(first.removed).toEqual([]);
  if(removeCursor)await fs.rm(first.lastScannedPath!,{recursive:true});
  const second=(await janitor.sweep()).deploymentSources!;
  expect(second.scanned).toBeLessThanOrEqual(1024);expect(second.attempted).toBe(1);expect(second.removed).toContain(clean);
  expect(f.git('worktree','list','--porcelain')).not.toContain(clean);
  for(const dir of young)if(!removeCursor||dir!==first.lastScannedPath)expect(await fs.readFile(path.join(dir,'keep'),'utf8')).toBe('young');
 },15000);
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
  expect(deploymentNeedsSourceCheckout([{...image,command:'node dist/server.js'}])).toBe(false);
  expect(deploymentNeedsSourceCheckout([{...image,prebuiltImage:false}])).toBe(true);
  expect(deploymentNeedsSourceCheckout([{...image,cacheMounts:[{hostPath:'/host/config',containerPath:'/config'}]}])).toBe(true);
 });
 it.each(['prisma/schema.prisma','drizzle.config.mjs','src/data-source.ts','config/database.js','manage.py','alembic.ini','db/migrate/001.rb','init.sql'])('shares database source signal %s with the existing detector',async file=>{
  const f=await fixture(),scan=path.join(f.root,'api');await fs.mkdir(path.dirname(path.join(scan,file)),{recursive:true});await fs.writeFile(path.join(scan,file),'fixture');
  expect(detectDatabaseInitialization(scan).length).toBeGreaterThan(0);
  expect(hasDatabaseInitializationSource([`api/${file}`],['api'])).toBe(true);
  expect(hasDatabaseInitializationSource([`api/${file}`],['./api/'])).toBe(true);
  expect(hasDatabaseInitializationSource([`unrelated/${file}`],['api'])).toBe(false);
 });
 it('retains source if the exact Git tree cannot be completely read',async()=>{
  for(const result of [{stdout:'manage.py',stderr:'',exitCode:0},{stdout:'',stderr:'unavailable',exitCode:1}]){
   const service=new WorktreeService({exec:async()=>result});
   expect(await service.needsDatabaseInitializationSource('/unused','a'.repeat(40),['.'])).toBe(true);
  }
 });
});


describe('source retention observability preserves safe reclamation', () => {
 function observe(f: Awaited<ReturnType<typeof sourceFixture>>, enabled = true) {
  const state = new StateService(path.join(f.root, 'observation-state.json'));
  state.addProject({id:'proj',slug:'proj',name:'Test',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as any);
  state.addBranch(f.branch);
  return new JanitorService(state, {enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,
   dockerPrune:false,imageRetention:false,orphanWorktrees:enabled}, f.base, undefined, () => null, undefined, undefined, f.files);
 }
 it('reports actual source deletion failures without copying paths or worker messages to snapshot', async () => {
  const f=await sourceFixture(), leaf=await f.make();
  f.files.removeDir=async()=> 'controlled worker failure containing private path';
  const janitor=observe(f), report=await janitor.sweep(), summary=janitor.getSnapshot().lastSweep!.deploymentSources!;
  expect(report.deploymentSources!.failed).toHaveLength(1);
  expect(summary).toMatchObject({scanned:1,attempted:1,removed:0,failed:1,held:0});
  expect(JSON.stringify(summary)).not.toContain(f.base);expect(JSON.stringify(summary)).not.toContain('private path');
  expect(await fs.readFile(path.join(leaf,'source.txt'),'utf8')).toBe('immutable source');
 });
 it('keeps a held worker outcome separate from a deletion failure', async () => {
  const f=await sourceFixture(),leaf=await f.make();f.files.removeDir=async()=>{throw new WorktreeClaimHeldError();};
  const janitor=observe(f);await janitor.sweep();const summary=janitor.getSnapshot().lastSweep!.deploymentSources!;
  expect(summary).toMatchObject({scanned:1,attempted:1,removed:0,failed:0,held:1});
  expect(await fs.readFile(path.join(leaf,'source.txt'),'utf8')).toBe('immutable source');
 });
 it('distinguishes a completed empty source sweep from an unexecuted source sweep', async () => {
  const f=await sourceFixture(),janitor=observe(f);
  expect(janitor.getSnapshot().lastSweep).toBeNull();await janitor.sweep();
  expect(janitor.getSnapshot().lastSweep!.deploymentSources).toEqual({scanned:0,attempted:0,removed:0,failed:0,held:0,deferred:0});
  const disabled=observe(f,false);await disabled.sweep();expect(disabled.getSnapshot().lastSweep!.deploymentSources).toBeUndefined();
 });
 it('keeps a real ELOOP unknown while known ENOENT remains empty', async () => {
  const f=await sourceFixture(),loop=path.join(f.root,'loop');await fs.symlink('loop',loop);
  const result=await reclaimDeploymentSources({base:loop,projectIds:['proj'],branches:()=>[],files:f.files,nowMs:Date.now()});
  expect(result.scanned).toBe(0);expect(result.held[loop]).toBeTruthy();expect(summarizeDeploymentSourceHolds(result.held)).toEqual({'filesystem-unknown':1});
  const missing=await reclaimDeploymentSources({base:path.join(f.root,'missing'),projectIds:['proj'],branches:()=>[],files:f.files,nowMs:Date.now()});
  expect(missing).toMatchObject({scanned:0,attempted:0,removed:[],failed:[],held:{}});
 });
 it.each(['project','bucket'])('records %s EACCES as held without dispatching deletion', async kind => {
  const f=await sourceFixture(),leaf=await f.make(),blocked=kind==='project'?path.join(f.base,'proj'):path.join(f.base,'proj','.deployment-sources');
  const original=fs.lstat.bind(fs);const read=vi.spyOn(fs,'lstat').mockImplementation(((value:any,...args:any[])=>
   String(value)===blocked?Promise.reject(Object.assign(new Error('controlled access failure'),{code:'EACCES'})):(original as any)(value,...args)) as any);
  try {const report=await f.sweep();expect(report.attempted).toBe(0);expect(report.removed).toEqual([]);expect(report.held[blocked]).toBeTruthy();
   expect(summarizeDeploymentSourceHolds(report.held)).toEqual({'filesystem-unknown':1});
   expect(await fs.readFile(path.join(leaf,'source.txt'),'utf8')).toBe('immutable source');
  } finally {read.mockRestore();}
 });
 it('publishes bounded hold reasons and retains mounted, claimed and persistent-data leaves', async () => {
  const f=await sourceFixture(),mounted=await f.make(),claimed=await f.make(),data=await f.make();
  await fs.mkdir(path.join(data,'.cds-data'));await fs.writeFile(path.join(data,'.cds-data','db'),'keep');
  const old=new Date(Date.now()-4*3600_000);await fs.utimes(data,old,old);
  f.branch.services={source:{profileId:'source',status:'stopped',sourceCheckoutPath:claimed} as any};
  f.files.listMountedHostPaths=async()=>[mounted];
  const janitor=observe(f);await janitor.sweep();const summary=janitor.getSnapshot().lastSweep!.deploymentSources!;
  expect(summary).toMatchObject({removed:0,failed:0,held:3,heldReasons:{'container-mounted':1,'age-or-claim-unconfirmed':1,'protected-or-unconfirmed':1}});
  expect(Object.values(summary.heldReasons!).reduce((sum,n)=>sum+n,0)).toBe(summary.held);
  expect(JSON.stringify(summary)).not.toContain(f.base);
  expect(await fs.readFile(path.join(data,'.cds-data','db'),'utf8')).toBe('keep');
  expect(await fs.readFile(path.join(mounted,'source.txt'),'utf8')).toBe('immutable source');
  expect(await fs.readFile(path.join(claimed,'source.txt'),'utf8')).toBe('immutable source');
 });
});
