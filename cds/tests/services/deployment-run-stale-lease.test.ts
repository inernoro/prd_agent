import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchOperationCoordinator, BranchOperationSupersededError, type BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { DeploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import { StateService } from '../../src/services/state.js';

describe('部署心跳过期后的精确租约回收', () => {
  let directory: string;
  let state: StateService;
  let coordinator: BranchOperationCoordinator;
  let runs: DeploymentRunService;
  let clock: Date;

  const request: BranchOperationRequest = {
    projectId: 'p1', branchId: 'b1', profileId: 'api', kind: 'deploy-profile',
    trigger: 'manual', commitSha: 'a'.repeat(40), commitPinned: true,
    configHash: 'same-config', source: 'stale-lease-regression',
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-stale-lease-'));
    state = new StateService(path.join(directory, 'state.json'));
    state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: '租约回归项目' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'codex/stale-lease-regression',
      worktreePath: '/tmp/stale-lease-regression', services: {}, status: 'idle', createdAt: '2026-10-15T00:00:00.000Z' });
    clock = new Date('2026-10-15T00:00:00.000Z');
    coordinator = new BranchOperationCoordinator();
    runs = new DeploymentRunService(state, { now: () => new Date(clock) });
    runs.bindOperationCoordinator(coordinator);
  });

  afterEach(async () => {
    await state.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function trackedDeployment(input = request) {
    const decision = coordinator.begin(input);
    expect(decision.status).toBe('started');
    const run = await runs.begin({ projectId: input.projectId || 'default', branchId: input.branchId,
      profileId: input.profileId || undefined, trigger: 'manual', operationId: decision.operationId,
      operationGeneration: decision.generation });
    runs.transition(run.id, 'preparing', { phase: 'prepare', message: '准备部署' });
    runs.transition(run.id, 'building', { phase: 'build', message: '开始构建' });
    return { decision, lease: decision.lease!, run };
  }

  function reapAfterSilence() {
    clock = new Date(clock.getTime() + 16 * 60_000);
    return runs.reconcileInterrupted();
  }

  it.each([undefined, 'embedded', 'master-current'])('本节点%s不能只把运行账本写成失败而继续保留原执行租约', async executorId => {
    const old = await trackedDeployment();
    old.run.executorId = executorId;
    state.getBranch('b1')!.executorId = executorId;
    expect(reapAfterSilence().map(run => run.id)).toEqual([old.run.id]);
    expect(runs.get(old.run.id)?.failure?.code).toBe('cds.run.interrupted');
    expect(old.lease.isCurrent()).toBe(false);
    expect(coordinator.getActiveOperations('b1')).toEqual([]);
  });

  it.each([
    { name: '远端run', runExecutor: 'remote-1' },
    { name: '远端branch', branchExecutor: 'remote-1' },
    { name: '非本地标记local的run', runExecutor: 'local' },
    { name: '非本地标记local的branch', branchExecutor: 'local' },
    { name: '分支已换项目', branchProject: 'p2' },
    { name: '原操作项目不匹配', branchProject: 'p2', runProject: 'p2' },
    { name: '原操作服务不匹配', profileId: 'web' },
    { name: '分支已不存在', missingBranch: true },
  ].flatMap(scope => [false, true].map(waiting => ({ ...scope, waiting }))))
  ('$name且等待判据为$waiting时只按原行为记失败，不豁免或撤销Master资格', async scope => {
    const waiting = vi.fn(() => scope.waiting);
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting: waiting });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment();
    old.run.executorId = 'runExecutor' in scope ? scope.runExecutor : undefined;
    if ('runProject' in scope) old.run.projectId = scope.runProject!;
    if ('profileId' in scope) old.run.profileId = scope.profileId;
    const branch = state.getBranch('b1')!;
    branch.executorId = 'branchExecutor' in scope ? scope.branchExecutor : undefined;
    if ('branchProject' in scope) branch.projectId = scope.branchProject!;
    if ('missingBranch' in scope) state.removeBranch('b1');
    expect(reapAfterSilence().map(run => run.id)).toEqual([old.run.id]);
    expect(old.run.failure?.code).toBe('cds.run.interrupted');
    expect(old.lease.isCurrent()).toBe(true);
    expect(waiting).not.toHaveBeenCalled();
  });

  it('回收旧租约后后继目标可由既有派发器领取，保持原操作和代次', async () => {
    const old = await trackedDeployment();
    const next = coordinator.begin({ ...request, commitSha: 'b'.repeat(40) });
    expect(next.status).toBe('merged');
    reapAfterSilence();
    const [claimed] = coordinator.drainReady();
    expect(claimed).toMatchObject({ operationId: next.operationId, generation: next.generation });
    const resumed = coordinator.begin({ ...claimed.request,
      pendingReplay: { operationId: claimed.operationId, generation: claimed.generation } });
    expect(resumed).toMatchObject({ status: 'started', operationId: next.operationId, generation: next.generation });
    expect(old.lease.isCurrent()).toBe(false);
    coordinator.completeAll(old.lease, 'cancelled');
    expect(resumed.lease!.isCurrent()).toBe(true);
  });

  it('超时旧执行体在迟到回调中不能继续通过写入资格围栏', async () => {
    const old = await trackedDeployment();
    reapAfterSilence();
    let overwritten = false;
    expect(() => {
      old.lease.assertCurrent('迟到的容器或分支状态回写');
      overwritten = true;
    }).toThrow(BranchOperationSupersededError);
    expect(overwritten).toBe(false);
    expect(runs.get(old.run.id)?.status).toBe('failed');
  });

  it('回收只命中原范围，不取消同分支其他服务、其他项目或其他分支的租约', async () => {
    const old = await trackedDeployment();
    const sibling = coordinator.begin({ ...request, profileId: 'web' });
    const anotherProject = coordinator.begin({ ...request, projectId: 'p2' });
    const anotherBranch = coordinator.begin({ ...request, branchId: 'b2' });
    expect(sibling.status).toBe('started');
    expect(anotherProject.status).toBe('started');
    expect(anotherBranch.status).toBe('started');
    reapAfterSilence();
    expect(old.lease.isCurrent()).toBe(false);
    expect(sibling.lease!.isCurrent()).toBe(true);
    expect(anotherProject.lease!.isCurrent()).toBe(true);
    expect(anotherBranch.lease!.isCurrent()).toBe(true);
  });

  it('相同操作ID已经续接新代次时，回收旧run不得取消新租约或新待办', async () => {
    const old = await trackedDeployment({ ...request, kind: 'force-rebuild', continueWith: 'deploy-profile' });
    coordinator.completeAll(old.lease, 'completed');
    const continued = coordinator.begin(request);
    expect(continued.operationId).toBe(old.decision.operationId);
    expect(continued.generation).toBeGreaterThan(old.decision.generation);
    const next = coordinator.begin({ ...request, commitSha: 'c'.repeat(40) });
    expect(next.status).toBe('merged');
    reapAfterSilence();
    expect(runs.get(old.run.id)?.status).toBe('failed');
    expect(continued.lease!.isCurrent()).toBe(true);
    expect(coordinator.getPendingWebhookDeploy('b1', 'api')?.operationId).toBe(next.operationId);
    expect(coordinator.drainReady()).toEqual([]);
  });

  it('旧代次运行不能借等待判据豁免，也不能撤销已续接的当前代次', async () => {
    const waiting = vi.fn(() => true);
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting: waiting });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment({ ...request, kind: 'force-rebuild', continueWith: 'deploy-profile' });
    coordinator.completeAll(old.lease, 'completed');
    const continued = coordinator.begin(request);
    expect(continued.operationId).toBe(old.lease.operationId);
    expect(continued.generation).toBeGreaterThan(old.lease.generation);
    expect(reapAfterSilence().map(run => run.id)).toEqual([old.run.id]);
    expect(waiting).not.toHaveBeenCalled();
    expect(continued.lease!.isCurrent()).toBe(true);
  });

  it('实际阶段等待不被15分钟心跳误杀，但原20分钟截止后仍回收，不伪造心跳', async () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock.getTime());
    const budget = new DeploymentPhaseBudget(() => 0);
    const controller = new AbortController();
    runs = new DeploymentRunService(state, { now: () => new Date(clock),
      isExecutionWaiting: (run, at) => Boolean(run.operationId && run.operationGeneration !== undefined
        && (budget.waitingOperation(run.operationId, run.operationGeneration)?.deadlineAt || 0) > at.getTime()) });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment();
    const heartbeat = old.run.heartbeatAt;
    const waiting = budget.acquire('start', { projectId: 'p1', branchId: 'b1', profileId: 'api',
      operationId: old.lease.operationId, operationGeneration: old.lease.generation }, {
      check: () => old.lease.assertCurrent('排队资格'), signal: controller.signal,
    }).catch(() => undefined);
    try {
      clock = new Date(clock.getTime() + 16 * 60_000);
      expect(runs.reconcileInterrupted()).toEqual([]);
      expect(runs.get(old.run.id)?.heartbeatAt).toBe(heartbeat);
      expect(old.lease.isCurrent()).toBe(true);
      clock = new Date(clock.getTime() + 5 * 60_000);
      expect(runs.reconcileInterrupted().map(run => run.id)).toEqual([old.run.id]);
      expect(old.lease.isCurrent()).toBe(false);
      budget.pump();
      await waiting;
    } finally { controller.abort(); await waiting; now.mockRestore(); }
  });

  it('旧预算中没有资格check的队列不能生成等待事实或阻止收割', async () => {
    const budget = new DeploymentPhaseBudget(() => 0), controller = new AbortController();
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting: run =>
      !!budget.waitingOperation(run.operationId!, run.operationGeneration!) });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment();
    const waiting = budget.acquire('start', { operationId: old.lease.operationId, operationGeneration: old.lease.generation },
      { signal: controller.signal }).catch(() => undefined);
    try {
      expect(budget.waitingOperation(old.lease.operationId, old.lease.generation)).toBeUndefined();
      expect(reapAfterSilence().map(run => run.id)).toEqual([old.run.id]);
    } finally { controller.abort(); await waiting; }
  });

  it.each([
    { projectId: 'p2', branchId: 'b1', profileId: 'api' },
    { projectId: 'p1', branchId: 'b2', profileId: 'api' },
    { projectId: 'p1', branchId: 'b1', profileId: 'web' },
  ])('伪造或陈旧的范围不能撤销其他当前身份：%o', async scope => {
    const old = await trackedDeployment();
    expect(coordinator.revokeInterrupted({ ...scope, operationId: old.lease.operationId,
      generation: old.lease.generation })).toBe(false);
    expect(old.lease.isCurrent()).toBe(true);
  });

  it('生产装配实际传递原代次并查询同一阶段队列，不能只在测试注入等待判据', () => {
    const server = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const routes = fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8');
    expect(server).toContain('deploymentPhaseBudget.waitingOperation(run.operationId, run.operationGeneration)?.deadlineAt');
    const leasedLaunches = (routes.match(/runServiceWithPortRetry\(\{[\s\S]*?\n\s*\}\)/g) || [])
      .filter(call => call.includes('assertBranchOperationCurrent(branchOperationLease'));
    expect(leasedLaunches).toHaveLength(2);
    for (const call of leasedLaunches) expect(call).toContain('operationGeneration: branchOperationLease?.generation');
    expect(routes).toContain('operationGeneration: options.operationGeneration');
  });

  it('启动装配在受理请求前仅盘点本执行节点，不把远端缺席当作本机释放依据', () => {
    const source = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("config.mode === 'executor' || !isRemoteExecutorOwned(branch.executorId)");
    const restore = source.indexOf('restoreDeploymentMemoryReservations(localMemoryBranches,');
    const reconcile = source.indexOf('containerService.reconcileDeploymentMemoryReservations(localMemoryBranches,');
    expect(restore).toBeGreaterThan(source.indexOf('const containerService = new ContainerService('));
    expect(reconcile).toBeGreaterThan(restore);
    expect(reconcile).toBeLessThan(source.indexOf('const app = createServer('));
    expect(source).toContain('creationSettled: (_owner, runtime) => Boolean(runtime.containerId && /^[a-f0-9]{64}$/.test(runtime.containerId))');
  });
});
