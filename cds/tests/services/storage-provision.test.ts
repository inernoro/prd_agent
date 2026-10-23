import { describe,it,expect,vi } from 'vitest';
import { StorageProvisionService,type StorageBirth,type StorageProvisionStore } from '../../src/services/storage-provision.js';
import { infraStoragePlan,stableStorageVolumeName,storageOwnerLabels } from '../../src/services/deployment-storage-plan.js';
import type { InfraService,IShellExecutor,StorageBinding } from '../../src/types.js';

function fixture() {
  const binding:StorageBinding={version:1,instanceId:'own',projectId:'p',scope:'project-shared',serviceId:'mysql',mountKey:'data',purpose:'persistent'};
  const name=stableStorageVolumeName(binding),rows=new Map<string,StorageBirth>(),events:string[]=[];
  let published:InfraService|undefined,volume:any,failStage:string|undefined,foreign=false,unknown=false,daemon='owned-daemon',afterCreateDaemon=false,absentStdout='',absentExit=1;
  const service:InfraService={id:'mysql',projectId:'p',scope:'project',name:'own',dockerImage:'mysql:8.0',containerPort:3306,hostPort:13306,containerName:'own-mysql',status:'stopped',env:{MYSQL_ROOT_PASSWORD:'not-output'},volumes:[{type:'volume',name,containerPath:'/var/lib/mysql',storage:binding}]};
  const plan=infraStoragePlan(service,{storageInstanceId:'own',repoRoot:'/owned'});
  const store:StorageProvisionStore={
    getInfraServiceForProjectAndId:()=>published,
    getStorageBirth:key=>rows.get(key),
    getStorageBirthsForService:(p,s)=>[...rows.values()].filter(x=>x.binding.projectId===p&&x.binding.serviceId===s),
    writeStorageBirthDurably:async(row,expected,fence)=>{fence();expect(rows.get(row.name)?.seq).toBe(expected);events.push('ack:'+row.stage);if(failStage===row.stage)throw Error('own-ack-failed');rows.set(row.name,structuredClone(row));fence()},
    publishProvisionedInfraDurably:async(value,births,operation,fence)=>{fence();expect(births.every(n=>rows.get(n)?.stage==='confirmed'&&rows.get(n)?.operationId===operation)).toBe(true);events.push('publish');if(failStage==='publish')throw Error('own-publish-failed');published=structuredClone(value);for(const n of births)rows.set(n,{...rows.get(n)!,stage:'published',seq:rows.get(n)!.seq+1});fence()},
  };
  const shell:IShellExecutor={exec:vi.fn(async(command:string)=>{
    events.push(command);
    if(command==="docker info --format '{{.ID}}'")return {stdout:daemon,stderr:'',exitCode:0};
    if(command.startsWith('docker volume inspect ')) {
      if(unknown)return {stdout:'',stderr:'daemon unavailable',exitCode:1};
      return volume?{stdout:JSON.stringify([volume]),stderr:'',exitCode:0}:{stdout:absentStdout,stderr:'Error response from daemon: get '+name+': no such volume',exitCode:absentExit};
    }
    if(command.startsWith('docker volume create ')){
      const birth=rows.get(name)!;expect(birth.stage).toBe('issued');
      volume={Name:name,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+name+'/_data',CreatedAt:'2026-10-22T00:00:00Z',Labels:{...storageOwnerLabels(binding),'cds.storage.birth':foreign?'foreign':birth.birthNonce}};
      if(afterCreateDaemon)daemon='other-daemon';
      return {stdout:name,stderr:'',exitCode:0};
    }
    throw Error('unexpected owned command');
  })} as IShellExecutor;
  return {service,plan,binding,name,rows,events,store,shell,allocator:new StorageProvisionService(store,shell,{repoRoot:'/owned',storageInstanceId:'own'}),volume:(x:any)=>{volume=x},fail:(s:string)=>{failStage=s},foreign:()=>{foreign=true},unknown:()=>{unknown=true},daemonChange:()=>{afterCreateDaemon=true},published:()=>published,absentStdout:(v:string)=>{absentStdout=v},absentExit:(v:number)=>{absentExit=v}};
}

describe('explicit new-only storage birth',()=>{
  it('ACKs intent and issued before one native create, confirms birth before private service publication',async()=>{
    const f=fixture();await f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{});
    expect(f.events.indexOf('ack:intent')).toBeLessThan(f.events.indexOf('ack:issued'));
    const creates=f.events.filter(x=>x.startsWith('docker volume create '));expect(creates).toHaveLength(1);
    expect(f.events.indexOf('ack:issued')).toBeLessThan(f.events.indexOf(creates[0]));expect(f.events.indexOf('ack:confirmed')).toBeLessThan(f.events.indexOf('publish'));
    expect(f.rows.get(f.name)?.stage).toBe('published');expect(f.published()?.id).toBe('mysql');expect(f.events.some(x=>/docker (run|start|rm)/.test(x))).toBe(false);
    await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_second',()=>{})).rejects.toThrow('storage_provision');expect(f.events.filter(x=>x.startsWith('docker volume create '))).toHaveLength(1);
  });
  it('accepts Docker inspect empty JSON array only together with exact named-volume absence',async()=>{
    const f=fixture();f.absentStdout('[]\n');await f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{});
    expect(f.published()?.id).toBe('mysql');expect(f.events.filter(x=>x.startsWith('docker volume create '))).toHaveLength(1);
  });
  it.each(['[{}]','null','[invalid]'])('rejects nonempty or unknown inspect output %s despite named absence',async output=>{
    const f=fixture();f.absentStdout(output);await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');
    expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);
  });
  it.each([2,124,130,-1])('exit code %s cannot certify absence even with otherwise matching missing-volume output',async code=>{
    const f=fixture();f.absentStdout('[]\n');f.absentExit(code);
    await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');
    expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);expect(f.published()).toBeUndefined();
  });
  it.each(['intent','issued'])('failed %s ACK cannot create any native volume or publish service',async stage=>{
    const f=fixture();f.fail(stage);await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');
    expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);expect(f.published()).toBeUndefined();
  });
  it.each(['confirmed','publish'])('failed %s keeps original native birth and never recreates it',async stage=>{
    const f=fixture();f.fail(stage);await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');expect(f.published()).toBeUndefined();
    await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_new',()=>{})).rejects.toThrow('storage_provision');expect(f.events.filter(x=>x.startsWith('docker volume create '))).toHaveLength(1);expect(f.events.some(x=>x.includes('volume rm'))).toBe(false);
  });
  it('changing a failed service mount key cannot authorize a second empty birth',async()=>{
    const f=fixture();f.fail('publish');await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_one',()=>{})).rejects.toThrow('storage_provision');
    const b={...f.binding,mountKey:'replacement'},s={...f.service,volumes:[{type:'volume' as const,name:stableStorageVolumeName(b),containerPath:'/var/lib/mysql',storage:b}]};
    await expect(f.allocator.provisionNewInfra(s,infraStoragePlan(s,{storageInstanceId:'own',repoRoot:'/owned'}),'op_two',()=>{})).rejects.toThrow('storage_provision');expect(f.events.filter(x=>x.startsWith('docker volume create '))).toHaveLength(1);
  });
  it('a plan different from the frozen service cannot publish an unplanned mount',async()=>{
    const f=fixture();f.service.volumes![0].name='foreign';await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);
  });
  it('foreign same-name race cannot be confirmed, adopted, removed or published',async()=>{
    const f=fixture();f.foreign();await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');expect(f.published()).toBeUndefined();expect(f.events.some(x=>x.includes('volume rm'))).toBe(false);
  });
  it('unknown inspect never authorizes an empty allocation',async()=>{
    const f=fixture();f.unknown();await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);
  });
  it('existing correctly labeled volume without this birth nonce is never adopted',async()=>{
    const f=fixture();f.volume({Name:f.name,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+f.name+'/_data',Labels:storageOwnerLabels(f.binding)});
    await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);
  });
  it('changed daemon after native creation cannot publish or create a second volume',async()=>{
    const f=fixture();f.daemonChange();await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{})).rejects.toThrow('storage_provision');expect(f.published()).toBeUndefined();expect(f.events.filter(x=>x.startsWith('docker volume create '))).toHaveLength(1);
  });
  it.each(['/config/mysql.cnf','config/mysql.cnf'])('readonly user config %s refuses before allocating otherwise valid persistent storage',async name=>{
    const f=fixture();f.service.volumes!.push({type:'bind',name,containerPath:'/etc/mysql/conf.d/own.cnf',readOnly:true});
    expect(()=>infraStoragePlan(f.service,{storageInstanceId:'own',repoRoot:'/owned'})).toThrow('storage-bind-pin-required');
    expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);expect(f.published()).toBeUndefined();
  });
  it('same binding concurrent requests have one issued native create',async()=>{
    const f=fixture();const results=await Promise.allSettled([f.allocator.provisionNewInfra(f.service,f.plan,'op_one',()=>{}),f.allocator.provisionNewInfra(f.service,f.plan,'op_two',()=>{})]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(f.events.filter(x=>x.startsWith('docker volume create '))).toHaveLength(1);
  });
});

it('rechecks the original owner at the real operation slot before any volume create',async()=>{
 const f=fixture(),original=f.shell.exec.bind(f.shell);let current=true,createdAfterRevocation=false,createHadFence=false;
 vi.spyOn(f.shell,'exec').mockImplementation(async(command,options)=>{
  if(command.startsWith('docker volume create ')){
   current=false;createHadFence=typeof options?.beforeStart==='function';
   options?.beforeStart?.();
   createdAfterRevocation=true;
  }
  return original(command,options);
 });
 await expect(f.allocator.provisionNewInfra(f.service,f.plan,'op_owned',()=>{if(!current)throw Error('owner revoked')})).rejects.toThrow('storage_provision');
 expect(createHadFence).toBe(true);expect(createdAfterRevocation).toBe(false);
 expect(f.rows.get(f.name)).toMatchObject({stage:'issued',createIssued:true,operationId:'op_owned'});
 expect(f.published()).toBeUndefined();expect(f.events.some(x=>x.startsWith('docker volume create '))).toBe(false);
});
