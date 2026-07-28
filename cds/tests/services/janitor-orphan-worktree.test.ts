/**
 * 孤儿 worktree 对账在 janitor 里的接线（2026-07-27 宕机复盘 P2）。
 *
 * 纯判定在 orphan-worktree.test.ts；这里只钉接线层的三条：
 *  - 真的会删（否则 45.5GB 还是收不回来）；
 *  - 查不到容器挂载情况时**整轮不删**（宁可晚一轮，也不删还被挂着的目录）；
 *  - 失败如实进 errors，不静默。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { JanitorService, type OrphanWorktreeFs } from '../../src/services/janitor.js';
import type { StateService } from '../../src/services/state.js';

const BASE = '/srv/.cds-worktrees';
const NOW = Date.parse('2026-07-28T12:00:00Z');
const OLD = NOW - 24 * 60 * 60_000;

let removed: string[];
let mounted: string[] | null;
let removeError: string | null;

const fsFake = (): OrphanWorktreeFs => ({
  listWorktreeDirs: async () => [
    { path: `${BASE}/proj/live`, mtimeMs: OLD },
    { path: `${BASE}/proj/orphan`, mtimeMs: OLD },
  ],
  listMountedHostPaths: async () => mounted,
  removeDir: async (dir) => { if (removeError) return removeError; removed.push(dir); return null; },
});

const stateFake = (): StateService => ({
  getAllBranches: () => [{ id: 'b1', worktreePath: `${BASE}/proj/live` }],
  getDeploymentVersions: () => [],
  getDefaultBranchFor: () => null,
} as unknown as StateService);

const mkJanitor = (): JanitorService => new JanitorService(
  stateFake(),
  { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600,
    dockerPrune: false, imageRetention: false },
  BASE,
  { now: () => NOW },
  () => null,
  async () => ({ ran: false, reclaimed: [], errors: [] }),
  { listImages: async () => [], listInUseImages: async () => [], removeImage: async () => null },
  fsFake(),
);

beforeEach(() => { removed = []; mounted = []; removeError = null; });

describe('janitor 孤儿 worktree 接线', () => {
  it('台账无人认领且无容器挂载 → 真的删掉', async () => {
    const report = await mkJanitor().sweep();
    expect(removed).toEqual([`${BASE}/proj/orphan`]);
    expect(report.orphanWorktrees?.removed).toEqual([`${BASE}/proj/orphan`]);
    // 台账里在用的那个必须留着并给出原因
    expect(report.orphanWorktrees?.keptReasons[`${BASE}/proj/live`]).toContain('正在使用');
  });

  it('查不到容器挂载情况 → 整轮只报不删', async () => {
    mounted = null;
    const report = await mkJanitor().sweep();
    expect(removed).toEqual([]);
    expect(report.orphanWorktrees?.deferred).toBe(1);
  });

  it('目录被容器挂载 → 不删，理由如实带出', async () => {
    mounted = [`${BASE}/proj/orphan/prd-admin`];
    const report = await mkJanitor().sweep();
    expect(removed).toEqual([]);
    expect(report.orphanWorktrees?.keptReasons[`${BASE}/proj/orphan`]).toContain('挂载');
  });

  it('删除失败进 errors，不静默吞掉', async () => {
    removeError = 'EBUSY: resource busy';
    const report = await mkJanitor().sweep();
    expect(report.orphanWorktrees?.failed).toHaveLength(1);
    expect(report.errors.some((e) => e.includes('orphan worktree rm'))).toBe(true);
  });
});
