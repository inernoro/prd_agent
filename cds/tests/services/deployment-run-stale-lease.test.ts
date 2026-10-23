import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BranchOperationCoordinator, BranchOperationSupersededError, type BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { DeploymentPhaseBudget, deploymentPhaseBudget, setDeploymentPhaseMemoryProvider } from '../../src/services/deployment-phase-budget.js';
import { ContainerService } from '../../src/services/container.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, BuildProfile, CdsConfig, IShellExecutor, ServiceState } from '../../src/types.js';

describe('部署合法等待与终态许可', () => {
  let directory: string;
  let state: StateService;
  let coordinator: BranchOperationCoordinator;
  let runs: DeploymentRunService;
  let clock: Date;
  const request: BranchOperationRequest = {
    projectId: 'p1', branchId: 'b1', profileId: 'api', kind: 'deploy-profile', trigger: 'manual',
    commitSha: 'a'.repeat(40), commitPinned: true, configHash: 'same-config', source: 'stale-lease-regression',
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-stale-lease-'));
    state = new StateService(path.join(directory, 'state.json'));
    state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: '租约回归项目' } as any);
    state.addBranch({ id: 'b1', projectId: 'p1', branch: 'codex/stale-lease-regression',
      worktreePath: directory, services: {}, status: 'idle', createdAt: '2026-10-15T00:00:00.000Z' });
    clock = new Date('2026-10-15T00:00:00.000Z');
    coordinator = new BranchOperationCoordinator();
    runs = new DeploymentRunService(state, { now: () => new Date(clock) });
    runs.bindOperationCoordinator(coordinator);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setDeploymentPhaseMemoryProvider(null);
    deploymentPhaseBudget.releaseMemory('stale-owned-api');
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
    return { lease: decision.lease!, run };
  }

  function reapAfterSilence() {
    clock = new Date(clock.getTime() + 16 * 60_000);
    return runs.reconcileInterrupted();
  }

  it.each([undefined, 'embedded', 'master-current'])('本节点 %s 心跳过期写失败并撤销同代执行许可', async executorId => {
    const old = await trackedDeployment();
    old.run.executorId = executorId;
    state.getBranch('b1')!.executorId = executorId;
    expect(reapAfterSilence().map(run => run.id)).toEqual([old.run.id]);
    expect(old.run.failure?.code).toBe('cds.run.interrupted');
    expect(old.lease.isCurrent()).toBe(false);
    expect(() => old.lease.assertCurrent('迟到回写')).toThrow(BranchOperationSupersededError);
  });

  it.each([
    { runExecutor: 'remote-1' }, { branchExecutor: 'remote-1' },
    { branchProject: 'p2' }, { profileId: 'web' }, { missingBranch: true },
  ])('非本地或非当前原范围不借等待豁免，也不撤销其他许可：%o', async scope => {
    const waiting = vi.fn(() => true);
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting: waiting });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment();
    if ('runExecutor' in scope) old.run.executorId = scope.runExecutor;
    const branch = state.getBranch('b1')!;
    if ('branchExecutor' in scope) branch.executorId = scope.branchExecutor;
    if ('branchProject' in scope) branch.projectId = scope.branchProject;
    if ('profileId' in scope) old.run.profileId = scope.profileId;
    if ('missingBranch' in scope) state.removeBranch('b1');
    expect(reapAfterSilence().map(run => run.id)).toEqual([old.run.id]);
    expect(old.lease.isCurrent()).toBe(true);
    expect(waiting).not.toHaveBeenCalled();
  });

  it('收割只撤销原服务，不伤同分支其他服务、其他项目与其他分支', async () => {
    const old = await trackedDeployment();
    const siblings = [
      coordinator.begin({ ...request, profileId: 'web' }),
      coordinator.begin({ ...request, projectId: 'p2' }),
      coordinator.begin({ ...request, branchId: 'b2' }),
    ];
    expect(siblings.every(item => item.status === 'started')).toBe(true);
    reapAfterSilence();
    expect(old.lease.isCurrent()).toBe(false);
    expect(siblings.every(item => item.lease!.isCurrent())).toBe(true);
  });

  it('旧代次记录不借等待事实豁免，也不能撤销已续接的新代次', async () => {
    const waiting = vi.fn(() => true);
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting: waiting });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment({ ...request, kind: 'force-rebuild', continueWith: 'deploy-profile' });
    coordinator.completeAll(old.lease, 'completed');
    const next = coordinator.begin(request);
    expect(next.operationId).toBe(old.lease.operationId);
    expect(next.generation).toBeGreaterThan(old.lease.generation);
    expect(reapAfterSilence().map(run => run.id)).toEqual([old.run.id]);
    expect(waiting).not.toHaveBeenCalled();
    expect(next.lease!.isCurrent()).toBe(true);
  });

  it('真实 16 分钟阶段排队不伪造心跳，原 20 分钟截止后失败且撤销许可', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock.getTime());
    const budget = new DeploymentPhaseBudget(() => 0), controller = new AbortController();
    runs = new DeploymentRunService(state, { now: () => new Date(clock), isExecutionWaiting: (run, now) =>
      Boolean(run.operationId && run.operationGeneration !== undefined
        && (budget.waitingOperation(run.operationId, run.operationGeneration, run)?.deadlineAt || 0) > now.getTime()) });
    runs.bindOperationCoordinator(coordinator);
    const old = await trackedDeployment(), heartbeat = old.run.heartbeatAt;
    const waiting = budget.acquire('start', { ...request, operationId: old.lease.operationId,
      operationGeneration: old.lease.generation }, { check: () => old.lease.assertCurrent(), signal: controller.signal }).catch(() => undefined);
    try {
      clock = new Date(clock.getTime() + 16 * 60_000);
      expect(runs.reconcileInterrupted()).toEqual([]);
      expect(old.run.heartbeatAt).toBe(heartbeat);
      expect(old.lease.isCurrent()).toBe(true);
      clock = new Date(clock.getTime() + 5 * 60_000);
      expect(runs.reconcileInterrupted().map(run => run.id)).toEqual([old.run.id]);
      expect(old.lease.isCurrent()).toBe(false);
      budget.pump(); await waiting;
    } finally { controller.abort(); await waiting; }
  });

  it.each([
    { projectId: 'p2', branchId: 'b1', profileId: 'api' },
    { projectId: 'p1', branchId: 'b2', profileId: 'api' },
    { projectId: 'p1', branchId: 'b1', profileId: 'web' },
  ])('伪造或陈旧 scope 不能撤销原许可：%o', async scope => {
    const old = await trackedDeployment();
    expect(coordinator.revokeInterrupted({ ...scope, operationId: old.lease.operationId, generation: old.lease.generation })).toBe(false);
    expect(old.lease.isCurrent()).toBe(true);
  });

  function queuedAdmission() {
    const blocker = coordinator.begin({ projectId: 'p1', branchId: 'b1', kind: 'deploy', trigger: 'manual' });
    const queuedRequest = { ...request, trigger: 'webhook' as const };
    const queued = coordinator.begin(queuedRequest);
    expect(queued.status).toBe('merged');
    const acceptance = runs.begin({ projectId: 'p1', branchId: 'b1', profileId: 'api', trigger: 'webhook', initialStatus: 'queued',
      operationId: queued.operationId, operationGeneration: queued.generation,
      commitSha: queuedRequest.commitSha, configHash: queuedRequest.configHash, executionInput: { request: queuedRequest,
        input: { profiles: [{ id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node original.js', containerPort: 3000 }],
          configuredEnv: { TOKEN: 'fixture-private-before' }, configHash: 'same-config', profileOverrides: undefined, ciTargetSha: undefined } } });
    return { acceptance, blocker: blocker.lease! };
  }

  it('正常关闭只保留已确认保存的原密封待办，新进程原身份仅领取一次', async () => {
    vi.stubEnv('CDS_SECRET_KEY', '17'.repeat(32));
    const { acceptance, blocker } = queuedAdmission(), run = await acceptance;
    const intent = structuredClone(state.getState().deploymentIntents![run.id]);
    coordinator.interruptAll('normal restart', 'process.shutdown', { normalShutdown: true });
    await state.flush();
    expect(run.status).toBe('queued');
    expect(blocker.isCurrent()).toBe(false);
    expect(coordinator.drainReady()).toEqual([]);
    expect(state.getState().deploymentIntents![run.id]).toEqual(intent);
    const reopened = new StateService(path.join(directory, 'state.json')); reopened.load();
    const recovered = new DeploymentRunService(reopened), next = new BranchOperationCoordinator();
    expect(recovered.restoreQueued(next).map(item => item.id)).toEqual([run.id]);
    await recovered.waitForAcceptance(run.id);
    const [pending] = next.drainReady();
    expect(pending).toMatchObject({ operationId: run.operationId, generation: run.operationGeneration });
    expect(next.drainReady()).toEqual([]);
    const replay = { ...pending.request, pendingReplay: { operationId: pending.operationId, generation: pending.generation } };
    expect(next.getDeploymentInputForReplay(replay)?.configuredEnv.TOKEN).toBe('fixture-private-before');
    expect(next.begin(replay).status).toBe('started');
    expect(next.begin(replay).status).toBe('rejected');
    await reopened.flush();
  });

  it('真实 JSON 保存尚未确认时不产生正常关闭保留许可，迟到保存不能复活', async () => {
    vi.stubEnv('CDS_SECRET_KEY', '17'.repeat(32));
    await state.flush();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const original = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (...args) => { entered(); await gate; await original(...args); });
    const { acceptance } = queuedAdmission();
    try {
      await writing;
      const [run] = runs.list();
      expect(run.status).toBe('queued');
      coordinator.interruptAll('normal restart', 'process.shutdown', { normalShutdown: true });
      expect(run.status).toBe('failed');
      expect(state.getDeploymentIntents()).toEqual([]);
      release(); await acceptance;
      expect(run.status).toBe('failed');
    } finally { release(); await acceptance.catch(() => {}); rename.mockRestore(); }
  });

  it.each(['plain', 'damaged', 'changed-request', 'foreign-owner', 'wrong-key', 'newer', 'not-normal'])
  ('%s 不可借正常关闭保留资格', async failure => {
    vi.stubEnv('CDS_SECRET_KEY', failure === 'plain' ? undefined : '17'.repeat(32));
    const { acceptance } = queuedAdmission(), run = await acceptance;
    if (failure === 'damaged') (state.getState().deploymentIntents![run.id].inputPayload as { tag: string }).tag = 'invalid';
    if (failure === 'changed-request') coordinator.getPendingWebhookDeploy('b1', 'api')!.request.commitSha = 'b'.repeat(40);
    if (failure === 'foreign-owner') state.getBranch('b1')!.executorId = 'remote-worker';
    if (failure === 'wrong-key') vi.stubEnv('CDS_SECRET_KEY', '31'.repeat(32));
    if (failure === 'newer') await runs.begin({ projectId: 'p1', branchId: 'b1', trigger: 'manual',
      operationId: 'newer', operationGeneration: 99, operationAdmissionGeneration: 99 });
    coordinator.interruptAll('shutdown', 'process.shutdown', { normalShutdown: failure !== 'not-normal' });
    expect(run.status).toBe('failed');
    expect(state.getState().deploymentIntents![run.id]).toBeUndefined();
  });

  it.each(['network', 'create', 'liveness'] as const)('容器 %s 异步返回后许可失效，不能继续写身份或声称成功', async at => {
    let current = true;
    const stale = new Error('本代部署已失效');
    const shell: IShellExecutor = { exec: async (command, options) => {
      options?.beforeStart?.();
      if (command.startsWith('docker create') || command.startsWith('docker run')) {
        if (at === 'create') current = false;
        return { stdout: 'a'.repeat(64), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    } };
    const container = new ContainerService(shell, { repoRoot: directory, worktreeBase: directory,
      dockerNetwork: 'fixture-shared', sharedEnv: {}, jwt: { secret: 'fixture-only', issuer: 'fixture' } } as CdsConfig);
    const network = vi.spyOn(container as any, 'ensureNetwork').mockImplementation(async () => { if (at === 'network') current = false; });
    const prune = vi.spyOn(container as any, 'pruneStaleAppContainersForProfile').mockResolvedValue(undefined);
    vi.spyOn(container as any, 'connectContainerToSharedNetwork').mockResolvedValue(undefined);
    const liveness = vi.spyOn(container as any, 'waitForContainerAlive').mockImplementation(async () => {
      if (at === 'liveness') current = false;
    });
    setDeploymentPhaseMemoryProvider(() => 10000);
    const profile = { id: 'api', name: 'API', dockerImage: 'alpine:3.20', workDir: '.', command: 'true', containerPort: 8080 } as BuildProfile;
    const service = { profileId: 'api', containerName: 'stale-owned-api', hostPort: 10001, status: 'building' } as ServiceState;
    const created = vi.fn(async () => {});
    await expect(container.runService(state.getBranch('b1')! as BranchEntry, profile, service, undefined, undefined, {
      operationId: 'owned-operation', operationGeneration: 1, onRuntimeCreated: created,
      assertCurrent: () => { if (!current) throw stale; },
    })).rejects.toBe(stale);
    if (at === 'network') {
      expect(network).toHaveBeenCalledTimes(1);
      expect(prune).not.toHaveBeenCalled();
      expect(created).not.toHaveBeenCalled();
    } else if (at === 'create') {
      expect(service.containerId).toBeUndefined();
      expect(created).toHaveBeenCalledTimes(1);
      expect(liveness).not.toHaveBeenCalled();
    }
  });

  it('原地重启 inspect 等待后原许可失效，不再发送 docker restart', async () => {
    let current = true;
    const commands: string[] = [], stale = new Error('本代重启已取消');
    const shell: IShellExecutor = { exec: async (command, options) => {
      options?.beforeStart?.(); commands.push(command);
      if (command.startsWith('docker inspect')) current = false;
      if (command.startsWith('docker restart')) throw new Error('失效后仍发送 docker restart');
      return { stdout: 'running', stderr: '', exitCode: 0 };
    } };
    const container = new ContainerService(shell, { repoRoot: directory, worktreeBase: directory,
      dockerNetwork: 'fixture-shared', sharedEnv: {}, jwt: { secret: 'fixture-only', issuer: 'fixture' } } as CdsConfig);
    await expect(container.restartServiceInPlace('owned-runtime', undefined, {
      assertCurrent: () => { if (!current) throw stale; },
    })).rejects.toBe(stale);
    expect(commands.some(command => command.startsWith('docker restart'))).toBe(false);
  });

  it.each(['unissued', 'next-generation', 'same-owner-successor', 'unknown-result'])
  ('启动失败 %s 只退还未派发且仍属于本次的预约', async mode => {
    const failure = new Error('fixture 创建失败'), name = 'stale-owned-api';
    const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'owned-operation', operationGeneration: 1 };
    const successor = { ...owner, operationGeneration: mode === 'next-generation' ? 2 : 1 };
    let issued = 0;
    const shell: IShellExecutor = { exec: async (command, options) => {
      options?.beforeStart?.();
      if (command.startsWith('docker create') || command.startsWith('docker run')) { issued++; throw failure; }
      return { stdout: '', stderr: '', exitCode: 0 };
    } };
    const container = new ContainerService(shell, { repoRoot: directory, worktreeBase: directory,
      dockerNetwork: 'fixture-shared', sharedEnv: {}, jwt: { secret: 'fixture-only', issuer: 'fixture' } } as CdsConfig);
    vi.spyOn(container as any, 'ensureNetwork').mockResolvedValue(undefined);
    vi.spyOn(container as any, 'pruneStaleAppContainersForProfile').mockResolvedValue(undefined);
    setDeploymentPhaseMemoryProvider(() => 10000);
    const profile = { id: 'api', name: 'API', dockerImage: 'alpine:3.20', workDir: '.', command: 'true', containerPort: 8080 } as BuildProfile;
    const service = { profileId: 'api', containerName: name, hostPort: 10001, status: 'building' } as ServiceState;
    await expect(container.runService(state.getBranch('b1')!, profile, service, undefined, undefined, {
      operationId: owner.operationId, operationGeneration: owner.operationGeneration, assertCurrent: () => {},
      onRuntimeCreated: async () => {
        if (mode === 'unknown-result') return;
        if (mode !== 'unissued') deploymentPhaseBudget.reserveKnownMemory(name, 600, successor, 128);
        throw failure;
      },
    })).rejects.toBe(failure);
    expect(service.creationIssued).toBe(true);
    expect(issued).toBe(mode === 'unknown-result' ? 1 : 0);
    const reservation = deploymentPhaseBudget.memorySnapshot().find(item => item.key === name);
    if (mode === 'unissued') expect(reservation).toBeUndefined();
    else expect(reservation).toMatchObject({ owner: mode === 'unknown-result' ? owner : successor,
      memoryMB: mode === 'unknown-result' ? 512 : 600, pids: mode === 'unknown-result' ? 64 : 128 });
  });

  it('实际生产装配传递等待完整 scope 与原代身份，原地重启也传资格检查', () => {
    const server = fs.readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');
    const routes = fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8');
    expect(server).toContain('deploymentPhaseBudget.waitingOperation(run.operationId, run.operationGeneration, {');
    expect(server).toContain('projectId: run.projectId, branchId: run.branchId, profileId: run.profileId');
    const launches = (routes.match(/await runServiceWithPortRetry\(\{[\s\S]*?\n\s*\}\);/g) || [])
      .filter(call => call.includes('assertBranchOperationCurrent(branchOperationLease'));
    expect(launches).toHaveLength(2);
    for (const call of launches) expect(call).toContain('operationGeneration: branchOperationLease?.generation');
    expect(routes).toContain('operationGeneration: options.operationGeneration');
    const cutovers = (routes.match(/await commitServiceReplacements\(\{[\s\S]*?\}\);/g) || [])
      .filter(call => call.includes('assertBranchOperationCurrent(branchOperationLease'));
    expect(cutovers).toHaveLength(2);
    for (const call of cutovers) {
      expect(call).toContain('operationId: branchOperationLease?.operationId');
      expect(call).toContain('operationGeneration: branchOperationLease?.generation');
    }
    const restarts = routes.match(/await containerService.restartServiceInPlace\([\s\S]*?\n\s*\}\);/g) || [];
    expect(restarts).toHaveLength(2);
    for (const call of restarts) expect(call).toMatch(/assertCurrent:\s*(?:\(\s*step\s*\)|step)\s*=>\s*assertBranchOperationCurrent\(branchOperationLease,\s*step\)/);
  });
});
