import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService, MAX_DEPLOYMENT_RUNS_PER_PROJECT } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { BranchOperationCoordinator, pendingDeployBody } from '../../src/services/branch-operation-coordinator.js';
import { captureDeploymentInput } from '../../src/services/deployment-input.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';

describe('已受理部署的持久输入与重启恢复', () => {
  let dir: string, file: string, state: StateService;
  const boundary = new Date('2099-01-01T00:00:00Z');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-intents-')); file = path.join(dir, 'state.json');
    state = new StateService(file); state.load();
    state.addProject({ id: 'p', name: 'P', slug: 'p' } as any);
    state.addBranch({ id: 'b', projectId: 'p', branch: 'main', worktreePath: dir, status: 'idle', createdAt: new Date().toISOString(), services: {} });
    process.env.CDS_SECRET_KEY = '17'.repeat(32);
  });
  afterEach(async () => { await flushAllJsonStateStores(); delete process.env.CDS_SECRET_KEY; fs.rmSync(dir, { recursive: true, force: true }); });

  async function accepted(profileId?: string) {
    const coordinator = new BranchOperationCoordinator();
    coordinator.begin({ branchId: 'b', projectId: 'p', kind: 'deploy', trigger: 'manual' });
    const request: BranchOperationRequest = { branchId: 'b', projectId: 'p', kind: profileId ? 'deploy-profile' : 'deploy', profileId,
      trigger: 'webhook', actor: 'original-agent', source: 'original-webhook', commitSha: 'b'.repeat(40), commitPinned: true, configHash: 'cfg' };
    const decision = coordinator.begin(request);
    const input = captureDeploymentInput(state.getBranch('b')!, [{ id: profileId || 'api', projectId: 'p', name: 'API', dockerImage: 'node', workDir: '.', containerPort: 3000, command: 'node before.js' }], { TOKEN: 'private-before' });
    input.configHash = 'cfg';
    const service = new DeploymentRunService(state);
    const run = await service.begin({ projectId: 'p', branchId: 'b', trigger: 'webhook', initialStatus: 'queued', profileId,
      operationId: decision.operationId, operationGeneration: decision.generation, operationAdmissionGeneration: decision.generation,
      configHash: 'cfg', commitSha: request.commitSha, executionInput: { request, input } });
    return { run, request, input, service, coordinator };
  }

  it.each([undefined, 'api'])('重新加载真实JSON后恢复%s原意图、配置和run；过期心跳不取消合法待办', async (profileId) => {
    const { run, input } = await accepted(profileId);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.deploymentIntents[run.id].inputPayload.__sealed).toBe(true);
    expect(JSON.stringify(persisted.deploymentIntents)).not.toContain('private-before');
    input.configuredEnv.TOKEN = 'mutated-after-acceptance';
    const reopened = new StateService(file); reopened.load();
    const service = new DeploymentRunService(reopened), coordinator = new BranchOperationCoordinator();
    expect(service.restoreQueued(coordinator).map((r) => r.id)).toEqual([run.id]);
    expect(service.reconcileOrphanedByRestart(boundary)).toEqual([]);
    expect(service.reconcileInterrupted(boundary)).toEqual([]);
    const pending = coordinator.drainReady()[0];
    expect(pending.operationId).toBe(run.operationId); expect(pending.generation).toBe(run.operationGeneration);
    const replay = { ...pending.request, pendingReplay: pendingDeployBody(pending).pendingReplay as BranchOperationRequest['pendingReplay'] };
    expect(coordinator.getDeploymentInputForReplay(replay)?.configuredEnv.TOKEN).toBe('private-before');
    expect(coordinator.begin(replay).status).toBe('started');
    await service.claimQueued(run.id);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).deploymentRuns[run.id].status).toBe('preparing');
    expect(JSON.stringify(service.get(run.id))).not.toContain('private-before');
    const again = new StateService(file); again.load(); const afterCrash = new DeploymentRunService(again);
    expect(afterCrash.restoreQueued(new BranchOperationCoordinator())).toEqual([]);
    expect(afterCrash.reconcileOrphanedByRestart(boundary).map((r) => r.id)).toEqual([run.id]);
  });

  it.each(['wrong-key', 'wrong-target', 'missing-owner'])('无法可靠读取%s时明确失败，不执行或泄露私有输入', async (failure) => {
    const { run } = await accepted();
    if (failure === 'wrong-key') process.env.CDS_SECRET_KEY = '31'.repeat(32);
    if (failure === 'wrong-target') state.getState().deploymentIntents![run.id].request.commitSha = 'c'.repeat(40);
    if (failure === 'missing-owner') delete (state.getState().branches as any).b;
    const service = new DeploymentRunService(state), coordinator = new BranchOperationCoordinator();
    expect(service.restoreQueued(coordinator)).toEqual([]); expect(service.get(run.id)?.status).toBe('failed');
    expect(coordinator.drainReady()).toEqual([]); expect(state.getDeploymentIntents()).toEqual([]);
    expect(JSON.stringify(service.get(run.id))).not.toContain('private-before');
  });

  it('内容摘要发现同配置标识下的私有执行输入损坏，不能执行', async () => {
    delete process.env.CDS_SECRET_KEY;
    const { run } = await accepted();
    const intent = state.getState().deploymentIntents![run.id];
    const input = JSON.parse(intent.inputPayload as string); input.profiles[0].command = 'node corrupted.js';
    intent.inputPayload = JSON.stringify(input);
    const service = new DeploymentRunService(state), coordinator = new BranchOperationCoordinator();
    expect(service.restoreQueued(coordinator)).toEqual([]);
    expect(service.get(run.id)?.failure?.code).toBe('cds.intent.unrecoverable');
    expect(coordinator.drainReady()).toEqual([]);
  });

  it('领取写盘失败不确认执行身份，磁盘上的原排队记录仍可恢复', async () => {
    const { run, service } = await accepted();
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('synthetic disk unavailable'));
    try { await expect(service.claimQueued(run.id)).rejects.toThrow('synthetic disk unavailable'); }
    finally { rename.mockRestore(); }
    const reopened = new StateService(file); reopened.load();
    const recovered = new DeploymentRunService(reopened), coordinator = new BranchOperationCoordinator();
    expect(recovered.restoreQueued(coordinator).map((r) => r.id)).toEqual([run.id]);
    expect(coordinator.drainReady()).toHaveLength(1);
    await reopened.flush(); await state.flush();
  });

  it('正在确认的取消记录不被其他分支新增历史裁剪，确认后才允许回收', async () => {
    const { run, service } = await accepted();
    service.cancel(run.id, 'stop');
    state.addBranch({ id: 'other', projectId: 'p', branch: 'other', worktreePath: dir, status: 'idle', createdAt: new Date().toISOString(), services: {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => { await gate; await original(...args); });
    const write = state.flushDeploymentRun(run.id);
    try {
      for (let i = 0; i < MAX_DEPLOYMENT_RUNS_PER_PROJECT + 1; i++) {
        state.addDeploymentRun({ ...run, id: `other-${i}`, branchId: 'other', status: 'failed', startedAt: `2099-01-01T00:00:${String(i).padStart(2, '0')}.000Z` });
      }
      expect(state.getDeploymentRun(run.id)?.status).toBe('cancelled');
      release(); await write;
      const reopened = new StateService(file); reopened.load();
      expect(new DeploymentRunService(reopened).restoreQueued(new BranchOperationCoordinator())).toEqual([]);
      state.addDeploymentRun({ ...run, id: 'after-confirmation', status: 'failed', startedAt: '2099-02-01T00:00:00.000Z' });
      expect(state.getDeploymentRun(run.id)).toBeUndefined();
    } finally { release(); await write.catch(() => {}); rename.mockRestore(); }
  });

  it('取消保存期间被新操作取代时旧停止者失去执行资格；不取消别的项目或不重叠服务', async () => {
    const { run, service, coordinator } = await accepted('api');
    service.bindOperationCoordinator(coordinator);
    const stop = coordinator.begin({ projectId: 'p', branchId: 'b', profileId: 'api', kind: 'cleanup-orphans', trigger: 'manual' });
    expect(stop.status).toBe('started');
    const other = await accepted('web');
    state.addProject({ id: 'q', name: 'Q', slug: 'q' } as any);
    state.addBranch({ id: 'qb', projectId: 'q', branch: 'main', worktreePath: dir, status: 'idle', createdAt: new Date().toISOString(), services: {} });
    state.addDeploymentRun({ ...other.run, id: 'other-project', projectId: 'q', branchId: 'qb' });
    const original = state.flushDeploymentRun.bind(state);
    let changed = false;
    const save = vi.spyOn(state, 'flushDeploymentRun').mockImplementation(async (id) => {
      await original(id);
      if (!changed) { changed = true; coordinator.cancelBranch('b', 'new owner'); }
    });
    try {
      await expect(service.persistBranchCancellation('p', 'b', stop.lease)).rejects.toThrow('no longer current');
      expect(service.get(run.id)?.status).toBe('cancelled');
      expect(service.get(other.run.id)?.status).toBe('queued');
      expect(state.getDeploymentRun('other-project')?.status).toBe('queued');
    } finally { save.mockRestore(); }
  });

  it('部署租约不能冒用终止权限取消合法待办', async () => {
    const { run, service, coordinator } = await accepted();
    const active = coordinator.getActiveOperations('b')[0];
    const lease = { ...active, isCurrent: () => true, assertCurrent: () => {} };
    await expect(service.persistBranchCancellation('p', 'b', lease)).rejects.toThrow('terminating owner');
    expect(service.get(run.id)?.status).toBe('queued');
  });

  it.each(['claim', 'stop'])('真实进程受理后被SIGKILL仍恢复同一run；%s确认后再次SIGKILL不恢复旧任务', async (mode) => {
    const fixture = fileURLToPath(new URL('../fixtures/deployment-intent-child.ts', import.meta.url));
    async function child(mode: string): Promise<any> {
      const processChild = fork(fixture, [file, mode], { cwd: fileURLToPath(new URL('../../', import.meta.url)),
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let errorOutput = ''; processChild.stderr?.on('data', (data) => { errorOutput += data.toString(); });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`child ${mode} timeout: ${errorOutput}`)), 10000);
          processChild.once('message', (message) => { clearTimeout(timer); resolve(message); });
          processChild.once('error', (error) => { clearTimeout(timer); reject(error); });
          processChild.once('exit', (code) => { clearTimeout(timer); reject(new Error(`child ${mode} exited ${code}: ${errorOutput}`)); });
        });
      } finally {
        if (processChild.exitCode === null && processChild.signalCode === null) {
          const exited = new Promise<string | null>((resolve) => processChild.once('exit', (_code, signal) => resolve(signal)));
          processChild.kill('SIGKILL'); expect(await exited).toBe('SIGKILL');
        }
      }
    }
    // 避免父实例尚未保存的初始化状态覆盖子进程结果。
    await state.flush();
    const accepted = await child('accept');
    const confirmed = await child(mode);
    if (mode === 'claim') {
      expect(confirmed).toMatchObject({ phase: 'claimed', runId: accepted.runId, operationId: accepted.operationId,
        generation: accepted.generation, command: 'node original.js', secretPreserved: true, prebuiltGated: true, runCount: 1 });
    } else {
      expect(confirmed).toMatchObject({ phase: 'stopped', runId: accepted.runId, status: 'cancelled', privateInputCleared: true });
    }
    expect(await child('inspect')).toEqual({ phase: 'restarted', restored: 0, pending: false, runCount: 1, status: mode === 'claim' ? 'failed' : 'cancelled' });
  }, 30000);

  it('较新的覆盖范围终态阻止旧队列恢复，重建续接按原受理顺序保留其后任务', async () => {
    const { run, service } = await accepted('api');
    const newer = await service.begin({ projectId: 'p', branchId: 'b', trigger: 'manual', operationId: 'newer', operationGeneration: 9, operationAdmissionGeneration: 3 });
    service.fail(newer.id, { code: 'test', owner: 'cds', retryable: true, summary: 'test', phase: 'test', evidenceRefs: [] });
    const recovery = new DeploymentRunService(state);
    expect(recovery.restoreQueued(new BranchOperationCoordinator())).toEqual([]); expect(recovery.get(run.id)?.status).toBe('cancelled');
    const second = await accepted('web');
    state.getDeploymentRun(newer.id)!.operationAdmissionGeneration = 1;
    expect(recovery.restoreQueued(new BranchOperationCoordinator()).map((r) => r.id)).toEqual([second.run.id]);
  });
});
