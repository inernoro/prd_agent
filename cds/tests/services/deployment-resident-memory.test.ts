import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentPhaseBudget, deploymentPhaseBudget, restoreDeploymentMemoryReservations, setDeploymentPhaseMemoryProvider } from '../../src/services/deployment-phase-budget.js';
import type { BranchEntry, ServiceState } from '../../src/types.js';

const cid = 'a'.repeat(64);
const runtime = (name = 'old') => ({ containerName: name, containerId: cid, hostPort: 10001, creationIssued: true });
function branch(service: Partial<ServiceState> = {}): BranchEntry {
  return { id: 'b', projectId: 'p', services: { api: { ...runtime(), profileId: 'api', status: 'error',
    servingRuntime: runtime(), ...service } } } as BranchEntry;
}
afterEach(() => {
  for (const row of deploymentPhaseBudget.memorySnapshot()) deploymentPhaseBudget.releaseMemory(row.key);
});
const restore = (entry: BranchEntry) => restoreDeploymentMemoryReservations([entry], () => []);

describe('失败替换的已发布版本不再恢复启动预约', () => {
  it('六份已发布旧容器不产生3072MiB启动预约，不修改持久运行身份', () => {
    const entry = branch(); entry.services = {};
    for (let i = 0; i < 6; i++) entry.services[`api${i}`] = {
      ...runtime(`old-${i}`), profileId: `api${i}`, status: 'error', servingRuntime: runtime(`old-${i}`) };
    const before = structuredClone(entry);
    restore(entry);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([]);
    expect(entry).toEqual(before);
  });

  it('同一次失败中的新候选仍全额恢复，旧版本不冒充新候选', () => {
    const entry = branch({ pendingRuntime: { ...runtime('candidate'), containerId: 'b'.repeat(64) } });
    restore(entry);
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: 'candidate', memoryMB: 512 })]);
  });

  it.each(['starting', 'building', 'restarting'] as const)('%s 仍保留启动责任，已有旧服务指针不能豁免', status => {
    restore(branch({ status }));
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: 'old', memoryMB: 512 })]);
  });

  it.each(['missing-serving', 'missing-id', 'short-id', 'changed-id', 'changed-name', 'same-name-pending'])(
    '%s 不足以证明已经发布，继续恢复完整预约', kind => {
      const entry = branch(); const service = entry.services.api;
      if (kind === 'missing-serving') delete service.servingRuntime;
      if (kind === 'missing-id') { delete service.containerId; delete service.servingRuntime!.containerId; }
      if (kind === 'short-id') { service.containerId = 'a'.repeat(12); service.servingRuntime!.containerId = service.containerId; }
      if (kind === 'changed-id') service.servingRuntime!.containerId = 'b'.repeat(64);
      if (kind === 'changed-name') service.servingRuntime!.containerName = 'different-old';
      if (kind === 'same-name-pending') service.pendingRuntime = runtime();
      restore(entry);
      expect(deploymentPhaseBudget.memorySnapshot()).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'old', memoryMB: 512 }),
      ]));
    });

  it('分类恢复不能释放本进程已经持有的同名新操作预约', () => {
    const owner = { projectId: 'p', branchId: 'b', profileId: 'api', operationId: 'new-operation', operationGeneration: 7 };
    deploymentPhaseBudget.reserveKnownMemory('old', 768, owner);
    restore(branch());
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: 'old', memoryMB: 768, owner })]);
  });

  it('普通运行版本维持原行为，未知保留容器仍恢复责任', () => {
    restore(branch({ status: 'running', retainedRuntimes: [{ containerName: 'unknown-retained', hostPort: 10002, creationIssued: true }] }));
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual([expect.objectContaining({ key: 'unknown-retained', memoryMB: 512 })]);
  });

  it('宿主余量不足仍排队；只看当前余量，不叠加历史驻留采样', async () => {
    let available = 1200;
    const budget = new DeploymentPhaseBudget(() => available);
    const abort = new AbortController(); let admitted = false;
    const next = budget.acquire('start', {}, { memoryMB: 512, signal: abort.signal })
      .then(release => { admitted = true; release(); });
    expect(budget.snapshot().start.queued[0].reason).toBe('memory-headroom');
    expect(admitted).toBe(false);
    available = 1600; budget.pump(); await next;
    expect(admitted).toBe(true);
  });

  it('统一恢复后准入证据只计新候选，真实余量不足时仍阻止启动', async () => {
    setDeploymentPhaseMemoryProvider(() => 1200);
    restore(branch({ pendingRuntime: { ...runtime('candidate'), containerId: 'b'.repeat(64) } }));
    const abort = new AbortController();
    const pending = deploymentPhaseBudget.acquire('start', { projectId: 'next-project' },
      { memoryMB: 512, reservationKey: 'next-runtime', signal: abort.signal }).catch(error => error);
    try {
      expect(deploymentPhaseBudget.snapshot().start.queued[0]).toMatchObject({
        reason: 'memory-headroom', memoryAdmission: {
          availableMemoryMB: 1200, reservedMemoryMB: 512, requestedMemoryMB: 512,
          requiredMemoryMB: 2048, deficitMemoryMB: 848, allowed: false,
        },
      });
      expect(deploymentPhaseBudget.memorySnapshot().map(row => row.key)).toEqual(['candidate']);
      expect(deploymentPhaseBudget.snapshot().start.active).toEqual([]);
    } finally { abort.abort(); await pending; }
  });

  it('已创建的新启动仍完整预留，不能因已占用物理内存提前退还', async () => {
    const budget = new DeploymentPhaseBudget(() => 2000);
    const release = await budget.acquire('start', {}, { memoryMB: 512, reservationKey: 'warming' }); release();
    const abort = new AbortController();
    const next = budget.acquire('start', {}, { memoryMB: 512, signal: abort.signal }).catch(() => undefined);
    expect(budget.snapshot().start.queued[0].reason).toBe('memory-headroom');
    expect(budget.memorySnapshot()[0]).toMatchObject({ key: 'warming', memoryMB: 512 });
    abort.abort(); await next; budget.releaseMemory('warming');
  });
});
