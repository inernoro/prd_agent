import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchOperationCoordinator, BranchOperationSupersededError, type BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';
import { DeploymentRunService, DEPLOYMENT_RUN_TERMINAL_STATUSES } from '../../src/services/deployment-run.js';
import { DeploymentPhaseBudget, deploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import { ContainerService } from '../../src/services/container.js';
import type { CdsConfig, ExecOptions, ExecResult, OperationLogEvent } from '../../src/types.js';
import { StateService } from '../../src/services/state.js';
import { drainInFlightDeploys, beginSelfUpdateDrain, endSelfUpdateDrain, collectDrainableRuns,
  DRAIN_GATE_MAX_HOLD_MS, resolveSelfUpdateDrainTimeoutMs, SelfUpdateRestartBlockedError,
  selfUpdateDrainBlockReason } from '../../src/services/deploy-drain.js';

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

  function actualCleanupInvocation(index: number, old: Awaited<ReturnType<typeof trackedDeployment>>, events: OperationLogEvent[]) {
    const source = ts.createSourceFile('branches.ts', fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
    const functions: string[] = [], contexts: string[] = [], methods: string[] = [];
    const names = ['createCleanupProgressReporter', 'appendDeploymentRunEvent', 'assertBranchOperationCurrent'];
    let reporterFound = false;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
        functions.push(node.getText(source));
        if (node.name.text === names[0]) reporterFound = true;
      }
      if (ts.isCallExpression(node) && /^containerService\.remove(?:RuntimeGroup)?$/.test(node.expression.getText(source))) {
        const context = node.arguments[1];
        if (context && ts.isObjectLiteralExpression(context) && context.properties.some(property =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === 'operation'
          && /^['"]deploy-(?:empty-profiles-cleanup|remove-orphan-service)['"]$/.test(property.initializer.getText(source)))) {
          contexts.push(context.getText(source)); methods.push(node.expression.getText(source).split('.')[1]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source); expect(contexts).toHaveLength(3);
    expect(methods).toEqual(['removeRuntimeGroup', 'remove', 'removeRuntimeGroup']);
    const functionSource = ts.transpileModule(functions.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const functionsAtRuntime = new Function('deploymentRunService', 'stateService', 'DEPLOYMENT_RUN_TERMINAL_STATUSES',
      `${functionSource}\nreturn { appendDeploymentRunEvent, assertBranchOperationCurrent, createCleanupProgressReporter: ${reporterFound ? 'createCleanupProgressReporter' : 'undefined'} };`)(runs, state, DEPLOYMENT_RUN_TERMINAL_STATUSES);
    const logEvent = (event: OperationLogEvent) => { functionsAtRuntime.appendDeploymentRunEvent(old.run.id, event); events.push(event); };
    const bindings = { ...functionsAtRuntime, entry: state.getBranch('b1'), sid: 'api', cleanupRun: old.run,
      cleanupLease: old.lease, deploymentRun: old.run, branchOperationLease: old.lease,
      cleanupReqId: 'test-request', requestId: 'test-request', cActor: 'tester', oActor: 'tester', zActor: 'tester',
      cTrigger: 'manual', oTrigger: 'manual', zTrigger: 'manual', logEvent, res: {},
      sendSSE: (_res: unknown, _type: unknown, event: OperationLogEvent) => events.push(event) };
    const compiled = ts.transpileModule(`const context = ${contexts[index]};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return { method: methods[index], context: new Function(...Object.keys(bindings), `${compiled}\nreturn context;`)(...Object.values(bindings)) };
  }

  function actualCleanupContext(index: number, old: Awaited<ReturnType<typeof trackedDeployment>>, events: OperationLogEvent[]) {
    return actualCleanupInvocation(index, old, events).context;
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

  it('真实16分钟start等待同时约束收割与排空，原排空预算内不能当作无在途', async () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock.getTime());
    const budget = new DeploymentPhaseBudget(() => 0), controller = new AbortController();
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting: (run, at) =>
      Boolean(run.operationId && run.operationGeneration !== undefined
        && (budget.waitingOperation(run.operationId, run.operationGeneration)?.deadlineAt || 0) > at.getTime()) });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment(), heartbeat = old.run.heartbeatAt;
    const waiting = budget.acquire('start', { projectId: 'p1', branchId: 'b1', profileId: 'api',
      operationId: old.lease.operationId, operationGeneration: old.lease.generation }, {
      check: () => old.lease.assertCurrent('排空阶段资格'), signal: controller.signal,
    }).catch(() => undefined);
    try {
      clock = new Date(clock.getTime() + 16 * 60_000);
      expect(budget.waitingOperation(old.lease.operationId, old.lease.generation)?.deadlineAt).toBeGreaterThan(clock.getTime());
      expect(runs.reconcileInterrupted()).toEqual([]);
      const out = await drainInFlightDeploys({ listRuns: () => runs.list(), now: () => clock.getTime(),
        sleep: async ms => { clock = new Date(clock.getTime() + ms); }, timeoutMs: 1000 });
      expect(out).toMatchObject({ drained: false, skipped: false, remaining: [old.run.id], waitedMs: 1000 });
      expect(old.run.heartbeatAt).toBe(heartbeat); expect(old.lease.isCurrent()).toBe(true);
      coordinator.completeAll(old.lease, 'completed');
      expect(runs.hasQualifiedExecutionWait(old.run.id, clock)).toBe(false);
      expect(await drainInFlightDeploys({ listRuns: () => runs.list(), now: () => clock.getTime(),
        sleep: async () => { throw new Error('零等待不得轮询'); }, timeoutMs: 0 }))
        .toMatchObject({ drained: false, remaining: [old.run.id] });
      budget.pump(); await waiting;
    } finally { controller.abort(); await waiting; now.mockRestore(); }
  });

  it.each([0, 1, 2])('真实cleanup入口%s等待16分钟后获准且stop尚在途时，原运行和原代次不得被收割', async index => {
    const source = ts.createSourceFile('server.ts', fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
    let predicate: string | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'DeploymentRunService') {
        const options = node.arguments?.[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          const property = options.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === 'isExecutionWaiting');
          if (property && ts.isPropertyAssignment(property)) predicate = property.initializer.getText(source);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source); expect(predicate).toBeTruthy();
    const compiled = ts.transpileModule(`const waiting = ${predicate};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    });
    const isExecutionWaiting = new Function('deploymentPhaseBudget', `${compiled.outputText}\nreturn waiting;`)(deploymentPhaseBudget);
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment({ ...request, kind: 'deploy', profileId: undefined }), heartbeat = old.run.heartbeatAt;
    const events: OperationLogEvent[] = [], { method, context } = actualCleanupInvocation(index, old, events);
    const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api',
      operationId: old.lease.operationId, operationGeneration: old.lease.generation };
    const cid = 'a'.repeat(64), name = 'cds-b1-api', target = method === 'remove' ? name : cid, commands: string[] = [];
    let finishStop!: (value: ExecResult) => void, stopStarted!: () => void, stopPending = false, settled = false, removed = false;
    const stopEntered = new Promise<void>(resolve => { stopStarted = resolve; });
    const stopResponse = new Promise<ExecResult>(resolve => { finishStop = resolve; });
    const ok = (): ExecResult => ({ stdout: '', stderr: '', exitCode: 0 });
    const shell = { exec: async (command: string, options?: ExecOptions): Promise<ExecResult> => {
      options?.beforeStart?.();
      commands.push(command);
      if (command.startsWith('docker inspect --format') && command.includes('"networks"')) return {
        ...ok(), stdout: JSON.stringify({ id: cid, running: true, project: 'p1', branch: 'b1', profile: 'api',
          networks: { 'test-network': { Aliases: ['api'] } } }),
      };
      if (command.startsWith('docker inspect --format') && removed) return {
        stdout: '', stderr: `Error: No such container: ${cid}`, exitCode: 1,
      };
      if (command.startsWith('docker inspect ')) return {
        ...ok(), stdout: JSON.stringify([{ Id: cid, State: { Status: 'running', Running: true } }]),
      };
      if (command.startsWith('docker logs ')) return ok();
      if (command === `docker stop ${target}`) {
        stopPending = true; stopStarted();
        try { return await stopResponse; } finally { stopPending = false; }
      }
      if (command === `docker rm ${target}`) { removed = true; return ok(); }
      throw new Error(`测试未授权的shell命令：${command}`);
    } };
    const config: CdsConfig = { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'test-network', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test-secret', issuer: 'test' } };
    const container = new ContainerService(shell, config);
    const releaseBlocker = await deploymentPhaseBudget.acquire('cleanup', { projectId: 'other-project', branchId: 'other-branch' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    const removing = method === 'remove'
      ? container.remove(name, context)
      : container.removeRuntimeGroup({ profileId: 'api', containerName: name,
        containerId: cid, hostPort: 10001, status: 'running' }, context);
    const completed = removing.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(deploymentPhaseBudget.waitingOperation(owner.operationId, owner.operationGeneration)).toMatchObject({ phase: 'cleanup' }));
      expect(commands.some(command => command.startsWith('docker stop '))).toBe(false);
      clock = new Date(clock.getTime() + 16 * 60_000); vi.setSystemTime(clock);
      expect(runs.reconcileInterrupted()).toEqual([]);
      expect(old.run.heartbeatAt).toBe(heartbeat);
      expect(events).toEqual([]);
      expect(old.lease.isCurrent()).toBe(true);
      releaseBlocker();
      await stopEntered;
      expect(commands).toContain(`docker stop ${target}`);
      expect(commands).not.toContain(`docker rm ${target}`);
      expect(settled).toBe(false);
      expect(deploymentPhaseBudget.waitingOperation(owner.operationId, owner.operationGeneration)).toBeUndefined();
      expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([expect.objectContaining(owner)]);
      const reaped = runs.reconcileInterrupted().map(run => run.id);
      expect({ reaped, status: old.run.status, leaseCurrent: old.lease.isCurrent(), stopPending, settled }).toEqual({
        reaped: [], status: 'building', leaseCurrent: true, stopPending: true, settled: false,
      });
      expect(events.map(event => event.detail?.cleanupStep)).toEqual(['admitted', 'diagnostics-returned', 'stop']);
      expect(events.every(event => event.detail?.runId === old.run.id && event.detail?.operationId === owner.operationId
        && event.detail?.operationGeneration === owner.operationGeneration && event.detail?.projectId === 'p1'
        && event.detail?.branchId === 'b1' && event.detail?.profileId === 'api')).toBe(true);
      expect(old.run.heartbeatAt).toBe(clock.toISOString());
      finishStop(ok()); await completed;
      expect(events.map(event => event.detail?.cleanupStep)).toEqual(['admitted', 'diagnostics-returned', 'stop', 'stop-returned', 'rm', 'rm-returned']);
      expect(removed).toBe(true); expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([]);
      console.log('[cleanup-actual-method]', JSON.stringify({ index, method, target,
        cleanupSteps: events.map(event => event.detail?.cleanupStep), leaseCurrent: old.lease.isCurrent() }));
      expect(runs.reconcileInterrupted()).toEqual([]);
      // 完成后不再有真实进展；不能把曾获准的active当作永久存活事实。
      clock = new Date(clock.getTime() + 16 * 60_000); vi.setSystemTime(clock);
      expect(runs.reconcileInterrupted().map(run => run.id)).toEqual([old.run.id]);
    } finally {
      finishStop(ok()); releaseBlocker(); await completed; vi.useRealTimers();
    }
  });

  it.each(['diagnostics', 'stop'] as const)('真实%s返回后下一命令仍在原15分钟排队预算内，不得借上一步旧心跳收割', async boundary => {
    const old = await trackedDeployment({ ...request, kind: 'deploy', profileId: undefined }), events: OperationLogEvent[] = [];
    const context = actualCleanupContext(1, old, events), name = 'cds-b1-api';
    const ok = (): ExecResult => ({ stdout: '', stderr: '', exitCode: 0 });
    let queued!: () => void, resume!: () => void, settled = false, queuedAt = 0;
    const entered = new Promise<void>(resolve => { queued = resolve; });
    const slot = new Promise<void>(resolve => { resume = resolve; });
    const physical: string[] = [];
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock);
    const moveClock = (ms: number) => { clock = new Date(clock.getTime() + ms); vi.setSystemTime(clock); };
    const container = new ContainerService({ exec: async (command, options) => {
      if (command.startsWith('docker inspect ')) {
        if (boundary === 'diagnostics') moveClock(1000); // 原5秒诊断预算内的真实返回。
        return { ...ok(), stdout: '[]' };
      }
      if (command.startsWith('docker logs ')) return ok();
      const action = /^docker (stop|rm) /.exec(command)?.[1];
      if (action === (boundary === 'diagnostics' ? 'stop' : 'rm')) { queuedAt = clock.getTime(); queued(); await slot; }
      options?.beforeStart?.();
      if (action) physical.push(action);
      if (action === 'stop' && boundary === 'stop') moveClock(14 * 60_000); // 原15分钟执行预算内成功返回。
      return ok();
    } }, { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'test-network', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test-secret', issuer: 'test' } });
    deploymentPhaseBudget.reserveKnownMemory(name, 512, { projectId: 'p1', branchId: 'b1', profileId: 'api',
      operationId: old.lease.operationId, operationGeneration: old.lease.generation });
    const removing = container.remove(name, context);
    const completed = removing.then(() => { settled = true; }, () => { settled = true; });
    try {
      await entered;
      moveClock(boundary === 'diagnostics' ? 15 * 60_000 - 500 : 2 * 60_000);
      expect(clock.getTime() - queuedAt).toBeLessThan(15 * 60_000);
      expect(physical).toEqual(boundary === 'diagnostics' ? [] : ['stop']);
      expect(settled).toBe(false); expect(deploymentPhaseBudget.snapshot().cleanup.active).toHaveLength(1);
      const reaped = runs.reconcileInterrupted().map(run => run.id);
      expect({ reaped, status: old.run.status, leaseCurrent: old.lease.isCurrent() }).toEqual({
        reaped: [], status: 'building', leaseCurrent: true,
      });
    } finally { resume(); await completed; vi.useRealTimers(); }
  });

  it('真实rm返回后原CID确认仍在5秒预算内，不能被rm派发时的旧心跳误收割', async () => {
    const old = await trackedDeployment({ ...request, kind: 'deploy', profileId: undefined }), events: OperationLogEvent[] = [];
    const context = actualCleanupContext(2, old, events), cid = 'a'.repeat(64), name = 'cds-b1-api';
    const ok = (): ExecResult => ({ stdout: '', stderr: '', exitCode: 0 });
    let entered!: () => void, finish!: () => void, settled = false;
    const inspecting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock);
    const container = new ContainerService({ exec: async (command, options) => {
      options?.beforeStart?.();
      if (command.startsWith('docker inspect --format') && command.includes('"networks"')) return { ...ok(), stdout: JSON.stringify({
        id: cid, running: true, project: 'p1', branch: 'b1', profile: 'api', networks: { 'test-network': { Aliases: ['api'] } } }) };
      if (command.startsWith('docker inspect --format')) {
        clock = new Date(clock.getTime() + 2000); vi.setSystemTime(clock); entered(); await response;
        return { stdout: '', stderr: `Error: No such container: ${cid}`, exitCode: 1 };
      }
      if (command.startsWith('docker inspect ')) return { ...ok(), stdout: '[]' };
      if (command.startsWith('docker logs ')) return ok();
      if (command === `docker stop ${cid}`) return ok();
      if (command === `docker rm ${cid}`) {
        clock = new Date(clock.getTime() + 15 * 60_000 - 1000); vi.setSystemTime(clock); return ok();
      }
      throw new Error(`测试未授权的shell命令：${command}`);
    } }, { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'test-network', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test-secret', issuer: 'test' } });
    deploymentPhaseBudget.reserveKnownMemory(name, 512, { projectId: 'p1', branchId: 'b1', profileId: 'api',
      operationId: old.lease.operationId, operationGeneration: old.lease.generation });
    const removing = container.removeRuntimeGroup({ profileId: 'api', containerName: name, containerId: cid, hostPort: 10001, status: 'running' }, context);
    const completed = removing.then(() => { settled = true; }, () => { settled = true; });
    try {
      await inspecting; expect(settled).toBe(false);
      expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual([name]);
      const reaped = runs.reconcileInterrupted().map(run => run.id);
      expect({ reaped, status: old.run.status, leaseCurrent: old.lease.isCurrent() }).toEqual({
        reaped: [], status: 'building', leaseCurrent: true,
      });
    } finally { finish(); await completed; vi.useRealTimers(); }
  });

  it.each(['running', 'failed', 'cancelled', 'project', 'branch', 'profile', 'operation', 'generation', 'superseded'] as const)(
    '实际cleanup回写不复活终态或串写失效身份：%s', async boundary => {
      const old = await trackedDeployment(), events: OperationLogEvent[] = [];
      const context = actualCleanupContext(1, old, events);
      if (boundary === 'running') { runs.transition(old.run.id, 'starting', { phase: 'start', message: '启动' });
        runs.transition(old.run.id, 'verifying', { phase: 'ready', message: '就绪' }); runs.transition(old.run.id, 'running', { phase: 'ready', message: '完成' }); }
      else if (boundary === 'failed') runs.fail(old.run.id, { code: 'test', owner: 'cds', retryable: true, summary: '测试失败', phase: 'test', evidenceRefs: [] });
      else if (boundary === 'cancelled') runs.cancel(old.run.id, '测试取消');
      else if (boundary === 'superseded') coordinator.revokeInterrupted({ operationId: old.lease.operationId,
        generation: old.lease.generation, projectId: 'p1', branchId: 'b1', profileId: 'api' });
      else if (boundary === 'project') old.run.projectId = 'other';
      else if (boundary === 'branch') old.run.branchId = 'other';
      else if (boundary === 'profile') old.run.profileId = 'other';
      else if (boundary === 'operation') old.run.operationId = 'other';
      else old.run.operationGeneration = old.lease.generation + 1;
      const before = { heartbeatAt: old.run.heartbeatAt, seq: old.run.seq, status: old.run.status };
      for (const step of ['admitted', 'diagnostics-returned', 'stop', 'stop-returned', 'rm', 'rm-returned']) {
        if (boundary === 'superseded') expect(() => context.onProgress?.(step)).toThrow(BranchOperationSupersededError);
        else context.onProgress?.(step);
      }
      expect(events).toEqual([]);
      expect({ heartbeatAt: old.run.heartbeatAt, seq: old.run.seq, status: old.run.status }).toEqual(before);
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

  it('生产装配实际传递原代次并查询同一阶段队列，不能只在测试注入等待判据', async () => {
    const server = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const routes = fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8');
    expect(server).toContain('deploymentPhaseBudget.waitingOperation(run.operationId, run.operationGeneration)?.deadlineAt');
    for (const endpoint of ['/self-restart', '/self-update', '/self-force-sync']) {
      const start = routes.indexOf(`router.post('${endpoint}',`);
      const drain = routes.indexOf('await drainDeploysBeforeSelfUpdateRestart({', start);
      expect(start).toBeGreaterThan(0); expect(drain).toBeGreaterThan(start);
      expect(routes.indexOf('const restartFlush = await flushSelfUpdateStateBeforeRestart({', start)).toBeGreaterThan(drain);
      if (endpoint !== '/self-restart') {
        expect(routes.indexOf('checkpoint = await createSelfUpdateCheckpoint(', start)).toBeGreaterThan(drain);
        expect(routes.indexOf("await shell.exec('git fetch --all --prune'", start)).toBeGreaterThan(drain);
      }
    }
    const leasedLaunches = (routes.match(/await runServiceWithPortRetry\(\{[\s\S]*?\n\s*\}\);/g) || [])
      .filter(call => call.includes('assertBranchOperationCurrent(branchOperationLease'));
    expect(leasedLaunches).toHaveLength(2);
    for (const call of leasedLaunches) expect(call).toContain('operationGeneration: branchOperationLease?.generation');
    expect(routes).toContain('operationGeneration: options.operationGeneration');
    const start = routes.indexOf('  async function drainDeploysBeforeSelfUpdateRestart(');
    const end = routes.indexOf('  async function flushSelfUpdateStateBeforeRestart(', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const compiled = ts.transpileModule(routes.slice(start, end), { reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
    expect(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const setWait = vi.fn(), now = vi.spyOn(Date, 'now').mockImplementation(() => clock.getTime());
    const actualDrain = new Function('stateService', 'branchOperationCoordinator', 'setRestartWait', 'serverEventLogStore',
      'drainInFlightDeploys', 'beginSelfUpdateDrain', 'endSelfUpdateDrain', 'collectDrainableRuns', 'DRAIN_GATE_MAX_HOLD_MS',
      'resolveSelfUpdateDrainTimeoutMs', 'SelfUpdateRestartBlockedError', `${compiled.outputText}\nreturn drainDeploysBeforeSelfUpdateRestart;`)(
      state, coordinator, setWait, undefined, drainInFlightDeploys, beginSelfUpdateDrain, endSelfUpdateDrain,
      collectDrainableRuns, DRAIN_GATE_MAX_HOLD_MS, resolveSelfUpdateDrainTimeoutMs, SelfUpdateRestartBlockedError);
    const active = coordinator.begin({ ...request, kind: 'pull' });
    try {
      expect(active.status).toBe('started'); expect(runs.list()).toEqual([]);
      await expect(actualDrain({ trigger: 'manual', source: 'api.self-update', timeoutMs: 0 }))
        .rejects.toMatchObject({ code: 'self_update_restart_cancelled', remaining: [`operation:${active.operationId}`], waitedMs: 0 });
      expect(coordinator.getActiveOperations().map(operation => operation.operationId)).toEqual([active.operationId]);
      expect(setWait).toHaveBeenLastCalledWith(null);
      expect(selfUpdateDrainBlockReason(clock.getTime())).toBeNull();
    } finally { endSelfUpdateDrain(); now.mockRestore(); }
  });

  it('实际装配每分钟续扫冷预约、不重入，并在退出后保留未确认责任', async () => {
    const source = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    const begin = source.indexOf('let memoryReconciliationRunning = false;');
    const end = source.indexOf('deploymentMemoryReconciler.unref?.();', begin);
    expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
    let finish!: (result: { released: string[] }) => void;
    const pending = new Promise<{ released: string[] }>(resolve => { finish = resolve; });
    const reconcile = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ released: [] });
    let entries = [{ id: 'local', executorId: undefined }, { id: 'remote', executorId: 'node-2' }];
    const state = { getAllBranches: () => entries };
    vi.useFakeTimers();
    let wiring: { timer: ReturnType<typeof setInterval>; stop: () => void } | undefined;
    try {
      wiring = new Function('stateService', 'config', 'isRemoteExecutorOwned', 'containerService', 'shutdownInProgress',
        source.slice(begin, end) + 'deploymentMemoryReconciler.unref?.(); return { timer: deploymentMemoryReconciler, stop: () => { shutdownInProgress = true; } };')(
        state, { mode: 'master' }, (id: string | undefined) => Boolean(id),
        { reconcileDeploymentMemoryReservations: reconcile }, false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile.mock.calls[0][0]).toEqual([entries[0]]);
      expect(reconcile.mock.calls[0][1].recoveredOnly).toBe(true);
      expect(reconcile.mock.calls[0][1].creationSettled({}, { containerId: undefined })).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      entries = [{ id: 'fresh-local', executorId: undefined }];
      finish({ released: [] }); await Promise.resolve(); await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(reconcile.mock.calls[1][0]).toEqual(entries);
      const predicate = reconcile.mock.calls[1][1].creationSettled;
      expect(predicate({}, { containerId: 'a'.repeat(64) })).toBe(true);
      wiring!.stop();
      expect(predicate({}, { containerId: 'a'.repeat(64) })).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(source).toContain('clearInterval(deploymentMemoryReconciler)');
    } finally { if (wiring) clearInterval(wiring.timer); vi.useRealTimers(); }
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
