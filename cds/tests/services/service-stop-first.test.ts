import { describe, expect, it, vi } from 'vitest';
import type { BranchEntry, BuildProfile, ServiceState } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';
import { ContainerService } from '../../src/services/container.js';
import { deploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';
import { prepareServiceReplacement, reserveServiceReplacements } from '../../src/services/service-replacement.js';

function fixture() {
  const profile: BuildProfile = { id: 'database', projectId: 'project', name: 'database', workDir: '.', dockerImage: 'mysql:8', containerPort: 3306, updateOrder: 'stop-first' };
  const old = { containerName: 'old-db', containerId: 'a'.repeat(64), networkName: 'old-network', hostPort: 10001 };
  const service: ServiceState = { profileId: profile.id, ...old, status: 'running', servingRuntime: { ...old } };
  const entry = { id: 'branch', projectId: 'project', services: { database: service } } as BranchEntry;
  const running = new Set([old.containerId]);
  const state = { save: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), allocatePort: () => 10002,
    getEffectiveProfilesForBranch: vi.fn(() => [profile]) } as unknown as StateService;
  const stop = vi.fn(async (id: string, _reason?: string, _context?: unknown, onStopped?: () => unknown | Promise<unknown>) => { running.delete(id); await onStopped?.(); });
  const container = { stop, inspectOwnedRuntime: vi.fn(async (_entry, _id, runtime) => running.has(runtime.containerId) ? { ...runtime } : null),
    connectReplacementPeer: vi.fn(), removeOwnedRuntime: vi.fn(), cleanupUnusedReplacementNetworks: vi.fn() } as unknown as ContainerService;
  reserveServiceReplacements({ entry, profileIds: [profile.id], state, portStart: 10000, operationId: 'operation' });
  return { profile, service, entry, state, container, running, old, portStart: 10000, operationId: 'operation' };
}

describe('显式先停后启与冷启动网络', () => {
  it('等待停止预算期间操作被取代，真实停止入口不得发命令或释放原预约', async () => {
    const name = 'stop-first-cancelled', owner = { projectId: 'project', branchId: 'branch', operationId: 'old' };
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker inspect /, () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify([
      { Id: 'a'.repeat(64), Name: '/' + name, State: { Running: true, Status: 'running' } },
    ]) }));
    deploymentPhaseBudget.reserveKnownMemory(name, 128, owner);
    const release = await deploymentPhaseBudget.acquire('terminal', owner);
    try {
      const container = new ContainerService(shell, {} as CdsConfig);
      let cancelled = false;
      const stopping = container.stop(name, 'replacement-stop-first', { ...owner,
        assertCurrent: () => { if (cancelled) throw new Error('superseded'); } });
      cancelled = true; deploymentPhaseBudget.pump();
      await expect(stopping).rejects.toThrow('superseded');
      expect(shell.commands.some(command => /^docker (stop|exec)\b/.test(command))).toBe(false);
      expect(deploymentPhaseBudget.memorySnapshot().find(row => row.key === name)?.memoryMB).toBe(128);
    } finally { release(); deploymentPhaseBudget.releaseMemory(name); }
  });

  it.each([false, true])('真实停止确认释放按名预约且不结算后继预约，检查期间换代=%s', async superseded => {
    const f = fixture(), owner = { projectId: 'project', branchId: 'branch', operationId: 'operation' };
    deploymentPhaseBudget.reserveKnownMemory(f.old.containerName, 128, owner);
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker inspect /, () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify([
      { Id: f.old.containerId, Name: '/' + f.old.containerName, State: { Running: f.running.has(f.old.containerId), Status: f.running.has(f.old.containerId) ? 'running' : 'exited', ExitCode: 0 } },
    ]) }));
    shell.addResponsePattern(/docker stop /, () => { f.running.delete(f.old.containerId); return { exitCode: 0, stdout: '', stderr: '' }; });
    const manager = new ContainerService(shell, {} as CdsConfig);
    f.container.stop = manager.stop.bind(manager);
    if (superseded) vi.mocked(f.container.inspectOwnedRuntime).mockImplementationOnce(async (_entry, _id, runtime) => {
      deploymentPhaseBudget.reserveKnownMemory(f.old.containerName, 256, { ...owner, operationId: 'new' });
      return { ...runtime };
    });
    try {
      await prepareServiceReplacement(f);
      expect(shell.commands).toContain('docker stop ' + f.old.containerId);
      const reservation = deploymentPhaseBudget.memorySnapshot().find(row => row.key === f.old.containerName);
      if (superseded) expect(reservation).toMatchObject({ memoryMB: 256, owner: { operationId: 'new' } });
      else expect(reservation).toBeUndefined();
    } finally { deploymentPhaseBudget.releaseMemory(f.old.containerName); }
  });

  it.each([false, true])('物理停止后取消仍结算原实例并保护后继指针和预约，已有后继=%s', async successor => {
    const f = fixture(), owner = { projectId: 'project', branchId: 'branch', operationId: 'operation' };
    deploymentPhaseBudget.reserveKnownMemory(f.old.containerName, 128, owner);
    let cancelled = false;
    const next = { containerName: 'next-db', containerId: 'b'.repeat(64), hostPort: 10004 };
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/docker inspect /, () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify([
      { Id: f.old.containerId, Name: '/' + f.old.containerName, State: { Running: f.running.has(f.old.containerId), Status: f.running.has(f.old.containerId) ? 'running' : 'exited', ExitCode: 0 } },
    ]) }));
    shell.addResponsePattern(/docker stop /, () => {
      f.running.delete(f.old.containerId); cancelled = true;
      if (successor) {
        Object.assign(f.service, next); f.service.servingRuntime = { ...next };
        deploymentPhaseBudget.reserveKnownMemory(f.old.containerName, 256, { ...owner, operationId: 'next' });
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const manager = new ContainerService(shell, {} as CdsConfig);
    f.container.stop = manager.stop.bind(manager);
    try {
      await expect(prepareServiceReplacement({ ...f, assertCurrent: () => { if (cancelled) throw new Error('superseded'); } })).rejects.toThrow('superseded');
      expect(shell.commands).toContain('docker stop ' + f.old.containerId);
      const reservation = deploymentPhaseBudget.memorySnapshot().find(row => row.key === f.old.containerName);
      if (successor) {
        expect(f.service.servingRuntime).toMatchObject(next);
        expect(f.service.status).toBe('running');
        expect(reservation).toMatchObject({ memoryMB: 256, owner: { operationId: 'next' } });
      } else {
        expect(f.service.servingRuntime).toBeUndefined();
        expect(f.service.status).toBe('stopped');
        expect(reservation).toBeUndefined();
        expect(f.state.flush).toHaveBeenCalled();
      }
    } finally { deploymentPhaseBudget.releaseMemory(f.old.containerName); }
  });

  it('候选获得运行身份前，先停止并确认旧写者；保留原容器与数据卷', async () => {
    const f = fixture();
    const target = await prepareServiceReplacement(f);
    expect(f.container.stop).toHaveBeenCalledWith(f.old.containerId, 'replacement-stop-first', expect.objectContaining({ branchId: 'branch', profileId: 'database' }), expect.any(Function));
    expect(f.running.size).toBe(0);
    expect(target.containerName).not.toBe(f.old.containerName);
    expect(target.containerId).toBeUndefined();
    expect(f.service.servingRuntime).toBeUndefined();
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });

  it.each(['stop-failed', 'still-running', 'wrong-owner'] as const)('%s 时不交出候选、不删除旧卷', async failure => {
    const f = fixture();
    if (failure === 'stop-failed') vi.mocked(f.container.stop).mockRejectedValueOnce(new Error('stop failed'));
    if (failure === 'still-running') vi.mocked(f.container.stop).mockImplementationOnce(async () => {});
    if (failure === 'wrong-owner') vi.mocked(f.container.inspectOwnedRuntime).mockRejectedValueOnce(new Error('owner mismatch'));
    await expect(prepareServiceReplacement(f)).rejects.toThrow();
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    if (failure === 'wrong-owner') expect(f.container.stop).not.toHaveBeenCalled();
  });

  it('默认滚动更新不停止旧实例，取消的租约也不能继续停止', async () => {
    const f = fixture(); f.profile.updateOrder = undefined;
    await prepareServiceReplacement(f);
    expect(f.container.stop).not.toHaveBeenCalled();
    const cancelled = fixture();
    await expect(prepareServiceReplacement({ ...cancelled, assertCurrent: () => { throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(cancelled.container.stop).not.toHaveBeenCalled();
  });

  it('全冷启动的同轮数据库和应用使用同一网络，不复用各自过期网络', () => {
    const f = fixture(); f.service.servingRuntime = undefined; f.service.pendingRuntime = undefined;
    f.entry.services.api = { profileId: 'api', containerName: 'cold-api', hostPort: 10003, status: 'idle', networkName: 'stale-api' };
    reserveServiceReplacements({ entry: f.entry, profileIds: ['database', 'api'], state: f.state, portStart: 10000, operationId: 'cold-operation' });
    expect(f.service.networkName).toBe(f.entry.services.api.networkName);
    expect(f.service.networkName).not.toBe('stale-api');
  });

});
