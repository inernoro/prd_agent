import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,it,vi} from 'vitest';
import {StateService} from '../../src/services/state.js';
const fixtures:Array<{state:StateService;dir:string}>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const f of fixtures.splice(0)){await f.state.flush();fs.rmSync(f.dir,{recursive:true,force:true});}});
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-branch-storage-retention-'));
 const state=new StateService(path.join(dir,'state.json'));state.load();fixtures.push({state,dir});
 state.addProject({id:'p',slug:'p',name:'own',kind:'git',createdAt:'2026-10-24',updatedAt:'2026-10-24'});
 state.addBuildProfile({id:'app',projectId:'p',name:'app',dockerImage:'alpine:3',workDir:'.',containerPort:8080,command:'sleep 30'});
 for(const id of ['a','b'])state.addBranch({id,projectId:'p',branch:id,createdAt:'2026-10-24',worktreePath:path.join(dir,id),status:'stopped',services:{},profileOverrides:{},extraProfiles:[]});
 const mutable=state.getState() as any;mutable.logs.a=[];mutable.uptimeMonitors={owned:{id:'owned',boundBranchId:'a'}};
 let orphaned=0;state.onUptimeMonitorsOrphaned(()=>orphaned++);return{state,mutable,orphaned:()=>orphaned};
}
const binding=(branchId='a',projectId='p')=>({version:1 as const,instanceId:'own',projectId,scope:'branch-private' as const,branchId,serviceId:'app',mountKey:'data',purpose:'persistent' as const});
const record=(branchId='a',projectId='p')=>({version:1 as const,target:{kind:'profile' as const,projectId,branchId,serviceId:'app'},branchIdentity:'frozen',declarationDigest:'frozen',mounts:[],names:['owned-data'],operationId:'own-op'});
function assertRefused(f:ReturnType<typeof fixture>){
 const before=JSON.stringify(f.state.getState()),save=vi.spyOn(f.state,'save');
 assert.throws(()=>f.state.removeBranch('a'),/storage_retained_branch_delete_refused/);
 assert.equal(JSON.stringify(f.state.getState()),before);assert.equal(f.orphaned(),0);assert.equal(save.mock.calls.length,0);
}
describe('branch-private ownership cannot lose its declaration through branch removal',()=>{
 it.each(['intent','issued','confirmed','published','held'])('preserves every %s birth stage before branch, logs, address or monitor mutation',stage=>{
  const f=fixture();f.mutable.storageBirths={n:{name:'n',binding:binding(),stage,seq:1,createIssued:stage!=='intent'}};assertRefused(f);
 });
 it.each(['binding','publication','draft'])('preserves %s even without a surviving birth row',kind=>{
  const f=fixture();if(kind==='binding')f.mutable.profileStorageBindings={x:record()};else if(kind==='publication')f.mutable.profileStoragePublications={x:{binding:record()}};else (f.state as any).profileStorageDrafts.set('x',record());assertRefused(f);
 });
 it.each(['baseline','override','extra'])('preserves branch-owned %s declaration even before journal rows exist',kind=>{
  const f=fixture(),cacheMounts=[{kind:'volume' as const,hostPath:'declared-owned',containerPath:'/data',storage:binding()}];
  if(kind==='baseline')f.state.getBuildProfile('app')!.cacheMounts=cacheMounts;
  else if(kind==='override')Object.assign(f.state.getBranch('a')!.profileOverrides!,{app:{cacheMounts}});
  else f.state.getBranch('a')!.extraProfiles=[{...f.state.getBuildProfile('app')!,id:'extra',cacheMounts}];assertRefused(f);
 });
 it.each(['ordinary','foreign-branch','foreign-project'])('does not change the ordinary deletion contract for %s',kind=>{
  const f=fixture();if(kind==='foreign-branch')f.mutable.profileStorageBindings={x:record('b')};if(kind==='foreign-project')f.mutable.profileStorageBindings={x:record('a','foreign')};
  assert.deepEqual(f.state.removeBranch('a'),['owned']);assert.equal(f.state.getBranch('a'),undefined);assert(f.state.getBranch('b'));assert.equal(f.orphaned(),1);
 });
});
