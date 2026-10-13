import { describe, expect, it, vi } from 'vitest';
import type { BranchEntry, ServiceState } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';
import type { ContainerService } from '../../src/services/container.js';
import { commitServiceReplacements, replacementLaunchEntry, reserveServiceReplacements } from '../../src/services/service-replacement.js';
import { resolveBranchUpstream } from '../../src/services/proxy.js';

function fixture() {
  const service: ServiceState = { profileId: 'api', containerName: 'new-api', hostPort: 10002, status: 'starting',
    networkName: 'new-network', servingRuntime: { containerName: 'old-api', containerId: 'a'.repeat(64), hostPort: 10001, networkName: 'old-network' } };
  const entry = { id: 'branch', projectId: 'project', services: { api: service } } as BranchEntry;
  let port = 10010;
  const state = { save: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), allocatePort: () => port++ } as unknown as StateService;
  const container = { cleanupUnusedReplacementNetworks: vi.fn().mockResolvedValue(undefined), removeOwnedRuntime: vi.fn().mockResolvedValue(undefined) } as unknown as ContainerService;
  return { entry, service, state, container };
}

describe('就绪切换与保旧回退', () => {
  it('同轮身份和环境提前预约，接口仍指向旧服务；下一轮另分网络', () => {
    const { entry, state, service } = fixture();
    entry.services.web = { ...service, profileId: 'web', containerName: 'old-web', hostPort: 10003,
      servingRuntime: { containerName: 'old-web', hostPort: 10003 } };
    reserveServiceReplacements({ entry, profileIds: ['api', 'web'], state, portStart: 10000, operationId: 'first' });
    const first = entry.replacementNetwork;
    const names = Object.values(entry.services).map(service => service.pendingRuntime!.containerName);
    expect(new Set(names).size).toBe(2);
    const prospective = replacementLaunchEntry(entry);
    expect(prospective.services.api.containerName).toBe(names[0]);
    expect(prospective.services.web.networkName).toBe(first);
    expect(resolveBranchUpstream(entry, 'api')).toBe('http://127.0.0.1:10001');
    reserveServiceReplacements({ entry, profileIds: ['api'], state, portStart: 10000, operationId: 'second' });
    expect(entry.replacementNetwork).not.toBe(first);
    expect(service.retainedRuntimes?.some(runtime => runtime.containerName === names[0])).toBe(true);
  });

  it.each(['starting', 'error'] as const)('候选%s或任一必需服务失败时不切换、不删旧容器', async status => {
    const f = fixture(); f.service.status = status;
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    f.service.status = 'running';
    f.entry.services.web = { profileId: 'web', containerName: 'web', hostPort: 10003, status: 'error' };
    await commitServiceReplacements({ ...f, profileIds: ['api', 'web'] });
    expect(f.service.servingRuntime?.containerName).toBe('old-api');
  });

  it('切换关键保存失败时恢复旧入口且不回收，随后重试以精确旧ID回收', async () => {
    const f = fixture(); f.service.status = 'running';
    vi.mocked(f.state.flush).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk failed'));
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'] })).rejects.toThrow('disk failed');
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10001');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(resolveBranchUpstream(f.entry, 'api')).toBe('http://127.0.0.1:10002');
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledWith(f.entry, 'api', expect.objectContaining({ containerId: 'a'.repeat(64) }), expect.objectContaining({ profileId: 'api' }));
  });

  it('保存期间新操作取代时，不恢复旧操作指针或回收容器', async () => {
    const f = fixture(); f.service.status = 'running';
    vi.mocked(f.state.flush).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      f.service.containerName = 'newer-api'; f.service.hostPort = 10005;
    });
    await expect(commitServiceReplacements({ ...f, profileIds: ['api'], assertCurrent: step => {
      if (step === 'after runtime cutover persistence') throw new Error('superseded');
    } })).rejects.toThrow('superseded');
    expect(f.service.containerName).toBe('newer-api');
    expect(f.service.servingRuntime?.containerName).toBe('new-api');
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
  });

  it('未替换Web仍依赖旧API时保留旧API，Web随后迁移才回收历史API', async () => {
    const f = fixture(); f.service.status = 'running';
    f.entry.services.web = { profileId: 'web', containerName: 'old-web', hostPort: 10003, status: 'running', networkName: 'old-network' };
    await commitServiceReplacements({ ...f, profileIds: ['api'] });
    expect(f.container.removeOwnedRuntime).not.toHaveBeenCalled();
    f.entry.services.web = { profileId: 'web', containerName: 'new-web', hostPort: 10004, status: 'running', networkName: 'new-network',
      servingRuntime: { containerName: 'old-web', hostPort: 10003, containerId: 'b'.repeat(64), networkName: 'old-network' } };
    await commitServiceReplacements({ ...f, profileIds: ['web'] });
    expect(f.container.removeOwnedRuntime).toHaveBeenCalledTimes(2);
    expect(f.service.retainedRuntimes).toEqual([]);
  });
});
