import { describe, expect, it } from 'vitest';
import { isoWeekNumber } from '../isoWeek';

/**
 * 跨年那几天是 ISO 周序唯一会出错的地方：朴素的「一年第几个 7 天」实现
 * 会把 2026-01-01（周四）算成第 1 周没问题，却会把 2027-01-01（周五）
 * 算成第 1 周 —— 实际它属于 2026 年的第 53 周。
 */
describe('isoWeekNumber', () => {
  it('普通日期返回所在 ISO 周', () => {
    expect(isoWeekNumber(new Date(2026, 7, 2))).toBe(31); // 2026-08-02 周日
    expect(isoWeekNumber(new Date(2026, 7, 3))).toBe(32); // 周一进入新的一周
  });

  it('周一为一周之始：同周的周一与周日属于同一周', () => {
    expect(isoWeekNumber(new Date(2026, 7, 3))).toBe(isoWeekNumber(new Date(2026, 7, 9)));
  });

  it('年初/年末按 ISO 归属，不按自然年切割', () => {
    // 2026-01-01 是周四 → 落在 2026 第 1 周
    expect(isoWeekNumber(new Date(2026, 0, 1))).toBe(1);
    // 2027-01-01 是周五 → 仍属于 2026 的最后一周（第 53 周）
    expect(isoWeekNumber(new Date(2027, 0, 1))).toBe(53);
    // 2023-01-01 是周日 → 属于 2022 的第 52 周
    expect(isoWeekNumber(new Date(2023, 0, 1))).toBe(52);
  });
});
