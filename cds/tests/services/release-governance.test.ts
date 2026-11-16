import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ReleaseGovernanceService, normalizeDebugPaths, pathAllowed, type GovernanceAdmission } from '../../src/services/release-governance.js';
import { ReleaseGovernanceGit } from '../../src/services/release-governance-git.js';
import { ReleaseService } from '../../src/services/release-service.js';
import { resetReleaseTargetLocksForTest } from '../../src/services/release-target-lock.js';
import type { ReleaseRun, ReleaseTarget } from '../../src/types.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), MAIN = 'd'.repeat(40);
const alice = 'user:alice:Alice', reviewer = 'user:reviewer:Reviewer', agent = 'ai:key:agent-1';
describe('独立批准与连续调试的服务层约束', () => {
  let root: string, state: StateService, git: ReleaseGovernanceGit, service: ReleaseGovernanceService, now: number;
  const input = (patch: Partial<GovernanceAdmission> = {}): GovernanceAdmission => ({ runId: 'new-run', projectId: 'p', targetId: 'prod', branchId: 'feature', commitSha: B, operator: alice, action: 'release', ...patch });
  const history = (releaseId: string, commitSha: string, extra: Partial<ReleaseRun> = {}): ReleaseRun => ({
    releaseId, projectId: 'p', targetId: 'prod', branchId: 'feature', commitSha, artifact: { type: 'branch-preview', commitSha, branchId: 'feature', branchName: 'feature/test', previewUrl: 'http://example.invalid' },
    planId: 'p:ssh-script', status: 'success', startedAt: '2026-11-15T00:00:00.000Z', finishedAt: '2026-11-15T00:01:00.000Z', logs: [], seq: 0, ...extra,
  });
  const request = (patch: Record<string, unknown> = {}) => service.request({ targetId: 'prod', branchId: 'feature', kind: 'single',
    expiresAt: new Date(now + 60 * 60_000).toISOString(), reason: '核验发布治理的固定版本', actor: alice, ...patch } as Parameters<typeof service.request>[0]);
  const approve = async (patch: Record<string, unknown> = {}) => {
    const record = await request(patch); return service.decide(record.id, 'approved', reviewer, '已核对版本与范围');
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-governance-test-')); now = Date.parse('2026-11-16T00:00:00Z');
    state = new StateService(path.join(root,'state.json'),root); state.load();
    state.addProject({ id: 'p', slug: 'p', name: '治理测试', kind: 'git', gitDefaultBranch: 'main', githubRepoFullName: 'example/repo', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
    state.addBranch({ id: 'feature', projectId: 'p', branch: 'feature/test', githubCommitSha: B, worktreePath: root, status: 'running', services: {}, createdAt: new Date(now).toISOString() });
    state.upsertReleaseTarget({ id: 'prod', projectId: 'p', name: '测试正式环境', type: 'ssh', isEnabled: true, createdAt: new Date(now).toISOString(),
      governance: { required: true, enabledAt: new Date(now).toISOString(), enabledBy: reviewer }, ssh: { host: '127.0.0.1', port: 22, user: 'test', privateKeyRef: 'host', appPath: '/tmp/test', deployCommand: './deploy.sh', healthcheckUrl: 'http://example.invalid' } });
    state.addReleaseRun(history('baseline',A));
    git = new ReleaseGovernanceGit(() => root, () => 'main', async () => ({ stdout: '', exitCode: 0 }));
    vi.spyOn(git,'inspect').mockImplementation(async (projectId, candidateSha) => ({ projectId, candidateSha, mainSha: MAIN, status: 'clean', checkedAt: new Date(now).toISOString(), changedPaths: ['allowed/file.ts'], conflicts: [], includesBaseline: true }));
    vi.spyOn(git,'includes').mockResolvedValue(true);
    vi.spyOn(git,'includesPr').mockResolvedValue(true);
    service = new ReleaseGovernanceService(state,git,async (_project,number) => ({ repository: 'example/repo', number, url: `https://github.com/example/repo/pull/${number}`,
      state: 'open', headSha: B, baseRef: 'main', checkedAt: new Date(now).toISOString() }), () => new Date(now));
  });
  afterEach(async () => { await state.flush(); fs.rmSync(root,{ recursive: true, force: true }); resetReleaseTargetLocksForTest(); vi.restoreAllMocks(); });
  it('无批准时拒绝，并持久记录拦截原因', async () => {
    await expect(service.authorize(input())).rejects.toThrow('独立批准');
    expect(service.list('p').attempts[0]).toMatchObject({ result: 'denied', candidateSha: B, operator: alice });
  });
  it('首个调试窗口须包含当前主干，在申请时即拒绝不满足条件的版本',async()=>{
    state.upsertReleaseTarget({...state.getReleaseTarget('prod')!,id:'fresh'});
    const check={projectId:'p',candidateSha:B,mainSha:MAIN,status:'clean' as const,checkedAt:new Date(now).toISOString(),changedPaths:['allowed/file.ts'],conflicts:[],includesBaseline:false};
    vi.mocked(git.inspect).mockResolvedValue(check);
    await expect(request({targetId:'fresh',kind:'debug',allowedPaths:['allowed/']})).rejects.toThrow('当前主干');
    expect(service.list('p').authorizations).toHaveLength(0);
    vi.mocked(git.inspect).mockResolvedValue({...check,includesBaseline:true});
    const record=await approve({targetId:'fresh',kind:'debug',allowedPaths:['allowed/']});
    expect((await service.authorize(input({targetId:'fresh',authorizationId:record.id})))?.authorizationId).toBe(record.id);
  });
  it('认证账号 ID 相同但显示名改变也不能自批', async () => {
    const record = await request();
    await expect(service.decide(record.id,'approved','user:alice:Alicia','核对后批准')).rejects.toThrow('自己');
    await expect(service.decide(record.id,'approved',agent,'核对后批准')).rejects.toThrow('人类');
  });
  it('项目执行凭据申请、人类批准，保留双方身份', async () => {
    const record = await approve({ actor: agent });
    const receipt = await service.authorize(input({ operator: agent, authorizationId: record.id }));
    expect(receipt).toMatchObject({ requestedBy: agent, approvedBy: reviewer, candidateSha: B, baselineReleaseId: 'baseline' });
  });
  it('真实申请人可为指定任务申请，独立批准后仅该任务可执行；修改任务使批准失效', async () => {
    const job = { id:'job-release', projectId:'p', name:'定时发布', enabled:false, schedule:{type:'manual' as const},
      target:{type:'release' as const,targetId:'prod',source:{kind:'branch' as const,branchId:'feature'}},
      timeoutSeconds:120,retryCount:0,concurrencyPolicy:'skip' as const,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString() };
    state.upsertScheduledJob(job);
    const pending = await request({scheduledJobId:job.id});
    expect(pending.requestedBy).toBe(alice);
    await expect(service.decide(pending.id,'approved',alice,'申请人不能自批')).rejects.toThrow('自己');
    await service.decide(pending.id,'approved',reviewer,'核验任务与固定版本');
    await expect(service.authorize(input({operator:alice,authorizationId:pending.id}))).rejects.toThrow('不匹配');
    await expect(service.authorize(input({operator:'system:scheduled-job:other',authorizationId:pending.id}))).rejects.toThrow('不匹配');
    const receipt=await service.authorize(input({operator:'system:scheduled-job:job-release'}));
    expect(receipt).toMatchObject({requestedBy:alice,approvedBy:reviewer,authorizationId:pending.id});
    state.upsertScheduledJob({...job,target:{...job.target,dryRun:true}});
    await expect(service.authorize(input({operator:'system:scheduled-job:job-release',authorizationId:pending.id}))).rejects.toThrow('配置已变化');
  });
  it('定时任务不存在或跨项目时不能借任务身份申请', async () => {
    await expect(request({scheduledJobId:'missing'})).rejects.toThrow('不匹配');
    state.upsertScheduledJob({id:'foreign',projectId:'other',name:'其他项目任务',enabled:false,schedule:{type:'manual'},
      target:{type:'release',targetId:'prod',source:{kind:'branch',branchId:'feature'}},timeoutSeconds:30,retryCount:0,concurrencyPolicy:'skip',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()});
    await expect(request({scheduledJobId:'foreign'})).rejects.toThrow('不匹配');
  });
  it('单次批准只能用于固定版本与一次运行，重启后不能再用', async () => {
    const record = await approve();
    await expect(service.authorize(input({ authorizationId: record.id, commitSha: C }))).rejects.toThrow('版本已变化');
    const receipt = await service.authorize(input({ authorizationId: record.id }));
    expect(receipt?.authorizationId).toBe(record.id);
    expect(state.getReleaseGovernance().authorizations[record.id].consumedBy).toBeUndefined();
    state.addReleaseRun(history('new-run',B,{status:'queued',operator:alice,governance:receipt}));
    await service.accept(state.getReleaseRun('new-run')!);
    const reloaded = new StateService(path.join(root,'state.json'),root); reloaded.load();
    const restarted = new ReleaseGovernanceService(reloaded,git,undefined,() => new Date(now));
    await expect(restarted.authorize(input({ authorizationId: record.id, runId: 'second-run' }))).rejects.toThrow('已使用');
    await reloaded.flush();
  });
  it.each([
    { operator: 'user:other:Other' }, { branchId: 'other' }, { projectId: 'other' }, { action: 'rollback' as const },
  ])('批准绑定身份、项目、分支和操作 %j', async patch => {
    const record = await approve(); await expect(service.authorize(input({ ...patch, authorizationId: record.id }))).rejects.toThrow('不匹配');
  });
  it('过期、撤销后均不再执行，批准历史仍保留', async () => {
    const record = await approve(); now += 61 * 60_000;
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('过期');
    now -= 61 * 60_000;
    const revoked = await service.decide(record.id,'revoked',reviewer,'停止调试发布');
    expect(revoked.decisions?.map(d => d.action)).toEqual(['approved','revoked']);
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('撤销');
  });
  it('配置变化、其他生产发布和主干更新均使旧批准失效', async () => {
    const record = await approve();
    const target = state.getReleaseTarget('prod')!; state.upsertReleaseTarget({ ...target, ssh: { ...target.ssh!, appPath: '/different' } });
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('配置');
    state.upsertReleaseTarget(target);
    state.addReleaseRun(history('external',C,{ startedAt: new Date(now).toISOString() }));
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('生产基线');
  });
  it('批准后真实冲突或主干前进，执行仍拒绝', async () => {
    const record = await approve();
    vi.mocked(git.inspect).mockResolvedValue({ ...record.conflictCheck, status: 'conflicts', conflicts: ['allowed/file.ts'] });
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('实际合并');
    vi.mocked(git.inspect).mockResolvedValue({ ...record.conflictCheck, mainSha: C });
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('主干已前进');
  });
  it('连续调试支持多次范围内提交，并只沿用本窗口的生产变化', async () => {
    const record = await approve({ kind: 'debug', allowedPaths: ['allowed/'] });
    const receipt = await service.authorize(input({ authorizationId: record.id }));
    state.addReleaseRun(history('debug-1',B,{ governance: receipt, startedAt: new Date(now).toISOString() }));
    const second = await service.authorize(input({ authorizationId: record.id, commitSha: C, runId: 'debug-2' }));
    expect(second?.authorizationId).toBe(record.id); expect(second?.baselineReleaseId).toBe('debug-1');
    state.addReleaseRun(history('external',A,{ startedAt: new Date(now+1000).toISOString() }));
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('其他发布');
  });
  it('连续调试累计越界与历史改写会被拦截并留下逐次记录', async () => {
    const record = await approve({ kind: 'debug', allowedPaths: ['allowed/'] });
    vi.mocked(git.inspect).mockResolvedValue({ ...record.conflictCheck, changedPaths: ['outside.ts'] });
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('累计改动');
    vi.mocked(git.inspect).mockResolvedValue({ ...record.conflictCheck, includesBaseline: false });
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('生产基线');
    expect(service.list('p').attempts).toHaveLength(2);
  });
  it('核验期间撤销授权不能被旧异步结果覆盖', async () => {
    const record = await approve({ kind: 'debug', allowedPaths: ['allowed/'] });
    vi.mocked(git.inspect).mockImplementationOnce(async () => {
      await service.decide(record.id,'revoked',reviewer,'即时撤销授权'); return record.conflictCheck;
    });
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('撤销');
  });
  it('存储未确认时不返回可执行批准凭据', async () => {
    const record = await approve(); const flush = vi.spyOn(state,'flush').mockRejectedValueOnce(new Error('secret database path'));
    await expect(service.authorize(input({ authorizationId: record.id }))).rejects.toThrow('保存未确认');
    expect(state.getReleaseGovernance().authorizations[record.id].consumedBy).toBeUndefined(); flush.mockRestore();
  });
  it('PR 关联从权威回执校验目标主干与源码包含关系', async () => {
    const linked = await service.linkMergeBack('prod',12,'回并负责人',alice,A);
    expect(linked).toMatchObject({ number: 12, state: 'open', sourceSha: A, owner: '回并负责人', baseRef: 'main' });
    vi.mocked(git.includesPr).mockResolvedValue(false);
    await expect(service.linkMergeBack('prod',13,'负责人',alice,A)).rejects.toThrow('未包含');
  });
  it('回滚必须独立申请历史成功版本，不借用发布或调试批准', async () => {
    await expect(request({ kind: 'debug', action: 'rollback', rollbackReleaseId: 'baseline', allowedPaths: ['allowed/'] })).rejects.toThrow('单次批准');
    await expect(request({ action: 'rollback', rollbackReleaseId: 'missing' })).rejects.toThrow('历史成功版本');
    const record = await approve({ action: 'rollback', rollbackReleaseId: 'baseline' });
    expect(record.candidateSha).toBe(A);
    await expect(service.authorize(input({ authorizationId: record.id, commitSha: A }))).rejects.toThrow('不匹配');
    expect(await service.authorize(input({ authorizationId: record.id, commitSha: A, action: 'rollback' }))).toMatchObject({ action: 'rollback', candidateSha: A });
  });
  it('发布申请不能通过附带历史运行 ID 偷换候选版本', async () => {
    const record = await request({ rollbackReleaseId: 'baseline' }); expect(record.candidateSha).toBe(B);
  });
  it('已获准运行在 SSH 执行前再次核对即时撤销和到期', async () => {
    const record = await approve({ kind: 'debug', allowedPaths: ['allowed/'] });
    const receipt = await service.authorize(input({ authorizationId: record.id }));
    const run = history('new-run',B,{ operator: alice, governance: receipt });
    expect(() => service.assertExecution(run)).not.toThrow();
    now += 61 * 60_000; expect(() => service.assertExecution(run)).toThrow('过期');
    now -= 61 * 60_000; await service.decide(record.id,'revoked',reviewer,'结束本次调试');
    expect(() => service.assertExecution(run)).toThrow('撤销');
  });
  it('PR 读取失败不能继续显示上次的已回并结论', async () => {
    const linked = await service.linkMergeBack('prod',12,'负责人',alice,A);
    const data = state.getReleaseGovernance(); data.mergeBacks[linked.id].state = 'merged'; state.saveReleaseGovernance(data);
    vi.mocked(git.includesPr).mockRejectedValue(new Error('offline'));
    const result = await service.refreshMergeBack(linked.id,alice);
    expect(result.state).toBe('unknown'); expect(result.checkedAt).toBe(linked.checkedAt);
  });
  it('路径规则不允许目录前缀逃逸，未知范围不放行', () => {
    expect(pathAllowed('allowed-other/file.ts',['allowed/'])).toBe(false);
    expect(pathAllowed('allowed/file.ts',['allowed/'])).toBe(true);
    for (const p of ['../x','/etc/passwd','allowed/../x','*','a//b','a\\b']) expect(() => normalizeDebugPaths([p])).toThrow();
    expect(() => normalizeDebugPaths([])).toThrow();
  });
  it('真正的 ReleaseService 入口在执行前调用同一道批准守卫', async () => {
    const release = new ReleaseService(state,{ governance: service });
    const target = state.getReleaseTarget('prod') as ReleaseTarget;
    vi.spyOn(release,'preflight').mockResolvedValue({ ok: true, checks: [], target, artifact: history('source',B).artifact,
      plan: { id: 'plan', projectId: 'p', name: '测试', template: 'ssh-script', rollbackStrategy: 'command', steps: [], createdAt: new Date(now).toISOString() } });
    const execution = vi.spyOn(release as any,'runRelease').mockResolvedValue(undefined);
    await expect(release.startRelease({ branchId: 'feature', targetId: 'prod', operator: alice })).rejects.toThrow('独立批准');
    expect(execution).not.toHaveBeenCalled();
    const record = await approve();
    const run = await release.startRelease({ branchId: 'feature', targetId: 'prod', operator: alice, authorizationId: record.id });
    expect(run.governance?.approvedBy).toBe(reviewer); expect(execution).toHaveBeenCalledOnce();
    state.patchReleaseRun(run.releaseId,{ status: 'success' });
  });
  it('运行未保存或保存未确认时不消耗批准，成功受理后批准与运行可一起查回',async()=>{
    const record=await approve(), receipt=await service.authorize(input({authorizationId:record.id}));
    const run=history('new-run',B,{status:'queued',operator:alice,governance:receipt});
    await expect(service.accept(run)).rejects.toThrow('运行记录不存在');
    expect(state.getReleaseGovernance().authorizations[record.id].consumedBy).toBeUndefined();
    state.addReleaseRun(run);
    const flush=vi.spyOn(state,'flush').mockRejectedValueOnce(new Error('private-storage-path'));
    await expect(service.accept(run)).rejects.toThrow('运行记录保存未确认');flush.mockRestore();
    expect(state.getReleaseGovernance().authorizations[record.id].consumedBy).toBeUndefined();
    await service.accept(run);
    const reloaded=new StateService(path.join(root,'state.json'),root);reloaded.load();
    expect(reloaded.getReleaseGovernance().authorizations[record.id].consumedBy).toBe('new-run');
    expect(reloaded.getReleaseRun('new-run')?.governance?.authorizationId).toBe(record.id);
    await reloaded.flush();
  });
  it('SSH 连通检查期间撤销审批，不执行部署也不触发自动恢复',async()=>{
    const target=state.getReleaseTarget('prod')!;
    state.upsertReleaseTarget({...target,strategy:{mode:'managed-script',script:'#!/bin/sh\nexit 0\n'}});
    // Approve against the managed-script configuration, then exercise the actual run path.
    const fresh=await approve(), freshReceipt=await service.authorize(input({authorizationId:fresh.id}));
    const run=history('new-run',B,{status:'queued',operator:alice,governance:freshReceipt,previousReleaseId:'baseline'});
    state.addReleaseRun(run);await service.accept(run);
    const release=new ReleaseService(state,{governance:service});
    const ssh=vi.spyOn(release as any,'sshExec').mockImplementation(async()=>{await service.decide(fresh.id,'revoked',reviewer,'连接期间停止发布');return 'connected';});
    const restore=vi.spyOn(release as any,'restorePreviousAfterFailedProbe').mockResolvedValue(undefined);
    await expect((release as any).runRelease(run.releaseId)).rejects.toThrow('撤销');
    expect(ssh).toHaveBeenCalledTimes(1);expect(restore).not.toHaveBeenCalled();
  });
  it('旧短提交固定值解析为同一提交的完整身份并持久保存，不借用分支最新提交',async()=>{
    const branch=state.getBranch('feature')!;branch.pinnedCommit=B.slice(0,7);branch.githubCommitSha=C;
    vi.spyOn(git,'resolveCommit').mockResolvedValue(B);
    const record=await request();expect(record.candidateSha).toBe(B);
    expect(git.resolveCommit).toHaveBeenCalledWith('p',B.slice(0,7));
    expect(state.getBranch('feature')?.pinnedCommit).toBe(B);
    branch.pinnedCommit='eeeeeee';vi.mocked(git.resolveCommit).mockRejectedValue(new Error('ambiguous'));
    await expect(request()).rejects.toThrow('无法唯一核实');
    expect(state.getBranch('feature')?.pinnedCommit).toBe('eeeeeee');
  });
  it('待审批配额按申请人和项目隔离，撤销后可释放待批名额',async()=>{
    const records=[];
    for(let i=0;i<16;i++) records.push(await request());
    await expect(request()).rejects.toThrow('待审批申请已满');
    for(let i=0;i<16;i++) await request({actor:agent});
    await expect(request({actor:'ai:key:third'})).rejects.toThrow('待审批申请已满');
    await service.decide(records[0].id,'revoked',alice,'不再需要此申请');
    await expect(request()).resolves.toMatchObject({status:'pending'});
    expect(service.list('p').authorizations.filter(r=>r.status==='pending')).toHaveLength(32);
  });
  it('大范围申请不能耗尽其他项目的审批与放行空间，限额跨重启保留',async()=>{
    const paths=['allowed/',...Array.from({length:31},(_,i)=>`long-${i}-`+'x'.repeat(480))];
    let accepted=0, rejection='';
    for(let i=0;i<60;i++) {
      try { await request({kind:'debug',allowedPaths:paths,reason:'测'.repeat(2000)}); accepted++; }
      catch(error) { rejection=String(error);break; }
    }
    expect(accepted).toBeGreaterThan(0);expect(accepted).toBeLessThan(16);
    expect(rejection).toContain('本项目审批历史达到存储上限');
    expect(Buffer.byteLength(JSON.stringify(state.getReleaseGovernance()))).toBeLessThan(384*1024);
    const project=state.getProject('p')!;state.addProject({...project,id:'other',slug:'other'});
    state.addBranch({...state.getBranch('feature')!,id:'other-branch',projectId:'other'});
    state.upsertReleaseTarget({...state.getReleaseTarget('prod')!,id:'other-target',projectId:'other'});
    const pending=await request({targetId:'other-target',branchId:'other-branch'});
    await service.decide(pending.id,'approved',reviewer,'其他项目仍可核验并批准');
    expect(await service.authorize(input({projectId:'other',targetId:'other-target',branchId:'other-branch',authorizationId:pending.id})))
      .toMatchObject({authorizationId:pending.id,approvedBy:reviewer});
    const reloaded=new StateService(path.join(root,'state.json'),root);reloaded.load();
    expect(reloaded.getReleaseGovernance().authorizations[pending.id].status).toBe('approved');
    const restarted=new ReleaseGovernanceService(reloaded,git,undefined,()=>new Date(now));
    await expect(restarted.request({targetId:'prod',branchId:'feature',kind:'debug',allowedPaths:paths,
      reason:'测'.repeat(2000),actor:alice,expiresAt:new Date(now+3600000).toISOString()})).rejects.toThrow('本项目审批历史达到存储上限');
    await reloaded.flush();
  });
});
