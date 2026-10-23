import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { ContainerService } from '../../src/services/container.js';
import { createBranchRouter } from '../../src/routes/branches.js';

let root: string, repo: string, remote: string, state: StateService, server: http.Server, branch: any, A: string, B: string;
let commands: Array<{command: string; cwd?: string}>;
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function request(method: string, suffix: string, project?:string) {
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/branches/${branch.id}${suffix}`, {method,headers:{'content-type':'application/json',...(project?{'x-owned-project':project}:{})},...(method === 'POST' ? {body:'{}'} : {})});
  return {status:response.status,body:await response.json() as any};
}
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cds-metadata-git-controls-')));
  remote = path.join(root,'remote'); repo = path.join(root,'repo'); fs.mkdirSync(remote);
  git(remote,'init','-b','main'); git(remote,'config','user.name','Owned Git tests'); git(remote,'config','user.email','owned@example.invalid');
  fs.writeFileSync(path.join(remote,'revision'),'A'); git(remote,'add','.'); git(remote,'commit','-m','main A'); A=git(remote,'rev-parse','HEAD');
  git(root,'clone',remote,repo); git(remote,'switch','-c','feature'); fs.writeFileSync(path.join(remote,'revision'),'B'); git(remote,'commit','-am','feature B'); B=git(remote,'rev-parse','HEAD');
  git(remote,'switch','main'); fs.writeFileSync(path.join(remote,'revision'),'C'); git(remote,'commit','-am','unrelated main C');
  state = new StateService(path.join(root,'state.json')); state.load();
  state.addProject({id:'p',slug:'p',name:'owned',repoPath:repo,createdAt:'2026-10-23',updatedAt:'2026-10-23'});
  state.addBuildProfile({id:'app',projectId:'p',name:'app',dockerImage:'node:22',workDir:'.',command:'node source.js',containerPort:8080,deployModes:{express:{prebuilt:true,dockerImage:'ghcr.io/owned/app:ready',command:''}}});
  const config:any={repoRoot:repo,worktreeBase:path.join(root,'wt'),storageInstanceId:'owned',dockerNetwork:'owned',portStart:17000,masterPort:9900,workerPort:5500,sharedEnv:{},jwt:{secret:'fixture',issuer:'fixture'}};
  branch={id:'p-feature',projectId:'p',branch:'feature',worktreePath:WorktreeService.worktreePathFor(config.worktreeBase,'p','p-feature'),services:{},status:'idle',createdAt:'2026-10-23',profileOverrides:{app:{activeDeployMode:'express'}}}; state.addBranch(branch);
  const actual=new ShellExecutor(); commands=[]; const shell={exec:async(command:string,options?:any)=>{commands.push({command,cwd:options?.cwd});return actual.exec(command,{...options,timeout:10000,env:{...options?.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}})}};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers['x-owned-project'])(req as any).cdsProjectKey={projectId:String(req.headers['x-owned-project']),keyId:'fixture'};next()});app.use('/api',createBranchRouter({stateService:state,worktreeService:new WorktreeService(shell),containerService:new ContainerService(shell,config),shell,config}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
});
afterEach(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await state.flush();fs.rmSync(root,{recursive:true,force:true});});
function unchanged(){expect(fs.existsSync(branch.worktreePath)).toBe(false);expect(git(repo,'rev-parse','HEAD')).toBe(A);expect(fs.readFileSync(path.join(repo,'revision'),'utf8')).toBe('A');expect(commands.some(c=>/^(?:mkdir|docker |git (?:reset|checkout|worktree add))/.test(c.command))).toBe(false);}
it('pull resolves the branch remote B without creating canonical or resetting the shared project repo',async()=>{
 const r=await request('POST','/pull');expect(r.status).toBe(200);expect(r.body.afterFull).toBe(B);expect(state.getBranch(branch.id)?.lastPullAt).toBeDefined();unchanged();
});
it('history reads feature B instead of project main A or unrelated remote main C',async()=>{
 const r=await request('GET','/git-log');expect(r.status).toBe(200);expect(r.body.commits[0]).toMatchObject({hash:B.slice(0,7),subject:'feature B'});expect(r.body.commits.some((c:any)=>c.subject==='unrelated main C')).toBe(false);unchanged();
});
it('pin and unpin only change branch metadata and never checkout the project repository',async()=>{
 await request('GET','/git-log');const pin=await request('POST',`/checkout/${B}`);expect(pin.status).toBe(200);expect(state.getBranch(branch.id)?.pinnedCommit).toBe(B);unchanged();
 const unpin=await request('POST','/unpin');expect(unpin.status).toBe(200);expect(state.getBranch(branch.id)?.pinnedCommit).toBeUndefined();unchanged();
});
it('invalid pin is refused and unavailable remote pull remains an error without a checkout',async()=>{
 const invalid=await request('POST',`/checkout/${'f'.repeat(40)}`);expect(invalid.status).toBe(400);expect(state.getBranch(branch.id)?.pinnedCommit).toBeUndefined();
 git(repo,'remote','set-url','origin',path.join(root,'missing-origin'));const pull=await request('POST','/pull');expect(pull.status).toBe(500);expect(state.getBranch(branch.id)?.lastPullAt).toBeUndefined();unchanged();
});

for(const canonicalExists of [false,true])for(const operation of ['pull','git-log','checkout','unpin'])it(`foreign project key cannot ${operation}, canonical present=${canonicalExists}`,async()=>{
 git(repo,'fetch','origin','feature');if(canonicalExists)fs.mkdirSync(branch.worktreePath,{recursive:true});branch.pinnedCommit=A;state.save();const before=structuredClone(branch),count=commands.length;
 const r=await request(operation==='git-log'?'GET':'POST',operation==='checkout'?`/checkout/${B}`:'/'+operation,'foreign-project');expect(r.status).toBe(403);expect(commands).toHaveLength(count);expect(state.getBranch(branch.id)).toEqual(before);expect(git(repo,'rev-parse','HEAD')).toBe(A);
});
it('same project key keeps all four metadata controls usable',async()=>{
 expect((await request('POST','/pull','p')).status).toBe(200);expect((await request('GET','/git-log','p')).status).toBe(200);expect((await request('POST',`/checkout/${B}`,'p')).status).toBe(200);expect((await request('POST','/unpin','p')).status).toBe(200);unchanged();
});

for(const kind of ['source','managed','host-bind'])it(`missing canonical remains usable after switching mode to ${kind}`,async()=>{
 const profile=state.getBuildProfile('app')!;branch.profileOverrides={app:{activeDeployMode:'source'}};
 if(kind==='managed')profile.managedBuild={strategy:'fixture'} as any;if(kind==='host-bind')profile.cacheMounts=[{kind:'bind',hostPath:path.join(root,'source-config'),containerPath:'/config',readOnly:true}];
 expect((await request('POST','/pull','p')).status).toBe(200);const history=await request('GET','/git-log','p');expect(history.status).toBe(200);expect(history.body.commits[0].subject).toBe('feature B');expect((await request('POST',`/checkout/${B}`,'p')).status).toBe(200);expect((await request('POST','/unpin','p')).status).toBe(200);unchanged();
});
