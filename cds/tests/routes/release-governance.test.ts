import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ReleaseGovernanceService } from '../../src/services/release-governance.js';
import { ReleaseGovernanceGit } from '../../src/services/release-governance-git.js';
import { createHumanProjectAccessMiddleware } from '../../src/middleware/human-project-access.js';
import { humanPrincipalId } from '../../src/services/human-project-access.js';
import { createReleaseGovernanceRouter } from '../../src/routes/release-governance.js';

describe('发布治理 HTTP 契约与认证边界夹具', () => {
  let root: string, state: StateService, server: http.Server, port: number, service: ReleaseGovernanceService, git: ReleaseGovernanceGit;
  const sha = 'a'.repeat(40);
  async function call(method: string, route: string, identity = 'agent', body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, { method,
      headers: { 'Content-Type':'application/json','x-fixture-identity':identity, 'x-cds-trigger':'webhook' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(),'cds-governance-route-'));
    state = new StateService(path.join(root,'state.json'),root); state.load();
    const now = new Date().toISOString();
    for (const projectId of ['p','other']) {
      state.addProject({ id: projectId, slug: projectId, name: projectId, kind:'git', createdAt: now, updatedAt: now });
      state.upsertReleaseTarget({ id: projectId+'-target', projectId, name: projectId, type:'ssh', isEnabled:true, createdAt:now, governance:{required:true} });
    }
    state.addBranch({ id:'b', projectId:'p', branch:'feature/test', githubCommitSha:sha, worktreePath:root, services:{},status:'running',createdAt:now });
    git = new ReleaseGovernanceGit(() => root, () => 'main',async () => ({ stdout:'',exitCode:0 }));
    vi.spyOn(git,'inspect').mockResolvedValue({ projectId:'p', candidateSha:sha, mainSha:sha, checkedAt:now,status:'clean',includesBaseline:true,conflicts:[],changedPaths:['allowed/file.ts'] });
    service = new ReleaseGovernanceService(state,git);
    const app = express(); app.use(express.json());
    // Test-only authentication stamps; these are route diagnostics, not browser-login evidence.
    app.use((req, _res, next) => {
      const identity = req.headers['x-fixture-identity'];
      if (identity === 'agent' || identity === 'agent2') (req as any).cdsProjectKey = { projectId:'p', keyId: identity === 'agent' ? 'agent-1' : 'agent-2' };
      if (identity === 'human' || identity === 'unverified-human') (req as any).cdsUser = { id:'reviewer', name:'Reviewer', isSystemOwner: true };
      if (identity === 'member' || identity === 'outsider') (req as any).cdsUser = { id: identity, name: identity, authProvider:'local' };
      if (['human','member','outsider'].includes(String(identity))) (req as any).cdsSession = { id:'verified-session' };
      next();
    });
    app.use(createHumanProjectAccessMiddleware(state));
    app.use('/api',createReleaseGovernanceRouter(state,service));
    server = app.listen(0,'127.0.0.1'); await new Promise<void>(resolve => server.once('listening',resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await state.flush(); fs.rmSync(root,{recursive:true,force:true}); vi.restoreAllMocks(); });
  const body = () => ({ branchId:'b', kind:'debug', allowedPaths:['allowed/'], expiresAt:new Date(Date.now()+60_000).toISOString(),reason:'路由隔离与真实身份契约核验' });
  it('项目密钥不能跨项目查询或修改，伪造 webhook 不改变权限', async () => {
    expect((await call('GET','/releases/governance?projectId=other')).status).toBe(403);
    expect((await call('POST','/releases/targets/other-target/authorizations','agent',body())).status).toBe(403);
  });
  it('单笔链接按项目授权，可独立审批但不能访问管理面', async () => {
    state.addProjectGrant({ id:'member-grant', principalId:humanPrincipalId('member'), projectId:'p', origin:'approved', grantedAt:new Date().toISOString() });
    const own = await call('POST','/releases/targets/p-target/authorizations','human',body());
    expect(own.status).toBe(200);
    const route = '/releases/authorizations/'+own.body.authorization.id;
    expect((await call('GET',route,'outsider')).status).toBe(403);
    expect((await call('GET',route,'agent')).status).toBe(403);
    expect((await call('GET',route,'human')).body.viewer).toEqual({applicant:true,mayReview:false,mayReapply:true});
    state.upsertReleaseTarget({id:'p-sibling',projectId:'p',name:'目标 B',type:'ssh',isEnabled:true,createdAt:new Date().toISOString(),governance:{required:true}});
    const sibling = await call('POST','/releases/targets/p-sibling/authorizations','human',body());
    expect(sibling.status).toBe(200);
    const inbox = '/releases/approval-inbox?projectId=p&targetId=p-target';
    const ownInbox = await call('GET',inbox,'human');
    expect(ownInbox.body.records.map((record: any) => [record.id,record.applicant,record.mayReview])).toEqual([[own.body.authorization.id,true,false]]);
    const reviewerInbox = await call('GET',inbox,'member');
    expect(reviewerInbox.body.records.map((record: any) => [record.id,record.applicant,record.mayReview])).toEqual([[own.body.authorization.id,false,true]]);
    expect((await call('GET',inbox,'outsider')).status).toBe(403);
    expect((await call('GET',inbox,'agent')).status).toBe(403);
    expect((await call('GET','/releases/approval-inbox?projectId=p&targetId=other-target','member')).status).toBe(403);
    const member = await call('GET',route,'member');
    expect(member.body).toMatchObject({target:{name:'p'},authorization:{id:own.body.authorization.id},viewer:{applicant:false,mayReview:true,mayReapply:false}});
    expect(member.body.authorization).not.toHaveProperty('targetFingerprint');
    expect((await call('GET','/releases/governance?projectId=p','member')).status).toBe(403);
    expect((await call('POST',route+'/approve','human',{reason:'不能自我批准'})).status).toBe(409);
    expect((await call('POST',route+'/approve','outsider',{reason:'没有项目授权'})).status).toBe(403);
    const check = await git.inspect('p', sha);
    vi.mocked(git.inspect).mockImplementationOnce(async () => { state.revokeProjectGrant('member-grant', 'review-fixture'); return check; });
    expect((await call('POST',route+'/approve','member',{reason:'核验期间撤销项目授权'})).status).toBe(409);
    expect((await call('GET',route,'human')).body.authorization.status).toBe('pending');
    state.addProjectGrant({ id:'member-restored', principalId:humanPrincipalId('member'), projectId:'p', origin:'approved', grantedAt:new Date().toISOString() });
    expect((await call('POST',route+'/approve','member',{reason:'核对目标与限定路径'})).status).toBe(200);
    expect((await call('GET',route,'human')).body.authorization).toMatchObject({status:'approved',decidedBy:'user:member:member'});
  });
  it('过期申请不接受批准或拒绝，链接仍可查看', async () => {
    const requested = await call('POST','/releases/targets/p-target/authorizations','agent',body());
    const stored = state.getReleaseGovernance();
    const stateRecord = stored.authorizations[requested.body.authorization.id];
    stateRecord.expiresAt = new Date(Date.now()-1).toISOString();
    state.saveReleaseGovernance(stored);
    const route = `/releases/authorizations/${stateRecord.id}`;
    expect((await call('GET',route,'human')).body.authorization.expiresAt).toBe(stateRecord.expiresAt);
    for (const action of ['approve','reject']) expect((await call('POST',route+'/'+action,'human',{reason:'已超过申请有效期'})).status).toBe(409);
  });
  it('HTTP单次审批只接受同项目同分支的已保存部署版本，分支前进也仍绑定其完整提交',async()=>{
    state.getBranch('b')!.githubCommitSha='b'.repeat(40);
    state.addDeploymentVersion({id:'saved-a',projectId:'p',branchId:'b',commitSha:sha,configHash:'fixture',profiles:[],migrations:[],capabilities:[],createdByRunId:'build-a',createdAt:new Date().toISOString()});
    const requested=await call('POST','/releases/targets/p-target/authorizations','agent',{...body(),kind:'single',deploymentVersionId:'saved-a',commitSha:'c'.repeat(40)});
    expect(requested.status).toBe(200);expect(requested.body.authorization).toMatchObject({candidateSha:sha,deploymentVersionId:'saved-a'});
    expect((await call('POST','/releases/authorizations/'+requested.body.authorization.id+'/approve','human',{reason:'核对已保存固定版本A'})).status).toBe(200);
    expect((await service.authorize({runId:'fixed-run',projectId:'p',targetId:'p-target',branchId:'b',commitSha:sha,operator:'ai:key:agent-1',action:'release',authorizationId:requested.body.authorization.id}))?.deploymentVersionId).toBe('saved-a');
    expect(state.getBranch('b')?.githubCommitSha).toBe('b'.repeat(40));
    state.addBranch({...state.getBranch('b')!,id:'foreign',projectId:'other'});
    state.addDeploymentVersion({id:'foreign-a',projectId:'other',branchId:'foreign',commitSha:sha,configHash:'fixture',profiles:[],migrations:[],capabilities:[],createdByRunId:'foreign-build',createdAt:new Date().toISOString()});
    expect((await call('POST','/releases/targets/p-target/authorizations','agent',{...body(),kind:'single',deploymentVersionId:'foreign-a'})).status).toBe(409);
    const listed=await call('GET','/releases/governance?projectId=p');expect(listed.body.deploymentVersions.map((v:any)=>v.id)).toEqual(['saved-a']);
  });
  it('全局凭据不能写入治理；项目密钥不能批准或启用', async () => {
    expect((await call('POST','/releases/targets/p-target/authorizations','global',body())).status).toBe(403);
    expect((await call('POST','/releases/targets/p-target/governance/enable')).status).toBe(403);
    const requested = await call('POST','/releases/targets/p-target/authorizations','agent',body());
    expect(requested.status).toBe(200); expect(requested.body.authorization.requestedBy).toBe('ai:key:agent-1');
    expect((await call('POST',`/releases/authorizations/${requested.body.authorization.id}/approve`,'agent',{reason:'测试批准意见'})).status).toBe(403);
  });
  it('只有真实人类会话能批准，客户端 operator 不会写成批准人', async () => {
    const requested = await call('POST','/releases/targets/p-target/authorizations','agent',body());
    const route = `/releases/authorizations/${requested.body.authorization.id}/approve`;
    expect((await call('POST',route,'unverified-human',{reason:'测试批准意见'})).status).toBe(403);
    const approved = await call('POST',route,'human',{reason:'已核验版本与范围',operator:'attacker'});
    expect(approved.status).toBe(200); expect(approved.body.authorization.decidedBy).toBe('user:reviewer:Reviewer');
    expect(approved.body.authorization.decidedBy).not.toBe('attacker');
  });
  it('执行凭据可撤销自己的调试授权，但不能替另一把密钥撤销', async () => {
    const requested = await call('POST','/releases/targets/p-target/authorizations','agent',body());
    const route = `/releases/authorizations/${requested.body.authorization.id}/revoke`;
    expect((await call('POST',route,'agent2',{reason:'结束本次调试'})).status).toBe(409);
    const revoked = await call('POST',route,'agent',{reason:'结束本次调试'});
    expect(revoked.status).toBe(200); expect(revoked.body.authorization.status).toBe('revoked');
  });
  it('未知内部异常不暴露路径、密钥或上游响应', async () => {
    vi.spyOn(service,'inspect').mockRejectedValue(new Error('PRIVATE_KEY secret /root/production HTTP 401'));
    const result = await call('POST','/releases/targets/p-target/conflict-check');
    expect(result.status).toBe(503); expect(result.body.code).toBe('release_governance_unavailable');
    expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_KEY|\/root\/production|HTTP 401|secret/);
    expect(result.body.message).toContain('重试');
  });
  it('启用审批持久化，普通目标更新不能关闭它', async () => {
    expect((await call('POST','/releases/targets/p-target/governance/enable','human')).status).toBe(200);
    const target = state.getReleaseTarget('p-target')!;
    state.upsertReleaseTarget({ ...target, governance: undefined });
    expect(state.getReleaseTarget('p-target')?.governance?.required).toBe(true);
  });
  it('存量目标先启用再申请，避免启用时令已有批准失效', async()=>{
    state.upsertReleaseTarget({id:'legacy',projectId:'p',name:'存量环境',type:'ssh',isEnabled:true,createdAt:new Date().toISOString()});
    expect((await call('POST','/releases/targets/legacy/authorizations','agent',body())).status).toBe(409);
    expect((await call('POST','/releases/targets/legacy/governance/enable','human')).status).toBe(200);
    const requested=await call('POST','/releases/targets/legacy/authorizations','agent',body());
    expect(requested.status).toBe(200);
    expect((await call('POST','/releases/authorizations/'+requested.body.authorization.id+'/approve','human',{reason:'启用之后核验并批准'})).status).toBe(200);
  });
});
