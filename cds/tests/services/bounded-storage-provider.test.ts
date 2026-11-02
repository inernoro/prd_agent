import { spawnSync } from 'node:child_process';
import { describe,it,expect,vi } from 'vitest';
import { BOUNDED_STORAGE_PROGRAM } from '../../src/services/bounded-storage-program.js';
import { boundedStorageProvider, type BoundedStorageProof } from '../../src/services/bounded-storage-provider.js';
import { allocateStorageBirths, type StorageBirth } from '../../src/services/storage-provision.js';
import { profileStoragePlan,stableStorageVolumeName,inspectStoragePlan,storageOwnerLabels } from '../../src/services/deployment-storage-plan.js';
import type { IShellExecutor,StorageBinding,BuildProfile } from '../../src/types.js';
import {ProfileStorageProvisionService,profileStorageBranchIdentity,profileStorageDeclarationDigest} from '../../src/services/profile-storage-provision.js';

const binding:StorageBinding={version:1,policy:'xxl-task-logs-v1',purpose:'persistent',instanceId:'owned',projectId:'p',scope:'branch-private',branchId:'b',serviceId:'worker',mountKey:'xxl-task-logs'};
const name=stableStorageVolumeName(binding), proof:BoundedStorageProof={version:1,device:'/dev/loop71',receiptSha256:'a'.repeat(64),bytes:134217728,inodes:8192,uuid:'12345678-1234-1234-1234-123456789abc'};
const request={name,binding,birthNonce:'b'.repeat(48),daemonId:'owned-daemon',target:'/data/applogs/xxl-job'};
function fixture() {
 const rows=new Map<string,StorageBirth>(),events:string[]=[],nonce=()=>rows.get(name)!.birthNonce;
 let volume:any,fail='',published=false;
 const profile={id:'worker',prebuiltImage:'owned/image',cacheMounts:[{kind:'volume',hostPath:name,containerPath:request.target,storage:binding}]} as BuildProfile;
 const plan=profileStoragePlan({id:'b',projectId:'p',worktreePath:'/own/source'},profile,{storageInstanceId:'owned'});
 const shell={exec:vi.fn(async (command:string)=>{
  events.push(command);
  if(command.startsWith('docker image inspect '))return{exitCode:0,stdout:JSON.stringify(['sha256:'+'e'.repeat(64),null]),stderr:''};
  if(command==="docker info --format '{{.ID}}'")return{exitCode:0,stdout:'owned-daemon',stderr:''};
  if(command.startsWith('python3 -c '))return fail==='provider'?{exitCode:1,stdout:'',stderr:'root grant denied'}:{exitCode:0,stdout:JSON.stringify(fail==='receipt'&&command.includes("'inspect'")?{...proof,receiptSha256:'c'.repeat(64)}:proof),stderr:''};
  if(command.startsWith('docker volume create ')){
   volume={Name:name,Driver:'local',Options:command.includes("--opt 'device=")?{type:'ext4',device:fail==='options'?'/dev/loop99':proof.device,o:'nodev,nosuid,noexec'}:null,Mountpoint:`/var/lib/docker/volumes/${name}/_data`,CreatedAt:'2026-10-27T10:00:00Z',Labels:{...storageOwnerLabels(binding),'cds.storage.birth':nonce()}};
   return{exitCode:0,stdout:name,stderr:''};
  }
  if(command.startsWith('docker volume inspect '))return volume?{exitCode:0,stdout:JSON.stringify([volume]),stderr:''}:{exitCode:1,stdout:'[]',stderr:'Error: No such volume: '+name};
  throw Error('unexpected command '+command);
 })} as unknown as IShellExecutor;
 const store={getStorageBirth:(n:string)=>rows.get(n),writeStorageBirthDurably:async(row:StorageBirth,seq:number|undefined,fence:()=>void)=>{fence();expect(rows.get(row.name)?.seq).toBe(seq);events.push('ack:'+row.stage);rows.set(row.name,structuredClone(row));}};
 const allocate=()=>allocateStorageBirths({store,shell,plan,newNames:[name],target:{kind:'profile',projectId:'p',branchId:'b',serviceId:'worker'},serviceDigest:'d'.repeat(64),operationId:'owned-op',deadline:Date.now()+30000,assertCurrent:()=>{},publish:async()=>{events.push('publish');published=true;}});
 const requirements=()=>({[name]:{birthNonce:nonce(),daemonId:'owned-daemon',mountpoint:volume.Mountpoint,createdAt:volume.CreatedAt,bounded:rows.get(name)!.observation!.bounded}});
 return{store,rows,events,shell,plan,allocate,requirements,setFail:(v:string)=>fail=v,wasPublished:()=>published,volume:()=>volume};
}

describe('bounded task storage P/R',()=>{
 it('public Profile P wrapper preserves policy and publishes its physically confirmed birth',async()=>{
  const f=fixture(),entry={id:'b',projectId:'p',branch:'own',createdAt:'2026-10-27T10:00:00Z',worktreePath:'/own',services:{},status:'idle' as const};
  const profile={id:'worker',projectId:'p',name:'worker',prebuiltImage:true,dockerImage:'owned:image',containerPort:8080};
  let accepted:any;
  const store={...f.store,getProfileStorageDeclaration:()=>({branchIdentity:profileStorageBranchIdentity(entry),declarationDigest:profileStorageDeclarationDigest(profile)}),getProfileStorageBinding:()=>accepted,getProfileStorageBirths:()=>[...f.rows.values()],assertFreshProfileStorageTarget:()=>{},publishProfileStorageDurably:async(record:any,fence:()=>void)=>{fence();accepted=record;}};
  const service=new ProfileStorageProvisionService(store,f.shell,{repoRoot:'/own',storageInstanceId:'owned'});
  const result=await service.provisionNewProfile(entry,profile,[{mountKey:'xxl-task-logs',containerPath:request.target,purpose:'persistent',policy:'xxl-task-logs-v1'}],'owned-profile',()=>{});
  expect(result.mounts[0].storage?.policy).toBe('xxl-task-logs-v1');expect(f.rows.get(name)?.observation?.bounded).toEqual(proof);expect(accepted).toBeDefined();
 });
 it('durably fences fixed physical P before Docker and preserves the receipt for read-only R',async()=>{
  const f=fixture();await f.allocate();expect(f.wasPublished()).toBe(true);expect(f.rows.get(name)!.observation!.bounded).toEqual(proof);
  const issued=f.events.indexOf('ack:issued'),physical=f.events.findIndex(x=>x.startsWith('python3 -c ')&&x.includes("'create'"));
  expect(physical).toBeGreaterThan(issued);expect(f.events.findIndex(x=>x.startsWith('docker volume create '))).toBeGreaterThan(physical);
  expect(f.events.find(x=>x.startsWith('docker volume create '))).toContain("--opt 'device=/dev/loop71'");
  f.events.length=0;await inspectStoragePlan(f.shell,f.plan,false,f.requirements());
  expect(f.events.some(x=>x.startsWith('python3 -c ')&&x.includes("'inspect'"))).toBe(true);
  expect(f.events.some(x=>x.includes("'create'")||x.startsWith('docker volume create '))).toBe(false);
 });
 it.each(['provider','options','receipt'])('holds %s failure without publication or fallback allocation',async(kind)=>{
  const f=fixture();f.setFail(kind);await expect(f.allocate()).rejects.toThrow();
  expect(f.wasPublished()).toBe(false);expect(f.rows.get(name)?.stage).toBe('held');
  if(kind==='provider')expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);
  expect(f.events.some(x=>/detach|rm |mkfs/.test(x)&&!x.startsWith('python3 -c '))).toBe(false);
 });
 it('rejects absent or altered physical receipt and noncanonical Docker options during R',async()=>{
  const f=fixture();await f.allocate();await expect(inspectStoragePlan(f.shell,f.plan,false,{})).rejects.toThrow();
  f.setFail('receipt');await expect(inspectStoragePlan(f.shell,f.plan,false,f.requirements())).rejects.toThrow();
  f.setFail('');f.volume().Options.o+=' ,rw';await expect(inspectStoragePlan(f.shell,f.plan,false,f.requirements())).rejects.toThrow();
 });
 it('missing bounded volumes remain held even when a caller permits missing ordinary volumes',async()=>{
  const f=fixture();await expect(inspectStoragePlan(f.shell,f.plan,true)).rejects.toThrow('storage-existing-volume-required');
  expect(f.events.some(x=>x.startsWith('docker volume create ')||x.startsWith('python3 -c '))).toBe(false);
 });
 it('rejects unknown policy, purpose, scope or target before native writes; retains stable identity',()=>{
  expect(stableStorageVolumeName({...binding,policy:undefined})).toBe(name);
  for(const change of [{policy:'arbitrary'},{purpose:'cache'},{scope:'project-shared',branchId:undefined}])expect(()=>stableStorageVolumeName({...binding,...change} as StorageBinding)).toThrow();
  expect(()=>profileStoragePlan({id:'b',projectId:'p',worktreePath:'/own'}, {id:'worker',prebuiltImage:'img',cacheMounts:[{kind:'volume',hostPath:name,containerPath:'/wrong',storage:binding}]} as BuildProfile,{storageInstanceId:'owned'})).toThrow();
 });
 it('executes embedded Python rather than undecoded text; nonroot or absent authority fails closed',async()=>{
  const shell={exec:async(command:string)=>{const r=spawnSync('/bin/sh',['-c',command],{encoding:'utf8',timeout:5000});expect(r.stderr).not.toContain('SyntaxError');return{exitCode:r.status??1,stdout:r.stdout,stderr:r.stderr};}} as IShellExecutor;
  await expect(boundedStorageProvider(shell,'inspect',request)).rejects.toThrow('bounded_storage_unconfirmed');
 });
 it('runs Python authority, fresh-only, held reservation and exact recovery red predicates',()=>{
  const harness=String.raw`
import unittest
from unittest.mock import patch
ns={'__name__':'bounded_provider'}
exec(base64.b64decode(sys.argv[1]),ns)
req=json.loads(base64.b64decode(sys.argv[2]))
class Cases(unittest.TestCase):
 def test_request(self):
  self.assertEqual(ns['validate_request'](req),req)
  for field,value in [('target','/'),('daemonId','bad;id'),('name','other'),('birthNonce','x')]:
   r=dict(req);r[field]=value
   with self.assertRaises(RuntimeError):ns['validate_request'](r)
  for field,value in [('policy','other'),('purpose','cache'),('scope','project-shared')]:
   r=dict(req);r['binding']=dict(req['binding']);r['binding'][field]=value
   with self.assertRaises(RuntimeError):ns['validate_request'](r)
 def test_authority(self):
  grant={k:req['binding'][k] for k in ('instanceId','projectId','scope','branchId','serviceId','mountKey')};grant['target']=req['target']
  original=ns['safe_dir'],ns['read_record']
  ns['safe_dir']=lambda p:None;ns['read_record']=lambda p,*limits:{'version':1,'grants':[grant]}
  try:
   ns['authorize'](req)
   for k in grant:
    bad=dict(grant);bad[k]='foreign';ns['read_record']=lambda p,*limits:{'version':1,'grants':[bad]}
    with self.assertRaises(RuntimeError):ns['authorize'](req)
  finally:ns['safe_dir'],ns['read_record']=original
 def test_32_worker_authority_budget(self):
  import tempfile,types
  grant={k:req['binding'][k] for k in ('instanceId','projectId','scope','branchId','serviceId','mountKey')};grant['target']=req['target']
  grants=[{**grant,'branchId':'branch-'+str(n)+'x'*90,'serviceId':'worker-'+'w'*90} for n in range(31)]+[grant]
  raw=json.dumps({'version':1,'grants':grants}).encode();self.assertGreater(len(raw),8192)
  original=ns['safe_dir'],ns['AUTHORITY']
  with tempfile.NamedTemporaryFile() as f:
   f.write(raw);f.flush();ns['AUTHORITY']=f.name;ns['safe_dir']=lambda p:None
   mockstat=types.SimpleNamespace(st_mode=0o100600,st_uid=0,st_nlink=1,st_size=len(raw))
   try:
    with patch.object(os,'fstat',return_value=mockstat):
     ns['authorize'](req)
     with self.assertRaises(RuntimeError):ns['read_record'](f.name)
   finally:ns['safe_dir'],ns['AUTHORITY']=original
 def test_host_disk_only(self):
  original=ns['command'];device=os.stat('/').st_dev
  row={'id':1,'maj:min':str(os.major(device))+':'+str(os.minor(device)),'fsroot':'/','fstype':'ext4','source':'/dev/owned','target':'/'}
  try:
   for kind in ('ext4','xfs'):
    value={**row,'fstype':kind};ns['command']=lambda a:json.dumps({'filesystems':[value]})
    self.assertEqual(ns['host_filesystem']('/'),value)
   for change in ({'fstype':'tmpfs'},{'fstype':'overlay'},{'fsroot':'/foreign'},{'maj:min':'0:0'}):
    value={**row,**change};ns['command']=lambda a:json.dumps({'filesystems':[value]})
    with self.assertRaises(RuntimeError):ns['host_filesystem']('/')
  finally:ns['command']=original
 def test_no_format_existing_or_full_pool(self):
  calls=[];old=ns['command'];ns['command']=lambda a:calls.append(a)
  try:
   with patch.object(os,'listdir',return_value=['pool.json','pool.lock']),patch.object(os.path,'lexists',return_value=True):
    with self.assertRaises(RuntimeError):ns['create'](req)
   reserved=['cds-storage-v1-'+format(n,'064x') for n in range(64)]
   with patch.object(os,'listdir',return_value=['pool.json','pool.lock']+reserved):
    with self.assertRaises(RuntimeError):ns['create'](req)
   self.assertEqual(calls,[])
  finally:ns['command']=old
 def test_R_never_substitutes(self):
  receipt={'version':1,'request':req,'backing':{'device':1,'inode':2},'filesystem':{'uuid':'original','bytes':134217728,'inodes':8192},'loop':{'path':'/dev/loop71','rdev':7}}
  originals={k:ns[k] for k in ('safe_dir','read_record','disk_identity','filesystem','loop_identity','command')}
  ns['safe_dir']=lambda p:None;ns['read_record']=lambda p,*limits:req if p.endswith('/intent.json') else receipt
  ns['disk_identity']=lambda p:receipt['backing'];ns['filesystem']=lambda p:receipt['filesystem'];ns['loop_identity']=lambda *a:receipt['loop']
  ns['command']=lambda *a:(_ for _ in ()).throw(AssertionError('R must not allocate'))
  try:
   self.assertEqual(ns['inspect'](req)['bytes'],134217728)
   for field,replacement in [('disk_identity',{'device':1,'inode':99}),('filesystem',{'uuid':'foreign','bytes':134217728,'inodes':8192}),('loop_identity',{'path':'/dev/loop99','rdev':99})]:
    original=ns[field];ns[field]=lambda *a,v=replacement:v
    with self.assertRaises(RuntimeError):ns['inspect'](req)
    ns[field]=original
   receipt['request']={**req,'birthNonce':'c'*48}
   with self.assertRaises(RuntimeError):ns['inspect'](req)
  finally:ns.update(originals)
unittest.main(argv=['bounded-storage-tests'])
`;
  const r=spawnSync('python3',['-c','import base64,json,os,sys\n'+harness,Buffer.from(BOUNDED_STORAGE_PROGRAM).toString('base64'),Buffer.from(JSON.stringify(request)).toString('base64')],{encoding:'utf8',timeout:10000});
  expect(r.status,r.stderr).toBe(0);expect(r.stderr).toContain('Ran 6 tests');
 });
});
