import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { DeploymentPhaseBudget, deploymentPhaseBudget, restoreDeploymentMemoryReservations } from '../../src/services/deployment-phase-budget.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { setBuildGateHostLoadProvider, type BuildLoadPressure } from '../../src/services/build-gate.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { BranchEntry, BuildProfile, CdsConfig, ExecResult, ServiceState } from '../../src/types.js';

const owner = { projectId: 'p1', branchId: 'b1', profileId: 'api', operationId: 'op-old', operationGeneration: 1 };
const runtime: ServiceState = { profileId: 'api', containerName: 'cds-b1-api', hostPort: 10001,
  status: 'error', containerId: 'a'.repeat(64), creationIssued: true };
const branch = (): BranchEntry => ({ id: 'b1', projectId: 'p1', branch: 'codex/memory-regression',
  worktreePath: '/tmp/memory-regression', services: { api: structuredClone(runtime) }, status: 'error', createdAt: '2026-10-15T00:00:00.000Z' });
const profile: BuildProfile = { id: 'api', name: 'API', dockerImage: 'node:20', workDir: '.',
  command: 'node server.js', containerPort: 8080, resources: { memoryMB: 512 } };
const config: CdsConfig = { repoRoot: '/repo', worktreeBase: '/wt', masterPort: 9900, workerPort: 5500,
  dockerNetwork: 'test-network', portStart: 10001, sharedEnv: {}, jwt: { secret: 'test-secret', issuer: 'test' } };
const absent = (): ExecResult => ({ stdout: '', stderr: 'Error response from daemon: No such container: cds-b1-api', exitCode: 1 });
const idlePressure = (): BuildLoadPressure => ({ load1: 0, cores: 18, ratio: 0, factor: 1.2, saturated: false });
function inspection(running: boolean, labels: Record<string, string> = {}, id = runtime.containerId!): ExecResult {
  return { stdout: JSON.stringify({ id, running, restarting: false, status: running ? 'running' : 'exited',
    project: labels.project || 'p1', branch: labels.branch || 'b1', profile: labels.profile || 'api' }), stderr: '', exitCode: 0 };
}

describe('部署内存预约生命周期', () => {
  let mock: MockShellExecutor;
  let service: ContainerService;
  beforeEach(() => {
    mock = new MockShellExecutor(); service = new ContainerService(mock, config);
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '0');
    setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 18 }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setBuildGateHostLoadProvider(null); });

  it('恢复三份历史未知预约不虚构本进程启动体，仍保留物理责任且允许新启动', async () => {
    const entry = branch(); entry.services = {};
    for (let index = 0; index < 3; index++) entry.services[`old-${index}`] = {
      ...runtime, profileId: `old-${index}`, containerName: `old-${index}` };
    restoreDeploymentMemoryReservations([entry], () => []);
    const restored = deploymentPhaseBudget.memorySnapshot();
    const abort = new AbortController(); let admitted = false;
    const next = deploymentPhaseBudget.acquire('start', owner, { reservationKey: 'new-runtime', signal: abort.signal })
      .then(release => { admitted = true; return release; }, () => undefined);
    try {
      await Promise.resolve();
      expect(admitted).toBe(true);
      expect(deploymentPhaseBudget.memorySnapshot().filter(item => item.key.startsWith('old-'))).toEqual(restored);
      expect(Object.values(entry.services).every(item => item.status === 'error' && item.creationIssued)).toBe(true);
    } finally { abort.abort(); (await next)?.(); deploymentPhaseBudget.releaseMemory('new-runtime'); }
  });

  it('按不可变ID停止成功后释放原容器名称预约，不删除容器', async () => {
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/docker exec/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: JSON.stringify([{ Id: runtime.containerId,
      State: { Status: 'exited', Running: false } }]), stderr: '', exitCode: 0 }));
    await service.stopRuntimeGroup(structuredClone(runtime), '测试停止', owner);
    expect(mock.commands).toContain(`docker stop ${runtime.containerId}`);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
    expect(mock.commands.some(command => /docker rm/.test(command))).toBe(false);
  });

  it('停止未确认仍保留名称预约，不将实际运行的候选记成空闲', async () => {
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: 'not confirmed', exitCode: 1 }));
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: JSON.stringify([{ Id: runtime.containerId,
      State: { Status: 'running', Running: true } }]), stderr: '', exitCode: 0 }));
    await expect(service.stopRuntimeGroup(structuredClone(runtime), '测试停止', owner)).rejects.toThrow('停止结果未确认');
    expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual([runtime.containerName]);
  });

  it.each([true, false])('停止旧%s身份的迟到回执不得清掉同名称新预约', async byId => {
    const oldRuntime = { ...runtime, containerId: byId ? runtime.containerId : undefined };
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 512, owner);
    let entered!: () => void, finish!: (result: ExecResult) => void;
    const stopping = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: JSON.stringify([{ Id: runtime.containerId,
      State: { Status: 'exited', Running: false } }]), stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker inspect --format.*"running"/, () => ({ stdout: JSON.stringify({
      id: runtime.containerId, running: false, project: 'p1', branch: 'b1', profile: 'api',
      networks: { 'old-network': { Aliases: ['api'] } } }), stderr: '', exitCode: 0 }));
    const delayed = new ContainerService({ exec: (command, options) => {
      if (command.startsWith('docker stop')) { entered(); return response; }
      return mock.exec(command, options);
    } }, config);
    const stop = delayed.stopRuntimeGroup(oldRuntime, '旧操作停止', owner);
    await stopping;
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 768, { ...owner, operationId: 'op-new', operationGeneration: 2 });
    finish({ stdout: '', stderr: '', exitCode: 0 }); await stop;
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ memoryMB: 768,
      owner: expect.objectContaining({ operationId: 'op-new' }) })]);
  });

  it.each(['absent', 'stopped'] as const)('已有创建终结证明的%s候选经真实身份检查后释放', async state => {
    const entry = branch();
    // 本例调用方额外确认创建已终结；实际冷启动另须通过下方生产接线判据。
    if (state === 'absent') entry.services.api.containerId = undefined;
    restoreDeploymentMemoryReservations([entry], () => [profile]);
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
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'creationSettled') predicate = node.initializer.getText(source);
      ts.forEachChild(node, visit);
    };
    visit(source); expect(predicate).toBeTruthy();
    const creationSettled = new Function(`return (${predicate});`)() as NonNullable<Parameters<ContainerService['reconcileDeploymentMemoryReservations']>[1]>['creationSettled'];
    const entry = branch(); if (state === 'unknown-create') entry.services.api.containerId = undefined;
    restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, () => state === 'absent' || state === 'unknown-create' ? absent()
      : { ...inspection(false), stdout: JSON.stringify({ ...JSON.parse(inspection(false).stdout), status: state }) });
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled });
    const unknown = state === 'unknown-create' || state === 'created';
    expect(result.retained).toHaveLength(unknown ? 1 : 0);
    expect(result.released).toHaveLength(unknown ? 0 : 1);
    expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(unknown ? 1 : 0);
  });

  it.each(['running', 'unavailable', 'foreign', 'wrong-id'] as const)('%s不能释放既有预约', async state => {
    const entry = branch(); restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, () => state === 'running' ? inspection(true)
      : state === 'unavailable' ? { stdout: '', stderr: 'daemon unavailable', exitCode: 1 }
        : state === 'foreign' ? inspection(false, { project: 'foreign' }) : inspection(false, {}, 'b'.repeat(64)));
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(result.released).toEqual([]);
    expect(deploymentPhaseBudget.memorySnapshot().map(item => item.key)).toEqual([runtime.containerName]);
  });

  it('一次冷盘点最多核64项，其余保持预约不拖长启动', async () => {
    const entry = branch(); entry.services = {};
    for (let index = 0; index < 65; index++) {
      const id = `api-${index}`;
      entry.services[id] = { ...runtime, profileId: id, containerName: `cds-b1-${id}` };
    }
    restoreDeploymentMemoryReservations([entry], () => []);
    mock.addResponsePattern(/docker inspect/, absent);
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(mock.commands).toHaveLength(64);
    expect(result.released).toHaveLength(64);
    expect(result.retained).toEqual(['cds-b1-api-64']);
  });

  it('总读取预算15秒且单次不超过剩余预算，耗尽后预约保持未知', async () => {
    const entry = branch(); entry.services = {};
    for (let index = 0; index < 5; index++) entry.services[`api-${index}`] = {
      ...runtime, profileId: `api-${index}`, containerName: `cds-b1-api-${index}` };
    restoreDeploymentMemoryReservations([entry], () => []);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const timeouts: number[] = [];
    const bounded = new ContainerService({ exec: async (_command, options) => {
      timeouts.push(options!.timeout!); elapsed += 6000; return absent();
    } }, config);
    const result = await bounded.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(timeouts).toEqual([5000, 5000, 3000]);
    expect(result.retained).toEqual(['cds-b1-api-3', 'cds-b1-api-4']);
  });

  it('创建结果未知或仍在途时即使容器当前缺席也不能释放', async () => {
    const entry = branch(); entry.services.api.containerId = undefined;
    restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, absent);
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => false });
    expect(result.released).toEqual([]);
    expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(1);
  });

  it.each(['stopped', 'absent'] as const)('旧身份%s读取期间同名称被新操作预约时，不释放新代次额度', async state => {
    const entry = branch(); restoreDeploymentMemoryReservations([entry], () => [profile]);
    let release!: (value: ExecResult) => void;
    const response = new Promise<ExecResult>(resolve => { release = resolve; });
    const delayed = new ContainerService({ exec: () => response }, config);
    const checking = delayed.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    await Promise.resolve();
    deploymentPhaseBudget.reserveKnownMemory(runtime.containerName, 768, { ...owner, operationId: 'op-new', operationGeneration: 2 });
    release(state === 'absent' ? absent() : inspection(false)); await checking;
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: runtime.containerName, memoryMB: 768,
      owner: expect.objectContaining({ operationId: 'op-new' }) })]);
  });

  function prepareRun(result: () => ExecResult) {
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm -f/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, result);
    mock.addResponsePattern(/docker inspect/, absent);
    const candidate = { ...runtime, containerId: undefined, creationIssued: undefined, status: 'building' as const };
    return { candidate, entry: branch() };
  }

  it('历史未知预约不冒充就绪，饱和负载下新run必须等前个真实readiness才启动', async () => {
    const historical = branch(); historical.services = {};
    for (let index = 0; index < 3; index++) historical.services[`old-${index}`] = {
      ...runtime, profileId: `old-${index}`, containerName: `old-${index}` };
    restoreDeploymentMemoryReservations([historical], () => []);
    const restored = deploymentPhaseBudget.memorySnapshot();
    setBuildGateHostLoadProvider(() => ({ load1: 18, cores: 18 }));
    const { candidate, entry } = prepareRun(() => ({ stdout: 'c'.repeat(64), stderr: '', exitCode: 0 }));
    const first = { ...candidate, containerName: 'current-first' };
    const second = { ...candidate, containerName: 'current-second' };
    vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    let entered!: () => void, finish!: () => void, current = true;
    const probing = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(service as any, 'waitForReadinessUnbudgeted').mockImplementationOnce(async () => {
      entered(); await response; return true;
    }).mockResolvedValue(true);
    const onBeforeSourceStart = vi.fn(async () => undefined);
    const assertCurrent = () => { if (!current) throw new Error('测试资格结束'); };
    await service.runService(entry, profile, first, undefined, undefined, { ...owner, assertCurrent, onBeforeSourceStart });
    const next = service.runService(entry, profile, second, undefined, undefined,
      { ...owner, operationId: 'op-next', operationGeneration: 2, assertCurrent, onBeforeSourceStart });
    const nextSettled = next.catch(() => undefined);
    let ready: Promise<boolean> | undefined;
    try {
      await vi.waitFor(() => expect(deploymentPhaseBudget.snapshot().start.queued[0]?.reason).toBe('cpu-startup-capacity'));
      expect(onBeforeSourceStart).toHaveBeenCalledTimes(1);
      ready = service.waitForReadiness(first.hostPort, undefined, undefined, undefined, first.containerName);
      await probing;
      expect(onBeforeSourceStart).toHaveBeenCalledTimes(1);
      expect(deploymentPhaseBudget.memorySnapshot()).toHaveLength(4);
      finish(); expect(await ready).toBe(true); await next;
      expect(onBeforeSourceStart).toHaveBeenCalledTimes(2);
      expect(deploymentPhaseBudget.memorySnapshot().filter(item => item.key.startsWith('old-'))).toEqual(restored);
      expect(Object.values(historical.services).every(item => item.status === 'error')).toBe(true);
      expect(await service.waitForReadiness(second.hostPort, undefined, undefined, undefined, second.containerName)).toBe(true);
      expect(deploymentPhaseBudget.memorySnapshot()).toEqual(restored);
    } finally { current = false; finish(); deploymentPhaseBudget.pump(); await nextSettled; await ready?.catch(() => undefined); }
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

  function prepareSplitRun(start: () => ExecResult, inspect: () => ExecResult) {
    vi.stubEnv('CDS_BRANCH_NETWORK_ISOLATION', '1');
    const prepared = prepareRun(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker create/, () => ({ stdout: runtime.containerId!, stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker start/, start);
    mock.addResponsePatternFirst(/docker inspect/, inspect);
    return prepared;
  }

  it.each(['created', 'absent'] as const)('create已确认但start结果未知时，%s快照不能退还责任', async state => {
    const { candidate, entry } = prepareSplitRun(() => { throw new Error('启动结果未知'); }, () =>
      state === 'absent' ? absent() : { ...inspection(false), stdout: JSON.stringify({
        id: runtime.containerId, running: false, restarting: false, status: 'created', project: 'p1', branch: 'b1', profile: 'api' }) });
    await expect(service.runService(entry, profile, candidate, undefined, undefined, owner)).rejects.toThrow('启动结果未知');
    expect(mock.commands.some(command => command.startsWith('docker create'))).toBe(true);
    expect(mock.commands).toContain(`docker start ${candidate.containerName}`);
    expect(candidate.containerId).toBe(runtime.containerId);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: candidate.containerName, owner })]);
  });

  it.each(['created', 'absent'] as const)('start明确失败且真实确认%s时，可释放本次预约', async state => {
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: 'start failed', exitCode: 1 }), () =>
      state === 'absent' ? absent() : { ...inspection(false), stdout: JSON.stringify({
        id: runtime.containerId, running: false, restarting: false, status: 'created', project: 'p1', branch: 'b1', profile: 'api' }) });
    await expect(service.runService(entry, profile, candidate, undefined, undefined, owner)).rejects.toThrow('start failed');
    expect(mock.commands).toContain(`docker start ${candidate.containerName}`);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
  });

  it('旧start等待派发后资格失效时，不能影响同名称新run的预约', async () => {
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }), absent);
    let entered!: () => void, finish!: (result: ExecResult) => void, oldCurrent = true, calls = 0;
    const starting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    const delayed = new ContainerService({ exec: (command, options) => {
      if (command.startsWith('docker start') && calls++ === 0) {
        entered(); return response.then(result => { options?.beforeStart?.(); return result; });
      }
      options?.beforeStart?.();
      return mock.exec(command, options);
    } }, config);
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

  it('旧start明确失败的迟到结果不释放同名称新run的预约或资格', async () => {
    const { candidate, entry } = prepareSplitRun(() => ({ stdout: '', stderr: '', exitCode: 0 }), absent);
    let entered!: () => void, finish!: (result: ExecResult) => void, calls = 0, newCurrent = true;
    const starting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<ExecResult>(resolve => { finish = resolve; });
    const delayed = new ContainerService({ exec: (command, options) => {
      options?.beforeStart?.();
      if (command.startsWith('docker start') && calls++ === 0) { entered(); return response; }
      return mock.exec(command, options);
    } }, config);
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
    const delayed = new ContainerService({ exec: (command, options) => {
      options?.beforeStart?.();
      if (!intercepted && command.startsWith(commandBoundary)) { intercepted = true; entered(); return response; }
      return mock.exec(command, options);
    } }, config, undefined, { record });
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

describe('有界部署阶段等待资格', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('只观测仍有效的真实排队和精确代次，不续心跳、不延长20分钟截止', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T00:00:00.000Z'));
    const budget = new DeploymentPhaseBudget(() => 0, {}, 1024, () => Infinity, idlePressure);
    const abort = new AbortController(); let current = true;
    const waiting = budget.acquire('start', owner, { reservationKey: 'waiting', signal: abort.signal,
      check: () => { if (!current) throw new Error('superseded'); } });
    const rejected = expect(waiting).rejects.toThrow();
    const initial = budget.waitingOperation('op-old', 1);
    expect(initial).toMatchObject({ phase: 'start', enqueuedAt: Date.now(), deadlineAt: Date.now() + 20 * 60_000 });
    expect(budget.waitingOperation('op-old', 2)).toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect(budget.waitingOperation('op-old', 1)?.deadlineAt).toBe(initial!.deadlineAt);
    current = false; expect(budget.waitingOperation('op-old', 1)).toBeUndefined();
    current = true; vi.setSystemTime(new Date(initial!.deadlineAt + 1));
    expect(budget.waitingOperation('op-old', 1)).toBeUndefined();
    abort.abort(); await rejected;
  });

  it('已授予的执行槽不是排队资格，不能豁免无进展执行的超时', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, {}, 1024, () => Infinity, idlePressure);
    const release = await budget.acquire('start', owner, { reservationKey: 'active' });
    expect(budget.waitingOperation('op-old', 1)).toBeUndefined();
    release(); budget.releaseMemory('active');
  });

  it('缺少实时资格检查的旧调用不能借排队身份豁免超时', async () => {
    const budget = new DeploymentPhaseBudget(() => 0, {}, 1024, () => Infinity, idlePressure);
    const abort = new AbortController();
    const waiting = budget.acquire('start', owner, { signal: abort.signal });
    const rejected = expect(waiting).rejects.toThrow();
    expect(budget.waitingOperation('op-old', 1)).toBeUndefined();
    abort.abort(); await rejected;
  });

  it('实际阶段任务await结束后资格已失效时不能发布迟到结果', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, {}, 1024, () => Infinity, idlePressure);
    let entered!: () => void, finish!: () => void, current = true;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    const task = budget.run('ready', owner, async () => { entered(); await response; return true; },
      { check: () => { if (!current) throw new Error('superseded'); } });
    const rejected = expect(task).rejects.toThrow('superseded');
    await started; current = false; finish(); await rejected;
    expect(budget.snapshot().ready.active).toEqual([]);
  });
});

describe('启动期CPU占位与物理责任分离', () => {
  it('有效的三份新启动阻塞第四份，失效资格只退出CPU且不泄露检查函数', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000, {}, 1024, () => 256, idlePressure);
    const valid = [true, true, true];
    for (let index = 0; index < 3; index++) {
      const release = await budget.acquire('start', { ...owner, operationId: `op-${index}` }, {
        reservationKey: `warm-${index}`, check: () => { if (!valid[index]) throw new Error('资格失效'); } });
      release();
    }
    const before = budget.memorySnapshot();
    expect(before.every(item => Object.keys(item).sort().join(',') === 'key,memoryMB,owner,pids')).toBe(true);
    expect(budget.snapshot().start.active).toEqual([]);
    let admitted = false;
    const abort = new AbortController();
    const next = budget.acquire('start', { ...owner, operationId: 'next' }, { reservationKey: 'next', signal: abort.signal })
      .then(release => { admitted = true; return release; }, () => undefined);
    try {
      await Promise.resolve(); expect(admitted).toBe(false);
      expect(budget.snapshot().start.queued[0].reason).toBe('cpu-startup-capacity');
      valid[0] = false; budget.pump(); await Promise.resolve();
      expect(admitted).toBe(true);
      expect(budget.memorySnapshot().filter(item => item.key.startsWith('warm-'))).toEqual(before);
    } finally { abort.abort(); (await next)?.(); for (const item of budget.memorySnapshot()) budget.releaseMemory(item.key); }
  });

  it.each(['memory-headroom', 'pid-headroom'] as const)('失效启动资格仍保留%s的原始物理保护', async reason => {
    let memory = reason === 'memory-headroom' ? 2000 : 10000;
    let pids = reason === 'pid-headroom' ? 96 : 256;
    let current = true;
    const budget = new DeploymentPhaseBudget(() => memory, {}, 1024, () => pids, idlePressure);
    const release = await budget.acquire('start', owner, { reservationKey: 'obsolete',
      check: () => { if (!current) throw new Error('资格失效'); } });
    release(); current = false;
    const before = budget.memorySnapshot();
    const abort = new AbortController(); let admitted = false;
    const next = budget.acquire('start', { ...owner, operationId: 'next' }, { reservationKey: 'next', signal: abort.signal })
      .then(released => { admitted = true; return released; }, () => undefined);
    try {
      await Promise.resolve(); expect(admitted).toBe(false);
      expect(budget.snapshot().start.queued[0].reason).toBe(reason);
      expect(budget.memorySnapshot()).toEqual(before);
      memory = 10000; pids = 256; budget.pump(); await Promise.resolve();
      expect(admitted).toBe(true);
      expect(budget.memorySnapshot().find(item => item.key === 'obsolete')).toEqual(before[0]);
    } finally { abort.abort(); (await next)?.(); for (const item of budget.memorySnapshot()) budget.releaseMemory(item.key); }
  });
});
