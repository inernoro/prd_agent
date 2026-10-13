import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeResourceSnapshot, ResourceUsageSampler, countReservedContainers, __setLatestResourceUsageForTests } from '../../src/services/resource-usage-sampler.js';
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
