import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import express from 'express';
import {StateService} from '../../src/services/state.ts';
import {WorktreeService} from '../../src/services/worktree.ts';
import {ContainerService} from '../../src/services/container.ts';
import {BranchOperationCoordinator} from '../../src/services/branch-operation-coordinator.ts';
import {resolveEffectiveProfile} from '../../src/services/container.ts';
import {mergeBranchProfiles} from '../../src/services/branch-extra-services.ts';
import {createBranchRouter} from '../../src/routes/branches.ts';
import {GitHubWebhookDispatcher} from '../../src/services/github-webhook-dispatcher.ts';
let root:string,state:StateService,config:any,shell:any,commands:string[],worktree:WorktreeService,create:any,server:http.Server|undefined;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'source-free-create-'));state=new StateService(path.join(root,'state.json'));state.load();state.addProject({id:'p',slug:'p',name:'owned',kind:'git',githubRepoFullName:'owned/fixture',githubInstallationId:42,createdAt:'2026-10-23',updatedAt:'2026-10-23'});commands=[];shell={exec:vi.fn(async(c:string,o:any)=>{o?.beforeStart?.();commands.push(c);return {exitCode:0,stdout:'',stderr:''};})};config={repoRoot:root,worktreeBase:path.join(root,'wt'),storageInstanceId:'owned',dockerNetwork:'owned',portStart:17000,masterPort:9900,workerPort:5500,sharedEnv:{},jwt:{secret:'fixture',issuer:'fixture'}};worktree=new WorktreeService(shell,config);create=vi.spyOn(worktree,'create').mockResolvedValue(undefined);});
afterEach(async()=>{if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;await state.flush();vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
function seed(kind:string){
 const defaults:Record<string,string>={};if(kind!=='empty')for(let i=0;i<(kind==='pure13'?13:1);i++){
  const id='app'+i;const p:any={id,projectId:'p',name:id,dockerImage:'node:22',command:'node app.js',workDir:'.',containerPort:8080};
  if(kind!=='source'){p.deployModes={express:{prebuilt:true,dockerImage:'ghcr.io/owned/'+id+':sha-${CDS_COMMIT_SHA}',command:''}};defaults[id]='express';}
  if(kind==='ro-host')p.cacheMounts=[{kind:'bind',hostPath:'/owned/config.json',containerPath:'/config.json',readOnly:true}];
  if(kind==='managed')p.managedBuild={stack:'node',installCommand:'true',buildCommand:'true',startCommand:'node app.js',artifactImage:'fixture:artifact'};
  state.addBuildProfile(p);
 }
 state.updateProject('p',{defaultDeployModes:defaults});
}
async function manual(body:any,authorized='p'){
 const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).cdsProjectKey={projectId:authorized,keyId:'fixture'};next()});app.use('/api',createBranchRouter({stateService:state,worktreeService:worktree,containerService:new ContainerService(shell,config),shell,config,branchOperationCoordinator:new BranchOperationCoordinator()}));
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 return new Promise<any>((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:(server!.address() as any).port,path:'/api/branches',method:'POST',agent:false,headers:{'content-type':'application/json'}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(raw)}));});req.on('error',reject);req.end(JSON.stringify({branch:'feature',projectId:'p',...body}));});
}
async function webhook(){return new GitHubWebhookDispatcher({stateService:state,worktreeService:worktree,shell,config}).handle('push',{ref:'refs/heads/feature',after:'a'.repeat(40),repository:{id:1,full_name:'owned/fixture'}});}
it.each(['manual','webhook'])('%s pure 13 defaults publish no canonical checkout and keep express identity',async method=>{
 seed('pure13');const response=method==='manual'?await manual({}):await webhook();if(method==='manual')expect(response.status).toBe(201);else expect(response.action).toBe('ci-image-waiting');
 const entry=state.findBranchByProjectAndName('p','feature')!;expect(entry).toBeDefined();const profiles=mergeBranchProfiles(state.getBuildProfilesForProject('p'),entry).map(p=>resolveEffectiveProfile(p,entry));expect(profiles).toHaveLength(13);expect(profiles.every(p=>p.prebuiltImage)).toBe(true);

 expect(create).not.toHaveBeenCalled();expect(commands.some(c=>/mkdir|git (fetch|worktree)/.test(c))).toBe(false);expect(fs.existsSync(entry.worktreePath)).toBe(false);
});
it.each(['manual','webhook'].flatMap(method=>['source','ro-host','managed','empty'].map(kind=>({method,kind}))))('$method $kind keeps original checkout contract',async({method,kind})=>{
 seed(kind);const response=method==='manual'?await manual({}):await webhook();if(method==='manual')expect(response.status).toBe(201);else expect(response.action).not.toBe('project-dispatch-failed');expect(create).toHaveBeenCalledOnce();expect(commands.some(c=>c.startsWith('mkdir -p'))).toBe(true);
});
it('manual derived source extra cannot hide behind pure base defaults',async()=>{seed('pure13');state.addBranch({id:'source',projectId:'p',branch:'source',worktreePath:path.join(root,'source'),services:{},status:'idle',createdAt:'2026-10-23',extraProfiles:[{id:'debug',projectId:'p',name:'debug',dockerImage:'node:22',command:'node app.js',workDir:'.',containerPort:9090}]});expect((await manual({sourceBranchId:'source'})).status).toBe(201);expect(create).toHaveBeenCalledOnce();});
it('webhook source keeps original one-fetch retry inside source branch claim',async()=>{seed('source');create.mockRejectedValueOnce(new Error('unknown branch')).mockResolvedValueOnce(undefined);expect((await webhook()).action).toBe('branch-created');expect(create).toHaveBeenCalledTimes(2);expect(commands.filter(c=>c.startsWith('git fetch origin'))).toHaveLength(1);});
it('manual foreign capability remains denied before source-free publication',async()=>{seed('pure13');expect((await manual({},'foreign')).status).toBe(403);expect(create).not.toHaveBeenCalled();expect(commands).toEqual([]);expect(state.getAllBranches()).toEqual([]);});
it('invalid default remains refused before pure-image branch publication',async()=>{seed('pure13');state.updateProject('p',{defaultDeployModes:{app0:'removed'}});expect((await manual({})).status).toBe(409);expect(create).not.toHaveBeenCalled();expect(commands).toEqual([]);expect(state.getAllBranches()).toEqual([]);});
