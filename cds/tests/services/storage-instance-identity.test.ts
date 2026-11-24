import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {StateService} from '../../src/services/state.js';
let root:string,state:StateService;
beforeEach(async()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-instance-'));state=new StateService(root+'/state.json');state.load();await state.flush();});
afterEach(async()=>{vi.restoreAllMocks();await state.flush();fs.rmSync(root,{recursive:true,force:true});});
describe('storage instance identity is durably accepted before runtime boot',()=>{
 it('upgrades an installation without configuration once and survives a cold state reload',async()=>{
  const id=await state.ensureStorageInstanceId();expect(id).toMatch(/^[a-f0-9]{32}$/);
  const cold=new StateService(root+'/state.json');cold.load();expect(await cold.ensureStorageInstanceId()).toBe(id);await cold.flush();
 });
 it('persists an explicit original identity so later restarts need no environment override',async()=>{
  expect(await state.ensureStorageInstanceId('original-owner')).toBe('original-owner');
  const cold=new StateService(root+'/state.json');cold.load();expect(await cold.ensureStorageInstanceId()).toBe('original-owner');await cold.flush();
 });
 it('restores a unique held birth identity instead of creating a new owner',async()=>{
  (state.getState() as any).storageBirths={v:{binding:{instanceId:'original-birth'},stage:'held'}};
  expect(await state.ensureStorageInstanceId()).toBe('original-birth');
 });
 it.each(['explicit','birth'])('refuses a conflicting %s owner before saving',async kind=>{
  await state.ensureStorageInstanceId('original');if(kind==='birth')(state.getState() as any).storageBirths={v:{binding:{instanceId:'foreign'},stage:'held'}};
  const before=JSON.stringify(state.getState()),save=vi.spyOn(state,'save');
  await expect(state.ensureStorageInstanceId(kind==='explicit'?'foreign':undefined)).rejects.toThrow('storage_instance_identity_unconfirmed');expect(save).not.toHaveBeenCalled();expect(JSON.stringify(state.getState())).toBe(before);
 });
 it.each(['infra','profile','override','extra','private-publication'])('preserves an owner from %s mappings even without a birth journal',async kind=>{
  const raw=state.getState() as any,mount={storage:{instanceId:'declared-owner'}};
  if(kind==='infra')raw.infraServices=[{volumes:[mount]}];
  if(kind==='profile')raw.buildProfiles=[{cacheMounts:[mount]}];
  if(kind==='override')raw.branches={b:{profileOverrides:{app:{cacheMounts:[mount]}}}};
  if(kind==='extra')raw.branches={b:{extraProfiles:[{cacheMounts:[mount]}]}};
  if(kind==='private-publication')raw.profileStoragePublications={v:{binding:{mounts:[mount]}}};
  expect(await state.ensureStorageInstanceId()).toBe('declared-owner');
 });
 it('refuses a declared binding with a missing owner instead of minting a namespace',async()=>{
  (state.getState() as any).infraServices=[{volumes:[{storage:{}}]}];const save=vi.spyOn(state,'save');
  await expect(state.ensureStorageInstanceId()).rejects.toThrow('storage_instance_identity_unconfirmed');expect(save).not.toHaveBeenCalled();
 });
 it('refuses multiple historical owners rather than guessing or adopting their volumes',async()=>{
  (state.getState() as any).storageBirths={a:{binding:{instanceId:'a'}},b:{binding:{instanceId:'b'}}};const save=vi.spyOn(state,'save');
  await expect(state.ensureStorageInstanceId()).rejects.toThrow('storage_instance_identity_unconfirmed');expect(save).not.toHaveBeenCalled();
 });
 it.each(['',' leading','bad/path','owner:invalid'])('rejects an invalid explicit identity %j before saving',async id=>{
  const save=vi.spyOn(state,'save');await expect(state.ensureStorageInstanceId(id)).rejects.toThrow('storage_instance_identity_unconfirmed');expect(save).not.toHaveBeenCalled();
 });
 it('does not publish an identity before its backing-store flush acknowledgment',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);vi.spyOn(state,'flush').mockReturnValueOnce(gate);let accepted=false;
  const pending=state.ensureStorageInstanceId().then(id=>{accepted=true;return id});await Promise.resolve();expect(accepted).toBe(false);release();expect(await pending).toMatch(/^[a-f0-9]{32}$/);
 });
 it('propagates a failed durable acknowledgment without pretending boot succeeded',async()=>{
  vi.spyOn(state,'flush').mockRejectedValueOnce(Error('fixture-write-failure'));await expect(state.ensureStorageInstanceId()).rejects.toThrow('fixture-write-failure');
 });
 it('retries the original identity write after a synchronous save failure',async()=>{
  const save=vi.spyOn(state,'save').mockImplementationOnce(()=>{throw Error('write-failure')});
  await expect(state.ensureStorageInstanceId()).rejects.toThrow('write-failure');const original=state.getState().storageInstanceId;
  expect(await state.ensureStorageInstanceId()).toBe(original);expect(save).toHaveBeenCalledTimes(2);
  const cold=new StateService(root+'/state.json');cold.load();expect(await cold.ensureStorageInstanceId()).toBe(original);await cold.flush();
 });
 it('boots identity after state loading and before deployment reservation restore',()=>{
  const source=fs.readFileSync(new URL('../../src/index.ts',import.meta.url),'utf8'),start=source.indexOf('await initStateService();');
  const identity=source.indexOf('config.storageInstanceId = await stateService.ensureStorageInstanceId(config.storageInstanceId);',start);
  expect(identity).toBeGreaterThan(start);expect(identity).toBeLessThan(source.indexOf('await restoreDeploymentMemoryReservations(',start));
 });
});
