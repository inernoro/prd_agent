import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { describe,it,expect,vi } from 'vitest';
import { StorageProvisionService,type StorageBirth,type StorageProvisionStore } from '../../src/services/storage-provision.js';
import { infraStoragePlan,stableStorageVolumeName,storageOwnerLabels } from '../../src/services/deployment-storage-plan.js';
import type { InfraService,IShellExecutor,StorageBinding } from '../../src/types.js';

function fixture() {
  const binding:StorageBinding={version:1,instanceId:'own',projectId:'p',scope:'project-shared',serviceId:'mysql',mountKey:'data',purpose:'persistent'};
  const name=stableStorageVolumeName(binding),rows=new Map<string,StorageBirth>(),events:string[]=[];
  let esDrift='',helper:any,helperRemoved=false;
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
    const image='sha256:'+'e'.repeat(64),cid='f'.repeat(64);
    if(command.startsWith('docker image inspect '))return {exitCode:0,stdout:command.includes('json .Config.User')?JSON.stringify(esDrift==='image-user'?'root':'1000:0'):JSON.stringify([image,null]),stderr:''};
    if(command.startsWith('docker create ')){
      const scalar=(v:string)=>v.slice(1,-1).replaceAll("'\\''", "'");
      const program=scalar(command.slice(command.lastIndexOf(" -ceu ")+6));
      const birth=rows.get(name)!;const helperName='cds-storage-init-'+birth.birthNonce;
      helper={Id:cid,Name:'/'+helperName,Image:image,Config:{User:'0:0',Entrypoint:['/bin/sh'],Cmd:['-ceu',program],Labels:{'cds.storage.init.birth':birth.birthNonce,'cds.storage.init.operation':birth.operationId}},State:{Status:'created',Running:false,Pid:0,ExitCode:0},HostConfig:{Privileged:false,NetworkMode:'none',ReadonlyRootfs:true,Memory:command.includes('--memory 64m')?67108864:0,MemorySwap:command.includes('--memory-swap 64m')?67108864:0,PidsLimit:16,RestartPolicy:{Name:'no'},CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}}},Mounts:[{Type:'volume',Name:name,Source:volume.Mountpoint,Destination:'/usr/share/elasticsearch/data',RW:true}]};
      if(esDrift==='caps')helper.HostConfig.CapAdd=['SYS_ADMIN'];if(esDrift==='mount')helper.Mounts[0].Name='foreign';if(esDrift==='image')helper.Image='sha256:'+'a'.repeat(64);if(esDrift==='birth')volume.Labels['cds.storage.birth']='foreign';
      return{exitCode:0,stdout:cid,stderr:''};
    }
    if(command.startsWith('docker inspect '))return helperRemoved?{exitCode:1,stdout:'',stderr:(esDrift==='lowercase-absent'?'error: no such object: ':'Error: No such object: ')+cid}:{exitCode:0,stdout:JSON.stringify([helper]),stderr:''};
    if(command.startsWith('docker start -a ')){helper.State={Status:esDrift==='not-cold'?'running':'exited',Running:esDrift==='not-cold',Pid:esDrift==='not-cold'?123:0,ExitCode:0};return{exitCode:esDrift==='nonempty'?1:0,stdout:'0:0:770',stderr:''};}
    if(command.startsWith('docker stop --time 2 ')){helper.State={Status:'exited',Running:false,Pid:0,ExitCode:137};return{exitCode:0,stdout:cid,stderr:''};}
    if(command.startsWith('docker rm ')){if(esDrift==='cleanup')return{exitCode:1,stdout:'',stderr:'unconfirmed'};helperRemoved=true;return{exitCode:0,stdout:cid,stderr:''};}

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
  return {helperProgram:()=>helper.Config.Cmd[1] as string,esDrift:(v:string)=>{esDrift=v},service,plan,binding,name,rows,events,store,shell,allocator:new StorageProvisionService(store,shell,{repoRoot:'/owned',storageInstanceId:'own'}),volume:(x:any)=>{volume=x},fail:(s:string)=>{failStage=s},foreign:()=>{foreign=true},unknown:()=>{unknown=true},daemonChange:()=>{afterCreateDaemon=true},published:()=>published,absentStdout:(v:string)=>{absentStdout=v},absentExit:(v:number)=>{absentExit=v}};
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

it('fresh Elasticsearch cannot publish a root-owned unwritable directory as usable storage',async()=>{
 const f=fixture();f.service.dockerImage='docker.elastic.co/elasticsearch/elasticsearch:8.11.0';f.service.volumes![0].containerPath='/usr/share/elasticsearch/data';
 const original=f.store.publishProvisionedInfraDurably;
 f.store.publishProvisionedInfraDurably=async(...args)=>{expect(f.events.some(c=>c.startsWith('docker start -a '))).toBe(true);return original(...args);};
 await expect(f.allocator.provisionNewInfra(f.service,infraStoragePlan(f.service,{storageInstanceId:'own',repoRoot:'/owned'}),'es-fresh',()=>{})).resolves.toBeUndefined();
});

it.each(['image-user','caps','mount','image','birth','not-cold','nonempty','cleanup'])('fresh ES initialization %s never publishes or reinitializes an unknown birth',async drift=>{
 const f=fixture();f.service.dockerImage='docker.elastic.co/elasticsearch/elasticsearch:8.11.0';f.service.volumes![0].containerPath='/usr/share/elasticsearch/data';f.esDrift(drift);
 const plan=infraStoragePlan(f.service,{storageInstanceId:'own',repoRoot:'/owned'});
 await expect(f.allocator.provisionNewInfra(f.service,plan,'es-fresh',()=>{})).rejects.toThrow('storage_provision');expect(f.published()).toBeUndefined();
 const row=f.rows.get(f.name)!;expect(row.stage).toBe('held');const before=f.events.length;
 await expect(f.allocator.provisionNewInfra(f.service,plan,'another',()=>{})).rejects.toThrow();expect(f.events).toHaveLength(before);expect(f.rows.get(f.name)?.birthNonce).toBe(row.birthNonce);
 expect(f.events.some(c=>/volume rm|rm -f|chown/.test(c))).toBe(false);
 if(['image-user','caps','mount','image','birth'].includes(drift))expect(f.events.some(c=>c.startsWith('docker start '))).toBe(false);
 if(drift==='not-cold'){expect(f.events).toContain('docker stop --time 2 '+'f'.repeat(64));expect(f.events).toContain('docker rm '+'f'.repeat(64));}
});

it('actual empty-directory program rejects find I/O failure before chmod',async()=>{
 const f=fixture();f.service.dockerImage='docker.elastic.co/elasticsearch/elasticsearch:8.11.0';f.service.volumes![0].containerPath='/usr/share/elasticsearch/data';
 await f.allocator.provisionNewInfra(f.service,infraStoragePlan(f.service,{storageInstanceId:'own',repoRoot:'/owned'}),'es-fresh',()=>{});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'storage-find-failure-')),bin=path.join(root,'bin'),data=path.join(root,'data'),marker=path.join(root,'chmod-called');fs.mkdirSync(bin);fs.mkdirSync(data);
 try{
  fs.writeFileSync(path.join(bin,'find'),'#!/bin/sh\nexit 13\n',{mode:0o755});
  fs.writeFileSync(path.join(bin,'stat'),"#!/bin/sh\nprintf '%s\\n' '0:0:755'\n",{mode:0o755});
  fs.writeFileSync(path.join(bin,'chmod'),`#!/bin/sh\n: > '${marker}'\n`,{mode:0o755});
  const result=spawnSync('/bin/sh',['-c',f.helperProgram().replaceAll('/usr/share/elasticsearch/data',data)],{env:{PATH:bin+':/usr/bin:/bin'},encoding:'utf8'});
  expect(result.status).not.toBe(0);expect(fs.existsSync(marker)).toBe(false);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

it('accepts the actual lowercase exact native missing-helper diagnostic after successful ES init',async()=>{
 const f=fixture();f.service.dockerImage='docker.elastic.co/elasticsearch/elasticsearch:8.11.0';f.service.volumes![0].containerPath='/usr/share/elasticsearch/data';f.esDrift('lowercase-absent');
 await expect(f.allocator.provisionNewInfra(f.service,infraStoragePlan(f.service,{storageInstanceId:'own',repoRoot:'/owned'}),'es-native-missing',()=>{})).resolves.toBeUndefined();expect(f.published()?.id).toBe('mysql');
});
