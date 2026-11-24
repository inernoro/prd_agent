import { expect, it } from 'vitest';
import {planFreshCatalogInfra,assertFreshLegacyVolumesAbsent} from '../../src/services/fresh-catalog-storage-plan.js';
import type {InfraService,IShellExecutor} from '../../src/types.js';
const config={repoRoot:'/owned/repo',storageInstanceId:'owned-instance'};
const service=():InfraService=>({id:'db',projectId:'p',name:'db',dockerImage:'mysql:8',containerName:'owned-db',containerPort:3306,hostPort:13306,env:{},volumes:[{type:'volume',name:'original-data',containerPath:'/var/lib/mysql'}],status:'stopped',createdAt:'2026-10-23'});
it('explicit fresh allocation preserves the original declaration and never reuses its physical name',()=>{
 const original=service(),before=structuredClone(original);const p=planFreshCatalogInfra(original,config,true);expect(original).toEqual(before);expect(p.provision).toBe(true);expect(p.legacyNames).toEqual(['original-data']);expect(p.service.volumes[0]).toMatchObject({type:'volume',containerPath:'/var/lib/mysql',storage:{instanceId:'owned-instance',projectId:'p',scope:'project-shared',serviceId:'db',purpose:'persistent'}});expect(p.service.volumes[0].name).not.toBe('original-data');
});
it.each([false,true])('new stateful declaration without explicit fresh allocation is rejected, volume omitted=%s',omitted=>{
 const original=service();if(omitted)original.volumes=[];expect(()=>planFreshCatalogInfra(original,config,false)).toThrow();
});
it.each(['bind','readonly','unexpected-target','duplicate-target','unknown-image','foreign-binding','unknown-type'] as const)('unsafe declaration is refused before native allocation: %s',kind=>{
 const original=service();
 if(kind==='bind')original.volumes[0].type='bind';
 if(kind==='unknown-type')(original.volumes[0] as any).type='invalid';
 if(kind==='readonly')original.volumes[0].readOnly=true;
 if(kind==='unexpected-target')original.volumes[0].containerPath='/host-data';
 if(kind==='duplicate-target')original.volumes.push({...original.volumes[0],name:'second-data'});
 if(kind==='unknown-image')original.dockerImage='unknown/private:latest';
 if(kind==='foreign-binding')original.volumes[0].storage={version:1,instanceId:'foreign',projectId:'foreign',serviceId:'db',scope:'project-shared',purpose:'persistent',mountKey:'data'};
 expect(()=>planFreshCatalogInfra(original,config,true)).toThrow();
});
it('Mongo fresh plan covers both declared data directories and keeps data first',()=>{
 const original=service();original.dockerImage='mongo:7';original.volumes=[{type:'volume',name:'mongo-original',containerPath:'/data/db'}];const p=planFreshCatalogInfra(original,config,true);expect(p.service.volumes.map(v=>v.containerPath)).toEqual(['/data/db','/data/configdb']);expect(p.service.volumes.map(v=>v.storage?.mountKey)).toEqual(['data','data-2']);
});
it.each(['Error: No such volume: original-data','Error response from daemon: No such volume: original-data','Error response from daemon: get original-data: no such volume'])('only precise native absence allows replacing a legacy declaration: %s',stderr=>{
 const p=planFreshCatalogInfra(service(),config,true),commands:string[]=[];
 const shell:IShellExecutor={exec:async c=>{commands.push(c);return c.startsWith('docker info')?{exitCode:0,stdout:'owned-daemon',stderr:''}:{exitCode:1,stdout:'[]',stderr};}};
 return assertFreshLegacyVolumesAbsent([p],shell,()=>{}).then(()=>{expect(commands).toHaveLength(3);expect(commands.every(c=>c.startsWith('docker info')||c.startsWith('docker volume inspect'))).toBe(true);});
});
it.each(['exists','unknown','wrong-name','changed-daemon','revoked'] as const)('unknown or revoked native absence is refused: %s',kind=>{
 const p=planFreshCatalogInfra(service(),config,true);let reads=0,current=true;
 const shell:IShellExecutor={exec:async(c,o)=>{o?.beforeStart?.();if(c.startsWith('docker info'))return{exitCode:0,stdout:kind==='changed-daemon'&&reads++?'other-daemon':'owned-daemon',stderr:''};if(kind==='revoked')current=false;return{exitCode:kind==='exists'?0:1,stdout:kind==='exists'?'[{"Name":"original-data"}]':'[]',stderr:kind==='unknown'?'request timed out':`Error: No such volume: ${kind==='wrong-name'?'other-volume':'original-data'}`};}};
 return expect(assertFreshLegacyVolumesAbsent([p],shell,()=>{if(!current)throw Error('revoked');})).rejects.toThrow();
});
