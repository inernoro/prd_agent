/**
 * 已删项目的 worktree 桶必须仍可回收（Codex PR #1275 三轮 P2）。
 *
 * 三轮 P1 给孤儿枚举加了「只进已知项目桶」的白名单（挡住误删迁移遗留的活 worktree），
 * 但白名单只认在册项目。删项目时 `removeProject()` cascade 掉项目与分支记录，路由的
 * 异步物理清理**不删 worktree 目录** —— 于是被删项目的 id 从清单里消失，那个桶
 * 从此再也进不去，里面已经没有任何分支认领的 worktree 永久占盘。护栏把功能护死了。
 *
 * 解法与容器清理同构：删项目时先落一条桶墓碑，对账把墓碑 id 并入白名单；桶里
 * 清空后墓碑自动摘除。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { JanitorService, type OrphanWorktreeFs } from '../../src/services/janitor.js';
import type { StateService } from '../../src/services/state.js';

const BASE = '/srv/.cds-worktrees';
const NOW = Date.parse('2026-07-28T12:00:00Z');
const OLD = NOW - 24 * 60 * 60_000;

let removed: string[];
let seenProjectIds: readonly string[];
let droppedTombstones: string[];
let deadBucketDirs: string[];
let enumerationBroken = false;

const fsFake = (): OrphanWorktreeFs => ({
  listWorktreeDirs: async (_base, knownProjectIds) => {
    seenProjectIds = knownProjectIds;
    // 只有在白名单里的桶才吐目录 —— 与真实实现同构
    return {
      dirs: deadBucketDirs
        .filter((d) => knownProjectIds.includes(d.split('/')[3]))
        .map((path) => ({ path, mtimeMs: OLD })),
      unreadable: enumerationBroken ? [`${BASE}/gone-proj`] : [],
    };
  },
  listMountedHostPaths: async () => [],
  removeDir: async (dir) => { removed.push(dir); deadBucketDirs = deadBucketDirs.filter((d) => d !== dir); return null; },
  statDirMtimeMs: async () => OLD,
});

const stateFake = (): StateService => ({
  // 项目已删：在册项目里没有 gone-proj，分支也已 cascade 掉
  getProjects: () => [{ id: 'live-proj' }],
  getAllBranches: () => [],
  getDeletedProjectWorktreeBuckets: () => [{ projectId: 'gone-proj', requestedAt: '2026-07-28T10:00:00Z' }],
  removeDeletedProjectWorktreeBucket: (id: string) => { droppedTombstones.push(id); },
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

beforeEach(() => {
  removed = [];
  droppedTombstones = [];
  seenProjectIds = [];
  deadBucketDirs = [`${BASE}/gone-proj/branch-a`, `${BASE}/gone-proj/branch-b`];
  enumerationBroken = false;
});

describe('已删项目的 worktree 桶', () => {
  it('墓碑 id 并入白名单，桶还进得去', async () => {
    await mkJanitor().sweep();
    expect(seenProjectIds).toContain('gone-proj');
    expect(seenProjectIds).toContain('live-proj');
  });

  it('桶里无人认领的 worktree 真的被回收（不再永久占盘）', async () => {
    const report = await mkJanitor().sweep();
    expect(removed.sort()).toEqual([`${BASE}/gone-proj/branch-a`, `${BASE}/gone-proj/branch-b`]);
    expect(report.orphanWorktrees?.removed).toHaveLength(2);
  });

  it('桶清空后墓碑自动摘除（不留无限增长的台账）', async () => {
    await mkJanitor().sweep();
    expect(droppedTombstones).toEqual(['gone-proj']);
  });

  it('桶里还有没删完的就留着墓碑，下一轮继续', async () => {
    // 单轮上限 1：只删得掉一个，另一个留到下轮
    const j = new JanitorService(
      stateFake(),
      { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600,
        dockerPrune: false, imageRetention: false, orphanWorktreeMaxRemovalsPerSweep: 1 },
      BASE,
      { now: () => NOW },
      () => null,
      async () => ({ ran: false, reclaimed: [], errors: [] }),
      { listImages: async () => [], listInUseImages: async () => [], removeImage: async () => null },
      fsFake(),
    );
    const report = await j.sweep();
    expect(report.orphanWorktrees?.removed).toHaveLength(1);
    expect(report.orphanWorktrees?.deferred).toBe(1);
    expect(droppedTombstones).toEqual([]);
  });

  it('枚举读失败时保留墓碑：读不出来不等于桶已空（Codex 六轮 P2）', async () => {
    // EACCES / IO 抖动 / 挂载失败 → 桶「看起来是空的」。若据此摘墓碑，文件系统恢复后
    // 那些目录永远落在项目 id 白名单之外，再也回收不了。
    deadBucketDirs = [];
    enumerationBroken = true;
    await mkJanitor().sweep();
    expect(droppedTombstones).toEqual([]);
  });
});
