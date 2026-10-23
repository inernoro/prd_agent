import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import os from 'node:os';import express from 'express';import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {createBranchRouter} from '../../src//routes/branches.ts';
import {StateService} from '../../src//services/state.ts';import {WorktreeService} from '../../src//services/worktree.ts';
import {ContainerService} from '../../src//services/container.ts';import {MockShellExecutor} from '../../src//services/shell-executor.ts';
import {BranchOperationCoordinator} from '../../src//services/branch-operation-coordinator.ts';import {DeploymentRunService} from '../../src//services/deployment-run.ts';
import {buildGateStatus,setBuildGateHostLoadProvider} from '../../src//services/build-gate.ts';
import {flushAllJsonStateStores} from '../../src//infra/state-store/json-backing-store.ts';
const db=vi.hoisted(()=>({calls:0,events:[] as string[]}));
vi.mock('../../src//services/per-branch-db-init.ts',async original=>({...await original<any>(),ensurePerBranchDbInitialized:async()=>{db.calls++;db.events.push('DB-INIT-ENTERED');return {kind:'not-applicable',reason:'warehouse-db-spy'};}}));
import {stableStorageVolumeName,storageOwnerLabels} from '../../src//services/deployment-storage-plan.ts';
const sha='a'.repeat(40),image='sha256:'+'b'.repeat(64);
let state:any,config:any,shell:any,container:any,worktree:any,server:any,caseDir:string,trace:string[],response:any;
function profile(id:string,bad=false){return {id,projectId:'default',name:id,dockerImage:'fixture:image',workDir:'.',command:'node server.js',containerPort:8080,...(bad?{cacheMounts:[{kind:'bind',hostPath:'/warehouse/unsafe-data',containerPath:'/data'}]}:{})};}
async function request(url:string,body:any){return new Promise<any>((resolve,reject)=>{const text=JSON.stringify(body);const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method:'POST',agent:false,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}},res=>{let raw='';res.on('data',x=>raw+=x);res.on('end',()=>resolve({status:res.statusCode,body:raw,events:raw.split('\n\n').filter(Boolean).map(x=>x.slice(0,240))}));});req.setTimeout(8000,()=>req.destroy(new Error('warehouse-request-timeout')));req.on('error',reject);req.end(text);});}
async function listen(){const app=express();app.use(express.json());app.use('/api',createBranchRouter({stateService:state,worktreeService:worktree,containerService:container,shell,config,branchOperationCoordinator:new BranchOperationCoordinator(),deploymentRunService:new DeploymentRunService(state)}));await new Promise<void>(r=>server=app.listen(0,'127.0.0.1',r));config.masterPort=server.address().port;}
function seedBranch(){const entry={id:'branch',projectId:'default',branch:'feature',worktreePath:path.join(caseDir,'canonical'),githubCommitSha:sha,status:'running',createdAt:new Date().toISOString(),services:{orphan:{profileId:'orphan',containerName:'old-orphan',hostPort:10010,status:'running'}}};fs.mkdirSync(entry.worktreePath,{recursive:true});state.addBranch(entry);return entry;}
function assertProtected(){expect(response.status).toBe(200);expect(response.body).toContain('unsafe_deployment_storage');expect(db.calls).toBe(0);expect(trace.some(x=>x.startsWith('MUTATE:'))).toBe(false);expect(shell.commands.some((x:string)=>/^docker (rm|stop|run|create|start|exec) /.test(x))).toBe(false);}
beforeEach(()=>{caseDir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-import-new-only-'));trace=[];db.calls=0;db.events=[];response=null;process.env.CDS_BRANCH_NETWORK_ISOLATION='0';config={repoRoot:caseDir,worktreeBase:path.join(caseDir,'wt'),storageInstanceId:'warehouse-instance',masterPort:9900,workerPort:5500,dockerNetwork:'warehouse',portStart:10001,sharedEnv:{},jwt:{secret:'fake-only',issuer:'fixture'}};
 state=new StateService(path.join(caseDir,'state.json'),caseDir);state.load();state.addProject({id:'default',slug:'default',name:'warehouse',kind:'git',legacyFlag:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});shell=new MockShellExecutor();
 shell.addResponsePattern(/docker image inspect.*json .Id/,()=>({exitCode:0,stdout:JSON.stringify([image,null]),stderr:''}));shell.addResponsePattern(/git symbolic-ref/,()=>({exitCode:0,stdout:'refs/remotes/origin/main',stderr:''}));
 shell.addResponsePattern(/git rev-parse/,()=>({exitCode:0,stdout:sha,stderr:''}));
 container=new ContainerService(shell,config,{storageBirthRequirements:p=>state.storageBirthRequirements(p),resolveProfileStorage:(b,p)=>state.resolvePublishedProfileStorage(b,p)});worktree=new WorktreeService(shell,caseDir);
 for(const method of ['remove','removeRuntimeGroup','startInfraService','runService']){const original=container[method].bind(container);vi.spyOn(container,method).mockImplementation(async(...args:any[])=>{trace.push('MUTATE:'+method);return original(...args);});}
 const preflight=container.preflightProfileStorage.bind(container);vi.spyOn(container,'preflightProfileStorage').mockImplementation(async(e:any,p:any,c:any)=>{trace.push('preflight:'+p.id);return preflight(e,p,c);});
 vi.spyOn(worktree,'needsDatabaseInitializationSource').mockResolvedValue(false);vi.spyOn(worktree,'resolveDeploymentCommit').mockResolvedValue({head:sha,after:sha.slice(0,7),afterFull:sha});vi.spyOn(worktree,'prepareDeploymentSource').mockImplementation(async()=>{trace.push('prepare-source');const sourcePath=path.join(caseDir,'.deployment-sources/owned');fs.mkdirSync(sourcePath,{recursive:true});return {head:sha,after:sha.slice(0,7),afterFull:sha,sourcePath};});vi.spyOn(worktree,'create').mockImplementation(async(_root:any,_branch:any,dest:string)=>{fs.mkdirSync(dest,{recursive:true});});
});
afterEach(async()=>{await flushAllJsonStateStores();if(server)await new Promise<void>(r=>server.close(()=>r()));server=undefined;vi.restoreAllMocks();delete process.env.CDS_BRANCH_NETWORK_ISOLATION;fs.rmSync(caseDir,{recursive:true,force:true});});

function declaration(id:string,legacy=false,bad=false){
 const storage={version:1,instanceId:'warehouse-instance',projectId:'default',scope:'project-shared',serviceId:id,mountKey:'data',purpose:'persistent'} as const;
 return {id,name:id,dockerImage:'fixture:db',containerPort:5432,volumes:[{type:'volume',name:legacy?'legacy-keep-exact':stableStorageVolumeName(storage),containerPath:'/data',...(legacy?{}:{storage:{...storage,...(bad?{serviceId:'foreign-service'}:{})}})}],env:{}};
}
function pFixture(){
 const volumes=new Map<string,any>();const execute=shell.exec.bind(shell);
 shell.exec=async(c:string,options:any)=>{
  if(c.startsWith('docker info')||c.startsWith('docker volume ')){
   options?.beforeStart?.();shell.commands.push(c);trace.push('NATIVE:'+c.split(' ').slice(0,3).join(' '));
   if(c.startsWith('docker info'))return{exitCode:0,stdout:'warehouse-daemon',stderr:''};
   const name=/'([^']+)'$/.exec(c)?.[1]||'';
   if(c.startsWith('docker volume inspect'))return volumes.has(name)?{exitCode:0,stdout:JSON.stringify([volumes.get(name)]),stderr:''}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+name+': no such volume'};
   if(c.startsWith('docker volume create')){const birth=state.getStorageBirth(name);expect(birth).toMatchObject({stage:'issued',createIssued:true});volumes.set(name,{Name:name,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+name+'/_data',CreatedAt:'2026-10-23T00:00:00Z',Labels:{...storageOwnerLabels(birth.binding),'cds.storage.birth':birth.birthNonce}});return{exitCode:0,stdout:name,stderr:''};}
  }
  if(c.startsWith('docker inspect --format=')){options?.beforeStart?.();shell.commands.push(c);const name=/'([^']+)'$/.exec(c)?.[1]||'';return{exitCode:1,stdout:'[]',stderr:'Error: No such object: '+name};}
 return execute(c,options);
 };
 const flush=state.flush.bind(state);vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();trace.push('ACK');});
 const oldPreflight=container.preflightInfraStorage.bind(container);vi.spyOn(container,'preflightInfraStorage').mockImplementation(async(s:any,c:any)=>{trace.push('R-PREFLIGHT:'+s.id);const name=s.volumes[0].name;expect(state.getStorageBirth(name)?.stage).toBe('published');expect(state.getInfraServiceForProjectAndId('default',s.id)).toBeDefined();return oldPreflight(s,c)});
 container.startInfraService.mockImplementation(async(s:any)=>{trace.push('R-START:'+s.id);expect(state.getStorageBirth(s.volumes[0].name)?.stage).toBe('published');});
 return volumes;
}
it('bad second import declaration refuses before first P birth or infra metadata',async()=>{
 const vols=pFixture();await listen();response=await request('/api/import-and-init',{initializeStorage:'new-only',config:{$schema:'cds-config',buildProfiles:[],infraServices:[declaration('first'),declaration('second',false,true)]}});
 expect(response.body).toContain('storage-owner-mismatch');expect(Object.keys(state.getState().storageBirths||{})).toHaveLength(0);expect(state.getInfraServicesForProject('default')).toHaveLength(0);expect(vols.size).toBe(0);expect(shell.commands.some((c:string)=>c.startsWith('docker volume create'))).toBe(false);expect(container.startInfraService).not.toHaveBeenCalled();
});
it('explicit legacy named volume cannot become a renamed fresh empty P',async()=>{
 const vols=pFixture();await listen();response=await request('/api/import-and-init',{initializeStorage:'new-only',config:{$schema:'cds-config',buildProfiles:[],infraServices:[declaration('legacy',true)]}});
 expect(response.body).toContain('storage-contract-required');expect(vols.size).toBe(0);expect(Object.keys(state.getState().storageBirths||{})).toHaveLength(0);expect(state.getInfraServicesForProject('default')).toHaveLength(0);expect(container.startInfraService).not.toHaveBeenCalled();
});
it('valid explicit import P durably publishes binding before actual R preflight and startup boundary',async()=>{
 const vols=pFixture();await listen();response=await request('/api/import-and-init',{initializeStorage:'new-only',config:{$schema:'cds-config',buildProfiles:[],infraServices:[declaration('fresh')]}});
 expect(response.body).not.toContain('初始化失败');expect(vols.size).toBe(1);const birth=Object.values(state.getState().storageBirths||{})[0] as any;expect(birth).toMatchObject({stage:'published',seq:4,createIssued:true});expect(trace).toContain('R-PREFLIGHT:fresh');expect(trace).toContain('R-START:fresh');expect(trace.slice(0,trace.indexOf('R-PREFLIGHT:fresh')).filter(x=>x==='ACK').length).toBeGreaterThanOrEqual(5);
 const cold=new StateService(path.join(caseDir,'state.json'));cold.load();// Publication assigns updatedAt separately in the durable and live projections; all identity/state fields must match.
 const coldBirth=cold.getStorageBirth(birth.name)!;expect(Number.isFinite(Date.parse(coldBirth.updatedAt))).toBe(true);expect({...coldBirth,updatedAt:birth.updatedAt}).toEqual(birth);expect(cold.getInfraServiceForProjectAndId('default','fresh').volumes[0]).toMatchObject({name:birth.name,storage:birth.binding});await cold.flush();
});

it('invalid imported default is rejected before any profile metadata or fresh storage allocation',async()=>{
 state.updateProject('default',{defaultDeployModes:{app:'express'}});const vols=pFixture(),before=structuredClone(state.getBuildProfiles());await listen();
 response=await request('/api/import-and-init',{initializeStorage:'new-only',config:{$schema:'cds-config',buildProfiles:[profile('app')],infraServices:[declaration('fresh')]}});
 expect(response.body).toContain('默认模式');expect(vols.size).toBe(0);expect(Object.keys(state.getState().storageBirths||{})).toHaveLength(0);expect(state.getInfraServicesForProject('default')).toHaveLength(0);expect(state.getBuildProfiles()).toEqual(before);expect(worktree.create).not.toHaveBeenCalled();expect(container.startInfraService).not.toHaveBeenCalled();
});

it.each([false,true])('invalid default in other affected project before import writes or P (move=%s)',async(move)=>{
 state.addProject({id:'other',slug:'other',name:'other',kind:'git',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),defaultDeployModes:{apiOther:'express'}});
 const original={...profile('apiOther'),projectId:'other',deployModes:{express:{prebuiltImage:true}}};state.addBuildProfile(original);
 const vols=pFixture(),before=structuredClone(state.getBuildProfiles());await listen();
 const incoming=move?{...profile('app'),id:'apiOther',projectId:'default',deployModes:{}}:{...original,deployModes:{}};
 // Moving a profile removes the old default key's subject; it remains a compatible deleted key.
 if(move)state.updateProject('default',{defaultDeployModes:{apiOther:'express'}});
 response=await request('/api/import-and-init',{initializeStorage:'new-only',config:{$schema:'cds-config',buildProfiles:[incoming],infraServices:[declaration('fresh')]}});
 expect(response.status).toBe(400);expect(JSON.parse(response.body).code).toBe('invalid_default_deploy_mode');expect(state.getBuildProfiles()).toEqual(before);
 expect(vols.size).toBe(0);expect(Object.keys(state.getState().storageBirths||{})).toHaveLength(0);expect(state.getInfraServicesForProject('default')).toHaveLength(0);expect(worktree.create).not.toHaveBeenCalled();expect(container.startInfraService).not.toHaveBeenCalled();
});
