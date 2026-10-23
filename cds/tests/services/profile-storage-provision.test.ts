import {it,expect} from 'vitest';
import {ProfileStorageProvisionService,profileStorageBranchIdentity,profileStorageDeclarationDigest,profileStorageTargetKey,type ProfileStorageTarget,type ProfileStorageBinding} from '../../src/services/profile-storage-provision.js';
import {storageOwnerLabels} from '../../src/services/deployment-storage-plan.js';
import type {StorageBirth} from '../../src/services/storage-provision.js';
function fixture(){
 const rows=new Map<string,StorageBirth>(),published=new Map<string,ProfileStorageBinding>(),volumes=new Map<string,any>(),commands:string[]=[];
 const entry=(id:string)=>({id,projectId:'p',branch:id,createdAt:'2026-10-23',worktreePath:'/own/'+id,services:{},status:'idle' as const});
 const profile={id:'app',projectId:'p',name:'app',workDir:'.',dockerImage:'fixture:image',prebuiltImage:true,containerPort:8080};let fail='',revoked=false,history=false,foreign=false;
 const target=(id:string):ProfileStorageTarget=>({kind:'profile',projectId:'p',branchId:id,serviceId:'app'});
 const store={getProfileStorageDeclaration:(t:ProfileStorageTarget)=>({branchIdentity:profileStorageBranchIdentity(entry(t.branchId)),declarationDigest:profileStorageDeclarationDigest(profile)}),assertFreshProfileStorageTarget:()=>{if(history)throw Error('old target')},getProfileStorageBinding:(t:ProfileStorageTarget)=>published.get(profileStorageTargetKey(t)),getProfileStorageBirths:(t:ProfileStorageTarget)=>[...rows.values()].filter(r=>r.binding.projectId===t.projectId&&r.binding.branchId===t.branchId&&r.binding.serviceId===t.serviceId),getStorageBirth:(n:string)=>rows.get(n),writeStorageBirthDurably:async(r:StorageBirth,seq:number|undefined,fence:()=>void)=>{fence();expect(rows.get(r.name)?.seq).toBe(seq);if(fail===r.stage)throw Error('ACK failed');rows.set(r.name,structuredClone(r));fence()},publishProfileStorageDurably:async(row:ProfileStorageBinding,fence:()=>void)=>{fence();if(fail==='publish')throw Error('public ACK failed');published.set(profileStorageTargetKey(row.target),structuredClone(row));for(const n of row.names){const r=rows.get(n)!;rows.set(n,{...r,stage:'published',seq:r.seq+1})}}};
 const shell={exec:async(c:string,o?:any)=>{commands.push(c);if(c.startsWith('docker volume create')&&fail==='queue')revoked=true;o?.beforeStart?.();if(c.startsWith('docker info'))return{exitCode:0,stdout:'own-daemon',stderr:''};const n=c.match(/'([^']+)'$/)?.[1]!;if(c.startsWith('docker volume inspect'))return volumes.has(n)?{exitCode:0,stdout:JSON.stringify([volumes.get(n)]),stderr:''}:{exitCode:1,stdout:'[]',stderr:'Error response from daemon: get '+n+': no such volume'};if(c.startsWith('docker volume create')){const r=rows.get(n)!;volumes.set(n,{Name:n,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+n+'/_data',CreatedAt:'2026-10-23',Labels:{...storageOwnerLabels(r.binding),'cds.storage.birth':foreign?'foreign':r.birthNonce}});return{exitCode:0,stdout:n,stderr:''}}throw Error('unexpected command')}};
 const service=new ProfileStorageProvisionService(store,shell,{repoRoot:'/own',storageInstanceId:'own'}),mounts=[{mountKey:'data',containerPath:'/data',purpose:'persistent' as const}];
 const run=(id='a',p:any=profile,requested=mounts)=>service.provisionNewProfile(entry(id),p,requested,'op_'+id,()=>{if(revoked)throw Error('owner revoked')});return{run,rows,published,volumes,commands,profile,fail:(x:string)=>fail=x,history:()=>history=true,foreign:()=>foreign=true};
}
it('two branch-private wrappers execute the same native birth kernel with different names and unchanged baseline',async()=>{const f=fixture();const [a,b]=await Promise.all([f.run('a'),f.run('b')]);expect(a.names[0]).not.toBe(b.names[0]);expect(f.volumes.size).toBe(2);expect(f.profile).not.toHaveProperty('cacheMounts');expect([...f.rows.values()].every(r=>r.stage==='published'&&r.target?.kind==='profile')).toBe(true)});
it.each(['intent','issued','confirmed','publish'])('failed %s cannot publish or authorize a second create',async stage=>{const f=fixture();f.fail(stage);await expect(f.run()).rejects.toThrow();expect(f.published.size).toBe(0);const count=f.volumes.size;await expect(f.run()).rejects.toThrow();expect(f.volumes.size).toBe(count);expect(f.commands.some(c=>c.includes('volume rm'))).toBe(false)});
it('revocation in the real operation slot executes no native create and keeps original issued nonce',async()=>{const f=fixture();f.fail('queue');await expect(f.run()).rejects.toThrow('owner revoked');expect(f.volumes.size).toBe(0);expect([...f.rows.values()].map(r=>r.stage)).toEqual(['issued'])});
it('foreign race is not adopted, removed or published',async()=>{const f=fixture();f.foreign();await expect(f.run()).rejects.toThrow();expect(f.volumes.size).toBe(1);expect(f.published.size).toBe(0);const nonce=[...f.rows.values()][0].birthNonce;await expect(f.run()).rejects.toThrow();expect([...f.rows.values()][0].birthNonce).toBe(nonce);expect(f.volumes.size).toBe(1)});
it('a stopped or failed old resource target cannot be treated as a fresh scope',async()=>{const f=fixture();f.history();await expect(f.run()).rejects.toThrow();expect(f.commands).toHaveLength(0)});
it('fresh destination never overwrites a declared physical mount',async()=>{const f=fixture();await expect(f.run('a',{...f.profile,cacheMounts:[{kind:'volume',hostPath:'old-data',containerPath:'/data'}]})).rejects.toThrow();expect(f.commands).toHaveLength(0)});

it.each(['/tmp','/app'])('fresh mount cannot hide reserved runtime/source target %s',async containerPath=>{const f=fixture();await expect(f.run('a',{...f.profile,prebuiltImage:false},[{mountKey:'fresh',containerPath,purpose:'persistent'}])).rejects.toThrow();expect(f.commands).toHaveLength(0)});

// V122: P must reject the same source overlap that runtime would reject, before ANY birth.
it.each([
 ['/app','/app/data'], // mount is below writable source workspace
 ['/app/component','/app'], // mount is above writable source workspace
 ['/app','/app'], // equal destination (also rejected by plan sealing)
 ['/app','/.__cds_source_ro/cache'], // fixed source staging subtree
 ['/tmp/app','/data'], // runtime tmpfs is an ancestor of source workspace
])('source P refuses workspace %s versus mount %s before physical or durable work',async(workspace,containerPath)=>{
 const f=fixture();Object.assign(f.profile,{prebuiltImage:false,containerWorkDir:workspace});
 await expect(f.run('a',f.profile,[{mountKey:'fresh',containerPath,purpose:'persistent'}])).rejects.toThrow();
 expect(f.commands).toEqual([]);expect(f.rows.size).toBe(0);expect(f.volumes.size).toBe(0);expect(f.published.size).toBe(0);
});
it.each(['source-disjoint','prebuilt-source-free','managed-source-free'])('safe Profile P still allocates: %s',async kind=>{
 const f=fixture();Object.assign(f.profile,{prebuiltImage:kind==='prebuilt-source-free',containerWorkDir:'/app',...(kind==='managed-source-free'?{managedBuild:{strategy:'fixture'}}:{})});
 const containerPath=kind==='source-disjoint'?'/data':'/app/data';
 const accepted=await f.run('a',f.profile,[{mountKey:'fresh',containerPath,purpose:'persistent'}]);
 expect(accepted.names).toHaveLength(1);expect(f.volumes.size).toBe(1);expect(f.published.size).toBe(1);
});
