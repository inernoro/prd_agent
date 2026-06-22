import { describe, it, expect } from 'vitest';
import { computeWaitTiming, formatWaitClock } from '../../src/services/wait-timing.js';

/**
 * 预览等待页时间计算（wait-timing.ts computeWaitTiming）单测。
 * 覆盖：elapsed 数学、remaining clamp、overdue 标志、无样本时 null（不编造）、
 * deployStartedAt 缺失兜底、clock 格式（MM:SS / H:MM:SS）。
 */
describe('computeWaitTiming', () => {
  it('computes elapsed and remaining when samples exist and not overdue', () => {
    const r = computeWaitTiming({
      status: 'building',
      deployStartedAtMs: 1_000_000,
      nowMs: 1_000_000 + 60_000, // 60s elapsed
      estimate: { medianMs: 180_000, samples: 5 }, // median 3min
    });
    expect(r.elapsedMs).toBe(60_000);
    expect(r.estimateMedianMs).toBe(180_000);
    expect(r.estimateSamples).toBe(5);
    expect(r.remainingMs).toBe(120_000); // 180 - 60
    expect(r.overdue).toBe(false);
  });

  it('clamps remaining to 0 and flags overdue when elapsed exceeds median', () => {
    const r = computeWaitTiming({
      status: 'building',
      deployStartedAtMs: 0,
      nowMs: 240_000, // 240s elapsed
      estimate: { medianMs: 180_000, samples: 8 },
    });
    expect(r.elapsedMs).toBe(240_000);
    expect(r.remainingMs).toBe(0); // clamped, never negative
    expect(r.overdue).toBe(true);
  });

  it('returns null estimate/remaining when there are no samples (no fabrication)', () => {
    const r = computeWaitTiming({
      status: 'building',
      deployStartedAtMs: 0,
      nowMs: 30_000,
      estimate: { medianMs: null, samples: 0 },
    });
    expect(r.elapsedMs).toBe(30_000);
    expect(r.estimateMedianMs).toBeNull();
    expect(r.remainingMs).toBeNull();
    expect(r.overdue).toBe(false);
  });

  it('treats samples>0 but medianMs null defensively as no estimate', () => {
    const r = computeWaitTiming({
      status: 'building',
      deployStartedAtMs: 0,
      nowMs: 10_000,
      estimate: { medianMs: null, samples: 3 },
    });
    expect(r.estimateMedianMs).toBeNull();
    expect(r.remainingMs).toBeNull();
    expect(r.overdue).toBe(false);
  });

  it('falls back to elapsed 0 when deployStartedAt is null', () => {
    const r = computeWaitTiming({
      status: 'starting',
      deployStartedAtMs: null,
      nowMs: 999_999,
      estimate: { medianMs: 120_000, samples: 2 },
    });
    expect(r.elapsedMs).toBe(0);
    expect(r.remainingMs).toBe(120_000);
    expect(r.overdue).toBe(false);
  });

  it('never produces negative elapsed when clock skews backward', () => {
    const r = computeWaitTiming({
      status: 'building',
      deployStartedAtMs: 5_000,
      nowMs: 1_000, // now < start
      estimate: { medianMs: 60_000, samples: 1 },
    });
    expect(r.elapsedMs).toBe(0);
  });
});

describe('formatWaitClock', () => {
  it('formats sub-hour as MM:SS', () => {
    expect(formatWaitClock(0)).toBe('00:00');
    expect(formatWaitClock(65_000)).toBe('01:05');
    expect(formatWaitClock(180_000)).toBe('03:00');
  });

  it('formats >= 1h as H:MM:SS', () => {
    expect(formatWaitClock(3_600_000)).toBe('1:00:00');
    expect(formatWaitClock(3_725_000)).toBe('1:02:05');
  });

  it('clamps negative to 00:00', () => {
    expect(formatWaitClock(-5_000)).toBe('00:00');
  });
});
