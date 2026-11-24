import { describe, expect, it } from 'vitest';

import {
  CANVAS_SAVE_COOLDOWN_MS,
  canvasSaveCooldownRemaining,
} from '@/lib/canvasSaveSchedule';

describe('画布落盘的频控时序', () => {
  it('距上次落盘够久了就立刻放行', () => {
    expect(canvasSaveCooldownRemaining({ now: 10_000, lastSavedAt: 5_000 })).toBe(0);
    expect(canvasSaveCooldownRemaining({ now: 5_800, lastSavedAt: 5_000 })).toBe(0);
  });

  it('【关键】撞上频控时返回「还要等多久」，而不是让调用方放弃这一次', () => {
    // 这条是整个抽取的理由：旧实现在这里直接 return，这次改动就此消失；
    // 之后若没有新的画布变化，再也没有人来救它——最后一批改动永远不落盘。
    // 返回正数 = 调用方必须改期重试。
    const remaining = canvasSaveCooldownRemaining({ now: 5_300, lastSavedAt: 5_000 });
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBe(CANVAS_SAVE_COOLDOWN_MS - 300);
  });

  it('改期之后再问一次就该放行（不会无限改期）', () => {
    const first = canvasSaveCooldownRemaining({ now: 5_300, lastSavedAt: 5_000 });
    // 等满它给的时长之后再问
    expect(canvasSaveCooldownRemaining({ now: 5_300 + first, lastSavedAt: 5_000 })).toBe(0);
  });

  it('从未落过盘时立刻放行', () => {
    expect(canvasSaveCooldownRemaining({ now: 1_000, lastSavedAt: 0 })).toBe(0);
  });

  it('时钟回拨不算出负数或天文数字的等待', () => {
    expect(canvasSaveCooldownRemaining({ now: 1_000, lastSavedAt: 9_999 })).toBe(0);
    expect(canvasSaveCooldownRemaining({ now: Number.NaN, lastSavedAt: 5_000 })).toBeGreaterThanOrEqual(0);
  });

  it('冷却时长可配，且负值不会把等待算成负数', () => {
    expect(canvasSaveCooldownRemaining({ now: 100, lastSavedAt: 50, cooldownMs: 200 })).toBe(150);
    expect(canvasSaveCooldownRemaining({ now: 100, lastSavedAt: 50, cooldownMs: -5 })).toBe(0);
  });
});
