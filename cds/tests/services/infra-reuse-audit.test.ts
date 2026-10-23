import {unitBindMountInspector} from '../helpers/storage-bind-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig, InfraService } from '../../src/types.js';

const src=readFileSync(new URL('../../src/services/container.ts',import.meta.url),'utf8');
const config={repoRoot:'/repo',worktreeBase:'/wt',masterPort:9900,workerPort:5500,dockerNetwork:'cds-network',portStart:10001,
 sharedEnv:{},jwt:{secret:'owned-fixture',issuer:'cds'}} as CdsConfig;
const service=()=>({id:'mongodb',projectId:'project',name:'MongoDB',dockerImage:'mongo:8.0',containerPort:27017,hostPort:10001,
 containerName:'cds-infra-mongodb',status:'running',volumes:[],env:{MONGO_INITDB_ROOT_USERNAME:'app',MONGO_INITDB_ROOT_PASSWORD:'owned-fixture'},
 createdAt:'2026-08-16T00:00:00Z'} as InfraService);
const bounded={Type:'json-file',Config:{'max-size':'20m','max-file':'2'}};
afterEach(()=>vi.restoreAllMocks());
async function reuse(logConfig:unknown,protectedLabel:string|null='true',failure?:'inspect'|'json') {
 const mock=new MockShellExecutor(),events:any[]=[],warnings:string[]=[];
 vi.spyOn(console,'warn').mockImplementation((...args)=>{warnings.push(args.join(' '));});
 mock.addResponsePattern(/docker network inspect/,()=>({stdout:'',stderr:'',exitCode:0}));
 mock.addResponsePattern(/docker inspect --format=.*State.Status/,()=>({stdout:['a'.repeat(64),'running','/cds-infra-mongodb'].map(x=>JSON.stringify(x)).join('|'),stderr:'',exitCode:0}));
 mock.addResponsePattern(/docker inspect --format=.*LogConfig/,command=>{
  if(failure==='inspect')return {stdout:'',stderr:'private-path-and-secret-fixture',exitCode:124};
  const modern=command[0].includes('{{json .HostConfig.LogConfig');
  return {stdout:failure==='json'?'not-json-private-path-and-secret-fixture':modern?JSON.stringify({logConfig,protected:protectedLabel})
   :String((logConfig as any)?.Config?.['max-size'] || '')+'|'+(protectedLabel || ''),stderr:'',exitCode:0};
 });
 const runtime=new ContainerService(mock,config,undefined,{record:(event:any)=>events.push(event)} as any, undefined, undefined, unitBindMountInspector);
 await runtime.startInfraService(service());
 expect(mock.commands.some(command=>/^docker (rm|create|run|start)\b/.test(command))).toBe(false);
 expect(events.some(event=>event.action==='infra.reuse-running')).toBe(true);
 return {events,warnings,mock};
}
describe('infra reuse actual logging and protection audit',()=>{
 it.each([
  {Type:'local',Config:{'max-size':'50m','max-file':'3'}},
  {Type:'json-file',Config:{'max-size':'50m'}},
  {Type:'json-file',Config:{'max-size':'51m','max-file':'3'}},
 ])('reports unbounded logger without rebuilding existing infra %#',async logConfig=>{
  const f=await reuse(logConfig);const audit=f.events.find(event=>event.action==='infra.protection-audit.missing');
  expect(audit?.details).toMatchObject({missingLogLimit:true,missingProtectedLabel:false});
 });
 it('accepts a tighter bounded logger and protected label',async()=>{
  const f=await reuse(bounded);expect(f.events.filter(event=>event.action.startsWith('infra.protection-audit.'))).toEqual([]);
 });
 it('reports a missing protected label independently from a valid log policy',async()=>{
  const f=await reuse(bounded,null);const audit=f.events.find(event=>event.action==='infra.protection-audit.missing');
  expect(audit?.details).toMatchObject({missingLogLimit:false,missingProtectedLabel:true});
 });
 it.each(['inspect','json'] as const)('keeps %s uncertainty visible and bounded while preserving reuse',async failure=>{
  const f=await reuse(bounded,'true',failure);const audit=f.events.find(event=>event.action==='infra.protection-audit.unknown');
  expect(audit?.details).toEqual({logLimitStatus:'unknown',protectedLabelStatus:'unknown'});
  expect(JSON.stringify(f.events)+f.warnings.join(' ')).not.toContain('private-path-and-secret-fixture');
 });
 it('keeps the audit on both running reuse and stopped-container wake paths',()=>{
  expect(src.match(/await this\.auditInfraLogLimit\(service\);/g)?.length).toBeGreaterThanOrEqual(2);
 });
});
