import { createHash,randomBytes } from 'node:crypto';
import path from 'node:path';
import type { CdsConfig,InfraService,IShellExecutor,StorageBinding } from '../types.js';
import { infraStoragePlan,renderStoragePlan,stableStorageVolumeName,storageOwnerLabels,type DeploymentStoragePlan } from './deployment-storage-plan.js';

export interface StorageBirth {
  version:1; name:string; binding:StorageBinding; operationId:string; birthNonce:string;
  daemonId:string; planDigest:string; serviceDigest:string; seq:number;
  stage:'intent'|'issued'|'confirmed'|'published'|'held'; createIssued:boolean;
  createdAt:string; updatedAt:string;
  observation?:{name:string;mountpoint:string;createdAt:string;labels:Record<string,string>};
}
export interface StorageProvisionStore {
  getInfraServiceForProjectAndId(projectId:string,id:string):InfraService|undefined;
  getStorageBirth(name:string):StorageBirth|undefined;
  getStorageBirthsForService(projectId:string,serviceId:string):StorageBirth[];
  writeStorageBirthDurably(row:StorageBirth,expectedSeq:number|undefined,assertCurrent:()=>void):Promise<void>;
  /** Must publish privately until the confirmed birth and configuration ACK together. */
  publishProvisionedInfraDurably(service:InfraService,names:string[],operationId:string,assertCurrent:()=>void):Promise<void>;
}
const locks=new WeakMap<StorageProvisionStore,Set<string>>();
const quote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,stable(v[k])])):v;
export const storageProvisionDigest=(v:unknown)=>createHash('sha256').update(JSON.stringify(stable(v)) ?? 'undefined').digest('hex');
const digest=storageProvisionDigest;
const safe=(s:unknown):s is string=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(s);
const reject=()=>new Error('storage_provision_unconfirmed');

/** Explicit fresh-resource P. Runtime materialization never calls this allocator. */
export class StorageProvisionService {
  constructor(private readonly store:StorageProvisionStore,private readonly shell:IShellExecutor,private readonly config:Pick<CdsConfig,'repoRoot'|'storageInstanceId'>) {}

  async provisionNewInfra(input:InfraService,inputPlan:DeploymentStoragePlan,operationId:string,assertCurrent:()=>void):Promise<void> {
    const service=structuredClone(input),plan=structuredClone(inputPlan);
    const key=JSON.stringify([service.projectId,service.id]);
    const active=locks.get(this.store)||new Set<string>();locks.set(this.store,active);
    if(active.has(key))throw reject();active.add(key);
    const originalDigest=digest(service),deadline=Date.now()+90_000;
    const births:StorageBirth[]=[];
    const fence=()=>{assertCurrent();if(Date.now()>=deadline||this.store.getInfraServiceForProjectAndId(service.projectId,service.id)||digest(service)!==originalDigest)throw reject()};
    const exec=async(command:string,write=false)=>{fence();const remaining=deadline-Date.now();if(remaining<=0)throw reject();const r=await this.shell.exec(command,{timeout:Math.min(30_000,remaining),executionLane:write?'operation':'observation',beforeStart:fence});fence();return r};
    const daemon=async()=>{const r=await exec("docker info --format '{{.ID}}'");if(r.exitCode!==0||!safe(r.stdout.trim()))throw reject();return r.stdout.trim()};
    try {
      renderStoragePlan(plan);fence();
      if(!safe(service.projectId)||!safe(service.id)||!safe(operationId)||service.status!=='stopped'||service.scope!=='project')throw reject();
      const targets=plan.mounts.filter(m=>m.kind==='volume');
      if(!targets.length||targets.length>8||targets.some(m=>!m.storage||m.storage.projectId!==service.projectId||m.storage.serviceId!==service.id||m.storage.scope!=='project-shared'||m.storage.branchId||m.source!==stableStorageVolumeName(m.storage)))throw reject();
      if(this.store.getStorageBirthsForService(service.projectId,service.id).length||targets.some(m=>this.store.getStorageBirth(m.source)))throw reject();
      if(infraStoragePlan(service,this.config).digest!==plan.digest)throw reject();
      const daemonId=await daemon();
      for(const mount of targets) {
        const now=new Date().toISOString();let row:StorageBirth={version:1,name:mount.source,binding:structuredClone(mount.storage!),operationId,birthNonce:randomBytes(24).toString('hex'),daemonId,planDigest:plan.digest,serviceDigest:originalDigest,seq:1,stage:'intent',createIssued:false,createdAt:now,updatedAt:now};
        births.push(row);
        await this.store.writeStorageBirthDurably(row,undefined,fence);fence();
        const absent=await exec('docker volume inspect '+quote(row.name));
        const notFound=['Error response from daemon: get '+row.name+': no such volume','Error response from daemon: No such volume: '+row.name,'Error: No such volume: '+row.name];
        // Docker CLI emits [] on stdout for a named inspect miss. Only that empty result
        // plus the exact daemon absence error is authoritative; [] alone is not absence.
        if(absent.exitCode!==1||!['','[]'].includes(absent.stdout.trim())||!notFound.includes(absent.stderr.trim()))throw reject();
        row={...row,seq:row.seq+1,stage:'issued',createIssued:true,updatedAt:new Date().toISOString()};births[births.length-1]=row;
        await this.store.writeStorageBirthDurably(row,row.seq-1,fence);fence();if(await daemon()!==daemonId)throw reject();
        const labels={...storageOwnerLabels(row.binding),'cds.storage.birth':row.birthNonce};
        const made=await exec('docker volume create --driver local '+Object.entries(labels).map(([k,v])=>'--label '+quote(k+'='+v)).join(' ')+' '+quote(row.name),true);
        if(made.exitCode!==0||made.stdout.trim()!==row.name)throw reject();
        const inspected=await exec('docker volume inspect '+quote(row.name));if(inspected.exitCode!==0)throw reject();
        let parsed:any;try{parsed=JSON.parse(inspected.stdout)}catch{throw reject()}
        if(!Array.isArray(parsed)||parsed.length!==1)throw reject();const v=parsed[0];
        if(v.Name!==row.name||v.Driver!=='local'||(v.Options!==null&&(!v.Options||typeof v.Options!=='object'||Array.isArray(v.Options)||Object.keys(v.Options).length))
          ||typeof v.Mountpoint!=='string'||!path.posix.isAbsolute(v.Mountpoint)||path.posix.normalize(v.Mountpoint)!==v.Mountpoint||v.Mountpoint.split('/').includes('.deployment-sources')
          ||!v.Mountpoint.endsWith('/'+row.name+'/_data')||!Number.isFinite(Date.parse(v.CreatedAt))
          ||Object.entries(labels).some(([k,value])=>!Object.hasOwn(v.Labels||{},k)||v.Labels[k]!==value))throw reject();
        if(await daemon()!==daemonId)throw reject();
        row={...row,seq:row.seq+1,stage:'confirmed',updatedAt:new Date().toISOString(),observation:{name:v.Name,mountpoint:v.Mountpoint,createdAt:v.CreatedAt,labels:structuredClone(v.Labels)}};births[births.length-1]=row;
        await this.store.writeStorageBirthDurably(row,row.seq-1,fence);fence();
      }
      if(await daemon()!==daemonId)throw reject();
      await this.store.publishProvisionedInfraDurably(service,births.map(x=>x.name),operationId,()=>{assertCurrent();if(Date.now()>=deadline)throw reject()});
    } catch {
      // Never delete or create again on uncertain ACK/Daemon results. Keep the original nonce.
      for(const row of births){const current=this.store.getStorageBirth(row.name);if(current?.operationId!==operationId||current.birthNonce!==row.birthNonce||current.stage==='published')continue;
        try{await this.store.writeStorageBirthDurably({...current,seq:current.seq+1,stage:'held',updatedAt:new Date().toISOString()},current.seq,assertCurrent)}catch{/* Original intent/issued record remains authoritative. */}}
      throw reject();
    } finally {active.delete(key)}
  }
}
