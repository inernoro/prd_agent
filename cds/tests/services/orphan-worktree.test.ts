/**
 * 孤儿 worktree 对账（2026-07-27 宕机复盘 P2）。
 *
 * janitor 只遍历台账里的分支，磁盘上「目录还在、台账里没有」的 worktree 从来没人管。
 * 事故当天宿主 .cds-worktrees 已 45.5GB，而按 TTL 够格删的分支只有 3 个——TTL 那条
 * 路径根本够不着这部分空间。
 *
 * 这里钉死的重点是**误删护栏**：删错一个正在创建的分支目录，比不清理危险得多。
 */
import { describe, it, expect } from 'vitest';
import {
  computeOrphanWorktreePlan, normalizeWorktreePath,
  DEFAULT_ORPHAN_WORKTREE_MIN_AGE_MS,
} from '../../src/services/orphan-worktree.js';

const NOW = Date.parse('2026-07-28T12:00:00Z');
const OLD = NOW - DEFAULT_ORPHAN_WORKTREE_MIN_AGE_MS - 60_000;
const BASE = '/srv/.cds-worktrees';
const dir = (p: string, mtimeMs = OLD) => ({ path: p, mtimeMs });

describe('路径归一化', () => {
  it('末尾斜杠不影响比对', () => {
    expect(normalizeWorktreePath(`${BASE}/proj/main/`)).toBe(`${BASE}/proj/main`);
    expect(normalizeWorktreePath(`${BASE}/proj/main`)).toBe(`${BASE}/proj/main`);
  });
});

describe('孤儿判定', () => {
  it('台账里有分支占用的目录一律不动', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/main`)],
      claimedPaths: [`${BASE}/proj/main`],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptReasons[`${BASE}/proj/main`]).toContain('正在使用');
  });

  it('台账里没有、且已够老 → 判为孤儿', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/gone`)],
      claimedPaths: [],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([`${BASE}/proj/gone`]);
  });

  it('目录太新一律不碰——分支创建是先建目录后写台账，中间重启就会被误判', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/being-created`, NOW - 60_000)],
      claimedPaths: [],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptReasons[`${BASE}/proj/being-created`]).toContain('可能正在创建中');
  });

  it('时间读不出来时按「太新」保守处理（宁可漏删不可误删）', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [{ path: `${BASE}/proj/weird`, mtimeMs: Number.NaN }],
      claimedPaths: [],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
  });

  it('台账路径带末尾斜杠也能正确认领（不会因为写法差异误删正在用的目录）', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/main`)],
      claimedPaths: [`${BASE}/proj/main/`],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
  });

  it('单轮上限截断，剩下的如实计入 deferred', () => {
    const dirs = Array.from({ length: 5 }, (_, i) => dir(`${BASE}/proj/gone-${i}`));
    const plan = computeOrphanWorktreePlan({
      diskDirs: dirs, claimedPaths: [], nowMs: NOW, maxRemovals: 2,
    });
    expect(plan.remove).toHaveLength(2);
    expect(plan.deferred).toBe(3);
    expect(plan.keptReasons[`${BASE}/proj/gone-4`]).toContain('下轮继续');
  });

  it('上限为 0 = 只报不删（可作 dry-run 用）', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/gone`)], claimedPaths: [], nowMs: NOW, maxRemovals: 0,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.deferred).toBe(1);
  });

  it('同一项目下多个分支只删没被认领的那些', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/a`), dir(`${BASE}/proj/b`), dir(`${BASE}/proj/c`)],
      claimedPaths: [`${BASE}/proj/a`, `${BASE}/proj/c`],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([`${BASE}/proj/b`]);
  });
});

describe('容器挂载护栏', () => {
  // 分支记录先被删、容器还没被收割的窗口里，目录仍被容器 bind-mount 着。
  // 此时删目录会让那个还在跑的容器当场瞎掉——台账之外必须再加物理占用检查。
  it('目录本身被挂载 → 不删', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/gone`)],
      claimedPaths: [],
      mountedPaths: [`${BASE}/proj/gone`],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptReasons[`${BASE}/proj/gone`]).toContain('挂载');
  });

  it('挂载的是目录下的子路径（compose 常见写法）→ 同样不删', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/gone`)],
      claimedPaths: [],
      mountedPaths: [`${BASE}/proj/gone/prd-admin`],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([]);
  });

  it('同名前缀的**兄弟**目录不算挂载（gone-2 不因 gone 被挂而豁免）', () => {
    const plan = computeOrphanWorktreePlan({
      diskDirs: [dir(`${BASE}/proj/gone-2`)],
      claimedPaths: [],
      mountedPaths: [`${BASE}/proj/gone`],
      nowMs: NOW,
    });
    expect(plan.remove).toEqual([`${BASE}/proj/gone-2`]);
  });
});
