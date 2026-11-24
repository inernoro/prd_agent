import { describe, expect, it } from 'vitest';

import { computePlanTotals, describeTotal } from '../planTotals';

describe('对照表表头的合计', () => {
  it('全部已知时就是直接求和', () => {
    const t = computePlanTotals([
      { sourceTotal: 10, localTotal: 3 },
      { sourceTotal: 5, localTotal: 0 },
    ]);
    expect(t).toEqual({ sourceTotal: 15, localTotal: 3, sourceUnknown: 0, localUnknown: 0 });
  });

  it('未知的那些不进合计，只记个数', () => {
    // 源站没报第二个集合（sourceTotal=-1），本站不认识第三个（localTotal=-1）。
    const t = computePlanTotals([
      { sourceTotal: 10, localTotal: 3 },
      { sourceTotal: -1, localTotal: 0 },
      { sourceTotal: 7, localTotal: -1 },
    ]);
    expect(t.sourceTotal).toBe(17);
    expect(t.sourceUnknown).toBe(1);
    expect(t.localTotal).toBe(3);
    expect(t.localUnknown).toBe(1);
  });

  it('未知比已知多时合计不会变成负数', () => {
    // 这是原实现最难看的一种：三个未知加一个 2 条，表头会显示 -1 条。
    const t = computePlanTotals([
      { sourceTotal: -1, localTotal: -1 },
      { sourceTotal: -1, localTotal: -1 },
      { sourceTotal: -1, localTotal: -1 },
      { sourceTotal: 2, localTotal: 2 },
    ]);
    expect(t.sourceTotal).toBe(2);
    expect(t.localTotal).toBe(2);
    expect(t.sourceUnknown).toBe(3);
  });

  it('负数一律当未知，不只挡 -1', () => {
    const t = computePlanTotals([{ sourceTotal: -99, localTotal: -2 }]);
    expect(t).toEqual({ sourceTotal: 0, localTotal: 0, sourceUnknown: 1, localUnknown: 1 });
  });

  it('有未知时文案必须说出来，不能给一个看着确定的数', () => {
    expect(describeTotal(17, 0)).toBe('17 条');
    expect(describeTotal(17, 2)).toBe('17 条（另有 2 个集合数量未知）');
  });
});

describe('合计判据接在对照表上', () => {
  it('页面用共享判据，没有把裸求和写回去', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../DataSyncPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('computePlanTotals(plan.rows)');
    expect(source).toContain('describeTotal(totals.sourceTotal, totals.sourceUnknown)');
    // 裸求和不许回来：它会把 -1 哨兵当成真实条数。
    expect(source).not.toContain('reduce((s, r) => s + r.sourceTotal, 0)');
    expect(source).not.toContain('reduce((s, r) => s + r.localTotal, 0)');
  });
});
