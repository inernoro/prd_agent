import {unitBindMountInspector} from '../helpers/storage-bind-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {StateService} from '../../src/services/state.js';
import {ContainerService} from '../../src/services/container.js';
import {WorktreeService} from '../../src/services/worktree.js';
import {BranchOperationCoordinator} from '../../src/services/branch-operation-coordinator.js';
import {createBranchRouter} from '../../src/routes/branches.js';
import {createPendingImportRouter} from '../../src/routes/pending-import.js';
import {storageOwnerLabels} from '../../src/services/deployment-storage-plan.js';
import type {CdsConfig,IShellExecutor} from '../../src/types.js';
let root:string,state:StateService,server:http.Server,commands:string[],volumes:Map<string,any>,shell:IShellExecutor,coordinator:BranchOperationCoordinator,unknown:boolean,nodes:any[];
beforeEach(async()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'cds-profile-p-http-'));state=new StateService(path.join(root,'state.json'));state.load();state.addProject({id:'p',slug:'p',name:'own',kind:'git',createdAt:'2026-10-23',updatedAt:'2026-10-23'});
 state.addBuildProfile({id:'app',projectId:'p',name:'app',workDir:'.',dockerImage:'fixture:image',prebuiltImage:true,localArtifact:true,containerPort:8080});for(const id of ['a','b'])state.addBranch({id,projectId:'p',branch:id,worktreePath:path.join(root,id),services:{},status:'idle',createdAt:'2026-10-23'});
 nodes=[];commands=[];volumes=new Map();unknown=false;coordinator=new BranchOperationCoordinator();
 shell={exec:vi.fn(async(c,o)=>{o?.beforeStart?.();commands.push(c);if(c.startsWith('docker info'))return{exitCode:0,stdout:'own-daemon',stderr:''};const name=/'([^']+)'$/.exec(c)?.[1]||'';
 if(c.startsWith('docker volume inspect'))return unknown?{exitCode:124,stdout:'',stderr:'unavailable'}:volumes.has(name)?{exitCode:0,stdout:JSON.stringify([volumes.get(name)]),stderr:''}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+name+': no such volume'};
 if(c.startsWith('docker volume create')){const row=state.getStorageBirth(name)!;volumes.set(name,{Name:name,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+name+'/_data',CreatedAt:'2026-10-23T00:00:00Z',Labels:{...storageOwnerLabels(row.binding),'cds.storage.birth':row.birthNonce}});return{exitCode:0,stdout:name,stderr:''}}throw Error('unexpected fixture command');})} as IShellExecutor;
 const config={repoRoot:root,worktreeBase:root,storageInstanceId:'own',dockerNetwork:'own',portStart:10001,masterPort:9900,workerPort:5500,sharedEnv:{},jwt:{secret:'own-fixture',issuer:'own'}} as CdsConfig;
 const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).cdsProjectKey={projectId:String(req.headers['x-own-project']||'p'),keyId:'fixture'};next()});
 app.use('/api',createBranchRouter({stateService:state,containerService:new ContainerService(shell,config, undefined, undefined, undefined, undefined, unitBindMountInspector),worktreeService:new WorktreeService(shell,config),shell,config,branchOperationCoordinator:coordinator,registry:{getAll:()=>nodes,getOnline:()=>nodes,selectExecutor:()=>nodes[0]||null} as any}));
 app.use('/api',createPendingImportRouter({stateService:state}));
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
});
afterEach(async()=>{await new Promise<void>(r=>server.close(()=>r()));vi.restoreAllMocks();vi.unstubAllGlobals();await state.flush();fs.rmSync(root,{recursive:true,force:true});});
const input=()=>({profileId:'app',initializeStorage:'new-only',freshMounts:[{mountKey:'data',containerPath:'/data',purpose:'persistent'}]});
async function post(branch='a',project='p',body:any=input()){
 const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/branches/${branch}/storage/provision`,{method:'POST',headers:{'content-type':'application/json','x-own-project':project},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});return{status:response.status,body:await response.json() as any};
}
it('official branch command allocates distinct concurrent branch storage without changing the baseline',async()=>{const baseline=structuredClone(state.getBuildProfilesForProject('p'));const [a,b]=await Promise.all([post('a'),post('b')]);expect([a.status,b.status]).toEqual([201,201]);expect(a.body.mounts[0].name).not.toBe(b.body.mounts[0].name);expect(volumes.size).toBe(2);expect(state.getBuildProfilesForProject('p')).toEqual(baseline);const cold=new StateService(path.join(root,'state.json'));cold.load();for(const id of ['a','b'])expect(cold.getProfileStorageBinding({kind:'profile',projectId:'p',branchId:id,serviceId:'app'})?.names).toHaveLength(1);await cold.flush();});
it('foreign project capability cannot allocate or learn a volume name',async()=>{const r=await post('a','foreign');expect(r.status).toBe(403);expect(commands).toEqual([]);expect(r.body).not.toHaveProperty('mounts');});
it('retained original runtime cannot become a fresh empty volume',async()=>{const branch=state.getBranch('a')!;branch.services.app={profileId:'app',containerName:'original-data',hostPort:1,status:'stopped'};const before=structuredClone(branch);expect((await post()).status).toBe(409);expect(commands).toEqual([]);expect(state.getBranch('a')).toEqual(before);});
it('held attempt retries return 409 without unhandled routing errors, second nonce or physical calls',async()=>{unknown=true;expect((await post()).status).toBe(409);const row=state.getProfileStorageBirths({kind:'profile',projectId:'p',branchId:'a',serviceId:'app'})[0];expect(row.stage).toBe('held');const count=commands.length;unknown=false;expect((await post()).status).toBe(409);expect(commands).toHaveLength(count);expect(state.getStorageBirth(row.name)?.birthNonce).toBe(row.birthNonce);});
it('project pause during observation prevents native allocation',async()=>{const exec=vi.mocked(shell.exec).getMockImplementation()!;vi.mocked(shell.exec).mockImplementation(async(c,o)=>{if(c.startsWith('docker info'))state.getProject('p')!.paused=true;return exec(c,o)});expect((await post()).status).toBe(409);expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false);});
it('newer stop revokes a queued original P before actual create dispatch',async()=>{const exec=vi.mocked(shell.exec).getMockImplementation()!;let stop:any;vi.mocked(shell.exec).mockImplementation(async(c,o)=>{if(c.startsWith('docker volume create'))stop=coordinator.begin({branchId:'a',projectId:'p',kind:'stop',trigger:'manual',source:'fixture'});return exec(c,o)});expect((await post()).status).toBe(409);expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false);expect(state.getProfileStorageBirths({kind:'profile',projectId:'p',branchId:'a',serviceId:'app'})[0].stage).toBe('issued');if(stop?.lease)coordinator.complete(stop.lease,'completed');});

it('remote-attributed profile is held before allocating on the wrong daemon',async()=>{state.getBranch('a')!.executorId='remote-own-fixture';const r=await post();expect(r.status).toBe(409);expect(r.body.error).toBe('storage_provision_target_daemon_unconfirmed');expect(commands).toEqual([]);});

let nextFixtureCommit=1;
function fixtureCommit(){return (nextFixtureCommit++).toString(16).padStart(40,'0');}
async function deployOverHttp(body:any) {
 return new Promise<{status:number;text:string}>((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:(server.address() as any).port,path:'/api/branches/a/deploy',method:'POST',agent:false,headers:{'content-type':'application/json'}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode!,text}));});
  req.on('error',reject);req.end(JSON.stringify(body));
 });
}
function lateExecutor() {
 const now=new Date().toISOString();
 nodes.push({id:'late-remote',role:'remote',host:'127.0.0.1',port:1,status:'online',labels:[],branches:[],capacity:{maxBranches:10,memoryMB:1024,cpuCores:2},load:{memoryUsedMB:0,cpuPercent:0},registeredAt:now,lastHeartbeat:now});
 const calls:Array<{url:string;body:any}>=[];
 vi.stubGlobal('fetch',async(input:any,init:any)=>{calls.push({url:String(input),body:JSON.parse(init.body)});return new Response('event: complete\ndata: {"ok":true,"services":{"app":{"status":"running"}}}\n\n',{status:200});});
 return calls;
}
it.each(['explicit','auto','sticky'])('late %s remote placement cannot drop published local P mounts',async placement=>{
 const allocated=await post();expect(allocated.status).toBe(201);
 expect(state.resolvePublishedProfileStorage(state.getBranch('a')!,state.getBuildProfilesForProject('p')[0]).cacheMounts).toHaveLength(1);
 const calls=lateExecutor();if(placement==='sticky')state.getBranch('a')!.executorId='late-remote';
 const before=commands.length;
 const result=await deployOverHttp({commitSha:fixtureCommit(),...(placement==='explicit'?{targetExecutorId:'late-remote'}:{})});
 expect(result.status).toBe(409);expect(result.text).toContain('storage_provision_target_daemon_unconfirmed');
 expect(calls.some(c=>c.url.endsWith('/exec/deploy'))).toBe(false);
 expect(commands).toHaveLength(before);expect(volumes.size).toBe(1);
});
it.each(['explicit','auto','sticky'])('late %s remote placement cannot bypass an original held P',async placement=>{
 unknown=true;expect((await post()).status).toBe(409);unknown=false;
 const birth=state.getProfileStorageBirths({kind:'profile',projectId:'p',branchId:'a',serviceId:'app'})[0];expect(birth.stage).toBe('held');
 const calls=lateExecutor();if(placement==='sticky')state.getBranch('a')!.executorId='late-remote';const before=commands.length;
 const result=await deployOverHttp({commitSha:fixtureCommit(),...(placement==='explicit'?{targetExecutorId:'late-remote'}:{})});
 expect(result.status).toBe(409);expect(result.text).toContain('storage_provision_target_daemon_unconfirmed');expect(calls.some(c=>c.url.endsWith('/exec/deploy'))).toBe(false);
 expect(commands).toHaveLength(before);expect(state.getStorageBirth(birth.name)?.birthNonce).toBe(birth.birthNonce);
});
it.each(['no-P','other-branch-P'])('remote without target-local P remains available: %s',async fixture=>{
 if(fixture==='other-branch-P')expect((await post('b')).status).toBe(201);
 const calls=lateExecutor();const result=await deployOverHttp({commitSha:fixtureCommit(),targetExecutorId:'late-remote'});
 expect(result.status).toBe(200);expect(calls.filter(c=>c.url.endsWith('/exec/deploy'))).toHaveLength(1);
});

it.each(['manual','webhook'])('private storage blocks %s DELETE before cancellation or runtime/state cleanup',async trigger=>{
 expect((await post()).status).toBe(201);const branch=state.getBranch('a')!,before=structuredClone(branch),count=commands.length,rows=state.getProfileStorageBirths({kind:'profile',projectId:'p',branchId:'a',serviceId:'app'});
 const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/branches/a`,{method:'DELETE',headers:{'x-own-project':'p','x-cds-trigger':trigger},signal:AbortSignal.timeout(3000)});expect(r.status).toBe(409);expect((await r.json() as any).error).toBe('storage_retained_branch_delete_refused');expect(state.getBranch('a')).toEqual(before);expect(commands).toHaveLength(count);expect(state.getProfileStorageBirths({kind:'profile',projectId:'p',branchId:'a',serviceId:'app'})).toEqual(rows);expect(volumes.size).toBe(1);
});

// V122 actual Router + State + controlled native CLI: no P may precede workspace admission.
it.each([
 ['/app','/app/data'], ['/app/component','/app'], ['/app','/app'],
 ['/app','/.__cds_source_ro/cache'], ['/tmp/app','/data'],
])('source Profile P rejects %s versus %s before any birth or native operation',async(workspace,containerPath)=>{
 const profile=state.getBuildProfilesForProject('p')[0];
 Object.assign(profile,{prebuiltImage:false,localArtifact:false,managedBuild:undefined,containerWorkDir:workspace});
 const before=structuredClone(profile);
 const result=await post('a','p',{...input(),freshMounts:[{mountKey:'fresh',containerPath,purpose:'persistent'}]});
 expect(result.status).toBe(409);expect(result.body.error).toBe('storage_provision_unconfirmed');
 expect(commands).toEqual([]);expect(volumes.size).toBe(0);
 const target={kind:'profile' as const,projectId:'p',branchId:'a',serviceId:'app'};
 expect(state.getProfileStorageBirths(target)).toEqual([]);expect(state.getProfileStorageBinding(target)).toBeUndefined();
 expect(state.getBuildProfilesForProject('p')[0]).toEqual(before);
});
it('source-free prebuilt Profile P permits /app/data and reliably publishes only its new binding',async()=>{
 const result=await post('a','p',{...input(),freshMounts:[{mountKey:'fresh',containerPath:'/app/data',purpose:'persistent'}]});
 expect(result.status).toBe(201);expect(volumes.size).toBe(1);
 expect(state.getProfileStorageBinding({kind:'profile',projectId:'p',branchId:'a',serviceId:'app'})?.mounts[0].containerPath).toBe('/app/data');
});

it('remote retained-storage refusal keeps master branch declaration instead of finalizing deletion',async()=>{
 const savedFetch=globalThis.fetch;lateExecutor();state.getBranch('a')!.executorId='late-remote';const before=structuredClone(state.getBranch('a')),count=commands.length;
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({error:'storage_retained_branch_delete_refused'}),{status:409}));
 const response=await savedFetch(`http://127.0.0.1:${(server.address() as any).port}/api/branches/a`,{method:'DELETE',headers:{'x-own-project':'p'},signal:AbortSignal.timeout(3000)});const text=await response.text();
 expect(text).toContain('storage_retained_branch_delete_refused');expect(state.getBranch('a')).toBeDefined();expect(state.getBranch('a')?.deleting).toBe(before?.deleting);expect(state.getBranch('a')?.status).toBe(before?.status);expect(commands).toHaveLength(count);
});

it.each(['/factory-reset?project=p','/factory-reset','/cleanup?project=p','/branches/cleanup-stopped?project=p'])('retained private storage survives bulk removal %s before runtime cleanup',async route=>{
 expect((await post()).status).toBe(201);state.removeBranch('b');const branch=state.getBranch('a')!;branch.services.app={profileId:'app',containerName:'original-own-runtime',hostPort:1,status:'stopped'};const before=structuredClone(branch),count=commands.length;
 const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api${route}`,{method:'POST',headers:{'x-own-project':'p','content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)});const text=await r.text();expect(text).toContain('storage_retained_branch_delete_refused');expect(state.getBranch('a')).toEqual(before);expect(commands).toHaveLength(count);expect(volumes.size).toBe(1);
});
it('orphan cleanup retains storage-bearing owner while only reading remote refs',async()=>{
 expect((await post()).status).toBe(201);state.removeBranch('b');const before=structuredClone(state.getBranch('a')),exec=vi.mocked(shell.exec).getMockImplementation()!;
 vi.mocked(shell.exec).mockImplementation(async(c,o)=>{if(c.includes('git fetch origin --prune')||c.startsWith('git for-each-ref')){commands.push(c);return{exitCode:0,stdout:c.startsWith('git for-each-ref')?'main\n':'',stderr:''}}return exec(c,o)});const count=commands.length;
 const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/cleanup-orphans?project=p`,{method:'POST',headers:{'x-own-project':'p','content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(3000)});expect(await r.text()).toContain('storage_retained_branch_delete_refused');expect(state.getBranch('a')).toEqual(before);expect(commands.slice(count).every(c=>c.includes('git fetch')||c.includes('git for-each-ref'))).toBe(true);expect(volumes.size).toBe(1);
});

it.each(['delete','update','drop-extra','copy-extra','import','import-init'])('HTTP %s preserves the original private declaration before snapshot, runtime or allocation',async kind=>{
 const original=structuredClone(state.getBuildProfile('app')!);
 if(kind.includes('extra')){state.removeBuildProfile('app');state.setBranchExtraProfiles('a',[original]);}
 expect((await post()).status).toBe(201);
 const before=JSON.stringify(state.getState()),count=commands.length,snapshots=vi.spyOn(state,'createConfigSnapshot');
 const bad={...original,cacheMounts:[{kind:'volume',hostPath:'different',containerPath:'/data'}]};
 const [route,method,body]=kind==='delete'?['/build-profiles/app','DELETE',undefined]
  :kind==='update'?['/build-profiles/app','PUT',bad]
  :kind==='drop-extra'?['/branches/a/extra-services','PUT',{extraProfiles:[]}]
  :kind==='copy-extra'?['/branches/a/copy-config-from/b','POST',{}]
  :[kind==='import'?'/import-config':'/import-and-init','POST',{initializeStorage:'new-only',config:{$schema:'cds-config',buildProfiles:[{...original,id:'first'},bad],infraServices:[{id:'new-db',dockerImage:'mysql:8.0',containerPort:3306,env:{MYSQL_ROOT_PASSWORD:'fixture'}}]}}];
 const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api${route}`,{method,headers:{'x-own-project':'p','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(3000)});
 expect(r.status).toBe(409);expect(await r.text()).toContain('storage_retained');
 expect(JSON.stringify(state.getState())).toBe(before);expect(snapshots).not.toHaveBeenCalled();expect(commands).toHaveLength(count);expect(volumes.size).toBe(1);
});

it('approved Compose rejects the whole batch before an earlier safe profile is added',async()=>{
 state.getProject('p')!.legacyFlag=true;expect((await post()).status).toBe(201);
 const yaml='services:\n  first:\n    image: node:20\n    working_dir: /app\n    volumes: ["./first:/app"]\n    command: node first.js\n    ports: ["3001"]\n  app:\n    image: node:20\n    working_dir: /app\n    command: node app.js\n    ports: ["8080"]\n    volumes: ["./app:/app", "new-data:/data"]\n';
 const submit=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/projects/p/pending-import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentName:'own-test',composeYaml:yaml}),signal:AbortSignal.timeout(3000)});
 const submitted=await submit.json() as any;expect(submit.status,JSON.stringify(submitted)).toBe(201);const id=submitted.importId,before=JSON.stringify(state.getState()),count=commands.length;
 const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/pending-imports/${id}/approve`,{method:'POST',headers:{'content-type':'application/json'},body:'{"force":true}',signal:AbortSignal.timeout(3000)});
 expect(r.status).toBe(409);expect(await r.text()).toContain('storage_retained');expect(state.getBuildProfile('first')).toBeUndefined();expect(JSON.stringify(state.getState())).toBe(before);expect(commands).toHaveLength(count);expect(volumes.size).toBe(1);
});
