/**
 * DORA 四项聚合回归。
 *
 * 这批用例守的是同一件事：**指标不许在样本不足时编数字，也不许因为切片切错
 * 而系统性低估**。DORA 一旦被信任就会被写进汇报，一个错的 0% 比没有指标更糟。
 */

import { describe, it, expect } from 'vitest';
import {
  computeReleaseDora,
  clampDoraWindowDays,
  DEFAULT_DORA_WINDOW_DAYS,
  MAX_DORA_WINDOW_DAYS,
  MIN_DORA_WINDOW_DAYS,
  type ReleaseDoraRunLike,
} from '../../src/services/release-dora.js';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;

function at(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

function run(overrides: Partial<ReleaseDoraRunLike> & { releaseId: string }): ReleaseDoraRunLike {
  return {
    targetId: 'target-a',
    status: 'success',
    startedAt: overrides.finishedAt || at(1),
    ...overrides,
  };
}

describe('发布频率', () => {
  it('只数正向成功发布，回滚成功不计入', () => {
    // 事故值：把 rollback_success 计进发布频率，会得出「回滚越多、发布越频繁」
    // 这种明显反直觉的结论，指标从此没有任何判别力。
    const metrics = computeReleaseDora([
      run({ releaseId: 'r1', finishedAt: at(10) }),
      run({ releaseId: 'r2', finishedAt: at(4) }),
      run({ releaseId: 'rb1', status: 'rollback_success', rollbackOf: 'r2', finishedAt: at(3) }),
    ], { nowMs: NOW, windowDays: 30 });

    expect(metrics.frequency.successCount).toBe(2);
    expect(metrics.frequency.medianIntervalMs).toBe(6 * DAY);
  });

  it('窗口外的发布不参与统计', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'old', finishedAt: at(45) }),
      run({ releaseId: 'new', finishedAt: at(2) }),
    ], { nowMs: NOW, windowDays: 30 });

    expect(metrics.frequency.successCount).toBe(1);
    // 只有一次发布 → 没有「相邻间隔」这回事，给 null 而不是 0。
    expect(metrics.frequency.medianIntervalMs).toBeNull();
  });

  it('一次都没发布时 perDay 是 0，但失败率是 null 而不是 0', () => {
    // 事故值：变更失败率在零发布时返回 0，前端渲染「变更失败率 0%」，
    // 用户据此认为发布链路很健康 —— 实际是压根没发过，结论完全相反。
    const metrics = computeReleaseDora([], { nowMs: NOW, windowDays: 30 });
    expect(metrics.frequency.successCount).toBe(0);
    expect(metrics.frequency.perDay).toBe(0);
    expect(metrics.changeFailure.ratio).toBeNull();
    expect(metrics.changeFailure.ratio).not.toBe(0);
  });
});

describe('变更失败率', () => {
  it('事后被回滚的成功发布也算失败，哪怕那次回滚还没跑完', () => {
    // 事故值：「被回滚」的判定若加上「回滚 run 必须是终态 / 必须落在窗口内」这类
    // 筛子，正在跑的回滚、自己也失败的回滚、窗口边界上的回滚都会被漏掉，
    // 被回滚的那次发布于是算成成功，失败率被系统性低估。
    const metrics = computeReleaseDora([
      run({ releaseId: 'rel-ok', finishedAt: at(10) }),
      run({ releaseId: 'rel-bad', finishedAt: at(5) }),
      // 回滚还在跑：非终态、没有 finishedAt。人已经按下回滚键 = 这次发布被判坏了。
      run({ releaseId: 'rb-1', status: 'rollback_running', rollbackOf: 'rel-bad', startedAt: at(4), finishedAt: undefined }),
    ], { nowMs: NOW, windowDays: 30 });

    expect(metrics.changeFailure.total).toBe(2);
    expect(metrics.changeFailure.failed).toBe(1);
    expect(metrics.changeFailure.ratio).toBe(0.5);
  });

  it('回滚运行本身不进分母（它是恢复动作，不是一次变更）', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'rel-a', status: 'failed', finishedAt: at(6) }),
      run({ releaseId: 'rb-a', status: 'rollback_success', rollbackOf: 'rel-a', finishedAt: at(6) }),
    ], { nowMs: NOW, windowDays: 30 });

    expect(metrics.changeFailure.total).toBe(1);
    expect(metrics.changeFailure.failed).toBe(1);
  });

  it('在途发布既不算成功也不算失败', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'running', status: 'running', startedAt: at(1), finishedAt: undefined }),
    ], { nowMs: NOW, windowDays: 30 });
    expect(metrics.changeFailure.total).toBe(0);
    expect(metrics.changeFailure.ratio).toBeNull();
  });
});

describe('恢复时长', () => {
  it('恢复必须在同一个发布目标上找，不许跨站点串链', () => {
    // 事故值：不按 targetId 分组时，B 站在 D-9 的一次成功会被当成 A 站 D-10 那次
    // 失败的恢复，恢复时长从 2 天缩成 1 天 —— 得到一个不属于任何真实故障的漂亮数字。
    const metrics = computeReleaseDora([
      run({ releaseId: 'a-fail', targetId: 'target-a', status: 'failed', finishedAt: at(10) }),
      run({ releaseId: 'b-ok', targetId: 'target-b', finishedAt: at(9) }),
      run({ releaseId: 'a-ok', targetId: 'target-a', finishedAt: at(8) }),
    ], { nowMs: NOW, windowDays: 30 });

    expect(metrics.recovery.sampleCount).toBe(1);
    expect(metrics.recovery.p50Ms).toBe(2 * DAY);
  });

  it('尚未恢复的失败单列，不混进中位样本', () => {
    // 事故值：把还在烧的故障按「当前时刻」算进 p50，这个数字每刷新一次就变大，
    // 看着像在恶化，其实只是时间在走。
    const metrics = computeReleaseDora([
      run({ releaseId: 'f1', status: 'failed', finishedAt: at(9) }),
      run({ releaseId: 'ok1', finishedAt: at(8) }),
      run({ releaseId: 'f2', status: 'failed', finishedAt: at(2) }),
    ], { nowMs: NOW, windowDays: 30 });

    expect(metrics.recovery.sampleCount).toBe(1);
    expect(metrics.recovery.ongoingCount).toBe(1);
    expect(metrics.recovery.p50Ms).toBe(1 * DAY);
  });

  it('没有失败发布时 p50/p90 为 null 而不是 0', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'ok', finishedAt: at(3) }),
    ], { nowMs: NOW, windowDays: 30 });
    expect(metrics.recovery.p50Ms).toBeNull();
    expect(metrics.recovery.p90Ms).toBeNull();
  });
});

describe('变更前置时间', () => {
  it('缺 commit 提交时间的发布不猜，靠 sampleCount/eligibleCount 暴露覆盖率', () => {
    // 事故值：拿 startedAt / lastPushAt 顶替 commit 时间，算出来的不是前置时间，
    // 而是「发布跑了多久」或「推送到发布的间隔」，两个都不是 DORA 要问的东西，
    // 且因为看起来精确，没人会怀疑它。
    const commitTimes: Record<string, string> = {
      r1: at(11),
      // r2 没有记录（worktree 已回收 / 存量 run）
    };
    const metrics = computeReleaseDora([
      run({ releaseId: 'r1', finishedAt: at(10) }),
      run({ releaseId: 'r2', finishedAt: at(4) }),
    ], {
      nowMs: NOW,
      windowDays: 30,
      resolveCommitAt: (r) => commitTimes[r.releaseId],
    });

    expect(metrics.leadTime.eligibleCount).toBe(2);
    expect(metrics.leadTime.sampleCount).toBe(1);
    expect(metrics.leadTime.p50Ms).toBe(1 * DAY);
  });

  it('commit 时间晚于发布完成（时钟漂移 / amend）一律丢样本', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'r1', finishedAt: at(10) }),
    ], {
      nowMs: NOW,
      windowDays: 30,
      resolveCommitAt: () => at(9),
    });
    expect(metrics.leadTime.sampleCount).toBe(0);
    expect(metrics.leadTime.p50Ms).toBeNull();
  });

  it('一次成功发布都没有时不产生任何样本', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'f', status: 'failed', finishedAt: at(2) }),
    ], { nowMs: NOW, windowDays: 30, resolveCommitAt: () => at(3) });
    expect(metrics.leadTime.eligibleCount).toBe(0);
    expect(metrics.leadTime.sampleCount).toBe(0);
  });
});

describe('窗口参数与脏数据', () => {
  it('窗口天数夹在 [7, 90]，非法值回落默认', () => {
    expect(clampDoraWindowDays(1)).toBe(MIN_DORA_WINDOW_DAYS);
    expect(clampDoraWindowDays(365)).toBe(MAX_DORA_WINDOW_DAYS);
    expect(clampDoraWindowDays('abc')).toBe(DEFAULT_DORA_WINDOW_DAYS);
    expect(clampDoraWindowDays(undefined)).toBe(DEFAULT_DORA_WINDOW_DAYS);
  });

  it('时间戳解析不出来的 run 直接丢，不当成 1970 年', () => {
    // 事故值：Date.parse 得 NaN 时退回 0，这条样本会被钉在 1970 年 ——
    // 窗口判定、间隔中位、恢复时长全部被一个天文数字污染。
    const metrics = computeReleaseDora([
      run({ releaseId: 'broken', startedAt: 'not-a-date', finishedAt: 'also-bad' }),
      run({ releaseId: 'ok', finishedAt: at(3) }),
    ], { nowMs: NOW, windowDays: 30 });
    expect(metrics.frequency.successCount).toBe(1);
  });

  it('finishedAt 缺失时退回 startedAt（存量 / 异常收尾的 run 仍可统计）', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'legacy', startedAt: at(3), finishedAt: undefined }),
    ], { nowMs: NOW, windowDays: 30 });
    expect(metrics.frequency.successCount).toBe(1);
  });

  it('targetId 过滤只算指定站点', () => {
    const metrics = computeReleaseDora([
      run({ releaseId: 'a', targetId: 'target-a', finishedAt: at(3) }),
      run({ releaseId: 'b', targetId: 'target-b', finishedAt: at(2) }),
    ], { nowMs: NOW, windowDays: 30, targetId: 'target-b' });
    expect(metrics.frequency.successCount).toBe(1);
  });
});
