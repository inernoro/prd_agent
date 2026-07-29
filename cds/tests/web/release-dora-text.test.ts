/**
 * 发布中心 DORA 文案判定回归（前端纯函数）。
 *
 * 唯一要守住的规矩：**样本不足时给诚实文案，绝不给看起来精确的假数字**。
 * 事故值：变更失败率在「最近 30 天一次都没发布」时渲染成「0%」，用户据此认为
 * 发布链路健康 —— 事实完全相反（压根没发过）。同款教训见 releaseEta 的
 * 「无样本 remainingMs 一律 null，不是 0」。
 *
 * 放在 cds/tests/ 而不是 web/src/**\/__tests__：后者不被任何 runner 执行，
 * 写在那里等于没写。
 */

import { describe, it, expect } from 'vitest';
import {
  describeReleaseDora,
  formatDoraDuration,
  type ReleaseDoraMetrics,
} from '../../web/src/lib/releaseDora.js';

const DAY = 24 * 3600 * 1000;

function metrics(overrides: Partial<ReleaseDoraMetrics> = {}): ReleaseDoraMetrics {
  return {
    windowDays: 30,
    fromAt: '2026-06-28T12:00:00.000Z',
    toAt: '2026-07-28T12:00:00.000Z',
    frequency: { successCount: 6, perDay: 0.2, medianIntervalMs: 5 * DAY },
    changeFailure: { total: 8, failed: 2, ratio: 0.25 },
    recovery: { sampleCount: 2, p50Ms: 2 * 3600_000, p90Ms: 5 * 3600_000, ongoingCount: 0 },
    leadTime: { sampleCount: 4, eligibleCount: 6, p50Ms: 3 * DAY, p90Ms: 9 * DAY },
    ...overrides,
  };
}

function card(all: ReturnType<typeof describeReleaseDora>, key: string) {
  return all.find((c) => c.key === key)!;
}

describe('样本不足时不许编造', () => {
  it('零发布 → 变更失败率显示「样本不足」并说清最近 N 天仅 0 次', () => {
    const cards = describeReleaseDora(metrics({
      frequency: { successCount: 0, perDay: 0, medianIntervalMs: null },
      changeFailure: { total: 0, failed: 0, ratio: null },
      recovery: { sampleCount: 0, p50Ms: null, p90Ms: null, ongoingCount: 0 },
      leadTime: { sampleCount: 0, eligibleCount: 0, p50Ms: null, p90Ms: null },
    }));
    const failure = card(cards, 'changeFailure');
    expect(failure.insufficient).toBe(true);
    expect(failure.value).toBe('样本不足');
    expect(failure.value).not.toContain('0%');
    expect(failure.hint).toContain('最近 30 天');
    expect(failure.hint).toContain('0 次发布');
    // 四张卡都必须存在：藏起来用户会以为功能坏了。
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.insufficient)).toBe(true);
  });

  it('后端没下发 dora（旧构建）→ 四项退化成样本不足，不白屏也不编 0', () => {
    const cards = describeReleaseDora(undefined);
    expect(cards).toHaveLength(4);
    expect(cards.every((c) => c.value === '样本不足')).toBe(true);
    expect(cards.every((c) => c.hint.includes('未下发'))).toBe(true);
  });

  it('缺 commit 提交时间时说清覆盖缺口，不拿别的时间戳凑一个前置时间', () => {
    const cards = describeReleaseDora(metrics({
      leadTime: { sampleCount: 0, eligibleCount: 5, p50Ms: null, p90Ms: null },
    }));
    const lead = card(cards, 'leadTime');
    expect(lead.insufficient).toBe(true);
    expect(lead.hint).toContain('5 次发布缺少 commit 提交时间');
  });

  it('只有一次发布时不谎称有间隔中位', () => {
    const cards = describeReleaseDora(metrics({
      frequency: { successCount: 1, perDay: 1 / 30, medianIntervalMs: null },
    }));
    const freq = card(cards, 'frequency');
    expect(freq.insufficient).toBe(false);
    expect(freq.value).toBe('1 次/30 天');
    expect(freq.hint).toContain('暂无间隔中位');
  });

  it('尚未恢复的故障单列在 hint 里，不混进 p50 数字', () => {
    const cards = describeReleaseDora(metrics({
      recovery: { sampleCount: 2, p50Ms: 90 * 60_000, p90Ms: 3 * 3600_000, ongoingCount: 1 },
    }));
    const recovery = card(cards, 'recovery');
    expect(recovery.value).toBe('1 小时 30 分钟');
    expect(recovery.hint).toContain('1 次尚未恢复');
  });

  it('一次失败都没有时恢复时长是「样本不足」，不是 0', () => {
    const cards = describeReleaseDora(metrics({
      recovery: { sampleCount: 0, p50Ms: null, p90Ms: null, ongoingCount: 0 },
    }));
    const recovery = card(cards, 'recovery');
    expect(recovery.value).toBe('样本不足');
    expect(recovery.value).not.toContain('0');
  });
});

describe('有样本时给真实数字', () => {
  it('四项都给数字与样本量', () => {
    const cards = describeReleaseDora(metrics());
    expect(card(cards, 'frequency').value).toBe('6 次/30 天');
    expect(card(cards, 'changeFailure').value).toBe('25%');
    expect(card(cards, 'changeFailure').hint).toContain('2/8');
    expect(card(cards, 'recovery').value).toBe('2 小时');
    expect(card(cards, 'leadTime').value).toBe('3 天');
    expect(card(cards, 'leadTime').hint).toContain('覆盖 4/6 次发布');
    expect(cards.every((c) => c.insufficient === false)).toBe(true);
  });

  it('日均超过一次时改用「次/天」', () => {
    const cards = describeReleaseDora(metrics({
      frequency: { successCount: 90, perDay: 3, medianIntervalMs: 8 * 3600_000 },
    }));
    expect(card(cards, 'frequency').value).toBe('3.0 次/天');
  });
});

describe('formatDoraDuration', () => {
  it('按量级给中文时长，null 给占位而不是 0', () => {
    expect(formatDoraDuration(null)).toBe('-');
    expect(formatDoraDuration(30_000)).toBe('不足 1 分钟');
    expect(formatDoraDuration(12 * 60_000)).toBe('12 分钟');
    expect(formatDoraDuration(90 * 60_000)).toBe('1 小时 30 分钟');
    expect(formatDoraDuration(2 * 3600_000)).toBe('2 小时');
    expect(formatDoraDuration(50 * 3600_000)).toBe('2 天 2 小时');
    expect(formatDoraDuration(2 * DAY)).toBe('2 天');
  });
});
