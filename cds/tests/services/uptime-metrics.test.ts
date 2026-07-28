import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BAR_SEGMENTS,
  MAX_HISTORY_POINTS,
  appendCapped,
  applyDailyRollup,
  applyIncidentTransition,
  availabilityFromDaily,
  availabilityFromSamples,
  availabilityOverRange,
  bucketizeSamples,
  dayKey,
  incidentDurationMs,
  nextDebounceState,
  parseRange,
  resolveBucketCount,
  type DebounceState,
  type UptimeDailyRollup,
  type UptimeIncident,
  type UptimeSample,
} from '../../src/services/uptime-metrics.js';

/**
 * 自建存活监控的纯函数回归门禁。覆盖用户诉求里点名的五件事：
 * 可用率计算、连续失败去抖判 down、环形缓冲上限不溢出、降采样点数上限、
 * 以及事件合成（第五件「探测不刷新 lastAccessedAt」在 uptime-monitor-cycle.test.ts）。
 */

const T0 = Date.UTC(2026, 6, 27, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const sample = (offsetMs: number, up: boolean, ms = 30, extra: Partial<UptimeSample> = {}): UptimeSample => ({
  t: T0 + offsetMs,
  up,
  ms,
  ...extra,
});

describe('appendCapped 环形缓冲', () => {
  it('未达上限时正常追加', () => {
    const list: number[] = [];
    for (let i = 0; i < 5; i++) appendCapped(list, i, 10);
    expect(list).toEqual([0, 1, 2, 3, 4]);
  });

  it('超过上限时丢最旧的，长度恒等于上限（不溢出）', () => {
    const list: number[] = [];
    for (let i = 0; i < 5000; i++) appendCapped(list, i, 1440);
    expect(list).toHaveLength(1440);
    expect(list[0]).toBe(5000 - 1440);
    expect(list[list.length - 1]).toBe(4999);
  });

  it('max 非法（0 / 负数）时至少保留 1 条，绝不清空成 0 或无限增长', () => {
    const list: number[] = [];
    for (let i = 0; i < 100; i++) appendCapped(list, i, 0);
    expect(list).toEqual([99]);
  });
});

describe('nextDebounceState 连续失败去抖', () => {
  const start: DebounceState = { status: 'up', consecutiveFailures: 0, consecutiveSuccesses: 3 };

  it('单次失败不翻转（抗抖动误报），保持 up', () => {
    const next = nextDebounceState(start, sample(0, false), { failureThreshold: 3 });
    expect(next.status).toBe('up');
    expect(next.consecutiveFailures).toBe(1);
    expect(next.transition).toBeNull();
  });

  it('连续 3 次失败才判 down，且只在跨过阈值那一次给 to-down', () => {
    let state: DebounceState = start;
    const transitions: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      const next = nextDebounceState(state, sample(i * MIN, false), { failureThreshold: 3 });
      transitions.push(next.transition);
      state = next;
    }
    expect(transitions).toEqual([null, null, 'to-down', null]);
    expect(state.status).toBe('down');
    expect(state.consecutiveFailures).toBe(4);
  });

  it('失败中途成功一次会清零失败计数，需要重新连续 3 次才判 down', () => {
    let state: DebounceState = start;
    state = nextDebounceState(state, sample(0, false), { failureThreshold: 3 });
    state = nextDebounceState(state, sample(MIN, false), { failureThreshold: 3 });
    state = nextDebounceState(state, sample(2 * MIN, true), { failureThreshold: 3 });
    expect(state.consecutiveFailures).toBe(0);
    expect(state.status).toBe('up');
    const again = nextDebounceState(state, sample(3 * MIN, false), { failureThreshold: 3 });
    expect(again.status).toBe('up');
    expect(again.transition).toBeNull();
  });

  it('恢复默认一次成功即判 up，并给 to-up', () => {
    const down: DebounceState = { status: 'down', consecutiveFailures: 7, consecutiveSuccesses: 0 };
    const next = nextDebounceState(down, sample(0, true));
    expect(next.status).toBe('up');
    expect(next.transition).toBe('to-up');
  });

  it('recoveryThreshold=2 时单次成功不算恢复', () => {
    const down: DebounceState = { status: 'down', consecutiveFailures: 5, consecutiveSuccesses: 0 };
    const first = nextDebounceState(down, sample(0, true), { recoveryThreshold: 2 });
    expect(first.status).toBe('down');
    expect(first.transition).toBeNull();
    const second = nextDebounceState(first, sample(MIN, true), { recoveryThreshold: 2 });
    expect(second.status).toBe('up');
    expect(second.transition).toBe('to-up');
  });
});

describe('可用率计算', () => {
  it('样本窗口内 9 上 1 下 → 90%，平均耗时只统计成功采样', () => {
    const samples: UptimeSample[] = [];
    for (let i = 0; i < 9; i++) samples.push(sample(-i * MIN, true, 100));
    samples.push(sample(-9 * MIN, false, 0));
    const result = availabilityFromSamples(samples, T0 - HOUR, T0);
    expect(result.upCount).toBe(9);
    expect(result.downCount).toBe(1);
    expect(result.ratio).toBeCloseTo(0.9, 6);
    expect(result.avgLatencyMs).toBe(100);
  });

  it('窗口内无采样时 ratio 为 null（前端渲染「无数据」而不是 0%）', () => {
    const result = availabilityFromSamples([sample(-10 * DAY, true)], T0 - HOUR, T0);
    expect(result.ratio).toBeNull();
    expect(result.avgLatencyMs).toBeNull();
  });

  it('窗口外采样不计入', () => {
    const samples = [sample(-2 * HOUR, false), sample(-10 * MIN, true)];
    const result = availabilityFromSamples(samples, T0 - HOUR, T0);
    expect(result.ratio).toBe(1);
  });

  it('按天聚合按 UTC 日期键闭区间过滤', () => {
    const daily: UptimeDailyRollup[] = [
      { day: '2026-07-20', up: 100, down: 0, sumMs: 1000, msCount: 100 },
      { day: '2026-07-26', up: 90, down: 10, sumMs: 900, msCount: 90 },
      { day: '2026-07-27', up: 50, down: 0, sumMs: 500, msCount: 50 },
    ];
    // 窗口起点 dayKey(T0-7d) = 2026-07-20，闭区间含当天
    const week = availabilityFromDaily(daily, dayKey(T0 - 7 * DAY), dayKey(T0));
    expect(week.upCount).toBe(240);
    expect(week.downCount).toBe(10);
    expect(week.ratio).toBeCloseTo(240 / 250, 6);

    // 窗口收窄到 2 天，2026-07-20 那条被排除
    const twoDays = availabilityFromDaily(daily, dayKey(T0 - 2 * DAY), dayKey(T0));
    expect(twoDays.upCount).toBe(140);
    expect(twoDays.ratio).toBeCloseTo(140 / 150, 6);
  });

  it('availabilityOverRange：24h 走原始采样，7d 走按天聚合', () => {
    const target = {
      samples: [sample(-MIN, true), sample(-2 * MIN, false)],
      daily: [{ day: dayKey(T0 - 3 * DAY), up: 8, down: 2, sumMs: 80, msCount: 8 }],
    };
    expect(availabilityOverRange(target, DAY, T0).ratio).toBeCloseTo(0.5, 6);
    expect(availabilityOverRange(target, 7 * DAY, T0).ratio).toBeCloseTo(0.8, 6);
  });
});

describe('applyDailyRollup 按天聚合', () => {
  it('同一天累加，跨天新开一桶', () => {
    const daily: UptimeDailyRollup[] = [];
    applyDailyRollup(daily, sample(-DAY, true, 40));
    applyDailyRollup(daily, sample(-DAY + MIN, false));
    applyDailyRollup(daily, sample(0, true, 60));
    expect(daily).toHaveLength(2);
    expect(daily[0]).toMatchObject({ up: 1, down: 1, msCount: 1, sumMs: 40 });
    expect(daily[1]).toMatchObject({ up: 1, down: 0, msCount: 1, sumMs: 60 });
  });

  it('天数超过上限时丢最旧的（不无限增长）', () => {
    const daily: UptimeDailyRollup[] = [];
    for (let i = 100; i >= 0; i--) applyDailyRollup(daily, sample(-i * DAY, true), 30);
    expect(daily).toHaveLength(30);
    expect(daily[daily.length - 1].day).toBe(dayKey(T0));
  });
});

describe('bucketizeSamples 降采样', () => {
  it('桶数恒等于请求值，空桶 status=none', () => {
    const buckets = bucketizeSamples([sample(-30 * MIN, true)], T0 - HOUR, T0, 6);
    expect(buckets).toHaveLength(6);
    expect(buckets.filter((b) => b.status === 'none')).toHaveLength(5);
    expect(buckets.filter((b) => b.status === 'up')).toHaveLength(1);
  });

  it('桶内混合成功失败 → partial；全失败 → down', () => {
    const samples = [
      sample(-50 * MIN, true),
      sample(-49 * MIN, false),
      sample(-10 * MIN, false),
      sample(-9 * MIN, false),
    ];
    // 6 桶 × 10 分钟：T0-50min / T0-49min 落第 1 桶，T0-10min / T0-9min 落第 5 桶
    const buckets = bucketizeSamples(samples, T0 - HOUR, T0, 6);
    expect(buckets[1].status).toBe('partial');
    expect(buckets[5].status).toBe('down');
  });

  it('几万条采样也只吐出上限内的点数（降采样硬闸）', () => {
    const samples: UptimeSample[] = [];
    for (let i = 0; i < 50_000; i++) samples.push(sample(-i * 1000, i % 7 !== 0));
    const buckets = bucketizeSamples(samples, T0 - 30 * DAY, T0, 100_000);
    expect(buckets.length).toBe(MAX_HISTORY_POINTS);
  });

  it('resolveBucketCount 收敛非法值与超限值', () => {
    expect(resolveBucketCount(undefined, DEFAULT_BAR_SEGMENTS)).toBe(DEFAULT_BAR_SEGMENTS);
    expect(resolveBucketCount('abc', DEFAULT_BAR_SEGMENTS)).toBe(DEFAULT_BAR_SEGMENTS);
    expect(resolveBucketCount(-5, DEFAULT_BAR_SEGMENTS)).toBe(DEFAULT_BAR_SEGMENTS);
    expect(resolveBucketCount(99_999, DEFAULT_BAR_SEGMENTS)).toBe(MAX_HISTORY_POINTS);
    expect(resolveBucketCount(30, DEFAULT_BAR_SEGMENTS)).toBe(30);
  });
});

describe('applyIncidentTransition 故障事件合成', () => {
  it('to-down 开事件，to-up 关事件并算出时长', () => {
    const incidents: UptimeIncident[] = [];
    applyIncidentTransition(incidents, 'to-down', { targetId: 'b::api', at: T0, cause: 'HTTP 502' });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].endedAt).toBeNull();
    expect(incidentDurationMs(incidents[0], T0 + 5 * MIN)).toBe(5 * MIN);

    applyIncidentTransition(incidents, 'to-up', { targetId: 'b::api', at: T0 + 5 * MIN });
    expect(incidents[0].endedAt).toBe(T0 + 5 * MIN);
    expect(incidentDurationMs(incidents[0], T0 + 99 * MIN)).toBe(5 * MIN);
  });

  it('已有未结束事件时 to-down 不重复开', () => {
    const incidents: UptimeIncident[] = [];
    applyIncidentTransition(incidents, 'to-down', { targetId: 'b::api', at: T0 });
    applyIncidentTransition(incidents, 'to-down', { targetId: 'b::api', at: T0 + MIN });
    expect(incidents).toHaveLength(1);
  });

  it('事件条数有上限，丢最旧的', () => {
    const incidents: UptimeIncident[] = [];
    for (let i = 0; i < 120; i++) {
      applyIncidentTransition(incidents, 'to-down', { targetId: 'b::api', at: T0 + i * HOUR }, 50);
      applyIncidentTransition(incidents, 'to-up', { targetId: 'b::api', at: T0 + i * HOUR + MIN }, 50);
    }
    expect(incidents).toHaveLength(50);
  });

  it('transition 为 null 时账本不变', () => {
    const incidents: UptimeIncident[] = [];
    applyIncidentTransition(incidents, null, { targetId: 'b::api', at: T0 });
    expect(incidents).toHaveLength(0);
  });
});

describe('parseRange', () => {
  it('识别 7d / 30d，其余一律回落 24h', () => {
    expect(parseRange('7d')).toEqual({ key: '7d', ms: 7 * DAY });
    expect(parseRange('30d')).toEqual({ key: '30d', ms: 30 * DAY });
    expect(parseRange('24h').key).toBe('24h');
    expect(parseRange('nonsense').key).toBe('24h');
    expect(parseRange(undefined).key).toBe('24h');
  });
});
