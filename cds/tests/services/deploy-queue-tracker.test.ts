/**
 * deploy-queue-tracker（构建排队可视化，2026-07-09）单测。
 *
 * 覆盖的行为契约：
 *   1. onQueued 首个排队服务建立 buildQueue 快照（queuedAt/ahead/active/max/serviceIds）
 *      并发 branch.updated；后续服务并入集合，ahead 取最小值。
 *   2. refresh 只更新位置快照 + 发事件，不触发持久化（瞬态刷新不值一次全量落盘）。
 *   3. onStart 从集合移除服务；集合清空时把「首入队 → 清空」的 wall-clock 区间
 *      累进 lastDeployQueueWaitMs 并清掉 buildQueue。
 *   4. dispose 兜底：部署 throw 后不许留下「排队中」残影，剩余等待也计入 waitMs。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeployQueueTracker } from '../../src/services/deploy-queue-tracker.js';
import { __resetBuildGateForTest } from '../../src/services/build-gate.js';
import type { BranchEntry } from '../../src/types.js';

function makeEntry(): BranchEntry {
  return {
    id: 'b1',
    branch: 'feat/queue',
    worktreePath: '/tmp/wt',
    services: {},
    status: 'building',
    createdAt: new Date().toISOString(),
  } as BranchEntry;
}

describe('deploy-queue-tracker', () => {
  let entry: BranchEntry;
  let saves: number;
  let emits: number;
  let tracker: ReturnType<typeof createDeployQueueTracker>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T00:00:00Z'));
    __resetBuildGateForTest();
    entry = makeEntry();
    saves = 0;
    emits = 0;
    tracker = createDeployQueueTracker({
      entry,
      save: () => { saves += 1; },
      emitBranchUpdated: () => { emits += 1; },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('onQueued establishes the snapshot and merges subsequent services with min(ahead)', () => {
    tracker.onQueued('api', { ahead: 2, active: 3, max: 3 });
    expect(entry.buildQueue).toMatchObject({ ahead: 2, active: 3, max: 3, serviceIds: ['api'] });
    expect(entry.buildQueue!.queuedAt).toBe('2026-07-09T00:00:00.000Z');
    expect(saves).toBe(1);
    expect(emits).toBe(1);

    tracker.onQueued('web', { ahead: 3, active: 3, max: 3 });
    expect(entry.buildQueue!.serviceIds).toEqual(['api', 'web']);
    // ahead 取最小（离槽位最近的那个代表分支位置）
    expect(entry.buildQueue!.ahead).toBe(2);
    // 同一服务重复 onQueued 不重复入列
    tracker.onQueued('web', { ahead: 3, active: 3, max: 3 });
    expect(entry.buildQueue!.serviceIds).toEqual(['api', 'web']);
  });

  it('refresh updates position without persisting', () => {
    tracker.onQueued('api', { ahead: 5, active: 3, max: 3 });
    const savesAfterQueue = saves;
    tracker.refresh();
    // buildGateStatus 此刻 queued=0（测试里没真排队）→ ahead 单调收敛到 0
    expect(entry.buildQueue!.ahead).toBe(0);
    expect(saves).toBe(savesAfterQueue); // 无新增持久化
    expect(emits).toBe(2);
  });

  it('onStart clears the set and settles wall-clock wait into lastDeployQueueWaitMs', () => {
    tracker.onQueued('api', { ahead: 1, active: 3, max: 3 });
    tracker.onQueued('web', { ahead: 2, active: 3, max: 3 });

    vi.advanceTimersByTime(30_000);
    tracker.onStart('api');
    // 还剩 web 在排队：不结清、快照仍在
    expect(entry.buildQueue).toBeDefined();
    expect(entry.buildQueue!.serviceIds).toEqual(['web']);
    expect(entry.lastDeployQueueWaitMs ?? 0).toBe(0);

    vi.advanceTimersByTime(15_000);
    tracker.onStart('web');
    // 集合清空：结清「首入队 → 清空」= 45s，快照移除
    expect(entry.buildQueue).toBeUndefined();
    expect(entry.lastDeployQueueWaitMs).toBe(45_000);
  });

  it('dispose settles remaining wait and never leaves a stale queue snapshot', () => {
    tracker.onQueued('api', { ahead: 1, active: 3, max: 3 });
    vi.advanceTimersByTime(20_000);
    tracker.dispose();
    expect(entry.buildQueue).toBeUndefined();
    expect(entry.lastDeployQueueWaitMs).toBe(20_000);
    // 已清空后再 dispose 是 no-op
    const emitsAfter = emits;
    tracker.dispose();
    expect(emits).toBe(emitsAfter);
  });

  it('onStart for a service that never queued is a no-op', () => {
    tracker.onStart('api');
    expect(entry.buildQueue).toBeUndefined();
    expect(saves).toBe(0);
    expect(emits).toBe(0);
  });
});
