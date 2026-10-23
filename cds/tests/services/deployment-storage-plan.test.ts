import {describe, it, expect, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {profileStoragePlan, infraStoragePlan, renderStoragePlan, stableStorageVolumeName, storageOwnerLabels, inspectStoragePlan,
  materializeStoragePlan, withReadOnlyTools} from '../../src/services/deployment-storage-plan.js';
import type {BuildProfile, IShellExecutor, StorageBinding} from '../../src/types.js';

const owner: StorageBinding = {version: 1, instanceId: 'stable-instance', projectId: 'p', scope: 'branch-private', branchId: 'b', serviceId: 'app', mountKey: 'data', purpose: 'persistent'};
const entry = {id: 'b', projectId: 'p', worktreePath: '/wt/p/.deployment-sources/b/uuid-a'};
const config = {repoRoot: '/repo', storageInstanceId: 'stable-instance'};
const profile = (cacheMounts: BuildProfile['cacheMounts'] = []): BuildProfile => ({id: 'app', projectId: 'p', name: 'App', workDir: '.', dockerImage: 'image', containerPort: 80, prebuiltImage: true, cacheMounts});
const plan = () => profileStoragePlan(entry, profile([{kind:'volume',hostPath:stableStorageVolumeName(owner),containerPath:'/data',storage:owner}]), config);
const native = () => ({Name:stableStorageVolumeName(owner), Driver:'local', Options:null, Mountpoint:'/var/lib/docker/volumes/'+stableStorageVolumeName(owner)+'/_data',Labels:storageOwnerLabels(owner)});
const shell = (result: unknown) => ({exec: vi.fn(async () => ({exitCode:0,stdout:JSON.stringify([result]),stderr:''}))}) as unknown as IShellExecutor;

describe('future storage contract and actual native admission', () => {
  it('source is readonly, no implicit writable node_modules, no automatic host mkdir', () => {
    const p = profileStoragePlan(entry, {...profile(),prebuiltImage:false}, config);
    expect(p.mounts).toHaveLength(1); expect(p.mounts[0]).toMatchObject({purpose:'source',readOnly:true});
    expect(renderStoragePlan(p).join(' ')).toContain('readonly'); expect(renderStoragePlan(p).join(' ')).not.toContain('-v ');
    expect(() => profileStoragePlan(entry, {...profile(),prebuiltImage:false,workDir:'../../../../../data'}, config)).toThrow('source-outside-checkout');
  });
  it('managed build has no runtime source mount, uses the existing independent build layer', () => {
    const p = profileStoragePlan(entry, {...profile(),prebuiltImage:false,managedBuild:{stack:'node',startCommand:'node index.js',artifactImage:'built'}},config);
    expect(p.mounts).toEqual([]);
  });
  it('same owner across commits/checkouts uses exactly the same stable storage identity', () => {
    expect(profileStoragePlan({...entry,worktreePath:'/different/checkout/new-uuid'},profile([{kind:'volume',hostPath:stableStorageVolumeName(owner),containerPath:'/data',storage:owner}]),config).digest).toBe(plan().digest);
    for (const delta of [{instanceId:'other'}, {projectId:'other'}, {branchId:'other'}, {serviceId:'other'}, {mountKey:'other'}]) {
      expect(stableStorageVolumeName({...owner,...delta})).not.toBe(stableStorageVolumeName(owner));
    }
  });
  it('explicit project-shared identity is stable across branches and does not invent branch-private storage', () => {
    const shared: StorageBinding = {...owner,scope:'project-shared'}; delete shared.branchId;
    const service = {id:'app',projectId:'p',volumes:[{name:stableStorageVolumeName(shared),containerPath:'/data',storage:shared}]};
    expect(infraStoragePlan(service,config).mounts[0].source).toBe(stableStorageVolumeName(shared));
    expect(() => infraStoragePlan({...service,projectId:'other'},config)).toThrow('owner-mismatch');
  });
  it.each([undefined,'another'])('missing/wrong fixed instance %s never guesses from repoRoot', instanceId => {
    expect(() => profileStoragePlan(entry,profile([{kind:'volume',hostPath:stableStorageVolumeName(owner),containerPath:'/data',storage:owner}]),{storageInstanceId:instanceId})).toThrow('owner-mismatch');
  });
  it('old bare volume cannot initialize or adopt by a familiar name', () => {
    expect(() => profileStoragePlan(entry,profile([{kind:'volume',hostPath:'old-data',containerPath:'/data'}]),config)).toThrow('contract-required');
    expect(() => profileStoragePlan(entry,profile([{kind:'volume',hostPath:'old-data',containerPath:'/data',storage:owner}]),config)).toThrow('name-mismatch');
  });
  it('refuses writable bind aliases including a real symlink without requiring unsafe pin guesses', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'cds-storage-alias-'));
    try {
      fs.mkdirSync(path.join(root,'.deployment-sources')); fs.symlinkSync(path.join(root,'.deployment-sources'),path.join(root,'alias'));
      for(const hostPath of [path.join(root,'alias'),path.join(root,'missing'),'/']) {
        expect(() => profileStoragePlan(entry,profile([{kind:'bind',hostPath,containerPath:'/data',storage:owner}]),config)).toThrow('pin-required');
      }
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it('preserves readonly config target and tools inside one immutable hashed plan', () => {
    const p=withReadOnlyTools(profileStoragePlan(entry,profile([{kind:'bind',hostPath:'/config/file',containerPath:'/etc/service/config',readOnly:true}]),config),[{source:'/usr/bin/ffmpeg',target:'/usr/local/bin/ffmpeg'}]);
    expect(Object.isFrozen(p.mounts)).toBe(true); expect(p.mounts).toHaveLength(2); expect(renderStoragePlan(p).every(f=>f.includes('readonly'))).toBe(true);
    expect(() => renderStoragePlan({...p,digest:'forged'})).toThrow('plan-invalid');
    expect(() => renderStoragePlan({...p,mounts:[{kind:'bind',source:'/source',target:'/app',readOnly:false,purpose:'source'}]})).toThrow('plan-invalid');
  });
  it('same-target ambiguity refuses even if an earlier mount looked valid',()=> {
    expect(()=>profileStoragePlan(entry,profile([{kind:'bind',hostPath:'/a',containerPath:'/etc/config',readOnly:true},{kind:'bind',hostPath:'/b',containerPath:'/etc/config',readOnly:true}]),config)).toThrow('target-duplicate');
  });
  it('no-copy stops Docker from filling a newly allocated data volume from image content',()=>{
    expect(renderStoragePlan(plan())[0]).toContain('volume-nocopy');
  });
  it.each(['labels','driver','bindOptions','mountpoint','unknownOptions'])('rejects native owner/physical kind mismatch %s without mutation',async kind=>{
    const item=native();
    if(kind==='labels') item.Labels={};
    if(kind==='driver') item.Driver='nfs';
    if(kind==='bindOptions') (item as any).Options={type:'none',o:'bind',device:'/source/.deployment-sources/b/u'};
    if(kind==='mountpoint') item.Mountpoint='/source/.deployment-sources/b/u';
    if(kind==='unknownOptions') delete (item as any).Options;
    const s=shell(item); await expect(inspectStoragePlan(s,plan())).rejects.toThrow('unsafe_deployment_storage');
    expect((s.exec as any).mock.calls.every(([cmd]:[string])=>cmd.startsWith('docker volume inspect'))).toBe(true);
  });
  it('accepts only the exact existing owner and default local physical volume',async()=>{
    await expect(inspectStoragePlan(shell(native()),plan(),false)).resolves.toBeUndefined();
  });
  it('absence may be allowed before allocation but never after successful create',async()=>{
    const s={exec:vi.fn(async(cmd:string)=>cmd.startsWith('docker volume inspect')?{exitCode:1,stdout:'',stderr:'Error: no such volume'}:{exitCode:0,stdout:stableStorageVolumeName(owner),stderr:''})} as IShellExecutor;
    await expect(inspectStoragePlan(s,plan(),true)).resolves.toBeUndefined();
    await expect(materializeStoragePlan(s,plan())).rejects.toThrow('storage-existing-volume-required');
  });
  it('a concurrent stranger returned by volume create is not adopted',async()=>{
    let calls=0;const s={exec:vi.fn(async(cmd:string)=>{
      if(cmd.startsWith('docker volume create')) return {exitCode:0,stdout:'name',stderr:''};
      calls++;return calls===1?{exitCode:1,stdout:'',stderr:'no such volume'}:{exitCode:0,stdout:JSON.stringify([{...native(),Labels:{}}]),stderr:''};
    })} as IShellExecutor;
    await expect(materializeStoragePlan(s,plan())).rejects.toThrow('storage-existing-volume-required');
    expect((s.exec as any).mock.calls.every(([cmd]:[string])=>cmd.startsWith('docker volume inspect'))).toBe(true);
  });
});

it.each(['unbound','parent-only','relative','array','wrong-id','unknown'])('actual image declaration fails closed: %s',async kind=>{
  const {resolveStorageImage}=await import('../../src/services/deployment-storage-plan.js');
  const id='sha256:'+'a'.repeat(64); const empty=profileStoragePlan(entry,profile(),config);
  const p=kind==='parent-only'?profileStoragePlan(entry,{...profile(),prebuiltImage:false},config):empty;
  const volumes=kind==='parent-only'?{'/app/data':{}}:kind==='relative'?{'relative':{}}:kind==='array'?[]:{'/data':{}};
  const s={exec:vi.fn(async()=>({exitCode:0,stderr:'',stdout:kind==='unknown'?'':JSON.stringify([id,volumes])}))} as IShellExecutor;
  await expect(resolveStorageImage(s,kind==='wrong-id'?'sha256:'+'b'.repeat(64):'image',p)).rejects.toThrow('unsafe_deployment_storage');
  expect((s.exec as any).mock.calls).toHaveLength(1);
});
it('explicit exact data target covers image VOLUME; checks actual image ID and never retags',async()=>{
 const {resolveStorageImage}=await import('../../src/services/deployment-storage-plan.js'); const id='sha256:'+'a'.repeat(64);
 const s={exec:vi.fn(async()=>({exitCode:0,stderr:'',stdout:JSON.stringify([id,{'/data':{}}])}))} as IShellExecutor;
 expect(await resolveStorageImage(s,'image:tag',plan())).toBe(id);expect((s.exec as any).mock.calls).toHaveLength(1);
});

it('ordinary deployment never turns a missing stable volume into a new empty database',async()=>{
  const calls:string[]=[];const s={exec:async(cmd:string)=>{calls.push(cmd);return {exitCode:cmd.startsWith('docker volume inspect')?1:0,stdout:'',stderr:'no such volume'};}} as IShellExecutor;
  await expect(materializeStoragePlan(s,plan())).rejects.toThrow();
  expect(calls.filter(c=>c.startsWith('docker volume create'))).toEqual([]);
});

it('resolves readonly config against the accepted checkout, independent from process cwd', () => {
  const p=profileStoragePlan(entry,profile([{kind:'bind',hostPath:'./config.yml',containerPath:'/etc/myapp/config.yml',readOnly:true}]),config);
  expect(p.mounts[0]).toMatchObject({source:entry.worktreePath+'/config.yml',target:'/etc/myapp/config.yml',readOnly:true});
  expect(renderStoragePlan(p)[0]).toContain('src='+entry.worktreePath+'/config.yml');
});

it('accepts a native Docker 29 image whose Config omits the optional Volumes key', async () => {
  const {resolveStorageImage} = await import('../../src/services/deployment-storage-plan.js');
  const id = 'sha256:'+'d'.repeat(64);
  // Real mycds Docker 29.1.3 returned this template error for cached alpine:3.20.
  // Missing optional metadata means no implicit volumes, not an unavailable image.
  const nativeTemplateError = 'template parsing error: executing "" at <.Config.Volumes>: map has no entry for key "Volumes"';
  const safeQuery = `docker image inspect '${id}' --format '[{{json .Id}},{{json (index .Config "Volumes")}}]'`;
  const s = {exec:vi.fn(async (command:string) => command.includes('.Config.Volumes')
    ? {exitCode:1,stdout:'\n',stderr:nativeTemplateError}
    : command === safeQuery ? {exitCode:0,stdout:JSON.stringify([id,null])+'\n',stderr:''}
      : {exitCode:1,stdout:'',stderr:'Unexpected native image projection'})} as IShellExecutor;
  await expect(resolveStorageImage(s,id,profileStoragePlan(entry,profile(),config))).resolves.toBe(id);
  expect(s.exec).toHaveBeenCalledTimes(1);
});

it('a provisioned native volume without a published birth journal cannot enter runtime',async()=>{
 const v={...native(),Labels:{...storageOwnerLabels(owner),'cds.storage.birth':'b'.repeat(48)}};
 await expect(inspectStoragePlan(shell(v),plan())).rejects.toThrow('storage-birth-unconfirmed');
});
it.each(['nonce','daemon','mountpoint','createdAt','daemon-after'])('runtime rechecks actual published birth fingerprint: %s',async drift=>{
 const v={...native(),CreatedAt:'2026-10-22T00:00:00Z',Labels:{...storageOwnerLabels(owner),'cds.storage.birth':'b'.repeat(48)}};
 const required={[v.Name]:{birthNonce:'b'.repeat(48),daemonId:'owned-daemon',mountpoint:v.Mountpoint,createdAt:v.CreatedAt}};
 if(drift==='nonce')v.Labels['cds.storage.birth']='c'.repeat(48);
 if(drift==='mountpoint')v.Mountpoint='/other/volumes/'+v.Name+'/_data';
 if(drift==='createdAt')v.CreatedAt='2026-10-22T01:00:00Z';
 let reads=0;const s={exec:vi.fn(async(c:string)=>c.startsWith('docker info')?{exitCode:0,stdout:drift==='daemon'||drift==='daemon-after'&&++reads>1?'foreign-daemon':'owned-daemon',stderr:''}:{exitCode:0,stdout:JSON.stringify([v]),stderr:''})} as IShellExecutor;
 await expect((inspectStoragePlan as any)(s,plan(),false,required)).rejects.toThrow('storage-birth-unconfirmed');
 expect((s.exec as any).mock.calls.every(([c]:[string])=>c.startsWith('docker volume inspect')||c.startsWith('docker info'))).toBe(true);
});
it('published exact birth is accepted read-only on its original daemon',async()=>{
 const v={...native(),CreatedAt:'2026-10-22T00:00:00Z',Labels:{...storageOwnerLabels(owner),'cds.storage.birth':'b'.repeat(48)}};
 const required={[v.Name]:{birthNonce:'b'.repeat(48),daemonId:'owned-daemon',mountpoint:v.Mountpoint,createdAt:v.CreatedAt}};
 const s={exec:vi.fn(async(c:string)=>c.startsWith('docker info')?{exitCode:0,stdout:'owned-daemon',stderr:''}:{exitCode:0,stdout:JSON.stringify([v]),stderr:''})} as IShellExecutor;
 await expect((inspectStoragePlan as any)(s,plan(),false,required)).resolves.toBeUndefined();
});
