import {unitBindMountInspector} from '../helpers/storage-bind-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {StateService} from '../../src/services/state.js';
import {WorktreeService} from '../../src/services/worktree.js';
import {ContainerService} from '../../src/services/container.js';
import {createProjectsRouter} from '../../src/routes/projects.js';
import {createBranchRouter} from '../../src/routes/branches.js';
import {stableStorageVolumeName,storageOwnerLabels} from '../../src/services/deployment-storage-plan.js';
import {MongoSplitStateBackingStore,type ISplitMongoHandle} from '../../src/infra/state-store/mongo-split-store.js';
import {selfStatusCache} from '../../src/services/self-status-cache.js';
import type {CdsConfig,IShellExecutor,StorageBinding} from '../../src/types.js';
let root:string,state:StateService,server:http.Server,config:CdsConfig,commands:string[],shell:IShellExecutor,container:ContainerService,volume:any,failInspect:boolean;
const b:StorageBinding={version:1,instanceId:'own',projectId:'p',scope:'project-shared',serviceId:'mysql',mountKey:'data',purpose:'persistent'};
const name=stableStorageVolumeName(b);
beforeEach(async()=>{
 selfStatusCache._resetForTests();root=fs.mkdtempSync(path.join(os.tmpdir(),'cds-storage-http-'));state=new StateService(path.join(root,'state.json'));state.load();state.addProject({id:'p',slug:'p',name:'own',kind:'git',createdAt:'2026-10-22',updatedAt:'2026-10-22'});
 config={repoRoot:root,worktreeBase:path.join(root,'wt'),storageInstanceId:'own',masterPort:9900,workerPort:5500,dockerNetwork:'owned',portStart:15000,rootDomains:['owned.invalid'],sharedEnv:{},jwt:{secret:'local-test',issuer:'test'}};commands=[];volume=undefined;failInspect=false;
 shell={exec:vi.fn(async(c:string)=>{commands.push(c);if(c.startsWith('docker info'))return {exitCode:0,stderr:'',stdout:'own-daemon'};
  if(c.startsWith('docker image inspect'))return {exitCode:0,stderr:'',stdout:JSON.stringify(['sha256:'+'a'.repeat(64),null])};
  if(c.startsWith('docker volume inspect')){const requested=c.match(/'([^']+)'$/)?.[1]||'';return failInspect?{exitCode:1,stderr:'daemon unavailable',stdout:''}:volume?.Name===requested?{exitCode:0,stderr:'',stdout:JSON.stringify([volume])}:{exitCode:1,stderr:'Error response from daemon: get '+requested+': no such volume',stdout:''};}
  if(c.startsWith('docker volume create')){const row=state.getStorageBirth(name)!;volume={Name:name,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+name+'/_data',CreatedAt:'2026-10-22T00:00:00Z',Labels:{...storageOwnerLabels(b),'cds.storage.birth':row.birthNonce}};return {exitCode:0,stderr:'',stdout:name}}return {exitCode:0,stderr:'',stdout:''};})} as IShellExecutor;
 container=new ContainerService(shell,config, undefined, undefined, undefined, undefined, unitBindMountInspector);
 const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers['x-owned-project']) (req as any).cdsProjectKey={projectId:String(req.headers['x-owned-project']),keyId:'fixture'};next()});app.use('/api',createBranchRouter({stateService:state,worktreeService:new WorktreeService(shell,config),containerService:container,shell,config}));app.use('/api',createProjectsRouter({stateService:state,shell,config}));server=await new Promise(r=>{const h=app.listen(0,'127.0.0.1',()=>r(h))});
});
afterEach(async()=>{vi.restoreAllMocks();await new Promise<void>(r=>server.close(()=>r()));await state.flush();fs.rmSync(root,{recursive:true,force:true});selfStatusCache._resetForTests()});
async function post(body:any,project='p',route='/api/infra'){
 const data=JSON.stringify(body);return new Promise<{status:number;body:any}>((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:(server.address() as any).port,path:route,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'x-owned-project':project,Connection:'close'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve({status:r.statusCode!,body:JSON.parse(s)}))});q.on('error',reject);q.end(data)});
}
const input=()=>({id:'mysql',projectId:'p',dockerImage:'mysql:8.0',containerPort:3306,env:{MYSQL_ROOT_PASSWORD:'fixture-password'},initializeStorage:'new-only'});
describe('product new-only infra storage HTTP producer',()=>{
 it('server-owned binding is physically born and durably confirmed before 201; repeat creates nothing',async()=>{
  const r=await post(input());expect(r.status).toBe(201);expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);expect(state.getStorageBirth(name)?.stage).toBe('published');expect(state.getInfraServiceForProjectAndId('p','mysql')?.volumes?.[0]).toMatchObject({name,storage:b});
  const restored=new StateService(path.join(root,'state.json'));restored.load();expect(restored.getStorageBirth(name)?.stage).toBe('published');await restored.flush();
  const again=await post(input());expect(again.status).toBe(409);expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
 });

 it('auto-filled known database storage without new-only is refused before publishing metadata',async()=>{
  const body=input();delete (body as any).initializeStorage;const r=await post(body);expect(r.status).toBe(409);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(commands).toHaveLength(0);
 });
 it('custom bare named volume without explicit allocation is rejected before metadata or Docker',async()=>{
  const r=await post({id:'custom',projectId:'p',dockerImage:'example/custom-db:1',containerPort:5432,volumes:[{name:'existing-user-volume',containerPath:'/custom-data'}]});
  expect(r.status).toBe(409);expect(state.getInfraServiceForProjectAndId('p','custom')).toBeUndefined();expect(commands).toHaveLength(0);
 });
 it('manual new Mongo allocation uses both catalog data paths before publication and passes actual image-volume admission',async()=>{
  const native=new Map<string,any>();vi.mocked(shell.exec).mockImplementation(async(c,o)=>{o?.beforeStart?.();commands.push(c);
   if(c.startsWith('docker info'))return {exitCode:0,stdout:'own-daemon',stderr:''};
   if(c.startsWith('docker image inspect'))return {exitCode:0,stdout:JSON.stringify(['sha256:'+'a'.repeat(64),{'/data/db':{},'/data/configdb':{}}]),stderr:''};
   const n=c.split(' ').at(-1)!.replace(/^'|'$/g,'');
   if(c.startsWith('docker volume inspect'))return native.has(n)?{exitCode:0,stdout:JSON.stringify([native.get(n)]),stderr:''}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+n+': no such volume'};
   if(c.startsWith('docker volume create')){const row=state.getStorageBirth(n)!;native.set(n,{Name:n,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+n+'/_data',CreatedAt:'2026-10-23T00:00:00Z',Labels:{...storageOwnerLabels(row.binding),'cds.storage.birth':row.birthNonce}});return{exitCode:0,stdout:n,stderr:''}}throw Error('unexpected command '+c);
  });
  const r=await post({id:'mongo',projectId:'p',dockerImage:'mongo:7',containerPort:27017,env:{MONGO_INITDB_ROOT_USERNAME:'fixture',MONGO_INITDB_ROOT_PASSWORD:'fixture-password'},initializeStorage:'new-only'});
  expect(r.status).toBe(201);const service=state.getInfraServiceForProjectAndId('p','mongo')!;expect(service.volumes.map(v=>v.containerPath)).toEqual(['/data/db','/data/configdb']);expect(native.size).toBe(2);const admitted=new ContainerService(shell,config,{getDockerNetwork:()=>undefined,storageBirthRequirements:plan=>state.storageBirthRequirements(plan)},undefined,undefined,undefined,unitBindMountInspector);await expect(admitted.preflightInfraStorage(service)).resolves.toBeDefined();
 });
 it('foreign project cannot acquire a birth or issue Docker writes',async()=>{expect((await post(input(),'other')).status).toBe(403);expect(commands).toHaveLength(0);expect(state.getStorageBirth(name)).toBeUndefined()});
 it('unknown native absence never returns a created service',async()=>{failInspect=true;const r=await post(input());expect(r.status).toBe(409);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false)});
 it('confirm ACK failure keeps physical birth, returns hold and prevents another fresh allocation',async()=>{
  const flush=state.flush.bind(state);let n=0;vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++n===3)throw Error('fixture lost ACK')});
  const r=await post(input());expect(r.status).toBe(409);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(volume).toBeDefined();expect((await post(input())).status).toBe(409);expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
 });
 it('explicit legacy volume name is never renamed, adopted or allocated by new-only',async()=>{
  const r=await post({...input(),volumes:[{name:'legacy-db',containerPath:'/var/lib/mysql',type:'volume'}]});expect(r.status).toBe(409);expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();
 });
});

describe('infra quickstart project boundary before first-allocation wiring',()=>{
 const compose='services:\n  mysql:\n    image: mysql:8.0\n    ports: ["3306:3306"]\n    environment:\n      MYSQL_ROOT_PASSWORD: fixture-password\n';
 it('same service ID in another project cannot suppress the requested project creation or change its status',async()=>{
  state.addProject({id:'other',slug:'other',name:'foreign',kind:'git',createdAt:'2026-10-22',updatedAt:'2026-10-22'});
  const foreign={id:'mysql',projectId:'other',name:'foreign',dockerImage:'mysql:8.0',containerPort:3306,hostPort:13306,containerName:'foreign-mysql',status:'stopped' as const,env:{MYSQL_ROOT_PASSWORD:'foreign'},volumes:[],createdAt:'2026-10-22'};state.addInfraService(foreign);const foreignBefore=structuredClone(state.getInfraServiceForProjectAndId('other','mysql'));
  vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);
  const r=await post({projectId:'p',compose,initializeStorage:'new-only'},'p','/api/infra/quickstart');expect(r.status).toBe(200);expect(r.body.results).toEqual([{id:'mysql',status:'started'}]);
  expect(state.getInfraServiceForProjectAndId('p','mysql')?.status).toBe('running');expect(state.getInfraServiceForProjectAndId('other','mysql')).toEqual(foreignBefore);
  expect(container.startInfraService).toHaveBeenCalledTimes(1);expect((vi.mocked(container.startInfraService).mock.calls[0][0]).projectId).toBe('p');
 });
 it('a foreign project capability cannot start or publish service in the requested project',async()=>{
  vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);
  const r=await post({projectId:'p',compose},'other','/api/infra/quickstart');expect(r.status).toBe(403);expect(container.startInfraService).not.toHaveBeenCalled();expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();
 });
});

describe('explicit existing-project presets storage P',()=>{
 it('awaits actual birth publication before generating connection metadata and response',async()=>{
  const publish=state.publishProvisionedInfraDurably.bind(state);vi.spyOn(state,'publishProvisionedInfraDurably').mockImplementation(async(...args)=>{expect(state.getCustomEnv('p').DATABASE_URL).toBeUndefined();await publish(...args)});
  const r=await post({presetIds:['mysql'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(200);expect(r.body.storageMode).toBe('allocated');expect(r.body.applied).toEqual(['mysql']);
  expect(state.getStorageBirth(name)?.stage).toBe('published');expect(state.getInfraServiceForProjectAndId('p','mysql')?.volumes?.[0].name).toBe(name);expect(state.getCustomEnv('p').DATABASE_URL).toBeTruthy();expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
 });
 it('unknown physical absence holds without publishing preset, connection metadata or success',async()=>{
  failInspect=true;const r=await post({presetIds:['mysql'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(409);expect(r.body.allocated).toEqual([]);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(state.getCustomEnv('p').DATABASE_URL).toBeUndefined();expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false);
 });
 it('repeating a successful new-only preset group cannot silently create a second database or birth nonce',async()=>{
  const body={presetIds:['mysql'],initializeStorage:'new-only'};expect((await post(body,'p','/api/projects/p/infra-presets')).status).toBe(200);const count=commands.length;
  const r=await post(body,'p','/api/projects/p/infra-presets');expect(r.status).toBe(409);expect(commands).toHaveLength(count);expect(state.getStorageBirthsForService('p','mysql-2')).toHaveLength(0);expect(state.getStorageBirth(name)?.stage).toBe('published');
 });
 it('prechecks a later held target before any earlier fresh target can allocate',async()=>{
  failInspect=true;expect((await post({presetIds:['postgres'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets')).status).toBe(409);expect(state.getStorageBirthsForService('p','postgres')[0]?.stage).toBe('held');failInspect=false;const count=commands.length;
  const r=await post({presetIds:['mysql','postgres'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(409);expect(commands).toHaveLength(count);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(state.getStorageBirthsForService('p','mysql')).toHaveLength(0);
 });
 it('the first fresh group can freeze two explicit instances but repeating cannot increment to a third',async()=>{
  const native=new Map<string,any>();vi.mocked(shell.exec).mockImplementation(async(c)=>{
   commands.push(c);if(c.startsWith('docker info'))return {exitCode:0,stderr:'',stdout:'own-daemon'};
   if(c.startsWith('docker image inspect'))return {exitCode:0,stderr:'',stdout:JSON.stringify(['sha256:'+'a'.repeat(64),null])};
   const volumeName=c.split(' ').at(-1)!.replace(/^'|'$/g,'');
   if(c.startsWith('docker volume inspect'))return native.has(volumeName)?{exitCode:0,stderr:'',stdout:JSON.stringify([native.get(volumeName)])}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+volumeName+': no such volume'};
   if(c.startsWith('docker volume create')){const birth=state.getStorageBirth(volumeName)!;native.set(volumeName,{Name:volumeName,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+volumeName+'/_data',CreatedAt:'2026-10-22T00:00:00Z',Labels:{...storageOwnerLabels(birth.binding),'cds.storage.birth':birth.birthNonce}});return {exitCode:0,stderr:'',stdout:volumeName}}
   throw Error('unexpected command');
  });
  const body={presetIds:['mysql'],infraExtra:[{presetId:'mysql',dbName:'second'}],initializeStorage:'new-only'};const r=await post(body,'p','/api/projects/p/infra-presets');expect(r.status).toBe(200);expect(r.body.applied).toEqual(['mysql','mysql-2']);expect(native.size).toBe(2);expect(state.getInfraServiceForProjectAndId('p','mysql-2')?.volumes?.[0].storage?.serviceId).toBe('mysql-2');const count=commands.length;
  expect((await post(body,'p','/api/projects/p/infra-presets')).status).toBe(409);expect(commands).toHaveLength(count);expect(state.getStorageBirthsForService('p','mysql-3')).toHaveLength(0);
 });
 it('failed confirmation ACK preserves held birth and never publishes connections',async()=>{
  const flush=state.flush.bind(state);let n=0;vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++n===3)throw Error('lost confirmation ACK')});
  const r=await post({presetIds:['mysql'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(409);expect(r.body.allocated).toEqual([]);expect(state.getStorageBirth(name)?.stage).toBe('held');expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(state.getCustomEnv('p').DATABASE_URL).toBeUndefined();expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
 });
 it('project pause during observation prevents subsequent native allocation or metadata publication',async()=>{
  const exec=vi.mocked(shell.exec).getMockImplementation()!;vi.mocked(shell.exec).mockImplementation(async(c,options)=>{if(c.startsWith('docker info'))state.getProject('p')!.paused=true;return exec(c,options)});
  const r=await post({presetIds:['mysql'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(409);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(state.getCustomEnv('p').DATABASE_URL).toBeUndefined();expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false);
 });
 it('batch failure reports only the first confirmed allocation and preserves it without volume rollback',async()=>{
  const exec=vi.mocked(shell.exec).getMockImplementation()!;vi.mocked(shell.exec).mockImplementation(async(c,options)=>c.startsWith('docker volume inspect')&&!c.includes(name)?{exitCode:0,stderr:'',stdout:JSON.stringify([{Name:'foreign-volume'}])}:exec(c,options));
  const r=await post({presetIds:['mysql','postgres'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(409);expect(r.body.allocated).toEqual(['mysql']);expect(r.body.recoveryRequired).toBe(true);expect(state.getStorageBirth(name)?.stage).toBe('published');expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeDefined();expect(state.getInfraServiceForProjectAndId('p','postgres')).toBeUndefined();expect(state.getCustomEnv('p').DATABASE_URL).toBeTruthy();expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);expect(commands.some(c=>c.includes('volume rm'))).toBe(false);
  const restored=new StateService(path.join(root,'state.json'));restored.load();expect(restored.getStorageBirth(name)?.stage).toBe('published');expect(restored.getInfraServiceForProjectAndId('p','mysql')).toBeDefined();await restored.flush();
 });
 it('MongoSplit retains first successful connections and hints when a later allocation is held',async()=>{
  await new Promise<void>(r=>server.close(()=>r()));await state.flush();
  const collection=()=>{const docs=new Map<string,any>();return {findOne:async(f:any)=>structuredClone(docs.get(f._id)||null),find:()=>({toArray:async()=>structuredClone([...docs.values()])}),replaceOne:async(f:any,d:any)=>{docs.set(f._id,structuredClone(d))},deleteOne:async(f:any)=>{docs.delete(f._id)},bulkWrite:async(ops:any[])=>{for(const op of ops){if(op.replaceOne)docs.set(op.replaceOne.filter._id,structuredClone(op.replaceOne.replacement));else if(op.deleteOne)docs.delete(op.deleteOne.filter._id);else throw Error('unexpected Mongo write')}},countDocuments:async()=>docs.size}};
  const handle={connect:async()=>{},close:async()=>{},ping:async()=>true,...Object.fromEntries(['global','projects','branches','deploymentRuns','deploymentVersions','selfUpdateHistory','webhookDeliveries','activityLogs'].map(n=>{const c=collection();return [n+'Collection',()=>c]}))} as unknown as ISplitMongoHandle;
  const backing=new MongoSplitStateBackingStore(handle);await backing.init();state=new StateService(path.join(root,'mongo-unused.json'),root,backing);state.load();state.addProject({id:'p',slug:'p',name:'own',kind:'git',createdAt:'2026-10-22',updatedAt:'2026-10-22'});await state.flush();
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).cdsProjectKey={projectId:'p',keyId:'fixture'};next()});app.use('/api',createProjectsRouter({stateService:state,shell,config}));server=await new Promise(r=>{const h=app.listen(0,'127.0.0.1',()=>r(h))});
  const exec=vi.mocked(shell.exec).getMockImplementation()!;vi.mocked(shell.exec).mockImplementation(async(c,options)=>c.startsWith('docker volume inspect')&&!c.includes(name)?{exitCode:0,stderr:'',stdout:JSON.stringify([{Name:'foreign-volume'}])}:exec(c,options));
  const r=await post({presetIds:['mysql','postgres'],initializeStorage:'new-only'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(409);expect(r.body.allocated).toEqual(['mysql']);expect(state.getCustomEnv('p').DATABASE_URL).toBeTruthy();await state.flush();
  const reopened=new MongoSplitStateBackingStore(handle);await reopened.init();const loaded=new StateService(path.join(root,'mongo-reopened.json'),root,reopened);loaded.load();expect(loaded.getStorageBirth(name)?.stage).toBe('published');expect(loaded.getCustomEnv('p').DATABASE_URL).toBeTruthy();expect(loaded.getEnvMeta('p').DATABASE_URL?.kind).toBe('infra-derived');await loaded.flush();
 });
 it('existing UI without allocation flag publishes actual stable storage before success',async()=>{
  const r=await post({presetIds:['mysql']},'p','/api/projects/p/infra-presets');expect(r.status).toBe(200);expect(r.body.storageMode).toBe('allocated');expect(r.body.applied).toEqual(['mysql']);expect(state.getStorageBirth(name)?.stage).toBe('published');expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
 });
 it('stateless preset without a flag remains metadata only with no storage instance configured',async()=>{
  delete config.storageInstanceId;
  const r=await post({presetIds:['memcached']},'p','/api/projects/p/infra-presets');expect(r.status).toBe(200);expect(r.body.storageMode).toBe('not-required');expect(r.body.applied).toEqual(['memcached']);expect(commands).toHaveLength(0);expect(state.getInfraServiceForProjectAndId('p','memcached')?.volumes||[]).toEqual([]);
 });
 it('new project preset creation uses actual P without needing an optional UI flag',async()=>{
  const native=new Map<string,any>();vi.mocked(shell.exec).mockImplementation(async(c)=>{
   commands.push(c);if(c.startsWith('docker info'))return {exitCode:0,stderr:'',stdout:'own-daemon'};
   if(c.startsWith('docker image inspect'))return {exitCode:0,stderr:'',stdout:JSON.stringify(['sha256:'+'a'.repeat(64),null])};
   const n=c.split(' ').at(-1)!.replace(/^'|'$/g,'');
   if(c.startsWith('docker volume inspect'))return native.has(n)?{exitCode:0,stderr:'',stdout:JSON.stringify([native.get(n)])}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+n+': no such volume'};
   if(c.startsWith('docker volume create')){const row=state.getStorageBirth(n)!;native.set(n,{Name:n,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+n+'/_data',CreatedAt:'2026-10-23T00:00:00Z',Labels:{...storageOwnerLabels(row.binding),'cds.storage.birth':row.birthNonce}});return {exitCode:0,stderr:'',stdout:n}}
   return {exitCode:0,stderr:'',stdout:''};
  });
  const r=await post({name:'Fresh preset test',infraPresets:['mysql']},'', '/api/projects');expect(r.status).toBe(201);
  const projectId=r.body.project.id;expect(state.getStorageBirthsForService(projectId,'mysql')).toHaveLength(1);expect(state.getStorageBirthsForService(projectId,'mysql')[0].stage).toBe('published');expect(state.getInfraServiceForProjectAndId(projectId,'mysql')).toBeDefined();expect(native.size).toBe(1);
 });
 it('fresh Mongo preset allocates and admits both image-declared volumes before any runtime create',async()=>{
  const native=new Map<string,any>();
  vi.mocked(shell.exec).mockImplementation(async(c)=>{
   commands.push(c);if(c.startsWith('docker info'))return{exitCode:0,stderr:'',stdout:'own-daemon'};
   const n=c.split(' ').at(-1)!.replace(/^'|'$/g,'');
   if(c.startsWith('docker volume inspect'))return native.has(n)?{exitCode:0,stderr:'',stdout:JSON.stringify([native.get(n)])}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+n+': no such volume'};
   if(c.startsWith('docker volume create')){const row=state.getStorageBirth(n)!;native.set(n,{Name:n,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+n+'/_data',CreatedAt:'2026-10-23T00:00:00Z',Labels:{...storageOwnerLabels(row.binding),'cds.storage.birth':row.birthNonce}});return{exitCode:0,stderr:'',stdout:n};}
   if(c.startsWith('docker image inspect'))return{exitCode:0,stderr:'',stdout:JSON.stringify(['sha256:'+'a'.repeat(64),{'/data/db':{},'/data/configdb':{}}])};
   return{exitCode:0,stderr:'',stdout:''};
  });
  const r=await post({presetIds:['mongodb']},'p','/api/projects/p/infra-presets');expect(r.status).toBe(200);
  const service=state.getInfraServiceForProjectAndId('p','mongodb')!;
  expect(service.volumes!.map(m=>m.containerPath)).toEqual(['/data/db','/data/configdb']);expect(native.size).toBe(2);
  expect(state.getStorageBirthsForService('p','mongodb').map(b=>b.stage)).toEqual(['published','published']);
  const admitted=new ContainerService(shell,config,{storageBirthRequirements:plan=>state.storageBirthRequirements(plan)},undefined,undefined,undefined,unitBindMountInspector);
  await expect(admitted.preflightInfraStorage(service)).resolves.toBeDefined();
  expect(commands.some(c=>/^docker (create|run|start|rm) /.test(c))).toBe(false);
 });
 it('new project P failure retains original project/network and held birth instead of rollback',async()=>{
  failInspect=true;const r=await post({name:'Failed fresh P',infraPresets:['mysql']},'', '/api/projects');expect(r.status).toBe(409);expect(r.body.recoveryRequired).toBe(true);expect(state.getProject(r.body.project.id)).toBeDefined();expect(commands.some(c=>c.startsWith('docker network rm'))).toBe(false);expect(commands.some(c=>c.includes('volume rm'))).toBe(false);
 });
 it('rejects unsupported allocation option instead of silently returning metadata success',async()=>{
  const r=await post({presetIds:['mysql'],initializeStorage:'guess'},'p','/api/projects/p/infra-presets');expect(r.status).toBe(400);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(commands).toHaveLength(0);
 });
});


describe('quickstart explicit new-only durable storage allocation',()=>{
 const compose='services:\n  mysql:\n    image: mysql:8.0\n    ports: ["3306:3306"]\n    environment:\n      MYSQL_ROOT_PASSWORD: fixture-password\n';
 const route='/api/infra/quickstart';
 it('publishes a physical birth durably before runtime start',async()=>{
  const start=vi.spyOn(container,'startInfraService').mockImplementation(async service=>{
   expect(state.getStorageBirth(name)?.stage).toBe('published');expect(service.projectId).toBe('p');expect(service.scope).toBe('project');expect(service.containerName).toBe('cds-infra-p-mysql');
   const restored=new StateService(path.join(root,'state.json'));restored.load();expect(restored.getStorageBirth(name)?.stage).toBe('published');await restored.flush();
  });
  const r=await post({projectId:'p',compose,initializeStorage:'new-only'},'p',route);expect(r.status).toBe(200);expect(r.body.allocated).toEqual(['mysql']);expect(r.body.results).toEqual([{id:'mysql',status:'started'}]);expect(state.getInfraServiceForProjectAndId('p','mysql')?.status).toBe('running');expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);expect(start).toHaveBeenCalledTimes(1);
  const cold=new StateService(path.join(root,'state.json'));cold.load();expect(cold.getInfraServiceForProjectAndId('p','mysql')?.status).toBe('running');await cold.flush();
 });
 it.each(['    volumes: ["/old/data:/var/lib/mysql"]\n','    volumes: null\n'])('invalid or host storage remains refused before allocation: %s',async declaration=>{
  vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const r=await post({projectId:'p',compose:compose+declaration,initializeStorage:'new-only'},'p',route);expect([400,409]).toContain(r.status);expect(commands).toHaveLength(0);expect(container.startInfraService).not.toHaveBeenCalled();expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(state.getStorageBirth(name)).toBeUndefined();
 });
 it('an existing physical legacy name is never replaced or adopted by new-only',async()=>{
  volume={Name:'legacy-db'};vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);
  const r=await post({projectId:'p',compose:compose+'    volumes: ["legacy-db:/var/lib/mysql"]\n',initializeStorage:'new-only'},'p',route);
  expect(r.status).toBe(409);expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false);expect(state.getStorageBirth(name)).toBeUndefined();expect(volume).toEqual({Name:'legacy-db'});expect(container.startInfraService).not.toHaveBeenCalled();
 });
 it('catalog named declaration requires exact native absence and creates only a new owned name',async()=>{
  vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const r=await post({projectId:'p',compose:compose+'    volumes: ["original-absent:/var/lib/mysql"]\n',initializeStorage:'new-only'},'p',route);
  expect(r.status).toBe(200);expect(state.getStorageBirth(name)?.stage).toBe('published');expect(volume.Name).toBe(name);expect(volume.Name).not.toBe('original-absent');const oldCheck=commands.findIndex(c=>c==="docker volume inspect 'original-absent'");const create=commands.findIndex(c=>c.startsWith('docker volume create'));expect(oldCheck).toBeGreaterThanOrEqual(0);expect(oldCheck).toBeLessThan(create);expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
 });
 it('explicit empty storage with new-only creates a fresh owned volume',async()=>{
  vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const r=await post({projectId:'p',compose:compose+'    volumes: []\n',initializeStorage:'new-only'},'p',route);expect(r.status).toBe(200);expect(state.getStorageBirth(name)?.stage).toBe('published');expect(commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
 });
 it('existing selected services stay unchanged while independent new services allocate',async()=>{
  const old={id:'postgres',projectId:'p',name:'old',dockerImage:'postgres:16',containerPort:5432,hostPort:15432,containerName:'old-postgres',status:'stopped' as const,env:{POSTGRES_PASSWORD:'old'},volumes:[],createdAt:'2026-10-22'};state.addInfraService(old);const before=structuredClone(old);vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);
  const second='  postgres:\n    image: postgres:16\n    ports: ["5432:5432"]\n    environment:\n      POSTGRES_PASSWORD: fixture-password\n';const r=await post({projectId:'p',compose:compose+second,initializeStorage:'new-only'},'p',route);expect(r.status).toBe(200);expect(r.body.results).toEqual([{id:'postgres',status:'exists'},{id:'mysql',status:'started'}]);expect(state.getInfraServiceForProjectAndId('p','postgres')).toEqual(before);expect(container.startInfraService).toHaveBeenCalledTimes(1);expect(vi.mocked(container.startInfraService).mock.calls[0][0].id).toBe('mysql');expect(state.getStorageBirth(name)?.stage).toBe('published');
 });
 it('retains a held original allocation without replacing its nonce',async()=>{
  failInspect=true;expect((await post(input())).status).toBe(409);const old=structuredClone(state.getStorageBirth(name));expect(old?.stage).toBe('held');failInspect=false;const count=commands.length;vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);
  const r=await post({projectId:'p',compose,initializeStorage:'new-only'},'p',route);expect(r.status).toBe(409);expect(commands).toHaveLength(count);expect(state.getStorageBirth(name)).toEqual(old);expect(container.startInfraService).not.toHaveBeenCalled();
 });
 it('preserves confirmed storage after startup failure and refuses a second allocation',async()=>{
  vi.spyOn(container,'startInfraService').mockRejectedValue(Error('runtime refused'));const body={projectId:'p',compose,initializeStorage:'new-only'};const r=await post(body,'p',route);expect(r.status).toBe(409);expect(r.body.allocated).toEqual(['mysql']);expect(r.body.recoveryRequired).toBe(true);expect(state.getStorageBirth(name)?.stage).toBe('published');expect(volume).toBeDefined();const count=commands.length;const retry=await post(body,'p',route);expect(retry.status).toBe(200);expect(retry.body.results).toEqual([{id:'mysql',status:'exists'}]);expect(commands).toHaveLength(count);expect(container.startInfraService).toHaveBeenCalledTimes(1);expect(commands.some(c=>c.includes('volume rm'))).toBe(false);
 });
 it('rejects invalid allocation options without silent metadata success',async()=>{
  vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const r=await post({projectId:'p',compose,initializeStorage:'guess'},'p',route);expect(r.status).toBe(400);expect(container.startInfraService).not.toHaveBeenCalled();expect(commands).toHaveLength(0);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();
 });
 it('unknown auto-discovered compose cannot silently allocate from a partial group',async()=>{
  vi.spyOn(state,'getProjectRepoRoot').mockReturnValue(root);fs.writeFileSync(path.join(root,'cds-compose.yml'),compose);fs.writeFileSync(path.join(root,'docker-compose.yml'),'services: [unterminated');vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const r=await post({projectId:'p',initializeStorage:'new-only'},'p',route);expect(r.status).toBe(400);expect(commands).toHaveLength(0);expect(container.startInfraService).not.toHaveBeenCalled();expect(state.getStorageBirth(name)).toBeUndefined();
 });
 it('an explicitly selected non-infra service cannot disappear into a partial new-only batch',async()=>{
  vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const second='  postgres:\n    image: postgres:16\n    ports: ["5432:5432"]\n    environment:\n      POSTGRES_PASSWORD: fixture-password\n      PGDATA: /srv/legacy-data\n    volumes: ["./old-data:/srv/legacy-data"]\n';const r=await post({projectId:'p',compose:compose+second,serviceIds:['mysql','postgres'],initializeStorage:'new-only'},'p',route);expect(r.status).toBe(409);expect(commands).toHaveLength(0);expect(state.getStorageBirth(name)).toBeUndefined();expect(container.startInfraService).not.toHaveBeenCalled();
 });
 it('rejects a supported service mutation between durable publication and runtime start',async()=>{
  const publish=state.publishProvisionedInfraDurably.bind(state);vi.spyOn(state,'publishProvisionedInfraDurably').mockImplementation(async(...args)=>{await publish(...args);state.updateInfraService('mysql',{env:{MYSQL_ROOT_PASSWORD:'mutated'}},'p')});vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const r=await post({projectId:'p',compose,initializeStorage:'new-only'},'p',route);expect(r.status).toBe(409);expect(r.body.allocated).toEqual(['mysql']);expect(state.getStorageBirth(name)?.stage).toBe('published');expect(container.startInfraService).not.toHaveBeenCalled();
 });
 it('passes a frozen service to runtime and rejects drift while runtime is awaiting',async()=>{
  vi.spyOn(container,'startInfraService').mockImplementation(async service=>{state.updateInfraService('mysql',{env:{MYSQL_ROOT_PASSWORD:'mutated'}},'p');expect(service.env.MYSQL_ROOT_PASSWORD).toBe('fixture-password')});const r=await post({projectId:'p',compose,initializeStorage:'new-only'},'p',route);expect(r.status).toBe(409);expect(r.body.results).toEqual([]);expect(state.getInfraServiceForProjectAndId('p','mysql')?.status).toBe('stopped');expect(state.getStorageBirth(name)?.stage).toBe('published');
 });
 it('pause during observation prevents native allocation and startup',async()=>{
  const exec=vi.mocked(shell.exec).getMockImplementation()!;vi.mocked(shell.exec).mockImplementation(async(c,options)=>{if(c.startsWith('docker info'))state.getProject('p')!.paused=true;return exec(c,options)});vi.spyOn(container,'startInfraService').mockResolvedValue(undefined);const r=await post({projectId:'p',compose,initializeStorage:'new-only'},'p',route);expect(r.status).toBe(409);expect(commands.some(c=>c.startsWith('docker volume create'))).toBe(false);expect(container.startInfraService).not.toHaveBeenCalled();
 });
});

async function removeOwned(route:string){return new Promise<{status:number;body:any}>((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port:(server.address() as any).port,path:route,method:'DELETE',headers:{'x-owned-project':'p',Connection:'close'}},r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>resolve({status:r.statusCode!,body:JSON.parse(s)}))});q.on('error',reject);q.end()});}
describe('HTTP retained storage is rejected before lifecycle or metadata changes',()=>{
 it('published infra DELETE is 409 before stop and retains its full metadata',async()=>{
  expect((await post(input())).status).toBe(201);const before=structuredClone(state.getInfraServiceForProjectAndId('p','mysql'));const count=commands.length;const stop=vi.spyOn(container,'stopInfraService').mockResolvedValue(undefined);
  const r=await removeOwned('/api/infra/mysql?project=p');expect(r.status).toBe(409);expect(r.body.error).toBe('storage_retained_service_delete_refused');expect(stop).not.toHaveBeenCalled();expect(commands).toHaveLength(count);expect(state.getInfraServiceForProjectAndId('p','mysql')).toEqual(before);
 });
 it('project DELETE is 409 before teardown tombstone, cascade or native work',async()=>{
  expect((await post(input())).status).toBe(201);const count=commands.length;const mark=vi.spyOn(state,'addContainerTeardownTombstones');const project=state.getProject('p');
  const r=await removeOwned('/api/projects/p');expect(r.status).toBe(409);expect(mark).not.toHaveBeenCalled();expect(commands).toHaveLength(count);expect(state.getProject('p')).toBe(project);expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeDefined();
 });
 it('ordinary no-birth infra deletion keeps existing behavior',async()=>{
  state.addInfraService({id:'plain',projectId:'p',name:'plain',dockerImage:'alpine:3',containerPort:8080,hostPort:18080,containerName:'plain',status:'stopped',env:{},volumes:[],createdAt:'2026-10-23'});const stop=vi.spyOn(container,'stopInfraService').mockResolvedValue(undefined);
  const r=await removeOwned('/api/infra/plain?project=p');expect(r.status).toBe(200);expect(stop).toHaveBeenCalledTimes(1);expect(state.getInfraServiceForProjectAndId('p','plain')).toBeUndefined();
 });
});

describe('ordinary preset UI compatibility still allocates every new persistent ID',()=>{
 function nativeFixture(){const native=new Map<string,any>(),helpers=new Map<string,any>();let issued=0;vi.mocked(shell.exec).mockImplementation(async(c)=>{
  commands.push(c);if(c.startsWith('docker info'))return {exitCode:0,stderr:'',stdout:'own-daemon'};
  if(c.startsWith('docker image inspect'))return {exitCode:0,stderr:'',stdout:c.includes('json .Config.User')?JSON.stringify('appuser'):JSON.stringify(['sha256:'+'a'.repeat(64),c.includes('apache/kafka')?{'/etc/kafka/secrets':{},'/var/lib/kafka/data':{},'/mnt/shared/config':{}}:null])};
  if(c.startsWith('docker create ')){
   const mount=/type=volume,source=([^,]+),dst=([^,]+),/.exec(c)!,row=state.getStorageBirth(mount[1])!,cid=(++issued).toString(16).padStart(64,'0'),name='cds-storage-init-'+row.birthNonce;
   const raw=c.slice(c.lastIndexOf(' -ceu ')+6),program=raw.slice(1,-1).replaceAll("'\\''", "'");
   helpers.set(cid,{Id:cid,Name:'/'+name,Image:'sha256:'+'a'.repeat(64),Config:{User:'0:0',Entrypoint:['/bin/sh'],Cmd:['-ceu',program],Labels:{'cds.storage.init.birth':row.birthNonce,'cds.storage.init.operation':row.operationId}},State:{Status:'created',Running:false,Pid:0,ExitCode:0},HostConfig:{Privileged:false,NetworkMode:'none',ReadonlyRootfs:true,Memory:67108864,MemorySwap:67108864,PidsLimit:16,RestartPolicy:{Name:'no'},CapDrop:['ALL'],CapAdd:['CHOWN'],SecurityOpt:['no-new-privileges'],LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}}},Mounts:[...c.matchAll(/type=volume,source=([^,]+),dst=([^,]+),/g)].map(x=>({Type:'volume',Name:x[1],Source:native.get(x[1]).Mountpoint,Destination:x[2],RW:true}))});return{exitCode:0,stdout:cid,stderr:''};
  }
  if(c.startsWith('docker inspect ')){const id=c.match(/[a-f0-9]{64}/g)!.at(-1)!;return helpers.has(id)?{exitCode:0,stdout:JSON.stringify([helpers.get(id)]),stderr:''}:{exitCode:1,stdout:'[]',stderr:'error: no such object: '+id};}
  if(c.startsWith('docker start -a ')){const id=c.split(' ').at(-1)!;helpers.get(id).State={Status:'exited',Running:false,Pid:0,ExitCode:0};return{exitCode:0,stdout:['0:1000:770','0:1000:770','0:1000:770'].join('\n'),stderr:''};}
  if(c.startsWith('docker rm ')){helpers.delete(c.split(' ').at(-1)!);return{exitCode:0,stdout:'',stderr:''};}
  const n=c.split(' ').at(-1)!.replace(/^'|'$/g,'');
  if(c.startsWith('docker volume inspect'))return native.has(n)?{exitCode:0,stderr:'',stdout:JSON.stringify([native.get(n)])}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+n+': no such volume'};
  if(c.startsWith('docker volume create')){const row=state.getStorageBirth(n)!;native.set(n,{Name:n,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+n+'/_data',CreatedAt:'2026-10-23T00:00:00Z',Labels:{...storageOwnerLabels(row.binding),'cds.storage.birth':row.birthNonce}});return {exitCode:0,stderr:'',stdout:n}}
  throw Error('unexpected native fixture command');
 });return native;}
 const route='/api/projects/p/infra-presets';
 it('no-flag repeated DB request creates mysql-2 with its own actual published birth',async()=>{
  const native=nativeFixture();expect((await post({presetIds:['mysql']},'p',route)).status).toBe(200);
  const r=await post({presetIds:['mysql']},'p',route);expect(r.status).toBe(200);expect(r.body.applied).toEqual(['mysql-2']);expect(native.size).toBe(2);expect(state.getStorageBirthsForService('p','mysql-2')[0].stage).toBe('published');
 });
 it('no-flag singleton repeat is 200/no-op with no further native operations',async()=>{
  nativeFixture();expect((await post({presetIds:['kafka']},'p',route)).status).toBe(200);const count=commands.length;
  const r=await post({presetIds:['kafka']},'p',route);expect(r.status).toBe(200);expect(r.body.applied).toEqual([]);expect(commands).toHaveLength(count);expect(state.getInfraServiceForProjectAndId('p','kafka-2')).toBeUndefined();
 });
 it('no-flag held original ID without a published service blocks instead of advancing',async()=>{
  failInspect=true;expect((await post({presetIds:['mysql']},'p',route)).status).toBe(409);const original=structuredClone(state.getStorageBirth(name));expect(original?.stage).toBe('held');expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();failInspect=false;const count=commands.length;
  const r=await post({presetIds:['mysql']},'p',route);expect(r.status).toBe(409);expect(commands).toHaveLength(count);expect(state.getStorageBirth(name)).toEqual(original);expect(state.getStorageBirthsForService('p','mysql-2')).toEqual([]);
 });
 it('explicit new-only remains strict after a successful UI allocation',async()=>{
  nativeFixture();expect((await post({presetIds:['mysql']},'p',route)).status).toBe(200);const count=commands.length;
  const r=await post({presetIds:['mysql'],initializeStorage:'new-only'},'p',route);expect(r.status).toBe(409);expect(commands).toHaveLength(count);expect(state.getStorageBirthsForService('p','mysql-2')).toEqual([]);
 });
});

it('ordinary infra PUT cannot erase published volume ownership and preserves status edits',async()=>{
 expect((await post(input())).status).toBe(201);const before=structuredClone(state.getInfraServiceForProjectAndId('p','mysql')),count=commands.length;
 const url=`http://127.0.0.1:${(server.address() as any).port}/api/infra/mysql?project=p`;
 const r=await fetch(url,{method:'PUT',headers:{'content-type':'application/json','x-owned-project':'p'},body:JSON.stringify({volumes:[]}),signal:AbortSignal.timeout(3000)});
 expect(r.status).toBe(409);expect(await r.text()).toContain('storage_retained');expect(state.getInfraServiceForProjectAndId('p','mysql')).toEqual(before);expect(commands).toHaveLength(count);
 const safe=await fetch(url,{method:'PUT',headers:{'content-type':'application/json','x-owned-project':'p'},body:JSON.stringify({name:'renamed',status:'stopped'}),signal:AbortSignal.timeout(3000)});
 expect(safe.status).toBe(200);expect(state.getInfraServiceForProjectAndId('p','mysql')?.volumes).toEqual(before?.volumes);expect(commands).toHaveLength(count);
});

it('unknown custom Docker VOLUME is rejected before publishing a poisoned service',async()=>{
 const exec=vi.mocked(shell.exec).getMockImplementation()!;vi.mocked(shell.exec).mockImplementation(async(c,o)=>c.startsWith('docker image inspect')?{exitCode:0,stderr:'',stdout:JSON.stringify(['sha256:'+'b'.repeat(64),{'/custom-data':{}}])}:exec(c,o));
 const r=await post({id:'custom-stateful',projectId:'p',dockerImage:'example/custom-db:1',containerPort:1234});
 expect(r.status).toBe(409);expect(state.getInfraServiceForProjectAndId('p','custom-stateful')).toBeUndefined();expect(commands.some(c=>/^docker (create|start|run|stop|rm) /.test(c))).toBe(false);
});
