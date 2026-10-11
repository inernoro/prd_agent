import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { BranchOperationCoordinator, BranchOperationSupersededError } from '../../src/services/branch-operation-coordinator.js';
import { StateService } from '../../src/services/state.js';

describe('DeploymentRunService', () => {
  let stateFile: string;
  let stateService: StateService;
  let clock: Date;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-deployment-run-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as any);
    stateService.addBranch({
      id: 'b1',
      projectId: 'p1',
      branch: 'feat/run-ledger',
      worktreePath: '/tmp/b1',
      services: {},
      status: 'idle',
      createdAt: '2026-07-10T00:00:00.000Z',
    });
    clock = new Date('2026-07-10T01:00:00.000Z');
  });

  afterEach(async () => {
    await stateService.flush();
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function createService(maxEvents = 500): DeploymentRunService {
    return new DeploymentRunService(stateService, {
      now: () => new Date(clock),
      idFactory: () => 'dr_test',
      maxEvents,
    });
  }

  it('persists the run before execution and links it from the branch', async () => {
    const service = createService();
    const run = await service.begin({
      projectId: 'p1',
      branchId: 'b1',
      trigger: 'webhook',
      commitSha: 'abc123',
    });

    expect(run.status).toBe('pending');
    expect(run.seq).toBe(1);
    expect(run.events[0].status).toBe('pending');
    expect(stateService.getBranch('b1')?.lastDeploymentRunId).toBe('dr_test');

    const reloadedState = new StateService(stateFile);
    reloadedState.load();
    expect(reloadedState.getDeploymentRun('dr_test')?.commitSha).toBe('abc123');
    expect(reloadedState.getBranch('b1')?.lastDeploymentRunId).toBe('dr_test');
  });

  async function verifying(service: DeploymentRunService) {
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    for (const status of ['preparing', 'building', 'starting', 'verifying'] as const) service.transition('dr_test', status, { phase: status, message: status });
    await stateService.flush();
  }

  it('keeps completion invisible until its real durable snapshot and owner fence succeed', async () => {
    const service = createService(); await verifying(service);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const complete = service.completeDurably('dr_test', { phase: 'complete', message: 'done' }, async () => {
      entered(); await gate; await stateService.flush();
    }, () => {});
    try {
      await started; expect(service.get('dr_test')?.status).toBe('verifying');
      expect(() => service.heartbeat('dr_test')).toThrow('finalizing');
      stateService.getBranch('b1')!.errorMessage = 'other entity'; stateService.save();
    } finally { release(); }
    await complete;
    const restored = new StateService(stateFile); restored.load();
    expect(restored.getDeploymentRun('dr_test')?.status).toBe('running');
    expect(service.get('dr_test')?.status).toBe('running');
    expect(restored.getBranch('b1')?.errorMessage).toBe('other entity');
  });

  it('does not seal running on real disk failure and can persist failed instead', async () => {
    const service = createService(); await verifying(service);
    fs.unlinkSync(stateFile); fs.mkdirSync(stateFile);
    try {
      await expect(service.completeDurably('dr_test', { phase: 'complete', message: 'done' }, () => stateService.flush(), () => {})).rejects.toThrow();
      expect(service.get('dr_test')?.status).toBe('verifying');
    } finally { fs.rmdirSync(stateFile); }
    service.fail('dr_test', { code: 'state_flush', category: 'platform', summary: 'disk failed', phase: 'state-flush', retryable: true } as any);
    await stateService.flush();
    const restored = new StateService(stateFile); restored.load();
    expect(restored.getDeploymentRun('dr_test')?.status).toBe('failed');
  });

  it('can cancel a completion superseded during its durable barrier without changing the newer branch', async () => {
    const service = createService(); await verifying(service);
    await expect(service.completeDurably('dr_test', { phase: 'complete', message: 'done' }, async () => {
      await stateService.flush(); stateService.getBranch('b1')!.status = 'starting'; stateService.save();
    }, () => { throw new Error('superseded'); })).rejects.toThrow('superseded');
    expect(service.get('dr_test')?.status).toBe('verifying');
    service.cancel('dr_test', 'new owner'); await stateService.flush();
    const restored = new StateService(stateFile); restored.load();
    expect(restored.getDeploymentRun('dr_test')?.status).toBe('cancelled');
    expect(restored.getBranch('b1')?.status).toBe('starting');
  });

  it('enforces legal transitions and keeps terminal runs immutable', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    service.transition('dr_test', 'preparing', { phase: 'pull', message: '正在准备源码' });
    service.transition('dr_test', 'building', { phase: 'build', message: '正在构建' });
    service.transition('dr_test', 'starting', { phase: 'start', message: '正在启动' });
    service.transition('dr_test', 'verifying', { phase: 'ready', message: '正在验证' });
    const completed = service.transition('dr_test', 'running', { phase: 'complete', message: '部署完成' });

    expect(completed.status).toBe('running');
    expect(completed.finishedAt).toBeTruthy();
    expect(completed.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(() => service.append('dr_test', {
      phase: 'late', level: 'info', status: 'done', message: '不应追加',
    })).toThrow(/terminal/);
  });

  it('rejects skipped states that would make the ledger ambiguous', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    expect(() => service.transition('dr_test', 'running', {
      phase: 'complete',
      message: '跳过全部阶段',
    })).toThrow(/pending -> running/);
  });

  it('supports afterSeq resume and reports a truncated event window', async () => {
    const service = createService(3);
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    service.append('dr_test', { phase: 'one', level: 'info', status: 'running', message: 'one' });
    service.append('dr_test', { phase: 'two', level: 'info', status: 'running', message: 'two' });
    service.append('dr_test', { phase: 'three', level: 'info', status: 'running', message: 'three' });

    const run = service.get('dr_test')!;
    expect(run.seq).toBe(4);
    expect(run.firstEventSeq).toBe(2);
    expect(service.getEventsAfter('dr_test', 2).events.map((event) => event.seq)).toEqual([3, 4]);
    expect(service.getEventsAfter('dr_test', 0).truncated).toBe(true);
  });

  it('reconciles stale non-terminal runs to a structured failure', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'system' });
    service.transition('dr_test', 'preparing', { phase: 'pull', message: '正在准备' });
    clock = new Date('2026-07-10T01:20:01.000Z');

    const reconciled = service.reconcileInterrupted(clock, 20 * 60 * 1000);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].status).toBe('failed');
    expect(reconciled[0].failure).toMatchObject({
      code: 'cds.run.interrupted',
      owner: 'cds',
      retryable: true,
    });
  });

  it('启动收尸：心跳早于本进程启动时刻的在途 run 一律收掉，不等 15 分钟；晚于启动的不动', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    service.transition('dr_test', 'preparing', { phase: 'pull', message: '正在准备' });
    // 上一个进程在 01:04 写了最后一次心跳
    clock = new Date('2026-07-10T01:04:00.000Z');
    service.append('dr_test', { phase: 'build', level: 'info', status: 'info', message: '构建心跳' });

    // 本进程 01:05 起来：心跳才停 1 分钟，周期收割不会碰它——但它已经没人推了
    const processStartedAt = new Date('2026-07-10T01:05:00.000Z');
    clock = new Date('2026-07-10T01:05:30.000Z');
    expect(service.reconcileInterrupted(clock, 15 * 60 * 1000)).toHaveLength(0);
    const orphaned = service.reconcileOrphanedByRestart(processStartedAt);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].status).toBe('failed');
    expect(orphaned[0].failure).toMatchObject({ code: 'cds.run.interrupted-by-restart', retryable: true });

    // 重入幂等
    expect(service.reconcileOrphanedByRestart(processStartedAt)).toHaveLength(0);
  });

  it('启动收尸不碰本进程起来之后才有心跳的 run', async () => {
    const service = createService();
    clock = new Date('2026-07-10T01:06:00.000Z');
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    service.transition('dr_test', 'preparing', { phase: 'pull', message: '正在准备' });
    expect(service.reconcileOrphanedByRestart(new Date('2026-07-10T01:05:00.000Z'))).toHaveLength(0);
    expect(service.get('dr_test')!.status).toBe('preparing');
  });

  it('reconcileInterrupted 周期语义：心跳新鲜不收割、终态跳过、重入幂等', async () => {
    const service = createService();
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual' });
    service.transition('dr_test', 'preparing', { phase: 'pull', message: '正在准备' });

    // 心跳新鲜（刚 append 过）→ 不收割
    clock = new Date('2026-07-10T01:05:00.000Z');
    service.append('dr_test', { phase: 'queue', level: 'info', status: 'info', message: '排队心跳' });
    expect(service.reconcileInterrupted(clock, 15 * 60 * 1000)).toHaveLength(0);

    // 心跳停跳超过阈值 → 收割为失败
    clock = new Date('2026-07-10T01:20:01.000Z');
    const reaped = service.reconcileInterrupted(clock, 15 * 60 * 1000);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].status).toBe('failed');

    // 已终态 → 第二轮（周期重入）不再处理，幂等
    clock = new Date('2026-07-10T02:00:00.000Z');
    expect(service.reconcileInterrupted(clock, 15 * 60 * 1000)).toHaveLength(0);
  });

  it('refuses a project and branch mismatch', async () => {
    const service = createService();
    await expect(service.begin({
      projectId: 'other',
      branchId: 'b1',
      trigger: 'manual',
    })).rejects.toThrow(/project mismatch/);
  });
  async function dispatchedLease() {
    const c = new BranchOperationCoordinator();
    const first = c.begin({ projectId: 'p1', branchId: 'b1', kind: 'deploy', trigger: 'manual', commitSha: 'a'.repeat(40) });
    c.begin({ projectId: 'p1', branchId: 'b1', profileId: 'api', kind: 'deploy-profile', trigger: 'webhook', commitSha: 'b'.repeat(40), commitPinned: true });
    const p = c.complete(first.lease!, 'completed')!; expect(await c.claimPending(p)).toBe(true); expect(c.markPendingSent(p)).toBe(true);
    const next = c.begin({ ...p.request, pendingOperationId: p.operationId, pendingGeneration: p.generation });
    expect(next.status).toBe('started'); return { c, lease: next.lease!, origin: p };
  }
  it('durably preserves immutable pending origin and rejects a wrong run scope', async () => {
    const service = createService(); await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' });
    const { lease, origin } = await dispatchedLease(); await service.bindPendingOrigin('dr_test', lease, () => {});
    const reloaded = new StateService(stateFile); reloaded.load(); expect(reloaded.getDeploymentRun('dr_test')?.pendingOrigin).toEqual({ version: 1, operationId: origin.operationId, generation: origin.generation, profileId: 'api' });
    await expect(service.bindPendingOrigin('dr_test', { ...lease, request: { ...lease.request, projectId: 'foreign' } }, () => {})).rejects.toThrow('pending_origin_scope');
    await expect(service.bindPendingOrigin('dr_test', { ...lease, request: { ...lease.request, pendingGeneration: origin.generation + 1 } }, () => {})).rejects.toThrow('pending_origin_scope');
    expect(service.get('dr_test')?.pendingOrigin?.generation).toBe(origin.generation);
  });
  it('binding deadline does not publish a draft even if the flush later resolves', async () => {
    const service = new DeploymentRunService(stateService, { idFactory: () => 'dr_test', pendingOriginTimeoutMs: 20 });
    await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' }); const { lease } = await dispatchedLease();
    let finish!: () => void; vi.spyOn(stateService, 'flush').mockImplementationOnce(() => new Promise<void>(r => finish = r));
    const binding = service.bindPendingOrigin('dr_test', lease, () => {}); await expect(binding).rejects.toThrow('pending_origin_unavailable');
    expect(service.get('dr_test')?.pendingOrigin).toBeUndefined(); finish(); await new Promise(r => setImmediate(r)); expect(service.get('dr_test')?.pendingOrigin).toBeUndefined();
  });
  it('cancellation ends binding before an unanswered flush and retains no published origin', async () => {
    const service = createService(); await service.begin({ projectId: 'p1', branchId: 'b1', trigger: 'webhook' }); const { c, lease } = await dispatchedLease();
    let finish!: () => void; let entered = false; vi.spyOn(stateService, 'flush').mockImplementationOnce(() => new Promise<void>(r => { entered = true; finish = r; }));
    const binding = service.bindPendingOrigin('dr_test', lease, () => {}); const rejection = expect(binding).rejects.toBeInstanceOf(BranchOperationSupersededError);
    await vi.waitFor(() => expect(entered).toBe(true)); c.cancelBranch('b1', 'owned cancel');
    try { await rejection; expect(service.get('dr_test')?.pendingOrigin).toBeUndefined(); } finally { finish(); }
  });

});
