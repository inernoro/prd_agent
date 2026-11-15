import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BSON } from 'mongodb';
import { ReleaseBatchService } from '../../src/services/release-batch-service.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseService, ReleaseStartInput } from '../../src/services/release-service.js';
import type { AcceptanceReportMeta, BranchEntry, DeploymentVersion, ReleaseRun, ReleaseTarget } from '../../src/types.js';
import type { ReleaseBatch } from '../../src/domain/release-batch.js';
import { endSelfUpdateDrain } from '../../src/services/deploy-drain.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const SHA = 'a'.repeat(40);
const NEXT_SHA = 'b'.repeat(40);
const BEFORE_SHA = 'c'.repeat(40);
const NOW = '2026-11-12T08:00:00.000Z';

describe('固定验收版本的批次发布协调器', () => {
  let root: string;
  let state: StateService;
  let coordinator: ReleaseBatchService;
  let service: ReturnType<typeof releaseStub>;
  let report: AcceptanceReportMeta;
  let counter: number;

  function releaseRun(targetId: string, extra: Partial<ReleaseRun> = {}): ReleaseRun {
    return { releaseId: `run-${++counter}`, projectId: 'p1', branchId: 'b1', targetId, planId: 'plan1',
      commitSha: SHA, artifact: { type: 'branch-preview', commitSha: SHA, branchId: 'b1', branchName: 'main' },
      status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), logs: [], seq: 0, ...extra };
  }

  function releaseStub() {
    return {
      onRunStarted: vi.fn(),
      isTargetBusy: vi.fn(() => ({ busy: false })),
      preflight: vi.fn(async (_input: ReleaseStartInput) => ({ ok: true, checks: [{ id: 'ci', label: '同提交 CI 成功', status: 'pass' as const, message: SHA, blocking: false }], preflightId: 'preflight-1' })),
      startRelease: vi.fn(async (input: ReleaseStartInput) => {
        input.assertDispatchAllowed?.();
        const run = releaseRun(input.targetId, { batchId: input.batchId, batchAttemptId: input.batchAttemptId,
          commitSha: input.expectedCommitSha!, artifact: input.batchSource!.artifact });
        state.addReleaseRun(run);
        return run;
      }),
      startRollback: vi.fn(async (runId: string, _operator?: string, previousReleaseId?: string,
        batch?: { id: string; attemptId: string; assertDispatchAllowed: () => void }) => {
        batch?.assertDispatchAllowed();
        const source = state.getReleaseRun(runId)!;
        const previous = state.getReleaseRun(previousReleaseId!)!;
        const run = releaseRun(source.targetId, { status: 'rollback_success', commitSha: previous.commitSha,
          artifact: previous.artifact, batchId: batch?.id, batchAttemptId: batch?.attemptId });
        state.addReleaseRun(run);
        return run;
      }),
      cancelRelease: vi.fn((runId: string) => {
        state.patchReleaseRun(runId, { status: 'failed', failure: { code: 'release.cancelled' } as never });
        return { ok: true };
      }),
      readRemoteReleaseState: vi.fn(async (_target: ReleaseTarget) => ({ inventory: { currentCommitSha: SHA }, readAt: NOW })),
    };
  }

  function addVersion(id: string, commitSha: string, projectId = 'p1', branchId = 'b1'): DeploymentVersion {
    return state.addDeploymentVersion({ id, projectId, branchId, commitSha, configHash: id, profiles: [], migrations: [], capabilities: [], createdByRunId: `build-${id}`, createdAt: NOW });
  }
  function addReport(extra: Partial<Parameters<StateService['createAcceptanceReport']>[0]> = {}): AcceptanceReportMeta {
    return state.createAcceptanceReport({ projectId: 'p1', branchId: 'b1', commitSha: SHA, verdict: 'pass', reportType: 'acceptance',
      title: '发布验收 · 固定提交 · 2026-11-12', content: '验收通过证据', format: 'md', createdAt: NOW, ...extra });
  }
  function create(key = 'create-key-0001') {
    return coordinator.create({ projectId: 'p1', versionId: 'v1', reportId: report.id, targetIds: ['site-a', 'site-b'], idempotencyKey: key, operator: 'user' });
  }
  async function settled(batchId: string): Promise<ReleaseBatch> {
    await vi.waitFor(() => expect(coordinator.get(batchId).status).not.toBe('running'));
    // A terminal status is visible before its final flush settles. Wait for the
    // backing store too before issuing a subsequent user action.
    await state.flush();
    await new Promise(resolve => setTimeout(resolve, 0));
    return coordinator.get(batchId);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-batch-test-'));
    state = new StateService(path.join(root, 'state.json'), root);
    state.load();
    counter = 0;
    for (const projectId of ['p1', 'p2']) {
      state.addProject({ id: projectId, name: projectId, slug: projectId, kind: 'git', createdAt: NOW, updatedAt: NOW });
      state.addBranch({ id: projectId === 'p1' ? 'b1' : 'b2', projectId, branch: 'main', worktreePath: root, services: {}, status: 'running', githubCommitSha: SHA, createdAt: NOW } as BranchEntry);
    }
    for (const targetId of ['site-a', 'site-b']) state.upsertReleaseTarget({ id: targetId, projectId: 'p1', name: targetId,
      type: 'ssh', isEnabled: true, createdAt: NOW, strategy: { mode: 'project-script', scriptFile: 'cds-release.sh' },
      ssh: { host: '127.0.0.1', port: 2222, user: 'deploy', privateKeyRef: 'fixture-host', appPath: `${root}/${targetId}`, deployCommand: '', healthcheckUrl: 'https://isolated.example.test/health' } });
    addVersion('v1', SHA);
    report = addReport();
    service = releaseStub();
    coordinator = new ReleaseBatchService(state, service as unknown as ReleaseService);
  });
  afterEach(async () => {
    endSelfUpdateDrain();
    await flushAllJsonStateStores();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('候选版本只取本项目完整提交及对应的通过验收记录', () => {
    addVersion('other-project', SHA, 'p2', 'b2');
    addReport({ projectId: 'p2', branchId: 'b2' });
    addVersion('short-sha', 'abcdef1');
    addReport({ commitSha: 'abcdef1' });
    expect(coordinator.acceptedVersions('p1')).toEqual([expect.objectContaining({ versionId: 'v1', commitSha: SHA, reportId: report.id })]);
    expect(coordinator.acceptedVersions('p1').every(version => version.commitSha.length === 40)).toBe(true);
  });

  it.each([
    ['code-review', { reportType: 'code-review' as const }],
    ['legacy-code-review', { reportType: undefined, title: '代码审查报告 · 固定提交 · 2026-11-12' }],
    ['monitor', { monitorEvent: { type: 'probe' } as never }],
    ['P0', { defectCounts: { p0: 1, p1: 0 } }],
    ['P1', { defectCounts: { p0: 0, p1: 1 } }],
    ['conditional', { verdict: 'conditional' as const }],
    ['cross-project', { projectId: 'p2', branchId: 'b2' }],
    ['short-report-sha', { commitSha: SHA.slice(0, 7) }],
  ])('不把 %s 报告当作已验收版本', (_name, changes) => {
    state.updateAcceptanceReport(report.id, { verdict: 'fail' });
    addVersion('candidate', NEXT_SHA);
    addReport({ commitSha: NEXT_SHA, ...changes, createdAt: '2026-11-12T08:01:00.000Z' });
    expect(coordinator.acceptedVersions('p1')).toEqual([]);
  });

  it('同提交的后来失败验收使旧通过记录失效，创建批次也拒绝旧报告', async () => {
    addReport({ verdict: 'fail', createdAt: '2026-11-12T09:00:00.000Z' });
    expect(coordinator.acceptedVersions('p1')).toEqual([]);
    await expect(create()).rejects.toThrow('通过验收记录');
  });

  it('创建同一幂等请求返回同一批次，版本和目标顺序不能借同键改变', async () => {
    const first = await create();
    const repeated = await create();
    expect(repeated.id).toBe(first.id);
    expect(state.getReleaseBatches('p1')).toHaveLength(1);
    await expect(coordinator.create({ projectId: 'p1', versionId: 'v1', reportId: report.id,
      targetIds: ['site-b', 'site-a'], idempotencyKey: 'create-key-0001', operator: 'user' })).rejects.toThrow('同一请求标识');
    expect(state.getReleaseBatches('p1')).toHaveLength(1);
  });

  it('预检与两目标执行始终传入冻结提交，批次中分支继续更新也不改分支状态', async () => {
    const created = await create();
    const originalBranch = structuredClone(state.getBranch('b1'));
    await coordinator.preflight(created.id);
    expect(state.getBranch('b1')).toEqual(originalBranch);
    const originalStart = service.startRelease.getMockImplementation()!;
    service.startRelease.mockImplementation(async input => {
      const run = await originalStart(input);
      if (input.targetId === 'site-a') state.updateBranchGithubMeta('b1', { githubCommitSha: NEXT_SHA });
      return run;
    });
    await coordinator.start(created.id, 'start-key-0001');
    const result = await settled(created.id);
    expect(result.status).toBe('success');
    expect(service.startRelease).toHaveBeenCalledTimes(2);
    expect(service.startRelease.mock.calls.map(([input]) => input.targetId)).toEqual(['site-a', 'site-b']);
    for (const [input] of [...service.preflight.mock.calls, ...service.startRelease.mock.calls]) {
      expect(input.expectedCommitSha).toBe(SHA);
      expect(input.batchSource?.artifact.commitSha).toBe(SHA);
    }
    expect(state.getBranch('b1')).toEqual({ ...originalBranch, githubCommitSha: NEXT_SHA });
  });

  it('一个目标失败仍执行并保留另一个目标真结果，重试只调用失败目标且仍发固定 SHA', async () => {
    const created = await create();
    await coordinator.preflight(created.id);
    const originalStart = service.startRelease.getMockImplementation()!;
    service.startRelease.mockImplementationOnce(async () => { throw new Error('仅 site-a 失败'); });
    await coordinator.start(created.id, 'start-key-0001');
    const partial = await settled(created.id);
    expect(partial.status).toBe('partial_success');
    expect(partial.targets.map(target => target.status)).toEqual(['failed', 'success']);
    const successfulRunId = partial.targets[1].runId;
    state.updateBranchGithubMeta('b1', { githubCommitSha: NEXT_SHA });
    service.startRelease.mockImplementation(originalStart);
    await coordinator.start(created.id, 'retry-key-0001', 'site-a');
    const retried = await settled(created.id);
    expect(retried.status).toBe('success');
    expect(service.startRelease.mock.calls.map(([input]) => input.targetId)).toEqual(['site-a', 'site-b', 'site-a']);
    expect(service.startRelease.mock.calls.at(-1)?.[0].expectedCommitSha).toBe(SHA);
    expect(retried.targets[1].runId).toBe(successfulRunId);
    expect(retried.targets[1].attempts).toHaveLength(1);
  });

  it('成功目标不能重试，同一启动回执重放不会再次调用发布服务', async () => {
    const created = await create();
    await coordinator.preflight(created.id);
    await coordinator.start(created.id, 'start-key-0001');
    await settled(created.id);
    await expect(coordinator.start(created.id, 'retry-key-0001', 'site-a')).rejects.toThrow('成功目标不会重复部署');
    const restarted = new ReleaseBatchService(state, service as unknown as ReleaseService);
    expect((await restarted.start(created.id, 'start-key-0001')).id).toBe(created.id);
    expect(service.startRelease).toHaveBeenCalledTimes(2);
    await expect(restarted.start(created.id, 'start-key-0001', 'site-a')).rejects.toThrow('幂等标识已用于其他操作');
    expect((await restarted.cancel(created.id, 'late-cancel-user')).status).toBe('success');
    expect(restarted.get(created.id).cancelRequested).not.toBe(true);
    expect(service.cancelRelease).not.toHaveBeenCalled();
  });

  it('Mongo BSON往返后的空目标回执仍可重放，且不接受同键逐目标操作', async () => {
    const created = await create();
    await coordinator.preflight(created.id);
    await coordinator.start(created.id, 'start-key-0001');
    const completed = await settled(created.id);
    const attempts = structuredClone(completed.targets.map(row => row.attempts));
    // Match the Mongo driver's default ignoreUndefined:false serialization.
    const persisted = BSON.deserialize(BSON.serialize(completed, { ignoreUndefined: false })) as ReleaseBatch;
    expect(persisted.requests['start-key-0001'].targetId).toBeNull();
    state.saveReleaseBatch(persisted);
    await state.flush();
    const restarted = new ReleaseBatchService(state, service as unknown as ReleaseService);

    expect((await restarted.start(created.id, 'start-key-0001')).id).toBe(created.id);
    expect(service.startRelease).toHaveBeenCalledTimes(2);
    expect(restarted.get(created.id).targets.map(row => row.attempts)).toEqual(attempts);
    await expect(restarted.start(created.id, 'start-key-0001', 'site-a')).rejects.toThrow('幂等标识已用于其他操作');
    await expect(restarted.start(created.id, 'start-key-0001', 'site-a', true)).rejects.toThrow('幂等标识已用于其他操作');
    expect(service.startRollback).not.toHaveBeenCalled();
  });

  it('受理回执首次持久化失败不派发，同键重放仍不派发，只有明确的新重试才执行', async () => {
    const created = await create();
    await coordinator.preflight(created.id);
    const flush = vi.spyOn(state, 'flush').mockRejectedValueOnce(new Error('存储暂不可写'));
    await expect(coordinator.start(created.id, 'start-key-0001')).rejects.toThrow('存储暂不可写');
    expect(service.startRelease).not.toHaveBeenCalled();
    expect(coordinator.get(created.id).status).toBe('interrupted');
    expect(coordinator.get(created.id).targets.every(target => target.status === 'interrupted')).toBe(true);
    const replayed = await coordinator.start(created.id, 'start-key-0001');
    expect(replayed.status).toBe('interrupted');
    expect(service.startRelease).not.toHaveBeenCalled();
    await coordinator.start(created.id, 'retry-key-0001', 'site-a', false, 'user:retry-operator');
    const retried = await settled(created.id);
    expect(service.startRelease).toHaveBeenCalledTimes(1);
    expect(service.startRelease.mock.calls[0][0]).toMatchObject({ targetId: 'site-a', expectedCommitSha: SHA, operator: 'user:retry-operator' });
    expect(retried.requests['retry-key-0001'].operator).toBe('user:retry-operator');
    expect(retried.targets[0].attempts[0].operator).toBe('user:retry-operator');
    expect(retried.targets[1].attempts).toHaveLength(0);
    flush.mockRestore();
  });

  it('预检后目标配置改变时停止派发，不能用旧预检发布到新位置', async () => {
    const created = await create();
    await coordinator.preflight(created.id);
    const target = state.getReleaseTarget('site-b')!;
    state.upsertReleaseTarget({ ...target, ssh: { ...target.ssh!, appPath: `${root}/different-site` } });
    await expect(coordinator.start(created.id, 'start-key-0001')).rejects.toThrow('目标配置已变更');
    expect(service.startRelease).not.toHaveBeenCalled();
  });

  it('批次创建后最新验收变为失败时阻断预检与执行', async () => {
    const created = await create();
    await coordinator.preflight(created.id);
    addReport({ verdict: 'fail', createdAt: '2026-11-12T09:00:00.000Z' });
    await expect(coordinator.preflight(created.id)).rejects.toThrow('最新验收未通过');
    await expect(coordinator.start(created.id, 'start-key-0001')).rejects.toThrow('最新验收未通过');
    expect(service.startRelease).not.toHaveBeenCalled();
  });

  it.each(['running', 'cancelled'] as const)('服务重启保留已终态目标，未完成目标标中断且不会自动派发（批次=%s）', async status => {
    const created = await create();
    const firstRun = releaseRun('site-a', { releaseId: 'completed-a', batchId: created.id, batchAttemptId: 'attempt-a' });
    state.addReleaseRun(firstRun);
    const secondRun = releaseRun('site-b', { releaseId: 'interrupted-b', status: 'running', finishedAt: undefined,
      batchId: created.id, batchAttemptId: 'attempt-b' });
    state.addReleaseRun(secondRun);
    created.status = status;
    if (status === 'cancelled') created.cancelRequested = true;
    created.requests['start-key-0001'] = { action: 'start' };
    for (const [index, row] of created.targets.entries()) {
      row.status = 'running';
      row.attempts = [{ id: index === 0 ? 'attempt-a' : 'attempt-b', kind: 'deploy', createdAt: NOW }];
    }
    state.saveReleaseBatch(created);
    await state.flush();
    const reloaded = new StateService(path.join(root, 'state.json'), root);
    reloaded.load();
    const restarted = new ReleaseBatchService(reloaded, service as unknown as ReleaseService);
    const recovered = restarted.get(created.id);
    expect(recovered.status).toBe(status === 'cancelled' ? 'cancelled' : 'interrupted');
    expect(recovered.targets[0]).toMatchObject({ status: 'success', runId: 'completed-a' });
    expect(recovered.targets[1]).toMatchObject({ status: 'interrupted', runId: 'interrupted-b' });
    expect(service.startRelease).not.toHaveBeenCalled();
    await restarted.start(created.id, 'start-key-0001');
    expect(service.startRelease).not.toHaveBeenCalled();
  });

  it('现场提交未知或不同版本，全部执行成功也不汇总成成功', async () => {
    const created = await create();
    await coordinator.preflight(created.id);
    service.readRemoteReleaseState.mockImplementation(async target => ({ inventory: { currentCommitSha: target.id === 'site-a' ? SHA : NEXT_SHA }, readAt: NOW }));
    await coordinator.start(created.id, 'start-key-0001');
    const result = await settled(created.id);
    expect(result.status).toBe('inconsistent');
    expect(result.targets.map(target => target.observedCommitSha)).toEqual([SHA, NEXT_SHA]);
    service.readRemoteReleaseState.mockImplementation(async () => ({ inventory: { currentCommitSha: '' }, readAt: NOW }));
    const refreshed = await coordinator.refresh(created.id);
    expect(refreshed.status).toBe('inconsistent');
    expect(refreshed.targets.every(target => target.observedCommitSha === undefined && target.observationError)).toBe(true);
  });

  it('回滚只恢复指定目标的批次前版本，重放回执不会重复回滚', async () => {
    for (const targetId of ['site-a', 'site-b']) state.addReleaseRun(releaseRun(targetId, { releaseId: `before-${targetId}`, commitSha: BEFORE_SHA,
      artifact: { type: 'branch-preview', commitSha: BEFORE_SHA }, startedAt: '2026-11-11T08:00:00.000Z' }));
    const created = await create();
    await coordinator.preflight(created.id);
    await coordinator.start(created.id, 'start-key-0001');
    await settled(created.id);
    service.readRemoteReleaseState.mockImplementation(async target => ({ inventory: { currentCommitSha: target.id === 'site-a' ? BEFORE_SHA : SHA }, readAt: NOW }));
    await coordinator.start(created.id, 'rollback-key-0001', 'site-a', true);
    const result = await settled(created.id);
    expect(result.status).toBe('inconsistent');
    expect(result.targets.map(target => target.status)).toEqual(['rolled_back', 'success']);
    expect(service.startRollback).toHaveBeenCalledWith(expect.any(String), 'user', 'before-site-a', expect.objectContaining({ id: created.id }));
    await coordinator.start(created.id, 'rollback-key-0001', 'site-a', true);
    expect(service.startRollback).toHaveBeenCalledTimes(1);
    expect(service.startRelease).toHaveBeenCalledTimes(2);
  });

  it.each([SHA, ''])('全部回滚执行成功但某目标读回原版本不符或未知时，不能汇总成已恢复（现场=%s）', async observed => {
    for (const targetId of ['site-a', 'site-b']) state.addReleaseRun(releaseRun(targetId, { releaseId: `before-${targetId}`, commitSha: BEFORE_SHA,
      artifact: { type: 'branch-preview', commitSha: BEFORE_SHA }, startedAt: '2026-11-11T08:00:00.000Z' }));
    const created = await create();
    await coordinator.preflight(created.id);
    await coordinator.start(created.id, 'start-key-0001');
    await settled(created.id);
    service.readRemoteReleaseState.mockImplementation(async target => ({ inventory: { currentCommitSha: target.id === 'site-a' ? BEFORE_SHA : observed }, readAt: NOW }));
    await coordinator.start(created.id, 'rollback-key-0001', 'site-a', true);
    await settled(created.id);
    await coordinator.start(created.id, 'rollback-key-0002', 'site-b', true);
    const result = await settled(created.id);
    expect(service.startRollback).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('inconsistent');
    expect(result.targets[1].observedCommitSha).toBe(observed || undefined);
    if (!observed) expect(result.targets[1].observationError).toBeTruthy();
  });
  it('取消落盘故障仍先中止当前写者，不继续下一目标', async () => {
    const batch = await create();
    const run = releaseRun('site-a', { status: 'running', batchId: batch.id, batchAttemptId: 'active-attempt' });
    state.addReleaseRun(run);
    state.saveReleaseBatch({ ...batch, status: 'running', targets: batch.targets.map(row =>
      row.targetId === 'site-a' ? { ...row, status: 'running', runId: run.releaseId } : row) });
    const flush = vi.spyOn(state, 'flush').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(coordinator.cancel(batch.id, 'owner')).rejects.toThrow('storage unavailable');
    expect(service.cancelRelease).toHaveBeenCalledWith(run.releaseId, 'owner');
    expect(state.getReleaseRun(run.releaseId)?.failure?.code).toBe('release.cancelled');
    expect(coordinator.get(batch.id).targets.find(row => row.targetId === 'site-b')?.status).toBe('cancelled');
    expect(service.startRelease).not.toHaveBeenCalled();
    flush.mockRestore();
  });

  it('目标派发回执落盘失败会收敛目标中断，而不遗留虚假的运行中或自动继续', async () => {
    const batch = await create(); await coordinator.preflight(batch.id);
    const flush = vi.spyOn(state, 'flush').mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('attempt persistence unavailable')).mockResolvedValue(undefined);
    await coordinator.start(batch.id, 'attempt-flush-failed');
    await vi.waitFor(() => expect(coordinator.get(batch.id).status).toBe('interrupted'));
    expect(coordinator.get(batch.id).targets.map(row => row.status)).toEqual(['interrupted', 'interrupted']);
    expect(service.startRelease).not.toHaveBeenCalled();
    await coordinator.start(batch.id, 'attempt-flush-failed');
    expect(service.startRelease).not.toHaveBeenCalled();
    flush.mockRestore();
  });

  it('批次收尾重新核对先完成目标，后续目标执行期间的现场变化不能沿用旧证据报全部成功', async () => {
    const batch = await create(); await coordinator.preflight(batch.id);
    const originalStart = service.startRelease.getMockImplementation()!;
    let firstTargetActual = SHA;
    service.startRelease.mockImplementation(async input => {
      const run = await originalStart(input);
      if (input.targetId === 'site-b') firstTargetActual = NEXT_SHA;
      return run;
    });
    service.readRemoteReleaseState.mockImplementation(async target => ({
      inventory: { currentCommitSha: target.id === 'site-a' ? firstTargetActual : SHA }, readAt: NOW,
    }));
    await coordinator.start(batch.id, 'final-observation-request');
    const result = await settled(batch.id);
    expect(result.status).toBe('inconsistent');
    expect(result.targets.map(row => row.observedCommitSha)).toEqual([NEXT_SHA, SHA]);
    expect(service.startRelease).toHaveBeenCalledTimes(2);
  });

});
