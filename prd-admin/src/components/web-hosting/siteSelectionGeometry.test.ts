import { describe, expect, it } from 'vitest';
import { crossesSelection, overlapsSelection, paintSelection, selectionBounds } from './siteSelectionGeometry';

describe('网页批量选择几何与状态', () => {
  it('反方向拖框得到同一片区域，接触边缘不误选相邻卡片', () => {
    const bounds = selectionBounds({ x: 70, y: 80 }, { x: 10, y: 20 });
    expect(bounds).toEqual({ left: 10, top: 20, right: 70, bottom: 80 });
    expect(overlapsSelection(bounds, { left: 30, top: 30, right: 40, bottom: 40 })).toBe(true);
    expect(overlapsSelection(bounds, { left: 70, top: 30, right: 90, bottom: 50 })).toBe(false);
  });
  it('快速横向滑选不会漏掉事件采样点之间的卡片', () => {
    expect(crossesSelection({ x: 0, y: 40 }, { x: 300, y: 40 }, { left: 100, top: 10, right: 200, bottom: 80 })).toBe(true);
  });
  it('斜向滑过只选线段实际穿过的卡片', () => {
    expect(crossesSelection({ x: 0, y: 0 }, { x: 300, y: 300 }, { left: 250, top: 10, right: 290, bottom: 60 })).toBe(false);
    expect(crossesSelection({ x: 0, y: 0 }, { x: 300, y: 300 }, { left: 100, top: 110, right: 200, bottom: 180 })).toBe(true);
  });
  it('追加和滑动取消保留不经过的已选项，并且不修改操作快照', () => {
    const base = new Set(['a', 'b']);
    expect([...paintSelection(base, ['b', 'c'], true)]).toEqual(['a', 'b', 'c']);
    expect([...paintSelection(base, ['b', 'c'], false)]).toEqual(['a']);
    expect([...base]).toEqual(['a', 'b']);
  });
});
