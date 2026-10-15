import { describe, it, expect, vi } from 'vitest';
import { ContainerService, ContainerStopUnconfirmedError } from '../../src/services/container.js';
import { deploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import type { ServiceState } from '../../src/types.js';

describe('按真实停止身份释放预留', () => {
  it('使用CID停止确认后释放的是原容器名称预留', async () => {
    const svc: ServiceState = { profileId: 'api', containerName: 'reservation-test', containerId: 'a'.repeat(64),
      hostPort: 10001, status: 'error', creationIssued: true };
    const container = Object.create(ContainerService.prototype) as ContainerService;
    container.stop = vi.fn().mockResolvedValue(undefined);
    deploymentPhaseBudget.reserveKnownMemory(svc.containerName, 512, {});
    try {
      await container.stopRuntimeGroup(svc, 'test', { branchId: 'b', projectId: 'p' });
      expect(container.stop).toHaveBeenCalledWith('a'.repeat(64), 'test', expect.any(Object));
      expect(deploymentPhaseBudget.memorySnapshot().some(row => row.key === svc.containerName)).toBe(false);
    } finally { deploymentPhaseBudget.releaseMemory(svc.containerName); }
  });

  it('创建已发出但CID仍未知，缺失观察不算停止，预留不释放', async () => {
    const svc: ServiceState = { profileId: 'api', containerName: 'unknown-reservation-test', hostPort: 10001, status: 'error', creationIssued: true };
    const container = Object.create(ContainerService.prototype) as ContainerService;
    container.inspectOwnedRuntime = vi.fn().mockResolvedValue(null); container.stop = vi.fn();
    deploymentPhaseBudget.reserveKnownMemory(svc.containerName, 512, {});
    try {
      await expect(container.stopRuntimeGroup(svc, 'test', { branchId: 'b', projectId: 'p' })).rejects.toBeInstanceOf(ContainerStopUnconfirmedError);
      expect(container.stop).not.toHaveBeenCalled();
      expect(deploymentPhaseBudget.memorySnapshot().some(row => row.key === svc.containerName)).toBe(true);
    } finally { deploymentPhaseBudget.releaseMemory(svc.containerName); }
  });
});
