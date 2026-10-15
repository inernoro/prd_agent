import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContainerService } from '../../src/services/container.js';
import { DeploymentPhaseBudget, deploymentPhaseBudget, restoreDeploymentMemoryReservations } from '../../src/services/deployment-phase-budget.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
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
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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

  it.each(['absent', 'stopped'] as const)('冷恢复的%s候选经真实身份检查和创建终结证明后释放', async state => {
    const entry = branch();
    // 历史创建没有回执ID也必须能在启动期无在途创建、真实缺席证据下收敛。
    if (state === 'absent') entry.services.api.containerId = undefined;
    restoreDeploymentMemoryReservations([entry], () => [profile]);
    mock.addResponsePattern(/docker inspect/, () => state === 'absent' ? absent() : inspection(false));
    const result = await service.reconcileDeploymentMemoryReservations([entry], { creationSettled: () => true });
    expect(result.released).toEqual([runtime.containerName]);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
    expect(entry.services.api.creationIssued).toBe(true);
    expect(mock.commands.every(command => command.startsWith('docker inspect'))).toBe(true);
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
    const budget = new DeploymentPhaseBudget(() => 0);
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
    const budget = new DeploymentPhaseBudget(() => 10000);
    const release = await budget.acquire('start', owner, { reservationKey: 'active' });
    expect(budget.waitingOperation('op-old', 1)).toBeUndefined();
    release(); budget.releaseMemory('active');
  });

  it('缺少实时资格检查的旧调用不能借排队身份豁免超时', async () => {
    const budget = new DeploymentPhaseBudget(() => 0);
    const abort = new AbortController();
    const waiting = budget.acquire('start', owner, { signal: abort.signal });
    const rejected = expect(waiting).rejects.toThrow();
    expect(budget.waitingOperation('op-old', 1)).toBeUndefined();
    abort.abort(); await rejected;
  });

  it('实际阶段任务await结束后资格已失效时不能发布迟到结果', async () => {
    const budget = new DeploymentPhaseBudget(() => 10000);
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
