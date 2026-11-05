import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { ExecutorRegistry } from '../../src/scheduler/executor-registry.js';
import { executorDeploymentOwners, readOwnedRemoteChunk, remoteProxyOwner, RemoteExecutionWaits,
  REMOTE_OWNER_TTL_MS, type RemoteDeploymentIdentity } from '../../src/services/remote-deployment-owner.js';

describe('远端原代次与本机剩余时长', () => {
  let dir: string, state: StateService;
  const owner: RemoteDeploymentIdentity = { projectId: 'default', branchId: 'owned', executorId: 'exec-a',
    deploymentRunId: 'run-owned', operationId: 'op-owned', operationGeneration: 1 };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-remote-owned-'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addBranch({ id: 'owned', projectId: 'default', branch: 'feature/owned', worktreePath: dir,
      status: 'building', services: {}, createdAt: new Date().toISOString() });
  });
  afterEach(async () => { vi.restoreAllMocks(); await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('同提交继任代次立即撤掉旧资格，迟到撤销和重复执行均不能污染继任者', () => {
    const owners = executorDeploymentOwners(state), old = owners.begin(owner, owners.claim(owner).admissionId);
    const next = { ...owner, operationId: 'op-new', operationGeneration: 2, deploymentRunId: 'run-new' };
    const current = owners.begin(next, owners.claim(next).admissionId);
    expect(() => old.assertCurrent()).toThrow(); expect(owners.revoke(owner)).toBe(false);
    expect(() => current.assertCurrent()).not.toThrow(); expect(() => owners.begin(next, 'replayed')).toThrow();
    expect(() => owners.begin(owner, 'replayed')).toThrow();
  });

  it('撤销先到仍阻止迟到部署，失联资格截止后也不能续租复活', () => {
    let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const owners = executorDeploymentOwners(state);
    owners.revoke(owner); expect(() => owners.begin(owner, 'replayed')).toThrow();
    const next = { ...owner, operationId: 'op-new', operationGeneration: 2, deploymentRunId: 'run-new' };
    const current = owners.begin(next, owners.claim(next).admissionId); now += REMOTE_OWNER_TTL_MS;
    expect(() => current.assertCurrent()).toThrow(); expect(() => owners.claim(next)).toThrow();
  });

  it('执行器重启后旧准入回执不能重放，必须由主节点派发新代次', async () => {
    const owners = executorDeploymentOwners(state), admitted = owners.claim(owner);
    owners.begin(owner, admitted.admissionId);
    await state.flush();
    const restarted = new StateService(path.join(dir, 'state.json')); restarted.load();
    const cold = executorDeploymentOwners(restarted);
    expect(() => cold.begin(owner, admitted.admissionId)).toThrow();
    expect(() => cold.claim(owner)).toThrow();
    const next = { ...owner, operationId: 'op-new', operationGeneration: 2, deploymentRunId: 'run-new' };
    expect(() => cold.begin(next, cold.claim(next).admissionId)).not.toThrow(); await restarted.flush();
  });

  it('项目历史真实裁剪后冷启动仍从分支已保存所有者恢复代次', async () => {
    const runs = new DeploymentRunService(state);
    const original = await runs.begin({ ...owner, operationGeneration: 7, trigger: 'manual' });
    runs.cancel(original.id, '原部署已结束');
    Object.assign(state.getBranch('owned')!, { executorId: owner.executorId,
      remoteDeployment: { ...owner, operationGeneration: 7, deploymentRunId: original.id, revoked: false } });
    state.addBranch({ ...state.getBranch('owned')!, id: 'history', branch: 'feature/history', remoteDeployment: undefined });
    for (let index = 0; index < 50; index++) state.addDeploymentRun({ ...original, id: `history-${index}`, branchId: 'history',
      operationId: `history-op-${index}`, operationGeneration: index + 1, startedAt: new Date(Date.now() + 1_000 + index).toISOString() });
    expect(state.getDeploymentRun(original.id)).toBeUndefined(); await state.flush();
    const cold = new StateService(path.join(dir, 'state.json')); cold.load();
    try {
      const coordinator = new BranchOperationCoordinator(); new DeploymentRunService(cold).restoreQueued(coordinator);
      const next = coordinator.begin({ projectId: 'default', branchId: 'owned', kind: 'deploy', trigger: 'manual' });
      expect(next.generation).toBe(8);
    } finally { await cold.flush(); }
  });

  it('1024条过期资格可回收且旧准入回执无法重放', () => {
    let now = 1_000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const owners = executorDeploymentOwners(state);
    const historical = { ...owner, branchId: 'deleted-0' };
    const admission = owners.claim(historical).admissionId;
    owners.begin(historical, admission);
    for (let index = 1; index < 1024; index++) {
      const item = { ...owner, branchId: `deleted-${index}` }; owners.begin(item, owners.claim(item).admissionId);
    }
    expect(() => owners.claim({ ...owner, branchId: 'new-branch' })).toThrow('暂满');
    now += REMOTE_OWNER_TTL_MS;
    expect(() => owners.claim({ ...owner, branchId: 'new-branch' })).not.toThrow();
    expect(() => owners.begin(historical, admission)).toThrow();
  });

  it('新资格仅预约时不围住旧执行，取消预约也不改已运行所有者', () => {
    const owners = executorDeploymentOwners(state), active = owners.begin(owner, owners.claim(owner).admissionId);
    const before = JSON.stringify(state.getBranch('owned'));
    const next = { ...owner, operationId: 'next', deploymentRunId: 'next', operationGeneration: 2 };
    const admission = owners.claim(next).admissionId;
    expect(() => owners.claim(owner)).not.toThrow();
    expect(() => active.assertCurrent()).not.toThrow(); expect(JSON.stringify(state.getBranch('owned'))).toBe(before);
    expect(owners.revoke(next)).toBe(true);
    expect(() => active.assertCurrent()).not.toThrow(); expect(JSON.stringify(state.getBranch('owned'))).toBe(before);
    expect(() => owners.begin(next, admission)).toThrow(); expect(() => owners.claim(next)).toThrow();
  });

  it('主节点准入失败仅结束新操作，旧运行态与心跳所有者保持逐字不变', async () => {
    const entry = state.getBranch('owned')!;
    Object.assign(entry, { status: 'running', errorMessage: '原诊断记录', executorId: owner.executorId, remoteDeployment: { ...owner, revoked: false } });
    const before = JSON.stringify(entry), actions: string[] = [];
    const registry = new ExecutorRegistry(state);
    registry.register({ id: owner.executorId, host: '127.0.0.1', port: 9901, capacity: { maxBranches: 4, memoryMB: 1024, cpuCores: 2 } });
    const coordinator = new BranchOperationCoordinator(); coordinator.seedGeneration('owned', 1);
    const decision = coordinator.begin({ projectId: 'default', branchId: 'owned', kind: 'deploy', trigger: 'manual' });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const action = JSON.parse(String(init.body)).action; actions.push(action);
      return new Response(JSON.stringify({ qualified: action === 'revoke' }), { status: action === 'revoke' ? 200 : 409 });
    }));
    const guard = remoteProxyOwner({ owner: { ...owner, operationId: decision.operationId, operationGeneration: decision.generation }, entry,
      state, coordinator, lease: decision.lease!, url: 'http://127.0.0.1/exec/deployment-owner', headers: {} });
    try {
      await expect(guard.claim()).rejects.toThrow(); await guard.close(true);
      expect(JSON.stringify(entry)).toBe(before); expect(decision.lease!.isCurrent()).toBe(false);
      expect(actions).toEqual(['claim', 'revoke']);
      registry.heartbeat(owner.executorId, { load: { memoryUsedMB: 0, cpuPercent: 0 }, branches: {
        owned: { status: 'running', remoteDeployment: { ...owner, revoked: false }, services: {
          api: { profileId: 'api', containerName: 'original-api', hostPort: 10001, status: 'running' },
        } } as any,
      } });
      expect(entry.services.api?.containerName).toBe('original-api'); expect(entry.status).toBe('running');
    } finally { await guard.close(); vi.unstubAllGlobals(); }
  });

  it('成功收尾期间迟到续期失败不改已成功状态且没有遗留控制请求', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const entry = state.getBranch('owned')!, actions: string[] = [];
    const coordinator = new BranchOperationCoordinator();
    const decision = coordinator.begin({ projectId: 'default', branchId: 'owned', kind: 'deploy', trigger: 'manual' });
    let rejectRenew!: (reason: Error) => void;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const action = JSON.parse(String(init.body)).action; actions.push(action);
      if (action === 'renew') return new Promise<Response>((_resolve, reject) => { rejectRenew = reject; });
      return new Response(JSON.stringify({ qualified: true, admissionId: 'success-admission' }));
    }));
    const guard = remoteProxyOwner({ owner: { ...owner, operationId: decision.operationId, operationGeneration: decision.generation }, entry,
      state, coordinator, lease: decision.lease!, url: 'http://127.0.0.1/exec/deployment-owner', headers: {} });
    try {
      await guard.claim(); await vi.advanceTimersByTimeAsync(10_000); expect(actions).toEqual(['claim', 'renew']);
      entry.status = 'running'; const before = JSON.stringify(entry), closing = guard.close(false);
      rejectRenew(new Error('迟到的网络失败')); await closing;
      expect(JSON.stringify(entry)).toBe(before); expect(decision.lease!.isCurrent()).toBe(true);
      expect(actions).toEqual(['claim', 'renew']);
    } finally { await guard.close(); vi.unstubAllGlobals(); vi.useRealTimers(); }
  });

  it.each([-120_000, 120_000])('执行器时钟偏移%s毫秒仍以本机首次收到后的20分钟为截止，重复回执不能续命', skew => {
    const waits = new RemoteExecutionWaits(), master = 10_000_000;
    const report = { ...owner, sequence: 1, wait: { phase: 'start', waitId: 'actual-wait-1', remainingMs: 20 * 60_000 },
      enqueuedAt: master + skew, deadlineAt: master + skew + 20 * 60_000 };
    expect(waits.observe(owner, report, master)).toBe(true);
    for (let minute = 1; minute <= 20; minute++) {
      const at = master + minute * 60_000;
      expect(waits.observe(owner, { ...report, sequence: minute + 1 }, at)).toBe(true);
      expect(waits.waiting(owner, at)).toBe(minute < 20);
    }
  });

  it('过期、倒序、跨所有者回执以及已经离队的旧等待均不能取得豁免', () => {
    const waits = new RemoteExecutionWaits(), now = 100_000;
    const report = { ...owner, sequence: 1, wait: { phase: 'start', waitId: 'wait-1', remainingMs: 120_000 } };
    expect(waits.observe(owner, report, now)).toBe(true);
    expect(waits.waiting(owner, now + REMOTE_OWNER_TTL_MS)).toBe(false);
    expect(waits.observe(owner, report, now + 1)).toBe(false);
    expect(waits.observe(owner, { ...report, sequence: 2, operationGeneration: 9 }, now + 1)).toBe(false);
    expect(waits.observe(owner, { ...report, sequence: 2, wait: { ...report.wait, remainingMs: 20 * 60_000 + 1 } }, now + 1)).toBe(false);
    expect(waits.observe(owner, { ...report, sequence: 2, wait: null }, now + 1)).toBe(true);
    expect(waits.observe(owner, { ...report, sequence: 3 }, now + 2)).toBe(false);
    expect(waits.waiting(owner, now + 2)).toBe(false);
  });

  it('run只豁免当前远端实际等待，截止收割原代次且不生成假心跳', async () => {
    let now = new Date('2026-11-05T00:00:00Z');
    const runs = new DeploymentRunService(state, { now: () => now });
    const coordinator = new BranchOperationCoordinator(); runs.bindOperationCoordinator(coordinator);
    const decision = coordinator.begin({ projectId: 'default', branchId: 'owned', kind: 'deploy', trigger: 'manual' });
    const run = await runs.begin({ projectId: 'default', branchId: 'owned', executorId: owner.executorId,
      operationId: decision.operationId, operationGeneration: decision.generation, trigger: 'manual' });
    const actual = { ...owner, deploymentRunId: run.id, operationId: decision.operationId, operationGeneration: decision.generation };
    Object.assign(state.getBranch('owned')!, { executorId: owner.executorId, remoteDeployment: { ...actual, revoked: false } });
    const heartbeat = run.heartbeatAt;
    now = new Date(now.getTime() + 16 * 60_000);
    expect(runs.observeRemoteExecutionWait(actual, { ...actual, sequence: 1, wait: { phase: 'start', waitId: '1', remainingMs: 120_000 } })).toBe(true);
    expect(runs.reconcileInterrupted()).toEqual([]); expect(run.heartbeatAt).toBe(heartbeat);
    now = new Date(now.getTime() + 30_001);
    expect(runs.reconcileInterrupted().map(item => item.id)).toEqual([run.id]);
    expect(decision.lease!.isCurrent()).toBe(false); expect(run.status).toBe('failed');
  });

  it('静默读取期间原协调器取消能立刻打断read，并独立发出精确远端撤销', async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        received.push(JSON.parse(body)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ qualified: true, admissionId: 'fixture-admission' }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const coordinator = new BranchOperationCoordinator();
    const decision = coordinator.begin({ projectId: 'default', branchId: 'owned', kind: 'deploy', trigger: 'manual' });
    const actual = { ...owner, operationId: decision.operationId, operationGeneration: decision.generation };
    const guard = remoteProxyOwner({ owner: actual, entry: state.getBranch('owned')!, state, coordinator, lease: decision.lease!,
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/exec/deployment-owner`, headers: { 'Content-Type': 'application/json' } });
    try {
      await guard.claim();
      const quiet = new ReadableStream<Uint8Array>({ start() {} }).getReader();
      const read = readOwnedRemoteChunk(quiet, guard.signal); const rejected = expect(read).rejects.toThrow('远端原代次已结束');
      coordinator.cancelBranch('owned', '本轮原操作主动取消'); await rejected;
      expect(guard.isCurrent()).toBe(false); await guard.close();
      expect(received.map(item => item.action)).toEqual(['claim', 'revoke']);
      expect(received[1]).toMatchObject(actual);
    } finally { await guard.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
