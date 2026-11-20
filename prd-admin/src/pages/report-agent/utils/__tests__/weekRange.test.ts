import { describe, expect, it } from 'vitest';
import { getPreviousIsoWeek, resolveDefaultSubmissionWeek } from '../weekRange';

/** 以 UTC+8 书写时间，换算成绝对时刻。 */
function china(y: number, m: number, d: number, h: number, min: number, s = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h - 8, min, s));
}

describe('getPreviousIsoWeek', () => {
  it('普通周减一', () => {
    expect(getPreviousIsoWeek({ weekYear: 2026, weekNumber: 48 })).toEqual({ weekYear: 2026, weekNumber: 47 });
  });

  it('跨年回到 53 周年的 W53（2026 有 53 周），而不是写死的 W52', () => {
    expect(getPreviousIsoWeek({ weekYear: 2027, weekNumber: 1 })).toEqual({ weekYear: 2026, weekNumber: 53 });
  });

  it('跨年回到 52 周年的 W52', () => {
    expect(getPreviousIsoWeek({ weekYear: 2026, weekNumber: 1 })).toEqual({ weekYear: 2025, weekNumber: 52 });
  });
});

describe('resolveDefaultSubmissionWeek（与后端同口径：最近一个尚未截止的周）', () => {
  it.each([
    ['周一凌晨（UTC 仍是周日）', china(2026, 11, 23, 0, 30), { weekYear: 2026, weekNumber: 47 }],
    ['周一上午', china(2026, 11, 23, 10, 0), { weekYear: 2026, weekNumber: 47 }],
    ['周一 23:59:59', china(2026, 11, 23, 23, 59, 59), { weekYear: 2026, weekNumber: 47 }],
    ['恰好截止时刻（周二 00:00）', china(2026, 11, 24, 0, 0, 0), { weekYear: 2026, weekNumber: 47 }],
    ['截止后一秒', china(2026, 11, 24, 0, 0, 1), { weekYear: 2026, weekNumber: 48 }],
    ['周五提前写本周', china(2026, 11, 27, 16, 0), { weekYear: 2026, weekNumber: 48 }],
    ['周日晚上', china(2026, 11, 29, 22, 0), { weekYear: 2026, weekNumber: 48 }],
    ['跨年周一', china(2027, 1, 4, 10, 0), { weekYear: 2026, weekNumber: 53 }],
    ['跨年周二', china(2027, 1, 5, 9, 0), { weekYear: 2027, weekNumber: 1 }],
  ])('%s', (_label, now, expected) => {
    expect(resolveDefaultSubmissionWeek(now)).toEqual(expected);
  });

  it('生效周之前的上一周按旧口径已截止，落回本周', () => {
    // 2026-11-09 是 W46 周一，上一周 W45 用旧的周日截止
    expect(resolveDefaultSubmissionWeek(china(2026, 11, 9, 10, 0))).toEqual({ weekYear: 2026, weekNumber: 46 });
  });
});
