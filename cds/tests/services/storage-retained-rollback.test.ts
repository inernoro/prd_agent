import http from 'node:http';
import express from 'express';
import {describe,it,expect,vi} from 'vitest';
import {StateService} from '../../src/services/state.js';
import {GLOBAL_ENV_SCOPE} from '../../src/types.js';
import {createSnapshotsRouter} from '../../src/routes/snapshots.js';
function fixture(){
 const s=Object.create(StateService.prototype) as any;
 s.state={projects:[{id:'p'},{id:'other'}],branches:{b:{id:'b',projectId:'p',profileOverrides:{app:{enabled:true}}}},buildProfiles:[{id:'app',projectId:'p',cacheMounts:[]}],customEnv:{p:{KEY:'original'},other:{KEY:'before'}},routingRules:[],infraServices:[{id:'db',projectId:'p',env:{PW:'original'},volumes:[{name:'original-volume'}]}],storageBirths:{v:{stage:'published',binding:{scope:'project-shared',projectId:'p',serviceId:'db'}}},storageProvisionPublications:{},profileStorageBindings:{},profileStoragePublications:{},configSnapshots:[],destructiveOps:[{id:'op',at:new Date().toISOString(),undoable:true,snapshotId:'before'}]};
 s.storageProvisionDrafts=new Map();s.profileStorageDrafts=new Map();s.save=vi.fn();s.createConfigSnapshot=vi.fn();s.recordDestructiveOp=vi.fn();s.markDestructiveOpUndone=vi.fn();
 const snapshot={id:'before',label:'before',createdAt:new Date().toISOString(),payload:{buildProfiles:structuredClone(s.state.buildProfiles),customEnv:structuredClone(s.state.customEnv),routingRules:[],infraServices:structuredClone(s.state.infraServices)}} as any;
 s.state.configSnapshots=[snapshot];return {s:s as StateService,raw:s,target:snapshot};
}
describe('P metadata survives snapshot rollback',()=>{
 it.each(['absent','changed'])('rejects %s original infra definition before backup/write',kind=>{
  const {s,raw,target}=fixture();if(kind==='absent')target.payload.infraServices=[];else target.payload.infraServices[0].env.PW='wrong';
  const before=JSON.stringify(raw.state);expect(()=>s.rollbackToConfigSnapshot('before')).toThrow('storage_retained_service_delete_refused');expect(raw.createConfigSnapshot).not.toHaveBeenCalled();expect(raw.save).not.toHaveBeenCalled();expect(JSON.stringify(raw.state)).toBe(before);
 });
 it.each(['draft','publication'])('keeps private %s metadata private instead of publishing an old snapshot row',kind=>{
  const {s,raw,target}=fixture();raw.state.storageBirths={};const service=structuredClone(raw.state.infraServices[0]);raw.state.infraServices=[];const row={service,names:['v'],operationId:'owned'};if(kind==='draft')raw.storageProvisionDrafts.set(JSON.stringify(['p','db']),row);else raw.state.storageProvisionPublications[JSON.stringify(['p','db'])]=row;
  expect(()=>s.rollbackToConfigSnapshot('before')).toThrow('storage_retained_service_delete_refused');expect(raw.createConfigSnapshot).not.toHaveBeenCalled();expect(raw.state.infraServices).toEqual([]);
 });
 it.each(['profile','env','branch'])('protects bound branch-private %s declaration',kind=>{
  const {s,raw,target}=fixture();raw.state.storageBirths={};raw.state.profileStorageBindings.bound={target:{projectId:'p'}};
  if(kind==='profile')target.payload.buildProfiles=[];if(kind==='env')target.payload.customEnv.p.KEY='wrong';if(kind==='branch')target.payload.branchConfigs={};
  expect(()=>s.rollbackToConfigSnapshot('before')).toThrow('storage_retained_service_delete_refused');expect(raw.createConfigSnapshot).not.toHaveBeenCalled();
 });
 it('retains referenced shared-infra project and global credentials even with identical service text',()=>{
  for(const scope of ['p',GLOBAL_ENV_SCOPE]){
   const {s,raw,target}=fixture();raw.state.infraServices[0].env={PW:'${MYSQL_ROOT_PASSWORD}'};target.payload.infraServices=structuredClone(raw.state.infraServices);
   raw.state.customEnv[scope]={MYSQL_ROOT_PASSWORD:'original'};target.payload.customEnv[scope]={MYSQL_ROOT_PASSWORD:'changed'};
   const before=JSON.stringify(raw.state);expect(()=>s.rollbackToConfigSnapshot('before')).toThrow('storage_retained_service_delete_refused');expect(raw.createConfigSnapshot).not.toHaveBeenCalled();expect(JSON.stringify(raw.state)).toBe(before);
  }
 });
 it('allows unchanged generated snapshot with omitted empty branch configuration',()=>{
  const {s,raw,target}=fixture();raw.state.profileStorageBindings.bound={target:{projectId:'p'}};raw.state.branches.b.profileOverrides={};raw.state.branches.b.extraProfiles=[];target.payload.branchConfigs={};
  expect(()=>s.rollbackToConfigSnapshot('before')).not.toThrow();expect(raw.createConfigSnapshot).toHaveBeenCalledTimes(1);
 });
 it('allows other-project config rollback when all protected declarations are identical',()=>{
  const {s,raw,target}=fixture();raw.state.profileStorageBindings.bound={target:{projectId:'p'}};target.payload.customEnv.other.KEY='after';
  expect(()=>s.rollbackToConfigSnapshot('before')).not.toThrow();expect(raw.state.customEnv.other.KEY).toBe('after');expect(raw.createConfigSnapshot).toHaveBeenCalledTimes(1);expect(raw.state.infraServices[0].volumes[0].name).toBe('original-volume');
 });
 it.each(['/api/config-snapshots/before/rollback','/api/destructive-ops/op/undo'])('HTTP %s rejects409 without success bookkeeping',async url=>{
  const {s,raw,target}=fixture();target.payload.infraServices=[];const app=express();app.use(express.json());app.use('/api',createSnapshotsRouter({stateService:s}));const server=await new Promise<http.Server>(r=>{const h=app.listen(0,'127.0.0.1',()=>r(h))});
  try{const response=await new Promise<{status:number;body:any}>((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:(server.address() as any).port,path:url,method:'POST',headers:{Connection:'close'}},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}))});req.on('error',reject);req.end()});expect(response.status).toBe(409);expect(response.body.error).toBe('storage_retained_service_delete_refused');expect(raw.markDestructiveOpUndone).not.toHaveBeenCalled();expect(raw.recordDestructiveOp).not.toHaveBeenCalled();expect(raw.createConfigSnapshot).not.toHaveBeenCalled();}
  finally{await new Promise<void>(r=>server.close(()=>r()))}
 });
});
