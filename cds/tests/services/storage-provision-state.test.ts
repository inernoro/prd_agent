import {unitBindMountInspector} from '../helpers/storage-bind-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {ContainerService} from '../../src/services/container.js';
import {StateService} from '../../src/services/state.js';
import {StorageProvisionService} from '../../src/services/storage-provision.js';
import {infraStoragePlan,stableStorageVolumeName,storageOwnerLabels} from '../../src/services/deployment-storage-plan.js';
import type {InfraService,StorageBinding,IShellExecutor} from '../../src/types.js';
let root:string,state:StateService;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'cds-storage-birth-'));state=new StateService(path.join(root,'state.json'));state.load();state.addProject({id:'p',slug:'p',name:'own'} as any)});
afterEach(async()=>{vi.restoreAllMocks();await state.flush();fs.rmSync(root,{recursive:true,force:true})});
function own(){
 const b:StorageBinding={version:1,instanceId:'own',projectId:'p',scope:'project-shared',serviceId:'mysql',mountKey:'data',purpose:'persistent'};const n=stableStorageVolumeName(b);let volume:any;const commands:string[]=[];
 const service:InfraService={id:'mysql',projectId:'p',scope:'project',name:'own',dockerImage:'mysql:8.0',containerName:'own-mysql',containerPort:3306,hostPort:13306,status:'stopped',env:{},volumes:[{type:'volume',name:n,containerPath:'/var/lib/mysql',storage:b}]};
 const plan=infraStoragePlan(service,{storageInstanceId:'own',repoRoot:root});
 const shell={exec:async(c:string)=>{commands.push(c);if(c.startsWith('docker image inspect'))return {exitCode:0,stderr:'',stdout:JSON.stringify(['sha256:'+'a'.repeat(64),null])};if(c.startsWith('docker info'))return {exitCode:0,stderr:'',stdout:'own-daemon'};if(c.startsWith('docker volume inspect'))return volume?{exitCode:0,stderr:'',stdout:JSON.stringify([volume])}:{exitCode:1,stderr:'Error response from daemon: get '+n+': no such volume',stdout:''};if(c.startsWith('docker volume create')){const row=(state as any).getStorageBirth(n);volume={Name:n,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+n+'/_data',CreatedAt:'2026-10-22T00:00:00Z',Labels:{...storageOwnerLabels(b),'cds.storage.birth':row.birthNonce}};return {exitCode:0,stderr:'',stdout:n}}throw Error('unexpected owned fixture command')}} as IShellExecutor;
 return {n,service,plan,commands,shell,allocator:new StorageProvisionService(state,shell,{repoRoot:root,storageInstanceId:'own'})};
}
describe('real State storage birth publication',()=>{
 it('stores original birth before native create and publishes a restart-readable confirmed service',async()=>{
  const f=own();await f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{});
  expect(state.getInfraServiceForProjectAndId('p','mysql')).toEqual(f.service);const row=(state as any).getStorageBirth(f.n);expect(row.stage).toBe('published');expect((state as any).storageBirthRequirements(f.plan)[f.n].birthNonce).toBe(row.birthNonce);
  const restored=new StateService(path.join(root,'state.json'));restored.load();expect(restored.getInfraServiceForProjectAndId('p','mysql')).toEqual(f.service);expect((restored as any).storageBirthRequirements(f.plan)[f.n].birthNonce).toBe(row.birthNonce);await restored.flush();
 });
 it.each([4,5])('keeps service private until publication ACK %s while preserving another entity',async barrier=>{
  const f=own(),flush=state.flush.bind(state);let calls=0,enter!:()=>void,resume!:()=>void;const started=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>resume=r);
  vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++calls===barrier){enter();await gate}});
  const run=f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{});const ended=run.then(()=>{throw Error('completed before held ACK')},()=>{throw Error('failed before held ACK')});void ended.catch(()=>{});await Promise.race([started,ended]);
  try{expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(()=>(state as any).storageBirthRequirements(f.plan)).toThrow('storage_provision');expect(()=>state.addInfraService({...f.service})).toThrow('storage_provision');state.setCustomEnv({OTHER_ENTITY:'retained'},'p')}
  finally{resume()}
  await run;expect(state.getCustomEnv('p').OTHER_ENTITY).toBe('retained');expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeDefined();
 });
 it('real ContainerService holds native-created volume until publication ACK, then validates its birth on the original daemon',async()=>{
  const f=own(),flush=state.flush.bind(state);let calls=0,enter!:()=>void,resume!:()=>void;const started=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>resume=r);
  vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++calls===4){enter();await gate}});
  const run=f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{});void run.catch(()=>{});await started;
  const container=new ContainerService(f.shell,{repoRoot:root,storageInstanceId:'own'} as any,{getDockerNetwork:()=>undefined,storageBirthRequirements:p=>state.storageBirthRequirements(p)}, undefined, undefined, undefined, unitBindMountInspector);
  try {await expect(container.preflightInfraStorage(f.service)).rejects.toThrow('storage_provision');expect(f.commands.some(c=>/docker (create|start|run)/.test(c))).toBe(false)} finally {resume()}
  await run;await expect(container.preflightInfraStorage(f.service)).resolves.toMatchObject({id:'mysql'});
  const exec=f.shell.exec.bind(f.shell);vi.spyOn(f.shell,'exec').mockImplementation(async(c,o)=>c.startsWith('docker info')?{exitCode:0,stdout:'other-daemon',stderr:''}:exec(c,o));
  await expect(container.preflightInfraStorage(f.service)).rejects.toThrow('storage-birth-unconfirmed');
 });
 it('failed final publication retracts config but retains native birth and prevents R',async()=>{
  const f=own(),flush=state.flush.bind(state);let calls=0;vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++calls===5)throw Error('own ACK failed')});
  await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');expect(state.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(()=>(state as any).storageBirthRequirements(f.plan)).toThrow('storage_provision');expect(f.commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);
  const restored=new StateService(path.join(root,'state.json'));restored.load();expect(restored.getInfraServiceForProjectAndId('p','mysql')).toBeUndefined();expect(()=>(restored as any).storageBirthRequirements(f.plan)).toThrow('storage_provision');await restored.flush();
 });
});

it.each(['volumes','id','projectId','scope','path','owner'])('refuses changing allocated infra %s before mutating metadata',async kind=>{
 const f=own();await f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{});
 const before=structuredClone(state.getInfraServiceForProjectAndId('p','mysql'));
 const patch=kind==='volumes'?{volumes:[]}:kind==='id'?{id:'moved'}:kind==='projectId'?{projectId:'q'}:kind==='scope'?{scope:'system' as const}:{volumes:f.service.volumes.map(v=>({...v,...(kind==='path'?{containerPath:'/different'}:{storage:{...v.storage!,instanceId:'other'}})}))};
 expect(()=>state.updateInfraService('mysql',patch,'p')).toThrow('storage_retained');
 expect(state.getInfraServiceForProjectAndId('p','mysql')).toEqual(before);
 expect(()=>state.updateInfraService('mysql',{name:'renamed',status:'stopped'},'p')).not.toThrow();
});
it('empty accepted infra plan cannot omit an original retained birth',async()=>{
 const f=own();await f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{});
 const empty=infraStoragePlan({...f.service,volumes:[]},{repoRoot:root,storageInstanceId:'own'});
 expect(()=>state.storageBirthRequirements(empty)).toThrow('storage_provision');
 const count=f.commands.length;
 const c=new ContainerService(f.shell,{repoRoot:root,storageInstanceId:'own'} as any,{getDockerNetwork:()=>undefined,storageBirthRequirements:p=>state.storageBirthRequirements(p)},undefined,undefined,undefined,unitBindMountInspector);
 await expect(c.preflightInfraStorage({...f.service,volumes:[]})).rejects.toThrow('storage_provision');
 expect(f.commands).toHaveLength(count);
});
