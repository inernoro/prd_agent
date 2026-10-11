import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceResourceRunService, acceptanceResourceDigest } from '../../src/services/acceptance-resource-run.js';
import { createAcceptanceResourceRunsRouter } from '../../src/routes/acceptance-resource-runs.js';

// Actual State/JSON and HTTP: a same-SHA historical success cannot establish original creation ownership.
describe('original creation required for every new registration', () => {
  let root: string, state: StateService, service: AcceptanceResourceRunService, server: http.Server;
  let owner: Awaited<ReturnType<AcceptanceResourceRunService['begin']>>;
  const sha = 'a'.repeat(40), cid = 'b'.repeat(64);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(),'cds-origin-required-')); state = new StateService(path.join(root,'state.json')); state.load();
    state.addProject({id:'p',slug:'p',name:'own'} as any);
    state.addBranch({id:'b',projectId:'p',branch:'own/origin',worktreePath:root,createdAt:'2026-10-12',status:'idle',services:{}});
    service = new AcceptanceResourceRunService(state);
    owner = await service.begin({projectId:'p',branchId:'b',profileId:'init',targetSha:sha,isolationRunId:'owned_run'});
    const b = state.getBranch('b')!;
    b.extraProfiles=[{id:'init',projectId:'p',env:{IMP_HEALTH_RUN_ID:'owned_run',IMP_TARGET_SHA:sha}} as any];
    b.services.init={profileId:'init',containerName:'same-target-container',containerId:cid,hostPort:10001,status:'running',deployedCommitSha:sha};
    state.addDeploymentRun({id:'dr_unrelated',projectId:'p',branchId:'b',commitSha:sha,status:'running',startedAt:new Date(Date.parse(owner.run.startedAt)+1).toISOString(),seq:1,events:[]} as any);
    state.save(); await state.flush();
    const app=express(); app.use('/api',createAcceptanceResourceRunsRouter({stateService:state})); server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
  });
  afterEach(async()=>{ server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await state.flush(); fs.rmSync(root,{recursive:true,force:true}); });
  it('does not adopt a last success even with matching profile, SHA, full container ID and capability',async()=>{
    await expect(service.register(owner.run.id,owner.ownerToken)).rejects.toThrow('acceptance_resource_unconfirmed');
    expect(service.get(owner.run.id)!.stage).toBe('active');
    expect(JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8')).acceptanceResourceRuns[owner.run.id].stage).toBe('active');
  });
  it('rejects the same unproven origin over the actual register HTTP route',async()=>{
    const body=JSON.stringify({ownerToken:owner.ownerToken});
    const result=await new Promise<{status:number,raw:string}>((resolve,reject)=>{
      const q=http.request({host:'127.0.0.1',port:(server.address() as any).port,path:'/api/acceptance-resource-runs/'+owner.run.id+'/register',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)},agent:false},res=>{
        let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode!,raw}));
      });q.setTimeout(5000,()=>q.destroy(Error('owned HTTP budget')));q.on('error',reject);q.end(body);
    });
    expect(result.status).toBe(409);expect(JSON.parse(result.raw)).toEqual({error:'acceptance_resource_unconfirmed'});expect(result.raw).not.toContain(owner.ownerToken);
  });
  it('does not grant a new registered row through the generic durable writer',async()=>{
    const previous=state.getState().acceptanceResourceRuns![owner.run.id];
    const b=state.getBranch('b')!,row={...previous,seq:previous.seq+1,stage:'registered' as const,
      resource:{configDigest:acceptanceResourceDigest([b.extraProfiles![0],null]),containerId:cid,deploymentRunId:'dr_unrelated'}};
    await expect(state.writeAcceptanceResourceRunDurably(row,previous.seq,()=>{})).rejects.toThrow('acceptance_creation_transaction_required');
    expect(service.get(owner.run.id)!.stage).toBe('active');
  });
});
