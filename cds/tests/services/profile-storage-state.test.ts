import {unitBindMountInspector} from '../helpers/storage-bind-fixture.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {StateService} from '../../src/services/state.js';
import {ContainerService} from '../../src/services/container.js';
import {ProfileStorageProvisionService,type ProfileStorageTarget,type FreshProfileMount} from '../../src/services/profile-storage-provision.js';
import {profileStoragePlan,storageOwnerLabels} from '../../src/services/deployment-storage-plan.js';
import type {BuildProfile,BranchEntry,IShellExecutor} from '../../src/types.js';
let root:string,state:StateService;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'cds-profile-birth-'));state=new StateService(path.join(root,'state.json'));state.load();state.addProject({id:'p',slug:'p',name:'own',kind:'git',createdAt:'2026-10-23',updatedAt:'2026-10-23'});});
afterEach(async()=>{vi.restoreAllMocks();await state.flush();fs.rmSync(root,{recursive:true,force:true});});
function own(){
 const profile:BuildProfile={id:'app',projectId:'p',name:'own',dockerImage:'sha256:'+'a'.repeat(64),prebuiltImage:true,localArtifact:true,workDir:'.',containerPort:8080};state.addBuildProfile(profile);
 const entries=['a','b'].map(id=>({id,projectId:'p',branch:id,createdAt:'2026-10-23',worktreePath:path.join(root,id),services:{},status:'idle'} as BranchEntry));for(const b of entries)state.addBranch(b);
 const target=(b:BranchEntry):ProfileStorageTarget=>({kind:'profile',projectId:'p',branchId:b.id,serviceId:'app'});
 const volumes=new Map<string,any>(),commands:string[]=[];
 const shell:IShellExecutor={exec:async(c,o)=>{o?.beforeStart?.();commands.push(c);if(c.startsWith('docker info'))return{exitCode:0,stdout:'own-daemon',stderr:''};if(c.startsWith('docker image inspect'))return{exitCode:0,stdout:JSON.stringify(['sha256:'+'a'.repeat(64),null]),stderr:''};const name=/'([^']+)'$/.exec(c)?.[1]||'';
  if(c.startsWith('docker volume inspect'))return volumes.has(name)?{exitCode:0,stdout:JSON.stringify([volumes.get(name)]),stderr:''}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+name+': no such volume'};
  if(c.startsWith('docker volume create')){const row=state.getStorageBirth(name)!;volumes.set(name,{Name:name,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+name+'/_data',CreatedAt:'2026-10-23T00:00:00Z',Labels:{...storageOwnerLabels(row.binding),'cds.storage.birth':row.birthNonce}});return{exitCode:0,stdout:name,stderr:''}}throw Error('unexpected own command');}};
 const config={repoRoot:root,worktreeBase:root,storageInstanceId:'own',dockerNetwork:'own'} as any;
 const allocator=new ProfileStorageProvisionService(state,shell,config),mount={mountKey:'data',containerPath:'/data',purpose:'persistent' as const};
 const run=(b=entries[0],mounts:FreshProfileMount[]=[mount])=>allocator.provisionNewProfile(b,profile,mounts,'op_'+b.id,()=>{});
 const container=new ContainerService(shell,config,{getDockerNetwork:()=>undefined,storageBirthRequirements:p=>state.storageBirthRequirements(p),resolveProfileStorage:(b,p)=>state.resolvePublishedProfileStorage(b,p)}, undefined, undefined, undefined, unitBindMountInspector);
 return{profile,entries,target,volumes,commands,shell,config,run,container};
}
describe('branch-private P with real State and JSON ACK',()=>{
 it('concurrent branches keep four distinct persistent/cache births, baseline and cold identities',async()=>{
  const f=own(),before=structuredClone(state.getBuildProfilesForProject('p'));
  const mounts=[{mountKey:'data',containerPath:'/data',purpose:'persistent' as const},{mountKey:'cache',containerPath:'/cache',purpose:'cache' as const}];
  const [a,b]=await Promise.all(f.entries.map(e=>f.run(e,mounts)));
  expect(new Set([...a.names,...b.names]).size).toBe(4);expect(f.volumes.size).toBe(4);expect(state.getBuildProfilesForProject('p')).toEqual(before);
  for(const e of f.entries){const p=state.resolvePublishedProfileStorage(e,f.profile);expect(state.resolvePublishedProfileStorage(e,p)).toEqual(p);expect(p.cacheMounts).toHaveLength(2);await expect(f.container.preflightProfileStorage(e,p)).resolves.toBeDefined();}
  const cold=new StateService(path.join(root,'state.json'));cold.load();for(const e of f.entries)expect(cold.resolvePublishedProfileStorage(e,f.profile)).toEqual(state.resolvePublishedProfileStorage(e,f.profile));await cold.flush();
 });
 it.each([4,5])('ACK %s remains private and preserves an independently saved entity',async barrier=>{
  const f=own(),flush=state.flush.bind(state);let calls=0,enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>resume=r);
  vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++calls===barrier){enter();await gate}});
  const run=f.run();void run.catch(()=>{});await entered;
  try{await expect(f.container.preflightProfileStorage(f.entries[0],f.profile)).rejects.toThrow('storage_provision');expect(()=>state.getProfileStorageBinding(f.target(f.entries[0]))).toThrow('storage_provision');state.setCustomEnvVar('OTHER','retained','p');state.save();await flush();}
  finally{resume();await run;}
  const cold=new StateService(path.join(root,'state.json'));cold.load();expect(cold.getCustomEnv('p').OTHER).toBe('retained');expect(cold.getProfileStorageBinding(f.target(f.entries[0]))).toBeDefined();await cold.flush();
 });
 it.each([4,5])('failed publication ACK %s keeps original nonce across retry and cold reopen',async barrier=>{
  const f=own(),flush=state.flush.bind(state);let calls=0;vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++calls===barrier)throw Error('lost own ACK')});
  await expect(f.run()).rejects.toThrow();const original=state.getProfileStorageBirths(f.target(f.entries[0]))[0];expect(original.stage).toBe('held');const before=f.commands.length;
  await expect(f.run()).rejects.toThrow();expect(f.commands).toHaveLength(before);expect(state.getStorageBirth(original.name)?.birthNonce).toBe(original.birthNonce);
  const cold=new StateService(path.join(root,'state.json'));cold.load();expect(()=>cold.resolvePublishedProfileStorage(f.entries[0],f.profile)).toThrow('storage_provision');expect(cold.getStorageBirth(original.name)?.birthNonce).toBe(original.birthNonce);await cold.flush();
 });
 it('published missing volume is held by R with zero allocation',async()=>{const f=own(),row=await f.run();f.volumes.delete(row.names[0]);const creates=f.commands.filter(c=>c.startsWith('docker volume create')).length;await expect(f.container.preflightProfileStorage(f.entries[0],f.profile)).rejects.toThrow('storage-existing-volume-required');expect(f.commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(creates);});
 it('cannot lend branch A physical mounts to branch B',async()=>{const f=own();await Promise.all(f.entries.map(e=>f.run(e)));const a=state.resolvePublishedProfileStorage(f.entries[0],f.profile),before=f.commands.length;await expect(f.container.preflightProfileStorage(f.entries[1],a)).rejects.toThrow('storage_provision');expect(f.commands).toHaveLength(before);});
 it('a retained stopped runtime is never interpreted as fresh first allocation',async()=>{const f=own();f.entries[0].services.app={profileId:'app',containerName:'original',hostPort:1,status:'stopped'};await expect(f.run()).rejects.toThrow();expect(f.commands).toEqual([]);});
 it('duplicate concurrent P cannot create a second nonce or volume',async()=>{const f=own();const results=await Promise.allSettled([f.run(),f.run()]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.volumes.size).toBe(1);expect(f.commands.filter(c=>c.startsWith('docker volume create'))).toHaveLength(1);});
 it('published private storage keeps its branch declaration across direct removal and cold reopen',async()=>{
  const f=own();await f.run();const before=structuredClone(f.entries[0]),row=state.getProfileStorageBinding(f.target(f.entries[0]));
  expect(()=>state.removeBranch(f.entries[0].id)).toThrow('storage_retained_branch_delete_refused');expect(state.getBranch(f.entries[0].id)).toEqual(before);expect(state.getProfileStorageBinding(f.target(f.entries[0]))).toEqual(row);expect(f.volumes.size).toBe(1);
  await state.flush();const cold=new StateService(path.join(root,'state.json'));cold.load();expect(()=>cold.removeBranch(f.entries[0].id)).toThrow('storage_retained_branch_delete_refused');expect(cold.resolvePublishedProfileStorage(f.entries[0],f.profile).cacheMounts).toHaveLength(1);await cold.flush();
 });
 it('held private birth keeps branch and original nonce, while an unrelated empty branch stays removable',async()=>{
  const f=own(),flush=state.flush.bind(state);let n=0;vi.spyOn(state,'flush').mockImplementation(async()=>{await flush();if(++n===3)throw Error('lost original ACK')});await expect(f.run()).rejects.toThrow();
  const row=state.getProfileStorageBirths(f.target(f.entries[0]))[0];expect(row.stage).toBe('held');expect(()=>state.removeBranch(f.entries[0].id)).toThrow('storage_retained_branch_delete_refused');expect(state.getStorageBirth(row.name)?.birthNonce).toBe(row.birthNonce);expect(()=>state.removeBranch(f.entries[1].id)).not.toThrow();expect(state.getBranch(f.entries[1].id)).toBeUndefined();
 });

});

it.each(['delete-base','move-base','move-id','change-mounts','drop-extra','replace-extra','shadow-extra'])('preserves retained private declaration for %s',async kind=>{
 const f=own();if(kind.includes('extra')){state.removeBuildProfile('app');state.setBranchExtraProfiles('a',[f.profile]);}
 await f.run();const before=JSON.stringify(state.getState()),b=state.getBranch('a')!;
 const mutate=()=>{switch(kind){
  case 'delete-base':return state.removeBuildProfile('app');
  case 'move-base':return state.updateBuildProfile('app',{projectId:'elsewhere'});
  case 'move-id':return state.updateBuildProfile('app',{id:'other-id'});
  case 'change-mounts':return state.updateBuildProfile('app',{cacheMounts:[{kind:'volume',hostPath:'different',containerPath:'/data'}]});
  case 'drop-extra':return state.setBranchExtraProfiles('a',[]);
  case 'replace-extra':return state.setBranchExtraProfiles('a',[{...f.profile,cacheMounts:[{kind:'volume',hostPath:'different',containerPath:'/data'}]}]);

  case 'shadow-extra':return state.addBuildProfile({...f.profile,name:'shadow'});
 }};
 expect(mutate).toThrow('storage_retained');expect(JSON.stringify(state.getState())).toBe(before);
 expect(state.resolvePublishedProfileStorage(b,f.profile).cacheMounts).toHaveLength(1);expect(f.volumes.size).toBe(1);
});
it('retained private storage still permits unrelated env and name edits',async()=>{
 const f=own();await f.run();state.updateBuildProfile('app',{name:'renamed',env:{SAFE:'yes'}});state.setBranchProfileOverride('a','app',{env:{SAFE:'branch'}});
 expect(state.resolvePublishedProfileStorage(f.entries[0],{...f.profile,env:{SAFE:'branch'}}).cacheMounts).toHaveLength(1);
});

it('a cold historical orphan cannot freeze an unrelated project profile write',async()=>{
 const f=own();await f.run();const raw=state.getState() as any;raw.buildProfiles=raw.buildProfiles.filter((p:any)=>p.id!=='app');state.save();await state.flush();
 const cold=new StateService(path.join(root,'state.json'));cold.load();cold.addProject({id:'q',slug:'q',name:'other',kind:'git',createdAt:'2026-10-24',updatedAt:'2026-10-24'});
 expect(()=>cold.addBuildProfile({...f.profile,id:'other',projectId:'q'})).not.toThrow();expect(cold.getBuildProfile('other')?.projectId).toBe('q');expect(()=>cold.addBuildProfile({...f.profile})).toThrow('storage_retained');expect(cold.getProfileStorageBirths(f.target(f.entries[0]))).toHaveLength(1);await cold.flush();
});

it.each(['baseline','override','clear'])('retained workspace candidate %s cannot overlap a published private mount',async kind=>{
 const f=own();state.updateBuildProfile('app',{prebuiltImage:false,localArtifact:false,containerWorkDir:'/app'});
 if(kind==='clear'){state.updateBuildProfile('app',{containerWorkDir:'/data'});state.setBranchProfileOverride('a','app',{containerWorkDir:'/app'});}
 const raw=state.getBuildProfilesForProject('p')[0],effective={...raw,containerWorkDir:'/app'};
 await new ProfileStorageProvisionService(state,f.shell,f.config).provisionNewProfile(f.entries[0],effective,[{mountKey:'data',containerPath:'/data',purpose:'persistent'}],'workspace-op',()=>{});
 const before=JSON.stringify(state.getState());
 const change=()=>kind==='baseline'?state.updateBuildProfile('app',{containerWorkDir:'/data'}):kind==='override'?state.setBranchProfileOverride('a','app',{containerWorkDir:'/data'}):state.clearBranchProfileOverride('a','app');
 expect(change).toThrow('storage_retained_profile_mutation_refused');expect(JSON.stringify(state.getState())).toBe(before);
});
it('legal workspace edits retain the original v1 publication digest across cold reopen',async()=>{
 const f=own();state.updateBuildProfile('app',{prebuiltImage:false,localArtifact:false,containerWorkDir:'/app'});
 const row=await new ProfileStorageProvisionService(state,f.shell,f.config).provisionNewProfile(f.entries[0],state.getBuildProfilesForProject('p')[0],[{mountKey:'data',containerPath:'/data',purpose:'persistent'}],'workspace-op',()=>{});
 state.setBranchProfileOverride('a','app',{containerWorkDir:'/safe'});await state.flush();
 const cold=new StateService(path.join(root,'state.json'));cold.load();expect(cold.getProfileStorageBinding(f.target(f.entries[0]))?.declarationDigest).toBe(row.declarationDigest);expect(cold.resolvePublishedProfileStorage(f.entries[0],cold.getBuildProfilesForProject('p')[0]).cacheMounts).toHaveLength(1);await cold.flush();
});
