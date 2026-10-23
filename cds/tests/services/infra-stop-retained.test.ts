import { describe, it, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

const cid='a'.repeat(64),other='b'.repeat(64),name='legacy-db';
const config: any={repoRoot:'/repo',worktreeBase:'/wt',storageInstanceId:'instance',masterPort:9900,workerPort:5500,dockerNetwork:'owned',portStart:10001,sharedEnv:{},jwt:{secret:'fixture',issuer:'fixture'}};
const legacy: any={id:'db',projectId:'project',name:'legacy',dockerImage:'mysql:8',containerName:name,containerPort:3306,hostPort:13306,status:'running',env:{MYSQL_ROOT_PASSWORD:'fixture-only-password'},createdAt:'2026-10-23',volumes:[{type:'volume',name:'historical-unannotated-db',containerPath:'/var/lib/mysql'}]};
function fixture(scenario='normal'){
 const shell=new MockShellExecutor();let exists=true,running=true,stops=0,rms=0,reads=0;
 shell.addResponsePattern(/^docker .*/,m=>{
  const c=m[0];
  if(c.startsWith('docker inspect ')){
   reads++;if(scenario==='absent'||!exists)return {exitCode:1,stdout:'',stderr:'Error: No such object: '+name};
   if(scenario==='unknown')return {exitCode:124,stdout:'',stderr:'timeout'};
   if(c.includes('.State.Pid'))return {exitCode:0,stdout:[scenario==='changed-id'&&reads>1?other:cid,scenario==='changed-name'&&reads>1?'/foreign':'/'+name,running,running?42:0,running?'running':'exited'].map(x=>JSON.stringify(x)).join('|'),stderr:''};
   if(c.includes('{{json .Id}}|{{json .Name}}'))return{exitCode:0,stdout:[cid,'/'+name].map(x=>JSON.stringify(x)).join('|'),stderr:''};
   return {exitCode:0,stdout:[cid,running?'running':'exited','/'+name].map(x=>JSON.stringify(x)).join('|'),stderr:''};
  }
  if(c.startsWith('docker stop ')){stops++;if(scenario==='stop-fail')return{exitCode:1,stdout:'',stderr:'controlled failure'};if(scenario!=='remains-running')running=false;return{exitCode:0,stdout:cid,stderr:''};}
  if(c.startsWith('docker rm ')){rms++;if(scenario==='rm-fail')return{exitCode:1,stdout:'',stderr:'controlled failure'};exists=false;return{exitCode:0,stdout:cid,stderr:''};}
  if(c.startsWith('docker start ')){assert.equal(c,'docker start '+cid);assert(exists);running=true;return{exitCode:0,stdout:cid,stderr:''};}
  return {exitCode:0,stdout:'',stderr:''};
 });
 const container: any=new ContainerService(shell,config);for(const method of ['ensureNetwork','ensureInfraOnNetwork','auditInfraLogLimit','auditMysqlConnectionLimit'])container[method]=async()=>{};container.captureContainerDiagnostics=async()=>({inspect:{state:{running}},logs:''});
 return {container,shell,state:()=>({exists,running,stops,rms,reads})};
}

describe('infra stop retains the only legacy runtime without rebinding historical data', () => {
 it('legacy named volume normal stop preserves original CID and subsequent start only wakes it',async()=>{const f=fixture();await f.container.stopInfraService(name,'cds-infra-stop');assert.equal(f.state().exists,true);assert.equal(f.state().running,false);assert.equal(f.state().rms,0);await f.container.startInfraService(legacy);assert.equal(f.state().running,true);assert(f.shell.commands.includes('docker start '+cid));assert(!f.shell.commands.some(c=>/^docker (create|run|volume create|volume rm) /.test(c)));});
 it('unconfirmed stop cannot continue removal',async()=>{const f=fixture('stop-fail');await assert.rejects(f.container.stopInfraService(name,'cds-infra-remove'));assert.equal(f.state().rms,0);assert.equal(f.state().exists,true)});
 it('unconfirmed rm is not returned as success',async()=>{const f=fixture('rm-fail');await assert.rejects(f.container.stopInfraService(name,'cds-infra-recreate'));assert.equal(f.state().exists,true)});
 it('unknown identity cannot stop or remove anything',async()=>{const f=fixture('unknown');await assert.rejects(f.container.stopInfraService(name,'cds-infra-stop'));assert.equal(f.state().stops,0);assert.equal(f.state().rms,0)});
 it('cold read must still be the exact captured CID',async()=>{const f=fixture('changed-id');await assert.rejects(f.container.stopInfraService(name,'cds-infra-stop'));assert.equal(f.state().rms,0);assert.equal(f.state().exists,true)});

 it.each(['remains-running', 'changed-name'])('native cold proof rejects %s without rm', async scenario => {
   const f=fixture(scenario);await assert.rejects(f.container.stopInfraService(name,'cds-infra-stop'));
   assert.equal(f.state().rms,0);assert.equal(f.state().exists,true);
 });
});

// This deliberately tests the actual production server callback, not a rewritten
// copy. It is a local dependency seam, not a real HTTP/credential rotation claim.
function actualServerRecreate(deps: any): (service: any) => Promise<void> {
 const source=fs.readFileSync(fileURLToPath(new URL('../../src/server.ts', import.meta.url)),'utf8');
 const ast=ts.createSourceFile('server.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const callbacks: ts.Expression[]=[];
 function visit(node: ts.Node): void {
  if(ts.isNewExpression(node) && node.expression.getText(ast)==='ProjectSharedCredentialRotationBackend') {
   const option=node.arguments?.[4];
   if(option && ts.isObjectLiteralExpression(option))for(const property of option.properties) {
    if(ts.isPropertyAssignment(property) && property.name.getText(ast)==='recreate')callbacks.push(property.initializer);
   }
  }
  ts.forEachChild(node,visit);
 }
 visit(ast);expect(callbacks).toHaveLength(1);
 const js=ts.transpileModule('const actual = '+callbacks[0].getText(ast)+';',
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 return new Function('deps',js+';return actual;')(deps);
}
describe('credential rotation recreation preserves storage preflight ordering',()=>{
 function depsFixture() {
  const trace:string[]=[];const accepted={...legacy,dockerImage:'sha256:'+'d'.repeat(64)};
  const deps={containerService:{preflightInfraStorage:vi.fn(async(s:any)=>{trace.push('preflight');expect(s).toBe(legacy);return accepted}),
   stopInfraService:vi.fn(async()=>{trace.push('stop')}),startInfraService:vi.fn(async()=>{trace.push('start')})},
   stateService:{getCustomEnv:vi.fn(()=>({})),updateInfraService:vi.fn(),save:vi.fn(),flush:vi.fn(async()=>{})}};
  return {deps,trace,accepted};
 }
 it('strict rejection occurs before stop/start and publishes no running state',async()=>{
  const f=depsFixture(),failure=new Error('unsafe_deployment_storage');
  f.deps.containerService.preflightInfraStorage.mockImplementation(async()=>{f.trace.push('preflight');throw failure});
  await expect(actualServerRecreate(f.deps)(legacy)).rejects.toBe(failure);
  expect(f.trace).toEqual(['preflight']);expect(f.deps.containerService.stopInfraService).not.toHaveBeenCalled();
  expect(f.deps.containerService.startInfraService).not.toHaveBeenCalled();expect(f.deps.stateService.updateInfraService).not.toHaveBeenCalled();
  expect(f.deps.stateService.save).not.toHaveBeenCalled();expect(f.deps.stateService.flush).not.toHaveBeenCalled();
 });
 it('legal recreation passes the SAME strict admitted declaration to start',async()=>{
  const f=depsFixture();await actualServerRecreate(f.deps)(legacy);
  expect(f.trace).toEqual(['preflight','stop','start']);
  expect(f.deps.containerService.startInfraService).toHaveBeenCalledWith(f.accepted,{});
  expect(f.deps.containerService.preflightInfraStorage).toHaveBeenCalledWith(legacy);
 });
});

it.each(['Error: No such object: ','Error response from daemon: No such container: '])('stateless removal accepts only exactly confirmed absent container %s',async prefix=>{
 const f=fixture('absent');
 await expect(f.container.stopInfraService(name,'cds-infra-remove')).resolves.toBeUndefined();
 expect(f.shell.commands.some(c=>/^docker (stop|rm) /.test(c))).toBe(false);
});
