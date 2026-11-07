import { unitBindMountInspector } from '../helpers/storage-bind-fixture.js';
import { withStorageImages } from '../helpers/storage-image-mock.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ContainerService, ContainerStopUnconfirmedError } from '../../src/services/container.js';
import { prepareServiceReplacement } from '../../src/services/service-replacement.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { DeploymentPhaseBudget, deploymentPhaseBudget, restoreDeploymentMemoryReservations } from '../../src/services/deployment-phase-budget.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { setBuildGateHostLoadProvider } from '../../src/services/build-gate.js';
import type { BranchEntry, BuildProfile, ExecResult, CdsConfig, ServiceState, IShellExecutor } from '../../src/types.js';

const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'op-old', operationGeneration: 1 };
const runtime: ServiceState = { profileId: 'api', containerName: 'cds-b1-api', hostPort: 10001,
  status: 'error', containerId: 'a'.repeat(64), creationIssued: true };
const config: CdsConfig = { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
  dockerNetwork: 'test-network', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test-secret', issuer: 'test' } };

const branch = (): BranchEntry => ({ id: 'b1', projectId: 'p1', branch: 'codex/memory-regression',
  worktreePath: '/tmp/memory-regression', services: { api: structuredClone(runtime) }, status: 'error', createdAt: '2026-10-15T00:00:00.000Z' });
const profile: BuildProfile = { id: 'api', name: 'API', dockerImage: 'node:20', workDir: '.',
  command: 'node server.js', containerPort: 8080, resources: { memoryMB: 512 } };
const absent = (): ExecResult => ({ stdout: '', stderr: 'Error response from daemon: No such container: cds-b1-api', exitCode: 1 });

function inspection(running: boolean, labels: Record<string, string> = {}, id = runtime.containerId!): ExecResult {
  return { stdout: JSON.stringify({ id, running, restarting: false, status: running ? 'running' : 'exited',
    project: labels.project || 'p1', branch: labels.branch || 'b1', profile: labels.profile || 'api' }), stderr: '', exitCode: 0 };
}

describe('部署内存预约生命周期：原真实清理接缝回归', () => {
  let mock: MockShellExecutor;
  beforeEach(() => {
    mock = new MockShellExecutor();
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '0');
    setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 18 }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setBuildGateHostLoadProvider(null); });

  it('原CID停止确认后退役原名称预约，保留真实停止调用', async () => {
    const service = new ContainerService(mock, config);
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/^docker inspect/, () => ({ stdout: JSON.stringify([{ Id: runtime.containerId,
      State: { Running: false, Status: 'exited', ExitCode: 0, OOMKilled: false } }]), stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/^docker stop /, () => ({ stdout: runtime.containerId!, stderr: '', exitCode: 0 }));
    try {
      await service.stopRuntimeGroup(structuredClone(runtime), 'fixture', owner);
      expect(mock.commands).toContain(`docker stop ${runtime.containerId}`);
      expect(deploymentPhaseBudget.memorySnapshot().some(item => item.key === runtime.containerName)).toBe(false);
    } finally { deploymentPhaseBudget.releaseMemory(runtime.containerName); }
  });

  it('原未知创建尚无CID时不能按名称缺席退役责任或报告停止成功', async () => {
    const service = new ContainerService(mock, config);
    const unknown = { ...runtime, containerId: undefined };
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/^docker (?:inspect|stop) /, absent);
    try {
      await expect(service.stopRuntimeGroup(unknown, 'fixture', owner)).rejects.toBeInstanceOf(ContainerStopUnconfirmedError);
      expect(mock.commands.some(command => command.startsWith('docker stop '))).toBe(false);
      expect(deploymentPhaseBudget.memorySnapshot().some(item => item.key === runtime.containerName)).toBe(true);
    } finally { deploymentPhaseBudget.releaseMemory(runtime.containerName); }
  });

  it.each(['complete', 'diagnostics', 'stop', 'stop-returned', 'rm', 'rm-returned'] as const)('真实cleanup的%s边界：资格先于进展与派发，未确认不退款', async boundary => {
    const trace: string[] = [], progress: string[] = [];
    let current = true, entered!: () => void, resume!: () => void;
    const assigned = new Promise<void>(resolve => { entered = resolve; });
    const slot = new Promise<void>(resolve => { resume = resolve; });
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs|docker stop|docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const delayed = new ContainerService({ exec: async (command, options) => {
      const action = /^docker (stop|rm) /.exec(command)?.[1];
      if (boundary === 'diagnostics' && command.startsWith('docker inspect ')) { entered(); await slot; }
      if (action === boundary) { entered(); await slot; }
      options?.beforeStart?.();
      if (action) trace.push(`physical:${action}`);
      const result = await mock.exec(command, options);
      if (action && boundary === `${action}-returned`) { entered(); await slot; }
      return result;
    } }, config);
    const removing = delayed.remove(runtime.containerName, { ...owner, assertCurrent: () => {
      trace.push('check'); if (!current) throw new Error('原清理资格失效');
    }, onProgress: step => { trace.push(`progress:${step}`); progress.push(step); } });
    const outcome = removing.then(() => undefined, error => error as Error);
    try {
      if (boundary !== 'complete') {
        await assigned;
        expect(deploymentPhaseBudget.snapshot().cleanup.active).toHaveLength(1);
        expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(1);
        current = false; resume();
      }
      const error = await outcome;
      const allProgress = ['admitted', 'diagnostics-returned', 'stop', 'stop-returned', 'rm', 'rm-returned'];
      const stoppedBefore = boundary === 'diagnostics' ? 1 : boundary === 'stop' ? 2 : boundary === 'stop-returned' ? 3 : boundary === 'rm' ? 4 : 5;
      expect(progress).toEqual(boundary === 'complete' ? allProgress : allProgress.slice(0, stoppedBefore));
      for (const step of progress) expect(trace[trace.indexOf(`progress:${step}`) - 1]).toBe('check');
      if (boundary === 'complete') {
        expect(error).toBeUndefined(); expect(trace.filter(item => item.startsWith('physical:'))).toEqual(['physical:stop', 'physical:rm']);
        expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
      } else {
        expect(error?.message).toBe('原清理资格失效'); expect(trace).not.toContain(`physical:${boundary}`);
        expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual(boundary === 'rm-returned' ? [] : [runtime.containerName]);
      }
      expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([]);
    } finally { resume(); await outcome; }
  });

  it('真实操作池原15分钟截止发cancel后，回执未到不得提前释放cleanup槽或物理预约', async () => {
    vi.useFakeTimers();
    const messages: Array<{ type: string; id?: number; command?: string }> = [], progress: string[] = [];
    const channel = new EventEmitter() as EventEmitter & { connected: boolean; send: (message: any, callback?: (error: null) => void) => boolean; ref: () => void; unref: () => void };
    channel.connected = true; channel.ref = () => {}; channel.unref = () => {};
    channel.send = (message, callback) => {
      messages.push(message); callback?.(null);
      if (message.type === 'initialize') queueMicrotask(() => channel.emit('message', { type: 'ready' }));
      if (message.type === 'exec') queueMicrotask(() => channel.emit('message', { type: 'assigned', id: message.id }));
      return true;
    };
    // 只替换IPC传输，实际IsolatedShellExecutor负责计时、authorize、cancel及回执结算；不创建进程。
    const isolated = new IsolatedShellExecutor(mock, { processFactory: () => channel as unknown as ChildProcess,
      isolatedLane: 'operation', concurrency: 2, reservedCleanup: 1, defaultTimeoutMs: 15 * 60_000 });
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    let settled = false;
    const removing = new ContainerService(isolated, config).remove(runtime.containerName, {
      ...owner, assertCurrent: () => undefined, onProgress: step => progress.push(step),
    });
    const outcome = removing.then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const stop = messages.find(message => message.type === 'exec' && message.command?.startsWith('docker stop '));
      expect(stop).toBeDefined(); expect(messages).toContainEqual({ type: 'authorize', id: stop!.id });
      expect(progress).toEqual(['admitted', 'diagnostics-returned', 'stop']);
      await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
      expect(messages.some(message => message.type === 'cancel')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(messages).toContainEqual({ type: 'cancel', id: stop!.id });
      expect(settled).toBe(false); expect(progress).toEqual(['admitted', 'diagnostics-returned', 'stop']);
      expect(deploymentPhaseBudget.snapshot().cleanup.active).toHaveLength(1);
      expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(1);
      channel.emit('message', { type: 'cancelled', id: stop!.id });
      expect(await outcome).toMatchObject({ code: 'deadline' });
      expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([]);
      expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual([runtime.containerName]);
      expect(messages.some(message => message.command?.startsWith('docker rm '))).toBe(false);
      expect(isolated.getStats()).toMatchObject({ active: 0, queued: 0, bytes: 0 });
    } finally {
      for (const message of messages.filter(item => item.type === 'exec')) channel.emit('message', { type: 'cancelled', id: message.id });
      await outcome; vi.useRealTimers();
    }
  });

  it.each(['absent', 'present', 'unavailable', 'replaced'] as const)('真实rm返回不是CID消失证明：后置inspect=%s仍按原确认与预约CAS结算', async result => {
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/docker inspect --format.*"networks"/, () => ({ stdout: JSON.stringify({
      id: runtime.containerId, running: true, project: 'p1', branch: 'b1', profile: 'api',
      networks: { 'test-network': { Aliases: ['api'] } } }), stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect --format/, () => {
      if (result === 'replaced') deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 768,
        { ...owner, operationId: 'op-next', operationGeneration: 2 });
      return result === 'present' ? { stdout: runtime.containerId!, stderr: '', exitCode: 0 }
        : result === 'unavailable' ? { stdout: '', stderr: 'daemon unavailable', exitCode: 1 }
          : { stdout: '', stderr: `Error: No such container: ${runtime.containerId}`, exitCode: 1 };
    });
    mock.addResponsePattern(/docker inspect /, () => ({ stdout: '[]', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs|docker stop|docker rm/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const progress: string[] = [];
    const actual = new ContainerService({ exec: (command, options) => { options?.beforeStart?.(); return mock.exec(command, options); } }, config);
    const error = await actual.removeRuntimeGroup(structuredClone(runtime), { ...owner,
      assertCurrent: () => undefined, onProgress: step => progress.push(step) }).then(() => undefined, error => error as Error);
    expect(progress).toEqual(['admitted', 'diagnostics-returned', 'stop', 'stop-returned', 'rm', 'rm-returned']);
    expect(error?.message).toBe(result === 'present' || result === 'unavailable' ? '旧运行身份回收未确认，保留责任及容量占用' : undefined);
    if (result === 'absent') expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
    else expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: runtime.containerName,
      memoryMB: result === 'replaced' ? 768 : 512, owner: result === 'replaced'
        ? { ...owner, operationId: 'op-next', operationGeneration: 2 } : owner })]);
    expect(deploymentPhaseBudget.snapshot().cleanup.active).toEqual([]);
  });

});

describe('原创建与就绪资格记录保留', () => {
  let mock: MockShellExecutor;
  let service: ContainerService;
  beforeEach(() => {
    mock = new MockShellExecutor();
    // 原断言要求公共资格检查在探测前拒绝；只替换底层I/O，失守时语义失败而不访问固定端口。
    vi.spyOn(ContainerService.prototype as any, 'waitForReadinessUnbudgeted').mockResolvedValue(true);
    mock.addResponsePattern(/^docker image inspect .* --format '\[\{\{json .Id/, () => ({ exitCode: 0, stdout: JSON.stringify(['sha256:' + 'a'.repeat(64), null]), stderr: '' }));
    service = new ContainerService(withStorageImages(mock), config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '0');
    setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 18 }));
  });
  afterEach(() => {
    for (const item of deploymentPhaseBudget.memorySnapshot()) deploymentPhaseBudget.releaseMemory(item.key);
    vi.restoreAllMocks(); vi.unstubAllEnvs(); setBuildGateHostLoadProvider(null);
  });
  function prepareRun(result: () => ExecResult) {
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, result);
    mock.addResponsePattern(/docker inspect/, absent);
    const candidate = { ...runtime, containerId: undefined, creationIssued: undefined, status: 'building' as const };
    return { candidate, entry: branch() };
  }

  it.each(['run-check', 'storage'] as const)('停止服务的%s异常不能把继承旧CID当本次启动的物理证明', async stage => {
    const oldId = 'd'.repeat(64), physicalProofs: string[] = [];
    let current = true;
    const prepared = stage === 'run-check'
      ? prepareRun(() => { current = false; return { stdout: runtime.containerId!, stderr: '', exitCode: 0 }; })
      : prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }), absent);
    const stopped = { ...prepared.candidate, status: 'stopped' as const, containerId: oldId };
    prepared.entry.services.api = stopped;
    const target = await prepareServiceReplacement({ entry: prepared.entry, service: stopped, profile,
      state: { save: vi.fn() } as any, container: service, portStart: config.portStart });
    expect(target).toBe(stopped); expect(target.containerId).toBe(oldId);
    mock.addResponsePatternFirst(/docker inspect --format.*"restarting"/, match => {
      physicalProofs.push(match.input!);
      return match.input!.includes(oldId)
        ? { stdout: '', stderr: `Error: No such object: ${oldId}`, exitCode: 1 }
        : { ...inspection(stage === 'run-check'), stdout: JSON.stringify({ id: runtime.containerId,
          running: stage === 'run-check', restarting: false, status: stage === 'run-check' ? 'running' : 'created',
          project: 'p1', branch: 'b1', profile: 'api' }) };
    });
    if (stage === 'storage') vi.spyOn(service as any, 'inspectCreatedStorageContainer')
      .mockRejectedValueOnce(new Error('本次存储验证失败'));
    await expect(service.runService(prepared.entry, profile, target, undefined, undefined, { ...owner,
      assertCurrent: () => { if (!current) throw new Error('本次资格失效'); },
    })).rejects.toThrow(stage === 'run-check' ? '本次资格失效' : '本次存储验证失败');
    expect(mock.commands.some(command => command.startsWith(stage === 'run-check' ? 'docker run' : 'docker create'))).toBe(true);
    expect(target.containerId).toBe(oldId);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: target.containerName, owner })]);
    expect(physicalProofs.some(command => command.includes(oldId))).toBe(false);
  });

  it('创建命令尚未发出就失败时，释放本次刚预约的额度', async () => {
    const { candidate, entry } = prepareRun(() => ({ stdout: 'unused', stderr: '', exitCode: 0 }));
    await expect(service.runService(entry, profile, candidate, undefined, undefined,
      { ...owner, onRuntimeCreated: async () => { throw new Error('持久化失败，命令未发送'); } })).rejects.toThrow('命令未发送');
    expect(mock.commands.some(command => command.startsWith('docker run'))).toBe(false);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
  });

  it('创建命令已经结束且真实确认容器缺席时，失败额度不残留', async () => {
    const { candidate, entry } = prepareRun(() => ({ stdout: '', stderr: 'port in use', exitCode: 125 }));
    await expect(service.runService(entry, profile, candidate, undefined, undefined, owner)).rejects.toThrow('启动服务');
    expect(mock.commands.some(command => command.startsWith('docker run'))).toBe(true);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
  });

  it('命令未发送的旧失败释放执行槽时，新唤醒预约不能被旧收尾清除', async () => {
    const holders = [await deploymentPhaseBudget.acquire('start', { ...owner, profileId: 'hold1' }),
      await deploymentPhaseBudget.acquire('start', { ...owner, profileId: 'hold2' })];
    let next: Promise<() => void> | undefined;
    try {
      const { candidate, entry } = prepareRun(() => ({ stdout: '', stderr: '', exitCode: 0 }));
      await expect(service.runService(entry, profile, candidate, undefined, undefined,
        { ...owner, onRuntimeCreated: async () => {
          next = deploymentPhaseBudget.acquire('start', { ...owner, operationId: 'op-new', operationGeneration: 2 },
            { reservationKey: runtime.containerName, memoryMB: 768 });
          throw new Error('旧命令未发送');
        } })).rejects.toThrow('旧命令未发送');
      const release = await next!;
      try {
        expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: runtime.containerName, memoryMB: 768,
          owner: expect.objectContaining({ operationId: 'op-new' }) })]);
      } finally { release(); }
    } finally { for (const release of holders) release(); }
  });

  it('创建命令结果未知时保留责任与额度，不能靠缺席快照猜测创建失败', async () => {
    const { candidate, entry } = prepareRun(() => { throw new Error('创建结果未知'); });
    await expect(service.runService(entry, profile, candidate, undefined, undefined, owner)).rejects.toThrow('创建结果未知');
    expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual([runtime.containerName]);
    expect(candidate.creationIssued).toBe(true);
  });

  // Only synthetic create-time storage inventory is adapted; physical absence/readiness stays on the original mock.
  function withDelayedMemoryStorageImages(shell: IShellExecutor): MockShellExecutor {
    const bridge = new MockShellExecutor(); bridge.exec = shell.exec.bind(shell);
    return withStorageImages(bridge);
  }

  function prepareSplitRun(start: () => ExecResult, inspect: () => ExecResult) {
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '1');
    const prepared = prepareRun(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: runtime.containerId!, stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, start);
    mock.addResponsePatternFirst(/docker inspect/, inspect);
    mock.addResponsePatternFirst(/^docker inspect .*json .Mounts/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    return prepared;
  }

  it.each(['storage', 'persist', 'network'] as const)('create后%s失败且尚未发start时，created身份继续保留预约', async stage => {
    const error = new Error(`create后${stage}失败`);
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }), () =>
      ({ ...inspection(false), stdout: JSON.stringify({ id: runtime.containerId, running: false,
        restarting: false, status: 'created', project: 'p1', branch: 'b1', profile: 'api' }) }));
    if (stage === 'storage') vi.spyOn(service as any, 'inspectCreatedStorageContainer').mockRejectedValueOnce(error);
    if (stage === 'network') mock.addResponsePatternFirst(/docker network connect/, () => ({ stdout: '', stderr: error.message, exitCode: 1 }));
    await expect(service.runService(entry, profile, candidate, undefined, undefined, { ...owner,
      onRuntimeCreated: async item => { if (stage === 'persist' && item.containerId) throw error; },
    })).rejects.toThrow(error.message);
    expect(mock.commands.some(command => command.startsWith('docker create'))).toBe(true);
    expect(mock.commands.some(command => command.startsWith('docker start'))).toBe(false);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: candidate.containerName, owner })]);
  });

  it.each(['created', 'absent'] as const)('create已确认但start结果未知时，%s快照不能退还责任', async state => {
    const { candidate, entry } = prepareSplitRun(() => { throw new Error('启动结果未知'); }, () =>
      state === 'absent' ? absent() : { ...inspection(false), stdout: JSON.stringify({
        id: runtime.containerId, running: false, restarting: false, status: 'created', project: 'p1', branch: 'b1', profile: 'api' }) });
    await expect(service.runService(entry, profile, candidate, undefined, undefined, owner)).rejects.toThrow('启动结果未知');
    expect(mock.commands.some(command => command.startsWith('docker create'))).toBe(true);
    expect(mock.commands).toContain(`docker start ${candidate.containerId}`);
    expect(candidate.containerId).toBe(runtime.containerId);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: candidate.containerName, owner })]);
  });

  it.each(['created', 'absent'] as const)('start明确失败且真实确认%s时，可释放本次预约', async state => {
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: 'start failed', exitCode: 1 }), () =>
      state === 'absent' ? absent() : { ...inspection(false), stdout: JSON.stringify({
        id: runtime.containerId, running: false, restarting: false, status: 'created', project: 'p1', branch: 'b1', profile: 'api' }) });
    await expect(service.runService(entry, profile, candidate, undefined, undefined, owner)).rejects.toThrow('start failed');
    expect(mock.commands).toContain(`docker start ${candidate.containerId}`);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
  });

  it('旧start等待派发后资格失效时，不能影响同名称新run的预约', async () => {
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }), absent);
    let entered!: () => void, finish!: (result: ExecResult) => void, oldCurrent = true, calls = 0;
    const starting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    const delayed = new ContainerService(withDelayedMemoryStorageImages({ exec: (command, options) => {
      if (command.startsWith('docker start') && calls++ === 0) {
        entered(); return response.then(result => { options?.beforeStart?.(); return result; });
      }
      options?.beforeStart?.();
      return mock.exec(command, options);
    } }), config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    vi.spyOn(delayed as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    const old = delayed.runService(entry, profile, candidate, undefined, undefined,
      { ...owner, assertCurrent: () => { if (!oldCurrent) throw new Error('旧资格失效'); } });
    const rejected = expect(old).rejects.toThrow('旧资格失效');
    await starting; oldCurrent = false;
    const nextOwner = { ...owner, operationId: 'op-next', operationGeneration: 2 };
    await delayed.runService(entry, { ...profile, resources: { memoryMB: 768 } }, { ...candidate }, undefined, undefined, nextOwner);
    finish({ stdout: '', stderr: '', exitCode: 0 }); await rejected;
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: candidate.containerName,
      memoryMB: 768, owner: nextOwner })]);
  });

  it('原无操作代次调用的旧start失败回执也保留同名新run的预约和资格', async () => {
    const previousOwner = { ...owner, operationId: undefined, operationGeneration: undefined };
    const nextId = 'b'.repeat(64);
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }),
      () => ({ stdout: '', stderr: `Error: No such object: ${runtime.containerId}`, exitCode: 1 }));
    let entered!: () => void, finish!: (result: ExecResult) => void, calls = 0, newCurrent = true;
    const starting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    const delayed = new ContainerService(withDelayedMemoryStorageImages({ exec: (command, options) => {
      options?.beforeStart?.();
      if (command.startsWith('docker start') && calls++ === 0) { entered(); return response; }
      return mock.exec(command, options);
    } }), config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    vi.spyOn(delayed as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    const old = delayed.runService(entry, profile, candidate, undefined, undefined, previousOwner);
    const rejected = expect(old).rejects.toThrow('旧start无代次明确失败');
    await starting;
    mock.addResponsePatternFirst(/docker create/, () => ({ stdout: nextId, stderr: '', exitCode: 0 }));
    const next = { ...candidate, containerId: undefined };
    await delayed.runService(entry, { ...profile, resources: { memoryMB: 768 } }, next, undefined, undefined,
      { ...previousOwner, assertCurrent: () => { if (!newCurrent) throw new Error('新资格失效'); } });
    expect(next.containerId).toBe(nextId);
    finish({ stdout: '', stderr: '旧start无代次明确失败', exitCode: 1 }); await rejected;
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: next.containerName,
      memoryMB: 768, owner: previousOwner })]);
    newCurrent = false;
    await expect(delayed.waitForReadiness(next.hostPort, undefined, undefined, undefined, next.containerName))
      .rejects.toThrow('新资格失效');
  });

  it('旧start明确失败的迟到结果不释放同名称新run的预约或资格', async () => {
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }), absent);
    let entered!: () => void, finish!: (result: ExecResult) => void, calls = 0, newCurrent = true;
    const starting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    const delayed = new ContainerService(withDelayedMemoryStorageImages({ exec: (command, options) => {
      options?.beforeStart?.();
      if (command.startsWith('docker start') && calls++ === 0) { entered(); return response; }
      return mock.exec(command, options);
    } }), config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    vi.spyOn(delayed as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    const old = delayed.runService(entry, profile, candidate, undefined, undefined, owner);
    const rejected = expect(old).rejects.toThrow('旧start明确失败');
    await starting;
    const nextOwner = { ...owner, operationId: 'op-next', operationGeneration: 2 };
    await delayed.runService(entry, { ...profile, resources: { memoryMB: 768 } }, { ...candidate }, undefined, undefined,
      { ...nextOwner, assertCurrent: () => { if (!newCurrent) throw new Error('新资格失效'); } });
    finish({ stdout: '', stderr: '旧start明确失败', exitCode: 1 }); await rejected;
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: candidate.containerName,
      memoryMB: 768, owner: nextOwner })]);
    newCurrent = false;
    await expect(delayed.waitForReadiness(candidate.hostPort, undefined, undefined, undefined, candidate.containerName))
      .rejects.toThrow('新资格失效');
  });

  it.each(['create', 'start', 'network'] as const)('旧%s成功晚回不得覆盖已完成的新run身份、预约、资格或成功事件', async boundary => {
    vi.useFakeTimers();
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }), absent);
    mock.addResponsePatternFirst(/docker inspect --format="/, () => ({ stdout: 'running|0', stderr: '', exitCode: 0 }));
    let createCalls = 0, intercepted = false, oldCurrent = true, newCurrent = true;
    let entered!: () => void, finish!: (result: ExecResult) => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    const newId = 'c'.repeat(64);
    mock.addResponsePatternFirst(/docker create/, () => ({ stdout: ++createCalls === 1 && boundary !== 'create'
      ? runtime.containerId! : newId, stderr: '', exitCode: 0 }));
    const record = vi.fn(), oldSaved = vi.fn(async () => undefined);
    const commandBoundary = boundary === 'network' ? 'docker network connect' : `docker ${boundary}`;
    const delayed = new ContainerService(withDelayedMemoryStorageImages({ exec: (command, options) => {
      options?.beforeStart?.();
      if (!intercepted && command.startsWith(commandBoundary)) { intercepted = true; entered(); return response; }
      return mock.exec(command, options);
    } }), config, undefined, { record }, undefined, undefined, unitBindMountInspector);
    const old = delayed.runService(entry, profile, candidate, undefined, undefined, { ...owner, onRuntimeCreated: oldSaved,
      assertCurrent: () => { if (!oldCurrent) throw new Error('旧资格失效'); } });
    const outcome = old.then(() => undefined, error => error as Error);
    try {
      await waiting; oldCurrent = false;
      const nextOwner = { ...owner, operationId: 'op-next', operationGeneration: 2 };
      const next = delayed.runService(entry, { ...profile, resources: { memoryMB: 768 } }, candidate, undefined, undefined,
        { ...nextOwner, assertCurrent: () => { if (!newCurrent) throw new Error('新资格失效'); } });
      await vi.advanceTimersByTimeAsync(6000); await next;
      expect(candidate.containerId).toBe(newId);
      const connectedNetworks = [...(candidate.connectedNetworks || [])];
      const savedCount = oldSaved.mock.calls.length;
      finish({ stdout: runtime.containerId!, stderr: '', exitCode: 0 });
      await vi.advanceTimersByTimeAsync(6000);
      expect(await outcome).toEqual(expect.objectContaining({ message: '旧资格失效' }));
      expect(candidate.containerId).toBe(newId);
      expect(candidate.connectedNetworks).toEqual(connectedNetworks);
      expect(oldSaved).toHaveBeenCalledTimes(savedCount);
      expect(record.mock.calls.some(([event]) => event.action === 'app.run.started' && event.operationId === owner.operationId)).toBe(false);
      expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: candidate.containerName,
        memoryMB: 768, owner: nextOwner })]);
      newCurrent = false;
      await expect(delayed.waitForReadiness(candidate.hostPort, undefined, undefined, undefined, candidate.containerName))
        .rejects.toThrow('新资格失效');
    } finally { finish({ stdout: '', stderr: '', exitCode: 1 }); await vi.advanceTimersByTimeAsync(6000); await outcome; vi.useRealTimers(); }
  });

  it('旧就绪回调迟到结束时不删除同名称新部署的资格记录', async () => {
    const { candidate, entry } = prepareRun(() => ({ stdout: 'a'.repeat(64), stderr: '', exitCode: 0 }));
    vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    let oldCurrent = true, newCurrent = true, entered!: () => void, finish!: () => void;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(service as any, 'waitForReadinessUnbudgeted').mockImplementationOnce(async () => {
      entered(); await response; return true;
    }).mockResolvedValue(true);
    const oldCheck = () => { if (!oldCurrent) throw new Error('旧资格失效'); };
    const newCheck = () => { if (!newCurrent) throw new Error('新资格失效'); };
    await service.runService(entry, profile, candidate, undefined, undefined, { ...owner, assertCurrent: oldCheck });
    const oldReady = service.waitForReadiness(candidate.hostPort, undefined, undefined, undefined, candidate.containerName);
    const rejected = expect(oldReady).rejects.toThrow('旧资格失效');
    await probing; oldCurrent = false;
    await service.runService(entry, profile, { ...candidate }, undefined, undefined,
      { ...owner, operationId: 'op-new', operationGeneration: 2, assertCurrent: newCheck });
    finish(); await rejected;
    newCurrent = false;
    await expect(service.waitForReadiness(candidate.hostPort, undefined, undefined, undefined, candidate.containerName)).rejects.toThrow('新资格失效');
  });

  it('旧创建失败catch迟到时不删除同名称新部署的资格记录', async () => {
    const { candidate, entry } = prepareRun(() => ({ stdout: 'a'.repeat(64), stderr: '', exitCode: 0 }));
    vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    vi.spyOn(service as any, 'waitForReadinessUnbudgeted').mockResolvedValue(true);
    let oldCurrent = true, newCurrent = true, entered!: () => void, finish!: () => void;
    const saving = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    const oldRun = service.runService(entry, profile, candidate, undefined, undefined,
      { ...owner, assertCurrent: () => { if (!oldCurrent) throw new Error('旧资格失效'); },
        onRuntimeCreated: async () => { entered(); await response; throw new Error('旧创建保存失败'); } });
    const rejected = expect(oldRun).rejects.toThrow('旧创建保存失败');
    await saving; oldCurrent = false;
    await service.runService(entry, profile, { ...candidate }, undefined, undefined,
      { ...owner, operationId: 'op-new', operationGeneration: 2,
        assertCurrent: () => { if (!newCurrent) throw new Error('新资格失效'); } });
    finish(); await rejected;
    newCurrent = false;
    await expect(service.waitForReadiness(candidate.hostPort, undefined, undefined, undefined, candidate.containerName)).rejects.toThrow('新资格失效');
  });
});

describe('原冷恢复预约合同在当前异步入口', () => {
  it('候选部署把聚合状态改成building时，不重复预约已发布旧运行，仍保留未就绪候选额度', async () => {
    const entry = branch(); entry.services.api.status = 'building';
    entry.services.api.servingRuntime = { ...runtime };
    entry.services.api.pendingRuntime = { ...runtime, containerName: 'new-candidate', containerId: 'b'.repeat(64) };
    const budget = new DeploymentPhaseBudget(() => 10000);
    await restoreDeploymentMemoryReservations([entry], () => [profile], { budget });
    expect(budget.memorySnapshot().map(item => item.key)).toEqual(['new-candidate']);
  });

  it('发布身份没有确认CID时仍保留旧运行的未知责任', async () => {
    const entry = branch(); entry.services.api.status = 'building';
    entry.services.api.servingRuntime = { ...runtime, containerId: undefined };
    const budget = new DeploymentPhaseBudget(() => 10000);
    await restoreDeploymentMemoryReservations([entry], () => [profile], { budget });
    expect(budget.memorySnapshot().map(item => item.key)).toEqual([runtime.containerName]);
  });

  it.each(['absent', 'exited', 'created', 'running', 'unavailable', 'foreign', 'wrong-id', 'unknown-create'] as const)(
    '原冷预约按确认事实收敛%s，未知仍保留', async kind => {
      const entry = branch();
      if (kind === 'unknown-create') entry.services.api.containerId = undefined;
      const budget = new DeploymentPhaseBudget(() => 10000), shell = new MockShellExecutor();
      shell.addResponsePattern(/^docker inspect /, () => kind === 'absent'
        ? { stdout: '', stderr: `Error: No such object: ${runtime.containerId}`, exitCode: 1 }
        : kind === 'unavailable' ? { stdout: '', stderr: 'daemon unavailable', exitCode: 1 }
          : { stdout: JSON.stringify({ id: kind === 'wrong-id' ? 'c'.repeat(64) : runtime.containerId,
            status: kind === 'exited' ? 'exited' : kind === 'created' ? 'created' : 'running',
            project: kind === 'foreign' ? 'p-other' : 'p1', branch: 'b1', profile: 'api' }), stderr: '', exitCode: 0 });
      await restoreDeploymentMemoryReservations([entry], () => [profile], { budget, shell });
      expect(budget.memorySnapshot().map(item => item.key)).toEqual(['absent', 'exited'].includes(kind) ? [] : [runtime.containerName]);
      expect(entry.services.api.status).toBe('error');
      expect(shell.commands.every(command => command.startsWith('docker inspect '))).toBe(true);
    });
});

describe('原有界冷盘点与不可变身份回归', () => {
  let mock: MockShellExecutor;
  let service: ContainerService;
  beforeEach(() => {
    mock = new MockShellExecutor();
    service = new ContainerService(mock, config);
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '0');
    setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 18 }));
  });
  afterEach(() => {
    for (const item of deploymentPhaseBudget.memorySnapshot()) deploymentPhaseBudget.releaseMemory(item.key);
    vi.restoreAllMocks(); vi.unstubAllEnvs(); setBuildGateHostLoadProvider(null);
  });

  it.each(['absent', 'stopped'] as const)('已有创建终结证明的%s候选经真实身份检查后释放', async state => {
    const entry = branch();
    // 本例调用方额外确认创建已终结；实际冷启动另须通过下方生产接线判据。
    if (state === 'absent') entry.services.api.containerId = undefined;
    await restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, () => state === 'absent' ? absent() : inspection(false));
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(result.released).toEqual([runtime.containerName]);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
    expect(entry.services.api.creationIssued).toBe(true);
    expect(mock.commands.every(command => command.startsWith('docker inspect'))).toBe(true);
  });

  it.each(['unknown-create', 'created', 'exited', 'absent'] as const)('冷恢复实际接线按确认事实收敛%s的预约', async state => {
    const source = ts.createSourceFile('index.ts', readFileSync(path.resolve('src/index.ts'), 'utf8'), ts.ScriptTarget.Latest);
    let predicate: string | undefined;
    const visit = (node: ts.Node) => {
      if (!predicate && ts.isPropertyAssignment(node) && node.name.getText(source) === 'creationSettled') predicate = node.initializer.getText(source);
      ts.forEachChild(node, visit);
    };
    visit(source); expect(predicate).toBeTruthy();
    const creationSettled = new Function(`return (${predicate});`)() as NonNullable<Parameters<ContainerService['reconcileDeploymentMemoryReservations']>[1]>['creationSettled'];
    const entry = branch(); if (state === 'unknown-create') entry.services.api.containerId = undefined;
    await restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, () => state === 'absent' || state === 'unknown-create' ? absent()
      : { ...inspection(false), stdout: JSON.stringify({ ...JSON.parse(inspection(false).stdout), status: state }) });
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled });
    const unknown = state === 'unknown-create' || state === 'created';
    expect(result.retained).toHaveLength(unknown ? 1 : 0);
    expect(result.released).toHaveLength(unknown ? 0 : 1);
    expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(unknown ? 1 : 0);
  });

  it.each(['running', 'unavailable', 'foreign', 'wrong-id'] as const)('%s不能释放既有预约', async state => {
    const entry = branch(); await restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, () => state === 'running' ? inspection(true)
      : state === 'unavailable' ? { stdout: '', stderr: 'daemon unavailable', exitCode: 1 }
        : state === 'foreign' ? inspection(false, { project: 'foreign' }) : inspection(false, {}, 'b'.repeat(64)));
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(result.released).toEqual([]);
    expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual([runtime.containerName]);
  });

  it.each(['absent', 'exited', 'running', 'unavailable', 'foreign', 'wrong-id', 'created'] as const)(
    '服务引用已被替换时，以预约保存的CID核验%s，不把其他项目或未知运行释放', async state => {
      const entry = branch();
      await restoreDeploymentMemoryReservations([entry], () => [profile]);
      entry.services.api = { ...runtime, containerName: 'replacement', containerId: 'b'.repeat(64), status: 'running' };
      mock.addResponsePattern(/docker inspect/, () => state === 'absent' ? absent()
        : state === 'unavailable' ? { stdout: '', stderr: 'daemon unavailable', exitCode: 1 }
          : state === 'foreign' ? inspection(false, { project: 'foreign' })
            : state === 'wrong-id' ? inspection(false, {}, 'c'.repeat(64))
              : state === 'created' ? { ...inspection(false), stdout: JSON.stringify({ ...JSON.parse(inspection(false).stdout), status: 'created' }) }
                : inspection(state === 'running'));
      const result = await service.reconcileDeploymentMemoryReservations([entry], {
        recoveredOnly: true, creationSettled: (_owner, item) => Boolean(item.containerId),
      });
      expect(mock.commands).toHaveLength(1);
      expect(mock.commands[0]).toContain(runtime.containerId!);
      expect(mock.commands[0]).not.toContain(entry.services.api.containerId!);
      expect(result.released).toHaveLength(state === 'absent' || state === 'exited' ? 1 : 0);
      expect(entry.services.api.status).toBe('running');
      expect(mock.commands.every(command => command.startsWith('docker inspect'))).toBe(true);
    });

  it('服务引用丢失且预约没有确认CID时，不能凭一次名称缺席释放未知创建', async () => {
    const entry = branch(); entry.services.api.containerId = undefined;
    await restoreDeploymentMemoryReservations([entry], () => [profile]);
    entry.services.api = { ...runtime, containerName: 'replacement', status: 'running' };
    mock.addResponsePattern(/docker inspect/, absent);
    const result = await service.reconcileDeploymentMemoryReservations([entry], { recoveredOnly: true, creationSettled: () => true });
    expect(result.released).toEqual([]);
    expect(mock.commands).toEqual([]);
  });

  it('旧引用被替换后的迟到核验不能删除同名称新代次预约', async () => {
    const entry = branch(); await restoreDeploymentMemoryReservations([entry], () => [profile]);
    entry.services.api = { ...runtime, containerName: 'replacement', status: 'running' };
    let finish!: (value: ExecResult) => void;
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    const delayed = new ContainerService({ exec: () => response }, config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    const checking = delayed.reconcileDeploymentMemoryReservations([entry], { recoveredOnly: true, creationSettled: () => true });
    await Promise.resolve();
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 768, { ...owner, operationId: 'op-new', operationGeneration: 2 });
    finish(absent()); await checking;
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ memoryMB: 768,
      owner: expect.objectContaining({ operationId: 'op-new' }) })]);
  });

  it('一次冷盘点最多核64项，其余保持预约不拖长启动', async () => {
    const entry = branch(); entry.services = {};
    for (let index = 0; index < 65; index++) {
      const id = `api-${index}`;
      entry.services[id] = { ...runtime, profileId: id, containerName: `cds-b1-${id}` };
    }
    await restoreDeploymentMemoryReservations([entry], () => []);
    mock.addResponsePattern(/docker inspect/, absent);
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(mock.commands).toHaveLength(64);
    expect(result.released).toHaveLength(64);
    expect(result.retained).toEqual(['cds-b1-api-64']);
  });

  it('冷恢复前64个仍在运行时，下一轮必须核到已结束的尾部预约', async () => {
    const entry = branch(); entry.services = {};
    for (let index = 0; index < 65; index++) entry.services[`api-${index}`] = {
      ...runtime, profileId: `api-${index}`, containerName: `cds-b1-api-${index}`,
      containerId: (index + 1).toString(16).padStart(64, '0') };
    await restoreDeploymentMemoryReservations([entry], () => []);
    mock.addResponsePattern(/docker inspect/, match => match.input!.includes(entry.services['api-64'].containerId!)
      ? absent() : inspection(true));
    const options = { creationSettled: () => true, recoveredOnly: true };
    await service.reconcileDeploymentMemoryReservations([entry], options);
    const second = await service.reconcileDeploymentMemoryReservations([entry], options);
    expect(second.released).toEqual(['cds-b1-api-64']);
    expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(64);
    expect(mock.commands).toHaveLength(128);
  });

  it('实际宿主Docker对已知CID返回no such object时释放原冷预约', async () => {
    const entry = branch(); await restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: '', exitCode: 1,
      stderr: `error: no such object: ${runtime.containerId}` }));
    const result = await service.reconcileDeploymentMemoryReservations([entry], {
      recoveredOnly: true, creationSettled: () => true });
    expect(result.released).toEqual([runtime.containerName]);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
  });

  it.each([false, true])('冷续扫不得释放同名称后来预约（先有冷预约=%s）', async restored => {
    const entry = branch();
    if (restored) await restoreDeploymentMemoryReservations([entry], () => [profile]);
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 768, owner);
    mock.addResponsePattern(/docker inspect/, absent);
    const options = { creationSettled: () => true, recoveredOnly: true };
    const result = await service.reconcileDeploymentMemoryReservations([entry], options);
    expect(result.released).toEqual([]);
    expect(mock.commands).toEqual([]);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ memoryMB: 768, owner })]);
  });

  it('总读取预算15秒且单次不超过剩余预算，耗尽后预约保持未知', async () => {
    const entry = branch(); entry.services = {};
    for (let index = 0; index < 5; index++) entry.services[`api-${index}`] = {
      ...runtime, profileId: `api-${index}`, containerName: `cds-b1-api-${index}` };
    await restoreDeploymentMemoryReservations([entry], () => []);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const timeouts: number[] = [];
    const bounded = new ContainerService({ exec: async (_command, options) => {
      timeouts.push(options!.timeout!); elapsed += 6000; return absent();
    } }, config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    const result = await bounded.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(timeouts).toEqual([5000, 5000, 3000]);
    expect(result.retained).toEqual(['cds-b1-api-3', 'cds-b1-api-4']);
  });

  it('创建结果未知或仍在途时即使容器当前缺席也不能释放', async () => {
    const entry = branch(); entry.services.api.containerId = undefined;
    await restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, absent);
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => false });
    expect(result.released).toEqual([]);
    expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(1);
  });

  it.each(['stopped', 'absent'] as const)('旧身份%s读取期间同名称被新操作预约时，不释放新代次额度', async state => {
    const entry = branch(); await restoreDeploymentMemoryReservations([entry], () => [profile]);
    let release!: (value: ExecResult) => void;
    const response = new Promise<ExecResult>(resolve => { release = resolve; });
    const delayed = new ContainerService({ exec: () => response }, config, undefined, undefined, undefined, undefined, unitBindMountInspector);
    const checking = delayed.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    await Promise.resolve();
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 768, { ...owner, operationId: 'op-new', operationGeneration: 2 });
    release(state === 'absent' ? absent() : inspection(false)); await checking;
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: runtime.containerName, memoryMB: 768,
      owner: expect.objectContaining({ operationId: 'op-new' }) })]);
  });

});
