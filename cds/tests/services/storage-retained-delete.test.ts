import { describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
function fake(){const s=Object.create(StateService.prototype) as any;s.state={infraServices:[{id:'db',projectId:'p',containerName:'keep',volumes:[{name:'original'}]}],storageBirths:{},storageProvisionPublications:{},profileStorageBindings:{},profileStoragePublications:{}};s.storageProvisionDrafts=new Map();s.profileStorageDrafts=new Map();return s as StateService;}
describe('retained storage deletion refusal',()=>{
 for(const stage of ['intent','confirmed','published','held'])it('retains full infra metadata for '+stage,()=>{
  const s=fake() as any;s.state.storageBirths.v={binding:{scope:'project-shared',projectId:'p',serviceId:'db'},stage};
  const before=JSON.stringify(s.state);expect(()=>s.removeInfraService('db','p')).toThrow('storage_retained_service_delete_refused');expect(JSON.stringify(s.state)).toBe(before);
  expect(()=>s.assertProjectStorageRemovalAllowed('p')).toThrow('storage_retained_service_delete_refused');
 });
 it('blocks unfinished private draft and public publication without a birth',()=>{
  const s=fake() as any;const key=JSON.stringify(['p','db']);s.storageProvisionDrafts.set(key,{service:s.state.infraServices[0],names:['v']});
  expect(()=>s.assertInfraRemovalAllowed('db','p')).toThrow();s.storageProvisionDrafts.clear();s.state.storageProvisionPublications[key]={service:s.state.infraServices[0],names:['v']};
  expect(()=>s.removeInfraService('db','p')).toThrow();expect(()=>s.removeProject('p')).toThrow();
 });
 it('blocks project cascade retaining a branch-private mapping',()=>{
  const s=fake() as any;s.state.profileStorageBindings.x={target:{projectId:'p'}};expect(()=>s.removeProject('p')).toThrow('storage_retained_service_delete_refused');
 });
 it('allows ordinary metadata deletion and preserves same id in a different project',()=>{
  const s=fake() as any;s.state.storageBirths.foreign={binding:{scope:'project-shared',projectId:'other',serviceId:'db'},stage:'published'};
  expect(()=>s.removeInfraService('db','p')).not.toThrow();expect(s.state.infraServices).toEqual([]);
  expect(()=>s.removeInfraService('db')).toThrow('storage_retained_service_delete_refused');
 });
});

it('keeps declaration-only imported storage reachable without a birth journal',()=>{
 const s=fake() as any;s.state.infraServices[0].volumes=[{name:'retained',storage:{version:1,instanceId:'own',projectId:'p',scope:'project-shared',serviceId:'db',mountKey:'data',purpose:'persistent'}}];
 const before=JSON.stringify(s.state);expect(()=>s.removeInfraService('db','p')).toThrow('storage_retained');expect(()=>s.assertProjectStorageRemovalAllowed('p')).toThrow('storage_retained');expect(JSON.stringify(s.state)).toBe(before);
});
