import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), readFile: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetModules();
});

async function fixture() {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T20:00:00Z'));
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  vi.spyOn(os, 'freemem').mockReturnValue(100 * 1048576);
  const read = vi.mocked(fs.readFile).mockResolvedValue('MemAvailable: 8192000 kB\n' as any);
  vi.stubEnv('CDS_HOST_MEMORY_BUDGET_MB', '10000');
  const m = await import('../../src/services/deployment-phase-budget.js');
  m.deploymentHostMemoryEvidence();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  return { m, read };
}

describe('主机准入采样证据', () => {
  it('区分 Linux 可用内存与 free，并揭示配置预算扣除 daemon 使用后的实际余量', async () => {
    const { m } = await fixture();
    m.setDeploymentPhaseHostUsage(7000, Date.now(), 90000, 100);
    expect(m.deploymentHostMemoryEvidence()).toMatchObject({
      source: 'linux-memavailable', physicalAvailableMB: 8000, sampleFresh: true,
      configuredBudgetMB: 10000, budgetState: 'configured', daemonUsedMB: 7000,
      daemonSampleFresh: true, effectiveAvailableMB: 3000, providerOverride: false,
    });
  });
  it('过期物理采样与过期 daemon 样本分别可见，且门禁仍保守返回零', async () => {
    const { m, read } = await fixture();
    m.setDeploymentPhaseHostUsage(7000, Date.now(), 4000);
    read.mockImplementation(() => new Promise(() => {}));
    vi.setSystemTime(Date.now() + 6000);
    expect(m.deploymentHostMemoryEvidence()).toMatchObject({
      physicalAvailableMB: 8000, sampleAgeMs: 6000, sampleFresh: false,
      daemonSampleAgeMs: 6000, daemonSampleFresh: false, effectiveAvailableMB: 0,
    });
  });
  it('无 daemon 样本和非法预算不伪装成实际内存耗尽', async () => {
    const { m } = await fixture();
    expect(m.deploymentHostMemoryEvidence()).toMatchObject({ daemonUsedMB: null, daemonSampleFresh: false, effectiveAvailableMB: 0 });
    vi.stubEnv('CDS_HOST_MEMORY_BUDGET_MB', 'not-a-budget');
    expect(m.deploymentHostMemoryEvidence()).toMatchObject({ configuredBudgetMB: 0, budgetState: 'invalid', effectiveAvailableMB: 0 });
    vi.stubEnv('CDS_HOST_MEMORY_BUDGET_MB', undefined);
    expect(m.deploymentHostMemoryEvidence()).toMatchObject({ configuredBudgetMB: null, budgetState: 'unconfigured', effectiveAvailableMB: 8000 });
  });
});
