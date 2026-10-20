import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateService, MAX_DEPLOYMENT_RUNS_PER_PROJECT } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { BranchOperationCoordinator, pendingDeployBody } from '../../src/services/branch-operation-coordinator.js';
import { captureDeploymentInput } from '../../src/services/deployment-input.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';
import { waitForFlushWithTimeout } from '../../src/services/bounded-flush.js';
import { MongoSplitStateBackingStore, type ISplitMongoHandle } from '../../src/infra/state-store/mongo-split-store.js';
import { CDS_RESTART_PERMIT_COMMAND, prepareDetachedCdsRestart } from '../../src/services/self-update-handoff.js';

function fakeMongoForRestart(seed?: Map<string, any>[]) {
  const names = ['globalCollection', 'projectsCollection', 'branchesCollection', 'deploymentRunsCollection',
    'deploymentVersionsCollection', 'selfUpdateHistoryCollection', 'webhookDeliveriesCollection', 'activityLogsCollection'];
  const collections = names.map((_, index) => {
    const docs = structuredClone(seed?.[index] ?? new Map<string, any>());
    return {
      docs,
      async findOne(filter: { _id: string }) { return structuredClone(docs.get(filter._id) ?? null); },
      find() { return { toArray: async () => structuredClone([...docs.values()]) }; },
      async replaceOne(filter: { _id: string }, doc: any) { docs.set(filter._id, structuredClone(doc)); },
      async deleteOne(filter: { _id: string }) { docs.delete(filter._id); },
      async countDocuments() { return docs.size; },
      async bulkWrite(operations: any[]) {
        for (const operation of operations) {
          if (operation.replaceOne) {
            docs.set(operation.replaceOne.filter._id, structuredClone(operation.replaceOne.replacement));
          } else if (operation.deleteOne) {
            docs.delete(operation.deleteOne.filter._id);
          }
        }
      },
    };
  });
  const handle = {
    ...Object.fromEntries(names.map((name, index) => [name, () => collections[index]])),
    async connect() {}, async close() {}, async ping() { return true; },
  } as unknown as ISplitMongoHandle;
  return { handle, snapshot: () => collections.map(collection => structuredClone(collection.docs)) };
}

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

  function queuedAdmission(profileId?: string, events?: ServerEventLogSink) {
    const coordinator = new BranchOperationCoordinator(events);
    const blocker = coordinator.begin({ branchId: 'b', projectId: 'p', kind: 'deploy', trigger: 'manual' });
    const request: BranchOperationRequest = { branchId: 'b', projectId: 'p', kind: profileId ? 'deploy-profile' : 'deploy', profileId,
      trigger: 'webhook', actor: 'original-agent', source: 'original-webhook', commitSha: 'b'.repeat(40), commitPinned: true, configHash: 'cfg' };
    const decision = coordinator.begin(request);
    const input = captureDeploymentInput(state.getBranch('b')!, [{ id: profileId || 'api', projectId: 'p', name: 'API', dockerImage: 'node', workDir: '.', containerPort: 3000, command: 'node before.js' }], { TOKEN: 'private-before' });
    input.configHash = 'cfg';
    const service = new DeploymentRunService(state);
    service.bindOperationCoordinator(coordinator);
    const acceptance = service.begin({ projectId: 'p', branchId: 'b', trigger: 'webhook', initialStatus: 'queued', profileId,
      operationId: decision.operationId, operationGeneration: decision.generation, operationAdmissionGeneration: decision.generation,
      configHash: 'cfg', commitSha: request.commitSha, executionInput: { request, input } });
    return { acceptance, request, input, service, coordinator, blocker: blocker.lease! };
  }

  async function accepted(profileId?: string, events?: ServerEventLogSink) {
    const fixture = queuedAdmission(profileId, events);
    return { ...fixture, run: await fixture.acceptance };
  }

  it.each([undefined, 'api'])('正常关闭保留已确认的%s原待办；旧进程不能领取，新进程同代次只领取一次', async profileId => {
    const record = vi.fn();
    const { run, service, coordinator, blocker, request } = await accepted(profileId, { record });
    const originalIntent = structuredClone(state.getState().deploymentIntents![run.id]);
    coordinator.interruptAll('normal restart', 'api.self-update', { normalShutdown: true });
    await state.flush();
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.deploymentRuns[run.id].status).toBe('queued');
    expect(persisted.deploymentIntents[run.id]).toEqual(originalIntent);
    expect(service.get(run.id)?.failure).toBeUndefined();
    expect(coordinator.completeAll(blocker, 'completed')).toEqual([]);
    expect(coordinator.drainReady()).toEqual([]);
    expect(coordinator.begin({ ...request, pendingReplay: { operationId: run.operationId!, generation: run.operationGeneration! } }).status).toBe('rejected');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'branch.operation.deferred',
      operationId: run.operationId, message: '保留原待办，重启后待校验', details: expect.objectContaining({ preserved: true }) }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('private-before');

    const reopened = new StateService(file); reopened.load();
    const recovered = new DeploymentRunService(reopened), next = new BranchOperationCoordinator();
    expect(recovered.restoreQueued(next).map(item => item.id)).toEqual([run.id]);
    const [pending] = next.drainReady();
    expect(pending).toMatchObject({ operationId: run.operationId, generation: run.operationGeneration });
    expect(next.drainReady()).toEqual([]);
    const replay = { ...pending.request, pendingReplay: { operationId: pending.operationId, generation: pending.generation } };
    expect(next.getDeploymentInputForReplay(replay)?.configuredEnv.TOKEN).toBe('private-before');
    expect(next.begin(replay)).toMatchObject({ status: 'started', operationId: run.operationId, generation: run.operationGeneration });
    expect(next.begin(replay).status).toBe('rejected');
    await recovered.claimQueued(run.id);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).deploymentRuns[run.id].status).toBe('preparing');
    const again = new StateService(file); again.load();
    expect(new DeploymentRunService(again).restoreQueued(new BranchOperationCoordinator())).toEqual([]);
  });

  it('默认中断与spawn失败不获得正常关闭例外，仍由真实observer终态化并删除意图', async () => {
    const { run, coordinator } = await accepted();
    coordinator.interruptAll('restart spawn failed', 'api.self-update');
    await state.flush();
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.deploymentRuns[run.id]).toMatchObject({ status: 'failed', failure: { code: 'cds.operation.interrupted' } });
    expect(persisted.deploymentIntents[run.id]).toBeUndefined();
  });

  it.each(['claimed', 'active', 'preparing', 'reserved'])('已派发或执行的%s不保留为可重放待办', async phase => {
    const { run, service, coordinator, blocker } = await accepted();
    let reservedGeneration = 0;
    let reservedOperationId = '';
    if (phase === 'reserved') {
      const reserved = coordinator.begin({ branchId: 'reserved', kind: 'force-rebuild', trigger: 'manual', continueWith: 'deploy' });
      reservedGeneration = reserved.generation;
      reservedOperationId = reserved.operationId;
      coordinator.completeAll(reserved.lease!, 'completed');
    }
    const [pending] = coordinator.completeAll(blocker, 'completed');
    expect(pending.operationId).toBe(run.operationId);
    if (phase !== 'claimed') expect(coordinator.begin({ ...pending.request,
      pendingReplay: { operationId: pending.operationId, generation: pending.generation } }).status).toBe('started');
    if (phase === 'preparing') await service.claimQueued(run.id);
    coordinator.interruptAll('normal signal', 'process.shutdown', { normalShutdown: true });
    expect(coordinator.getActiveOperations()).toEqual([]);
    expect(coordinator.hasWaitingOperation(pending.operationId, pending.generation)).toBe(false);
    expect(coordinator.begin({ ...pending.request,
      pendingReplay: { operationId: pending.operationId, generation: pending.generation } }).status).toBe('rejected');
    if (phase === 'reserved') {
      const next = coordinator.begin({ branchId: 'reserved', kind: 'deploy', trigger: 'manual' });
      expect(next.status).toBe('started');
      expect(next.generation).toBeGreaterThan(reservedGeneration);
      expect(next.operationId).not.toBe(reservedOperationId);
    }
    await state.flush();
    expect(service.get(run.id)?.status).toBe('failed');
    expect(state.getDeploymentIntents()).toEqual([]);
    const reopened = new StateService(file); reopened.load();
    expect(new DeploymentRunService(reopened).restoreQueued(new BranchOperationCoordinator())).toEqual([]);
  });

  it.each(['plain', 'damaged', 'missing', 'wrong-key', 'missing-owner', 'foreign-owner', 'wrong-admission', 'changed-request', 'newer'])
  ('%s待办不能借正常关闭绕过原意图、受理或作用域资格', async failure => {
    if (failure === 'plain') delete process.env.CDS_SECRET_KEY;
    const { run, service, coordinator } = await accepted();
    const intent = state.getState().deploymentIntents![run.id];
    if (failure === 'damaged') (intent.inputPayload as { tag: string }).tag = 'invalid';
    if (failure === 'missing') delete state.getState().deploymentIntents![run.id];
    if (failure === 'wrong-key') process.env.CDS_SECRET_KEY = '31'.repeat(32);
    if (failure === 'missing-owner') delete state.getState().branches.b;
    if (failure === 'foreign-owner') state.getBranch('b')!.executorId = 'remote-worker';
    if (failure === 'wrong-admission') run.operationAdmissionGeneration = 99;
    if (failure === 'changed-request') coordinator.getPendingWebhookDeploy('b')!.request.commitSha = 'c'.repeat(40);
    if (failure === 'newer') await service.begin({ projectId: 'p', branchId: 'b', trigger: 'manual',
      operationId: 'newer', operationGeneration: 9, operationAdmissionGeneration: 9 });
    coordinator.interruptAll('normal restart', 'api.self-update', { normalShutdown: true });
    await state.flush();
    expect(service.get(run.id)?.status).toBe('failed');
    expect(state.getState().deploymentIntents![run.id]).toBeUndefined();
  });

  it('真实JSON恢复确认保存后可再次正常关闭；仍只恢复原op/gen且preparing后不重放', async () => {
    const { run } = await accepted();
    const originalIntent = structuredClone(state.getState().deploymentIntents![run.id]);
    const reopened = new StateService(file); reopened.load();
    const recovered = new DeploymentRunService(reopened), coordinator = new BranchOperationCoordinator();
    expect(recovered.restoreQueued(coordinator).map(item => item.id)).toEqual([run.id]);
    await recovered.waitForAcceptance(run.id);
    coordinator.interruptAll('normal signal', 'process.shutdown', { normalShutdown: true });
    await reopened.flush();
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.deploymentRuns[run.id].status).toBe('queued');
    expect(persisted.deploymentIntents[run.id]).toEqual(originalIntent);
    expect(coordinator.drainReady()).toEqual([]);
    const again = new StateService(file); again.load();
    const service = new DeploymentRunService(again), next = new BranchOperationCoordinator();
    expect(service.restoreQueued(next).map(item => item.id)).toEqual([run.id]);
    await service.waitForAcceptance(run.id);
    const [pending] = next.drainReady();
    expect(next.drainReady()).toEqual([]);
    const replay = { ...pending.request, pendingReplay: { operationId: pending.operationId, generation: pending.generation } };
    expect(next.begin(replay)).toMatchObject({ status: 'started', operationId: run.operationId, generation: run.operationGeneration });
    expect(next.begin(replay).status).toBe('rejected');
    await service.claimQueued(run.id);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).deploymentRuns[run.id].status).toBe('preparing');
    const afterClaim = new StateService(file); afterClaim.load();
    expect(new DeploymentRunService(afterClaim).restoreQueued(new BranchOperationCoordinator())).toEqual([]);
  });

  it.each(['unconfirmed', 'failed'])('恢复后的真实JSON保存%s仍拒绝保留，不能把恢复数组当回执', async mode => {
    const { run } = await accepted();
    const reopened = new StateService(file); reopened.load();
    // 同一真实状态重新保存，确保受控的是实际原子写盘，而非替换flush的返回值。
    reopened.save();
    const recovered = new DeploymentRunService(reopened), coordinator = new BranchOperationCoordinator();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const original = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      if (mode === 'failed') throw new Error('synthetic recovery disk failure');
      await gate; await original(...args);
    });
    try {
      expect(recovered.restoreQueued(coordinator).map(item => item.id)).toEqual([run.id]);
      const confirmation = recovered.waitForAcceptance(run.id);
      if (mode === 'failed') await expect(confirmation).rejects.toThrow('synthetic recovery disk failure');
      else await writing;
      expect(recovered.get(run.id)?.status).toBe('queued');
      coordinator.interruptAll('normal signal', 'process.shutdown', { normalShutdown: true });
      expect(recovered.get(run.id)?.status).toBe('failed');
      release(); await confirmation.catch(() => {});
    } finally { release(); await recovered.waitForAcceptance(run.id).catch(() => {}); rename.mockRestore(); }
    await reopened.flush();
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted.deploymentRuns[run.id].status).toBe('failed');
    expect(persisted.deploymentIntents[run.id]).toBeUndefined();
  });

  it.each(['unconfirmed', 'failed'])('真实JSON受理保存%s时不产生保留许可，迟到写入也不能复活', async mode => {
    await state.flush();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const original = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      if (mode === 'failed') throw new Error('synthetic acceptance disk failure');
      await gate; await original(...args);
    });
    const { acceptance, service, coordinator } = queuedAdmission();
    try {
      await writing;
      if (mode === 'failed') await expect(acceptance).rejects.toThrow('synthetic acceptance disk failure');
      const [run] = service.list();
      expect(run.status).toBe('queued');
      coordinator.interruptAll('normal signal', 'process.shutdown', { normalShutdown: true });
      expect(run.status).toBe('failed');
      expect(state.getDeploymentIntents()).toEqual([]);
    } finally { release(); await acceptance.catch(() => {}); rename.mockRestore(); }
    await state.flush();
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Object.values(persisted.deploymentRuns)).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(persisted.deploymentIntents).toEqual({});
  });

  it.each([
    { name: '真实ENOENT', hasPid: false, storage: 'healthy' },
    { name: '健康延迟保存', hasPid: true, storage: 'delayed' },
    { name: '最终保存失败', hasPid: true, storage: 'failed' },
    { name: '最终保存超时', hasPid: true, storage: 'timeout' },
    { name: '合法旧待办在取消后仍可按原资格续接', hasPid: true, storage: 'failed', preserve: true },
  ])('真实退出回调前须保存中断终态，不能由测试事后flush补齐Mongo五秒合批：$name', async scenario => {
    const { hasPid, storage } = scenario, preserve = 'preserve' in scenario && scenario.preserve;
    // FakeMongo 只实现集合读写；保存、五秒合批、意图校验和恢复全部运行真实实现。
    const mongo = fakeMongoForRestart(), store = new MongoSplitStateBackingStore(mongo.handle);
    await store.init(); store.save(structuredClone(state.getState())); await store.flush();
    state = new StateService(file, undefined, store); state.load();
    const { run, service, coordinator, blocker } = await accepted();
    const source = fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8');
    const start = source.search(/(?:async )?function scheduleDetachedCdsRestart/);
    const end = source.indexOf('async function flushBranchStateBeforeSuccess', start);
    const gate = source.match(/^\s*const RESTART_GATE_RELEASE_MS = [^\n]+;/m);
    const budget = source.match(/const SELF_UPDATE_STATE_FLUSH_TIMEOUT_MS = (\d+);/);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    expect(gate).not.toBeNull(); expect(budget?.[1]).toBe('1000');
    const code = ts.transpileModule(`${gate![0]}\n${budget![0]}\n${source.slice(start, end)}\nscheduleDetachedCdsRestart;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true,
    });
    expect(code.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const cdsDir = path.join(dir, 'cds'), emptyBin = path.join(dir, 'empty-bin');
    fs.mkdirSync(cdsDir); fs.mkdirSync(emptyBin);
    fs.writeFileSync(path.join(cdsDir, 'exec_cds.sh'), 'exit 0\n');
    const env = { PATH: hasPid ? '/usr/bin:/bin' : emptyBin, TZ: 'UTC', LANG: 'C' };
    const timers: ReturnType<typeof setTimeout>[] = [], fds: number[] = [], errors: string[] = [];
    let child: ChildProcess | undefined, closed: Promise<void> | undefined;
    let atExit: ReturnType<typeof mongo.snapshot> | undefined, exitCode: number | undefined;
    let observeExit!: () => void;
    const observedExit = new Promise<void>(resolve => { observeExit = resolve; });
    const exit = vi.fn((code: number) => { exitCode = code; atExit = mongo.snapshot(); observeExit(); });
    const maintenanceOwner = { restartScheduled: false };
    const schedule = vm.runInNewContext(code.outputText, {
      config: { repoRoot: dir }, path, stateService: state, waitForFlushWithTimeout, prepareDetachedCdsRestart,
      process: { env, exit }, console: { warn: vi.fn() },
      getRestartWait: () => null, setRestartWait: vi.fn(), endSelfUpdateDrain: vi.fn(),
      releaseSelfMaintenance: vi.fn((owner: object) => owner === maintenanceOwner),
      branchOperationCoordinator: coordinator, deploymentRunService: service,
      fs: {
        mkdirSync: fs.mkdirSync, appendFileSync: fs.appendFileSync,
        openSync: (target: string, flags: fs.OpenMode) => {
          expect(path.resolve(target).startsWith(`${dir}${path.sep}`)).toBe(true);
          const fd = fs.openSync(target, flags); fds.push(fd); return fd;
        },
        closeSync: (fd: number) => { fs.closeSync(fd); fds.splice(fds.indexOf(fd), 1); },
      },
      setTimeout: (callback: () => void, ms: number) => {
        const timer = setTimeout(callback, ms); timers.push(timer); return timer;
      },
      spawn: (command: string, args: string[], options: SpawnOptions) => {
        expect(command).toBe('bash'); expect(args).toEqual(['-p', '-c', CDS_RESTART_PERMIT_COMMAND]);
        expect(options.cwd).toBe(cdsDir); expect(options.env).toEqual(env);
        child = spawn(command, args, options);
        closed = new Promise(resolve => child!.once('close', () => resolve()));
        child.once('error', error => { errors.push((error as NodeJS.ErrnoException).code || error.name); });
        return child;
      },
    }, { timeout: 200 }) as (input: { branchLabel: string; source: string; maintenanceOwner: typeof maintenanceOwner; preserveQueued: boolean }) => Promise<void>;
    let reopenedStore: MongoSplitStateBackingStore | undefined;
    let release!: () => void, entered!: () => void;
    const writeGate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const collection = mongo.handle.deploymentRunsCollection(), originalWrite = collection.bulkWrite.bind(collection);
    const write = vi.spyOn(collection, 'bulkWrite');
    const globalWrite = vi.spyOn(mongo.handle.globalCollection(), 'replaceOne');
    try {
      expect(await waitForFlushWithTimeout(() => state.flush(), Number(budget![1]))).toBe('flushed');
      expect(mongo.snapshot()[3].get(run.id)).toMatchObject({ doc: { status: 'queued' }, executionIntent: { runId: run.id } });
      // 正PID对照也须终止不合格待办；已确认的旧pair仍保持在FakeMongo中。
      if (hasPid && !preserve) run.operationAdmissionGeneration = 99;
      if (preserve) {
        state.getState().nextPortIndex++; state.save([{ kind: 'global' }]);
        globalWrite.mockImplementationOnce(async () => { entered(); throw new Error('synthetic unrelated global failure'); });
      } else if (storage !== 'healthy') write.mockImplementationOnce(async (...args) => {
        entered();
        if (storage === 'failed') throw new Error('synthetic final Mongo write failure');
        await writeGate; return originalWrite(...args);
      });
      const completion = schedule({ branchLabel: 'owned-exit-boundary', source: 'api.self-update', maintenanceOwner, preserveQueued: true })
        .then(() => null, error => error as Error);
      if (storage !== 'healthy') {
        await writing; expect(exit).not.toHaveBeenCalled();
        if (storage === 'delayed') release();
      }
      const outcome = await completion, shouldExit = storage === 'delayed';
      // 使用生产安排的真实一秒timer；在process.exit观察点先封存，清理不能改变判据。
      if (shouldExit) { expect(outcome).toBeNull(); await observedExit; expect(exitCode).toBe(0); }
      else { expect(outcome?.message).toContain('已取消更新与重启'); expect(exit).not.toHaveBeenCalled(); atExit = mongo.snapshot(); }
      await closed;
      expect(Boolean(child?.pid)).toBe(hasPid); expect(errors).toEqual(hasPid ? [] : ['ENOENT']);
      expect(service.get(run.id)?.status).toBe(preserve ? 'queued' : 'failed');
      expect(exit).toHaveBeenCalledTimes(shouldExit ? 1 : 0);
      if (preserve) {
        await service.waitForAcceptance(run.id);
        expect(coordinator.hasWaitingOperation(run.operationId!, run.operationGeneration!)).toBe(true);
        expect(coordinator.getActive('b')).toBeUndefined();
        expect(blocker.isCurrent()).toBe(false);
        const ready = coordinator.drainReady();
        expect(ready).toMatchObject([{ operationId: run.operationId, generation: run.operationGeneration,
          request: { actor: 'original-agent', commitSha: run.commitSha } }]);
        expect(coordinator.drainReady()).toEqual([]);
        const next = coordinator.begin({ ...ready[0].request,
          pendingReplay: { operationId: ready[0].operationId, generation: ready[0].generation } });
        expect(coordinator.completeAll(blocker, 'completed')).toEqual([]);
        expect(next.lease?.isCurrent()).toBe(true);
      } else expect(coordinator.drainReady()).toEqual([]);
      const durable = atExit![3].get(run.id);
      reopenedStore = new MongoSplitStateBackingStore(fakeMongoForRestart(atExit).handle);
      await reopenedStore.init();
      const reopened = new StateService(path.join(dir, 'reopened.json'), undefined, reopenedStore); reopened.load();
      const restoredIds = new DeploymentRunService(reopened).restoreQueued(new BranchOperationCoordinator()).map(item => item.id);
      console.info('[cds-exit-boundary-receipt]', JSON.stringify({ storage: `FakeMongo:${storage}`, exitCode, cancelled: !shouldExit,
        pidAtExit: child?.pid ?? null, errors, liveStatus: service.get(run.id)?.status,
        durableStatus: durable.doc.status, intentPresent: Boolean(durable.executionIntent), restoredIds }));
      const saved = storage === 'healthy' || storage === 'delayed';
      expect({ status: durable.doc.status, intentPresent: Boolean(durable.executionIntent), restoredIds })
        .toEqual(saved ? { status: 'failed', intentPresent: false, restoredIds: [] }
          : { status: 'queued', intentPresent: true, restoredIds: [run.id] });
    } finally {
      release(); write.mockRestore(); globalWrite.mockRestore();
      for (const timer of timers) clearTimeout(timer);
      await closed;
      for (const fd of fds) fs.closeSync(fd);
      // 只在退出快照与恢复判据已封存后清理真实store的合批timer。
      state.save(); await store.close(); await reopenedStore?.close();
    }
  });

  it.each([
    { name: '保存成功且有PID', flush: 'flushed', pid: true, status: 'queued' },
    { name: '保存成功但真实ENOENT无PID', flush: 'flushed', pid: false, status: 'failed' },
    { name: '真实保存失败且有PID', flush: 'failed', pid: true, status: 'failed' },
    { name: '原保存超时且有PID', flush: 'timeout', pid: true, status: 'failed' },
  ] as const)('实际重启调度门禁：$name', async scenario => {
    const record = vi.fn();
    const { run, service, coordinator } = await accepted(undefined, { record });
    const source = fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8');
    const start = source.search(/(?:async )?function scheduleDetachedCdsRestart/);
    const end = source.indexOf('async function flushBranchStateBeforeSuccess', start);
    const gate = source.match(/^\s*const RESTART_GATE_RELEASE_MS = [^\n]+;/m);
    const flushBudget = source.match(/const SELF_UPDATE_STATE_FLUSH_TIMEOUT_MS = (\d+);/);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    expect(gate).not.toBeNull(); expect(flushBudget).not.toBeNull();
    const code = ts.transpileModule(`${gate![0]}\n${flushBudget![0]}\n${source.slice(start, end)}\nscheduleDetachedCdsRestart;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true,
    });
    expect(code.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const cdsDir = path.join(dir, 'cds'), emptyBin = path.join(dir, 'empty-bin');
    fs.mkdirSync(cdsDir); fs.mkdirSync(emptyBin);
    fs.writeFileSync(path.join(cdsDir, 'exec_cds.sh'), 'exit 0\n', { mode: 0o600 });
    const env = { PATH: scenario.pid ? '/usr/bin:/bin' : emptyBin, TZ: 'UTC', LANG: 'C' };
    let release!: () => void, entered!: () => void;
    const writeGate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const originalRename = fs.promises.rename.bind(fs.promises);
    let faulted = false;
    const rename = scenario.flush === 'flushed' ? undefined : vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
      if (!faulted && args[1] === file) {
        faulted = true; entered();
        if (scenario.flush === 'failed') throw new Error('synthetic restart state failure');
        await writeGate;
      }
      await originalRename(...args);
    });
    const timers: { callback: () => void; ms: number }[] = [], trace: string[] = [];
    const fds: number[] = [], errors: string[] = [];
    let child: ChildProcess | undefined, pidAtReturn: number | undefined, childClosed = false;
    let close: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined, timedOut = false, boundaryError: Error | undefined;
    let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined, closedFds = 0;
    const closedFdSet = new Set<number>(), releaseGate = vi.fn(), restartWait = vi.fn(), rollback = vi.fn();
    const maintenanceOwner = { restartScheduled: false };
    const ownedPath = (target: string) => {
      if (typeof target !== 'string' || !path.resolve(target).startsWith(`${dir}${path.sep}`)) {
        boundaryError = new Error('restart fixture escaped its owned directory'); throw boundaryError;
      }
    };
    const exit = vi.fn();
    const interrupt = coordinator.interruptAll.bind(coordinator);
    const tap = vi.spyOn(coordinator, 'interruptAll').mockImplementation((...args) => { trace.push('interrupt'); interrupt(...args); });
    let write = Promise.resolve();
    try {
      state.save(); write = state.flush();
      const result = await waitForFlushWithTimeout(() => write, Number(flushBudget![1]));
      expect(result).toBe(scenario.flush);
      if (scenario.flush !== 'flushed') await writing;
      const schedule = vm.runInNewContext(code.outputText, {
        config: { repoRoot: dir }, path, stateService: state, waitForFlushWithTimeout, prepareDetachedCdsRestart,
        process: { env, exit }, console: { warn: vi.fn() },
        getRestartWait: () => null, setRestartWait: restartWait, endSelfUpdateDrain: releaseGate,
        releaseSelfMaintenance: vi.fn((owner: object) => owner === maintenanceOwner),
        branchOperationCoordinator: coordinator, deploymentRunService: service,
        fs: {
          mkdirSync: (target: string, options: fs.MakeDirectoryOptions) => { ownedPath(target); return fs.mkdirSync(target, options); },
          appendFileSync: (target: string, data: string) => { ownedPath(target); fs.appendFileSync(target, data); },
          openSync: (target: string, flags: fs.OpenMode) => { ownedPath(target); const fd = fs.openSync(target, flags); fds.push(fd); return fd; },
          closeSync: (fd: number) => { fs.closeSync(fd); closedFdSet.add(fd); closedFds++; },
        },
        setTimeout: (callback: () => void, ms: number) => { timers.push({ callback, ms }); trace.push(`timer:${ms}`); return { unref() {} }; },
        spawn: (command: string, args: string[], options: SpawnOptions) => {
          if (command !== 'bash' || JSON.stringify(args) !== JSON.stringify(['-p', '-c', CDS_RESTART_PERMIT_COMMAND])
            || options.cwd !== cdsDir || JSON.stringify(options.env) !== JSON.stringify(env)) {
            boundaryError = new Error('restart fixture received an unexpected command or environment'); throw boundaryError;
          }
          child = spawn(command, args, options); pidAtReturn = child.pid;
          close = new Promise(resolve => child!.once('close', (code, signal) => { childClosed = true; resolve({ code, signal }); }));
          child.once('error', error => { errors.push((error as NodeJS.ErrnoException).code || error.name); });
          watchdog = setTimeout(() => { if (!childClosed) { timedOut = true; child!.kill('SIGKILL'); } }, 2000);
          return child;
        },
      }, { timeout: 200 }) as (input: { branchLabel: string; source: string; maintenanceOwner: typeof maintenanceOwner; preserveQueued: boolean; rollback: () => Promise<void> }) => Promise<void>;
      record.mockClear();
      const completion = schedule({ branchLabel: 'owned-fixture', source: 'api.self-update', maintenanceOwner, preserveQueued: result === 'flushed', rollback })
        .then(() => null, error => error as Error);
      expect(timers).toHaveLength(1); timers.shift()!.callback();
      const outcome = await completion;
      expect(boundaryError).toBeUndefined(); expect(child).toBeDefined();
      const closed = closeResult = await close!;
      expect(timedOut).toBe(false);
      const handedOff = scenario.flush === 'flushed' && scenario.pid;
      if (scenario.pid) { expect(Number.isSafeInteger(pidAtReturn) && pidAtReturn! > 0).toBe(true); expect(closed).toEqual({ code: handedOff ? 0 : 1, signal: null }); expect(errors).toEqual([]); }
      else { expect(pidAtReturn).toBeUndefined(); expect(errors).toEqual(['ENOENT']); }
      expect(outcome === null).toBe(handedOff); expect(exit).not.toHaveBeenCalled();
      if (handedOff) {
        expect(timers).toHaveLength(2); expect(timers[0].ms).toBeGreaterThanOrEqual(0); expect(timers[0].ms).toBeLessThanOrEqual(1000);
        expect(trace.lastIndexOf(`timer:${timers[0].ms}`)).toBeGreaterThan(trace.indexOf('interrupt'));
        expect(timers[1].ms).toBe(15_000); expect(rollback).not.toHaveBeenCalled();
      } else {
        expect(timers).toEqual([]); expect(rollback).toHaveBeenCalledOnce();
        expect(releaseGate).toHaveBeenCalledOnce(); expect(restartWait).toHaveBeenLastCalledWith(null);
      }
      expect(service.get(run.id)?.status).toBe(scenario.status);
      expect(record.mock.calls.some(([event]) => event.operationId === run.operationId && event.action === 'branch.operation.deferred')).toBe(scenario.status === 'queued');
      expect(coordinator.drainReady()).toEqual([]);
      release(); await write.catch(() => {}); rename?.mockRestore(); await state.flush();
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(persisted.deploymentRuns[run.id].status).toBe(scenario.status);
      expect(Boolean(persisted.deploymentIntents[run.id])).toBe(scenario.status === 'queued');
    } finally {
      try { if (child && !childClosed) child.kill('SIGKILL'); if (close) closeResult = await close; }
      finally {
        if (watchdog) clearTimeout(watchdog);
        release(); await write.catch(() => {}); rename?.mockRestore(); tap.mockRestore();
        for (const fd of fds) if (!closedFdSet.has(fd)) { fs.closeSync(fd); closedFds++; }
        console.info('[cds-owned-restart-receipt]', JSON.stringify({ scenario: scenario.name, flush: scenario.flush,
          command: 'bash', args: ['-p', '-c', CDS_RESTART_PERMIT_COMMAND], cwd: cdsDir, envKeys: Object.keys(env), inheritedEnv: false,
          pidAtReturn: pidAtReturn ?? null, errors, close: closeResult, childClosed, timedOut,
          status: service.get(run.id)?.status, intentPresent: Boolean(state.getState().deploymentIntents?.[run.id]),
          timers: timers.map(timer => timer.ms), exitCalls: exit.mock.calls.length, openedFds: fds.length, closedFds }));
      }
    }
  });

  it('真实signal与三个正常重启入口接线，原保存失败及spawn失败不启用保留模式', () => {
    const routes = fs.readFileSync(new URL('../../src/routes/branches.ts', import.meta.url), 'utf8');
    const index = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(index).toContain("'process.shutdown', { normalShutdown: true }");
    expect(routes.match(/preserveQueued: restartFlush === 'flushed'/g)).toHaveLength(3);
    const launch = routes.slice(routes.indexOf('async function scheduleDetachedCdsRestart'), routes.indexOf('async function flushBranchStateBeforeSuccess'));
    expect(launch).toContain('input.preserveQueued === true && permit?.hasChildPid === true');
    expect(launch.indexOf('stateService.flush()')).toBeGreaterThan(launch.indexOf('interruptAll('));
    expect(launch.indexOf('await permit.release()')).toBeLessThan(launch.indexOf('process.exit(0)'));
    expect(routes.match(/await scheduleDetachedCdsRestart\(/g)).toHaveLength(3);
    expect(routes.match(/rollback: \(\) => checkpoint!\.rollback\(\)/g)).toHaveLength(2);
  });

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
      release(); await write; await state.flush();
      // 恢复路径另有强退回归；本例直接核对真实文件，避免两个活实例并发写同一临时文件。
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(persisted.deploymentRuns[run.id]?.status).toBe('cancelled');
      expect(persisted.deploymentIntents[run.id]).toBeUndefined();
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
