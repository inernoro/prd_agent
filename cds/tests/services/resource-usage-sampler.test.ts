import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeResourceSnapshot, ResourceUsageSampler, countReservedContainers, forgetConfirmedStoppedContainers, __setLatestResourceUsageForTests } from '../../src/services/resource-usage-sampler.js';
import type { StateService } from '../../src/services/state.js';
import type { BranchEntry } from '../../src/types.js';
import type { BuildActivitySummary } from '../../src/services/build-activity-tracker.js';

function branch(projectId: string, services: Array<{ status: string; containerName: string }>): BranchEntry {
  return {
    id: `${projectId}-b`,
    projectId,
    branch: 'main',
    worktreePath: `/tmp/${projectId}`,
    status: 'running',
    createdAt: '2026-06-23T00:00:00.000Z',
    services: Object.fromEntries(
      services.map((s, i) => [`svc${i}`, { profileId: `svc${i}`, containerName: s.containerName, status: s.status as any }]),
    ),
  } as unknown as BranchEntry;
}

const MB = 1024 * 1024;
afterEach(() => __setLatestResourceUsageForTests(null));

describe('computeResourceSnapshot', () => {
  it('分支额度只计已知驻留身份，不把基础设施与无关宿主容器算入', async () => {
    const branches = [branch('p1', [{ status: 'error', containerName: 'resident' }])];
    branches[0].replicaSets = { db: { members: [{ id: 'r', containerName: 'replica', status: 'error' }] } } as BranchEntry['replicaSets'];
    const provider = { getRunningContainerNames: vi.fn().mockResolvedValue(new Set(['resident', 'replica', 'infra-proxy', 'other-host'])),
      getServiceStats: vi.fn().mockResolvedValue(new Map()) };
    const sampler = new ResourceUsageSampler({ getAllBranches: () => branches } as StateService, provider);
    await sampler.sampleOnce(); expect(countReservedContainers(branches)).toBe(2);
    branches.length = 0; provider.getRunningContainerNames.mockRejectedValueOnce(new Error('observation unavailable'));
    await sampler.sampleOnce(); expect(countReservedContainers(branches)).toBe(2);
    forgetConfirmedStoppedContainers(['replica']); expect(countReservedContainers(branches)).toBe(1);
    provider.getRunningContainerNames.mockResolvedValueOnce(new Set(['infra-proxy', 'other-host']));
    await sampler.sampleOnce(); expect(countReservedContainers(branches)).toBe(0);
  });

  it('没有已知分支身份时成功盘点其它宿主容器仍为零分支额度', async () => {
    const provider = { getRunningContainerNames: vi.fn().mockResolvedValue(new Set(['infra-proxy', 'other-host'])),
      getServiceStats: vi.fn().mockResolvedValue(new Map()) };
    await new ResourceUsageSampler({ getAllBranches: () => [] } as unknown as StateService, provider).sampleOnce();
    expect(countReservedContainers([])).toBe(0);
  });

  it('盘点中容器的台账暂时消失且读取失败时仍保留物理容量', async () => {
    const branches = [branch('p1', [{ status: 'error', containerName: 'resident' }])];
    const provider = { getRunningContainerNames: vi.fn().mockResolvedValue(new Set(['resident'])), getServiceStats: vi.fn().mockResolvedValue(new Map()) };
    const sampler = new ResourceUsageSampler({ getAllBranches: () => branches } as StateService, provider);
    await sampler.sampleOnce(); expect(countReservedContainers(branches)).toBe(1);
    branches.length = 0; provider.getRunningContainerNames.mockRejectedValueOnce(new Error('observation unavailable'));
    await sampler.sampleOnce(); expect(countReservedContainers(branches)).toBe(1);
  });
  it('sampler queries the actual running inventory for error services, and a failed read retains their reservation', async () => {
    const branches = [branch('p1', [{ status: 'error', containerName: 'alive-error' }, { status: 'stopped', containerName: 'stopped' }])];
    const provider = { getRunningContainerNames: vi.fn().mockResolvedValue(new Set(['alive-error'])),
      getServiceStats: vi.fn().mockResolvedValue(new Map([['alive-error', { cpuPercent: 25, memUsedBytes: 128 * MB }]])) };
    const sampler = new ResourceUsageSampler({ getAllBranches: () => branches } as StateService, provider);
    expect((await sampler.sampleOnce())?.totals.runningContainers).toBe(1);
    expect(provider.getServiceStats).toHaveBeenCalledWith(['alive-error']);
    expect(countReservedContainers(branches)).toBe(1);
    provider.getRunningContainerNames.mockRejectedValueOnce(new Error('owned observation unavailable'));
    expect((await sampler.sampleOnce())?.totals.runningContainers).toBe(1);
    expect(countReservedContainers(branches)).toBe(1);
    provider.getRunningContainerNames.mockResolvedValueOnce(new Set());
    await sampler.sampleOnce(); expect(countReservedContainers(branches)).toBe(0);
    expect(branches[0].services.svc0.status).toBe('error');
  });
  it('counts a physically running error service and excludes an observed stopped service', () => {
    const branches = [branch('p1', [{ status: 'error', containerName: 'alive-error' }, { status: 'stopped', containerName: 'stopped' }])];
    const stats = new Map([['alive-error', { cpuPercent: 25, memUsedBytes: 128 * MB }],
      ['stopped', { cpuPercent: 0, memUsedBytes: 0 }]]);
    const snap = computeResourceSnapshot(branches, stats, new Map(), Date.now(), 45000, new Set(['alive-error']));
    expect(snap.totals).toEqual({ cpuPercent: 25, memUsedMB: 128, runningContainers: 1 });
  });
  it('真实snapshot返回未知时不走会掩盖错误的空集合兼容方法', async () => {
    const branches = [branch('p1', [{ status: 'error', containerName: 'alive' }])];
    const provider = { getRunningContainerNamesSnapshot: vi.fn().mockResolvedValue(new Set(['alive'])),
      getRunningContainerNames: vi.fn().mockResolvedValue(new Set()),
      getServiceStats: vi.fn().mockResolvedValue(new Map([['alive', { cpuPercent: 5, memUsedBytes: 8 * MB }]])) };
    const sampler = new ResourceUsageSampler({ getAllBranches: () => branches } as StateService, provider);
    await sampler.sampleOnce(); expect(countReservedContainers(branches)).toBe(1);
    provider.getRunningContainerNamesSnapshot.mockResolvedValueOnce(null);
    expect((await sampler.sampleOnce())?.totals.runningContainers).toBe(1);
    expect(countReservedContainers(branches)).toBe(1);
    expect(provider.getRunningContainerNames).not.toHaveBeenCalled();
  });
  it('rolls up running-container CPU/mem per project and merges build churn', () => {
    const branches = [
      branch('p1', [
        { status: 'running', containerName: 'c1' },
        { status: 'running', containerName: 'c2' },
        { status: 'stopped', containerName: 'c-cold' },
      ]),
    ];
    const stats = new Map([
      ['c1', { cpuPercent: 30, memUsedBytes: 100 * MB }],
      ['c2', { cpuPercent: 10, memUsedBytes: 50 * MB }],
    ]);
    const builds = new Map<string, BuildActivitySummary>([
      ['p1', { recentBuilds1h: 5, recentBuilds24h: 12, lastBuildAt: Date.parse('2026-06-23T10:00:00.000Z') }],
      // p2 is rebuilding constantly but has no running containers right now.
      ['p2', { recentBuilds1h: 40, recentBuilds24h: 200, lastBuildAt: Date.parse('2026-06-23T10:05:00.000Z') }],
    ]);

    const snap = computeResourceSnapshot(branches, stats, builds, Date.now(), 45_000);
    const p1 = snap.projects.find((p) => p.projectId === 'p1')!;
    const p2 = snap.projects.find((p) => p.projectId === 'p2')!;

    expect(p1.cpuPercent).toBe(40);
    expect(p1.memUsedMB).toBe(150);
    expect(p1.runningContainers).toBe(2);
    expect(p1.recentBuilds1h).toBe(5);

    // The build-churn-only project still surfaces (the "作死反复构建" culprit).
    expect(p2.runningContainers).toBe(0);
    expect(p2.cpuPercent).toBe(0);
    expect(p2.recentBuilds1h).toBe(40);
    expect(p2.lastBuildAt).not.toBeNull();

    expect(snap.totals.cpuPercent).toBe(40);
    expect(snap.totals.runningContainers).toBe(2);
  });

  it('ignores containers without a stats entry (docker stats missed it)', () => {
    const branches = [branch('p1', [{ status: 'running', containerName: 'gone' }])];
    const snap = computeResourceSnapshot(branches, new Map(), new Map(), Date.now(), 45_000);
    const p1 = snap.projects.find((p) => p.projectId === 'p1')!;
    expect(p1.runningContainers).toBe(1);
    expect(p1.cpuPercent).toBe(0);
  });
});

describe('静态站资源归属', () => {
  it('静态候选与已发布站点不占容器额度，尚未退役的旧容器仍计入', () => {
    const entry = branch('static-project', [{ status: 'running', containerName: 'static-web' }]);
    const service = entry.services.svc0;
    service.runtimeKind = 'static';
    service.pendingRuntime = { containerName: 'next-static', hostPort: 1234, runtimeKind: 'static' };
    service.retainedRuntimes = [{ containerName: 'old-nginx', hostPort: 1235, containerId: 'a'.repeat(64) }];
    expect(countReservedContainers([entry])).toBe(1);
    const snapshot = computeResourceSnapshot([entry], new Map(), new Map(), Date.now(), 1000, new Set(['old-nginx']));
    expect(snapshot.totals.runningContainers).toBe(1);
    service.retainedRuntimes = [];
    expect(countReservedContainers([entry])).toBe(0);
  });
});
