import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentPhaseBudget, deploymentPhaseBudget, restoreDeploymentMemoryReservations,
  setDeploymentPhaseMemoryProvider, setDeploymentPhaseResidentUsage, setDeploymentPhaseHostUsage, type ResidentMemorySnapshot } from '../../src/services/deployment-phase-budget.js';
import { ResourceUsageSampler } from '../../src/services/resource-usage-sampler.js';
import { setBuildGateHostLoadProvider } from '../../src/services/build-gate.js';
import type { BranchEntry } from '../../src/types.js';
import type { StateService } from '../../src/services/state.js';
import { readFile } from 'node:fs/promises';

// setup fixture 会预载门禁模块；重新加载以便此文件验证真实采样接线。
vi.hoisted(() => vi.resetModules());
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => 'MemAvailable: 1945600 kB\n') }));
const cid = 'a'.repeat(64);
const owner = { projectId: 'p', branchId: 'b', profileId: 'api' };
const pressure = () => ({ load1: 0, cores: 18, ratio: 0, factor: 1, saturated: false });
const evidence = (usedMB = 512, containerId = cid.slice(0, 12)): ResidentMemorySnapshot => ({
  sampledAt: Date.now(), completedAt: Date.now(), samples: new Map([['old', { containerId, usedMB }]]) });
const platform = process.platform;
let sequence = 0;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + (++sequence * 10000));
  vi.stubEnv('CDS_HOST_MEMORY_BUDGET_MB', undefined); vi.stubEnv('CDS_HOST_PID_BUDGET', undefined);
  setBuildGateHostLoadProvider(() => ({ load1: 0, cores: 18 }));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  for (const row of deploymentPhaseBudget.memorySnapshot()) deploymentPhaseBudget.releaseMemory(row.key);
  setDeploymentPhaseResidentUsage(new Map(), 0, 0);
  setBuildGateHostLoadProvider(null); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('冷恢复已服务版本的驻留内存抵扣', () => {
  it('事故场景：六份已计入物理余量的512MiB只保留账本，不再重复扣3072MiB', async () => {
    const samples = new Map(Array.from({ length: 6 }, (_, i) => [`old-${i}`, { containerId: cid, usedMB: 600 }]));
    const budget = new DeploymentPhaseBudget(() => 2500, {}, 1024, () => Infinity, pressure,
      () => ({ sampledAt: Date.now(), completedAt: Date.now(), samples }));
    for (let i = 0; i < 6; i++) budget.reserveKnownMemory(`old-${i}`, 512, owner, 64, true, cid);
    const release = await budget.acquire('start', owner, { memoryMB: 512, reservationKey: 'new' });
    release();
    expect(budget.memorySnapshot().filter(x => x.key.startsWith('old-'))).toHaveLength(6);
    expect(budget.memorySnapshot().filter(x => x.key.startsWith('old-')).every(x => x.chargedMemoryMB === 0)).toBe(true);
    budget.releaseMemory('new');
  });

  it('只抵扣实测重叠，不提前释放未实现的启动余量', async () => {
    const budget = new DeploymentPhaseBudget(() => 1800, {}, 1024, () => Infinity, pressure, () => evidence(128));
    budget.reserveKnownMemory('old', 512, owner, 64, true, cid);
    const abort = new AbortController();
    const pending = budget.acquire('start', owner, { memoryMB: 512, signal: abort.signal }).catch(() => undefined);
    expect(budget.memorySnapshot()[0]).toMatchObject({ memoryMB: 512, accountedResidentMB: 128, chargedMemoryMB: 384 });
    expect(budget.snapshot().start.queued[0]).toMatchObject({ memoryAdmission: { availableMB: 1800,
      grossReservedMB: 512, accountedResidentMB: 128, chargedReservedMB: 384, requiredMB: 1920, allowed: false } });
    abort.abort(); await pending;
  });

  it.each(['missing', 'changed-id', 'stale', 'future', 'invalid-id', 'negative', 'nan', 'unknown-serving', 'inflight'])(
    '%s 证据不能抵扣预约', async kind => {
      const sample = evidence();
      if (kind === 'missing') sample.samples = new Map();
      if (kind === 'changed-id') sample.samples = new Map([['old', { containerId: 'b'.repeat(64), usedMB: 512 }]]);
      if (kind === 'stale') sample.sampledAt -= 5001;
      if (kind === 'future') sample.sampledAt += 1;
      if (kind === 'invalid-id') sample.samples = new Map([['old', { containerId: 'a', usedMB: 512 }]]);
      if (kind === 'negative' || kind === 'nan') sample.samples = new Map([['old', { containerId: cid, usedMB: kind === 'nan' ? NaN : -1 }]]);
      const budget = new DeploymentPhaseBudget(() => 1900, {}, 1024, () => Infinity, pressure, () => sample);
      budget.reserveKnownMemory('old', 512, owner, 64, kind !== 'inflight', kind === 'unknown-serving' ? undefined : cid);
      const abort = new AbortController();
      const pending = budget.acquire('start', owner, { memoryMB: 512, signal: abort.signal }).catch(() => undefined);
      expect(budget.memorySnapshot()[0].chargedMemoryMB).toBe(512);
      expect(budget.snapshot().start.queued).toHaveLength(1);
      abort.abort(); await pending;
    });

  it('新启动覆盖同名恢复预约后不继承旧CID抵扣', async () => {
    let memory = 3000;
    const budget = new DeploymentPhaseBudget(() => memory, {}, 1024, () => Infinity, pressure, () => evidence());
    budget.reserveKnownMemory('old', 512, owner, 64, true, cid);
    const release = await budget.acquire('start', owner, { reservationKey: 'old', memoryMB: 512 });
    release(); memory = 1900;
    const abort = new AbortController();
    const pending = budget.acquire('start', owner, { memoryMB: 512, signal: abort.signal }).catch(() => undefined);
    expect(budget.memorySnapshot()[0].accountedResidentMB).toBe(0);
    expect(budget.snapshot().start.queued).toHaveLength(1);
    abort.abort(); await pending; budget.releaseMemory('old');
  });

  it('证据过期恢复全额计费且不删除账本；物理余量不足仍不放行', async () => {
    const sample = evidence();
    const budget = new DeploymentPhaseBudget(() => 1200, {}, 1024, () => Infinity, pressure, () => sample);
    budget.reserveKnownMemory('old', 512, owner, 64, true, cid);
    const abort = new AbortController();
    const pending = budget.acquire('start', owner, { memoryMB: 512, signal: abort.signal }).catch(() => undefined);
    expect(budget.snapshot().start.queued[0].memoryAdmission?.requiredMB).toBe(1536);
    vi.setSystemTime(Date.now() + 5001);
    expect(budget.memorySnapshot()[0].chargedMemoryMB).toBe(512);
    expect(budget.snapshot().start.queued[0].memoryAdmission?.requiredMB).toBe(2048);
    abort.abort(); await pending;
  });
});

describe('真实采样与恢复调用链', () => {
  function branch(): BranchEntry {
    const runtime = { containerName: 'old', containerId: cid, hostPort: 10001, creationIssued: true };
    return { id: 'b', projectId: 'p', services: { api: { ...runtime, profileId: 'api', status: 'error', servingRuntime: runtime } } } as BranchEntry;
  }
  it('恢复已发布身份，经sampler和较新的Linux采样抵扣，未发布候选保持全额', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    setDeploymentPhaseMemoryProvider(null);
    const entry = branch();
    entry.services.api.pendingRuntime = { containerName: 'candidate', containerId: 'b'.repeat(64), creationIssued: true, hostPort: 10002 };
    restoreDeploymentMemoryReservations([entry], () => []);
    const sampler = new ResourceUsageSampler({ getAllBranches: () => [entry] } as StateService, {
      getRunningContainerNames: async () => new Set(['old', 'candidate']),
      getServiceStats: async () => new Map(['old', 'candidate'].map(name => [name, {
        id: (name === 'old' ? cid : 'b'.repeat(64)).slice(0, 12), cpuPercent: 0, memUsedBytes: 512 * 1048576 }])) });
    await sampler.sampleOnce();
    // 大请求仅促使真实provider采样，始终不能获准；没有Docker或业务写操作。
    const abort = new AbortController();
    const pending = deploymentPhaseBudget.acquire('start', owner, { memoryMB: 1e12, signal: abort.signal }).catch(() => undefined);
    await flush(); deploymentPhaseBudget.pump();
    expect(deploymentPhaseBudget.memorySnapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'old', accountedResidentMB: 512, chargedMemoryMB: 0 }),
      expect.objectContaining({ key: 'candidate', accountedResidentMB: 0, chargedMemoryMB: 512 }),
    ]));
    abort.abort(); await pending;
  });

  it('恢复仍在启动的任务，即使保留旧服务指针也不能抵扣', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    setDeploymentPhaseMemoryProvider(null);
    const entry = branch(); entry.services.api.status = 'starting';
    restoreDeploymentMemoryReservations([entry], () => []);
    setDeploymentPhaseResidentUsage(evidence().samples, Date.now(), Date.now());
    const abort = new AbortController();
    const pending = deploymentPhaseBudget.acquire('start', owner, { memoryMB: 1e12, signal: abort.signal }).catch(() => undefined);
    await flush();
    expect(deploymentPhaseBudget.memorySnapshot()[0]).toMatchObject({ accountedResidentMB: 0, chargedMemoryMB: 512 });
    abort.abort(); await pending;
  });

  it('物理采样早于容器采样，或预算采样陈旧时，不能混用抵扣', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    setDeploymentPhaseMemoryProvider(null);
    const budget = new DeploymentPhaseBudget();
    budget.reserveKnownMemory('old', 512, owner, 64, true, cid);
    const abort = new AbortController();
    const pending = budget.acquire('start', owner, { memoryMB: 1e12, signal: abort.signal }).catch(() => undefined);
    await flush();
    vi.setSystemTime(Date.now() + 1);
    setDeploymentPhaseResidentUsage(evidence().samples, Date.now(), Date.now());
    expect(budget.memorySnapshot()[0].accountedResidentMB).toBe(0);
    budget.pump(); await flush();
    expect(budget.memorySnapshot()[0].accountedResidentMB).toBe(512);
    vi.stubEnv('CDS_HOST_MEMORY_BUDGET_MB', '8192');
    setDeploymentPhaseHostUsage(1000, Date.now() - 10000, 5000);
    expect(budget.memorySnapshot()[0].accountedResidentMB).toBe(0);
    setDeploymentPhaseHostUsage(1000, Date.now(), 5000);
    expect(budget.memorySnapshot()[0].accountedResidentMB).toBe(512);
    abort.abort(); await pending;
  });
  it.each(['slow-sample', 'proc-fallback', 'non-linux', 'future-completion'])(
    '%s 不能提供可抵扣驻留证据', async kind => {
      Object.defineProperty(process, 'platform', { value: kind === 'non-linux' ? 'darwin' : 'linux' });
      setDeploymentPhaseMemoryProvider(null);
      const budget = new DeploymentPhaseBudget();
      budget.reserveKnownMemory('old', 512, owner, 64, true, cid);
      const sampledAt = Date.now();
      if (kind === 'slow-sample') vi.setSystemTime(Date.now() + 6000);
      setDeploymentPhaseResidentUsage(evidence().samples, sampledAt,
        kind === 'future-completion' ? Date.now() + 100 : Date.now());
      if (kind === 'proc-fallback') vi.mocked(readFile).mockRejectedValueOnce(new Error('proc unavailable'));
      const abort = new AbortController();
      const pending = budget.acquire('start', owner, { memoryMB: 1e12, signal: abort.signal }).catch(() => undefined);
      await flush();
      expect(budget.memorySnapshot()[0]).toMatchObject({ chargedMemoryMB: 512, accountedResidentMB: 0 });
      abort.abort(); await pending;
    });

});
