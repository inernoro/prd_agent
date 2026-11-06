import { describe, expect, it, vi } from 'vitest';
import type { BranchEntry, BuildProfile, ServiceState } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';
import type { ContainerService } from '../../src/services/container.js';
import { prepareServiceReplacement, reserveServiceReplacements } from '../../src/services/service-replacement.js';

function fixture() {
  const profile: BuildProfile = { id: 'database', projectId: 'project', name: 'database', workDir: '.', dockerImage: 'mysql:8', containerPort: 3306, updateOrder: 'stop-first' };
  const old = { containerName: 'old-db', containerId: 'a'.repeat(64), networkName: 'old-network', hostPort: 10001 };
  const service: ServiceState = { profileId: profile.id, ...old, status: 'running', servingRuntime: { ...old } };
  const entry = { id: 'branch', projectId: 'project', services: { database: service } } as BranchEntry;
  const running = new Set([old.containerId]);
  const state = { save: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), allocatePort: () => 10002,
    getEffectiveProfilesForBranch: vi.fn(() => [profile]) } as unknown as StateService;
  const stop = vi.fn(async (id: string) => { running.delete(id); });
  const container = { stop, inspectOwnedRuntime: vi.fn(async (_entry, _id, runtime) => running.has(runtime.containerId) ? { ...runtime } : null),
    connectReplacementPeer: vi.fn(), removeOwnedRuntime: vi.fn(), cleanupUnusedReplacementNetworks: vi.fn() } as unknown as ContainerService;
  reserveServiceReplacements({ entry, profileIds: [profile.id], state, portStart: 10000, operationId: 'operation' });
  return { profile, service, entry, state, container, running, old, portStart: 10000, operationId: 'operation' };
}

describe('显式先停后启与冷启动网络', () => {
  it('候选获得运行身份前，先停止并确认旧写者；保留原容器与数据卷', async () => {
    const f = fixture();
    const target = await prepareServiceReplacement(f);
    expect(f.container.stop).toHaveBeenCalledWith(f.old.containerId, 'replacement-stop-first', expect.objectContaining({ branchId: 'branch', profileId: 'database' }));
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
