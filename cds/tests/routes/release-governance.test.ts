import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ReleaseGovernanceService } from '../../src/services/release-governance.js';
import { ReleaseGovernanceGit } from '../../src/services/release-governance-git.js';
import { createReleaseGovernanceRouter } from '../../src/routes/release-governance.js';

describe('发布治理 HTTP 契约与认证边界夹具', () => {
  let root: string, state: StateService, server: http.Server, port: number, service: ReleaseGovernanceService;
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
    const git = new ReleaseGovernanceGit(() => root, () => 'main',async () => ({ stdout:'',exitCode:0 }));
    vi.spyOn(git,'inspect').mockResolvedValue({ projectId:'p', candidateSha:sha, mainSha:sha, checkedAt:now,status:'clean',includesBaseline:true,conflicts:[],changedPaths:['allowed/file.ts'] });
    service = new ReleaseGovernanceService(state,git);
    const app = express(); app.use(express.json());
    // Test-only authentication stamps; these are route diagnostics, not browser-login evidence.
    app.use((req, _res, next) => {
      const identity = req.headers['x-fixture-identity'];
      if (identity === 'agent' || identity === 'agent2') (req as any).cdsProjectKey = { projectId:'p', keyId: identity === 'agent' ? 'agent-1' : 'agent-2' };
      if (identity === 'human' || identity === 'unverified-human') (req as any).cdsUser = { id:'reviewer', name:'Reviewer' };
      if (identity === 'human') (req as any).cdsSession = { id:'verified-session' };
      next();
    });
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
