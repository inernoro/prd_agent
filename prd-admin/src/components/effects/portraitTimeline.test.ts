import { describe, expect, it } from 'vitest';
import { CLOSED_LID, eyeControlPoints, samplePortrait } from './portraitTimeline';
const midpoint = (points: readonly number[]) => (points[0] + 3 * points[1] + 3 * points[2] + points[3]) / 8;
describe('角色成形的阶段与眼睑几何', () => {
  it('线稿和网格建立时不提前暴露实体或虹膜，材质完成后才睁眼', () => {
    expect(samplePortrait(1.4)).toMatchObject({ material: 0, eye: 0, brand: 0, chrome: 0 });
    expect(samplePortrait(2.1).line).toBe(1);
    expect(samplePortrait(2.1).grid).toBeGreaterThan(.5);
    expect(samplePortrait(4)).toMatchObject({ material: 1, eye: 0, brand: 0, chrome: 0 });
    expect(samplePortrait(5.25).eye).toBeCloseTo(.5);
    expect(samplePortrait(6.1).eye).toBe(1);
    expect(samplePortrait(6.1).brandFill).toBeGreaterThan(0);
    expect(samplePortrait(6.1).chrome).toBe(0);
    expect(samplePortrait(7.2)).toMatchObject({ eye: 1, chrome: 1, brandFill: 1, grid: 0, lineOpacity: 0 });
  });
  it('闭眼上下缘重合；101 个开度的实际控制点连续张开，眼角固定', () => {
    expect(eyeControlPoints(0)).toEqual({ upper: [...CLOSED_LID], lower: [...CLOSED_LID] });
    let previousGap = 0;
    for (let index = 0; index <= 100; index++) {
      const { upper, lower } = eyeControlPoints(index / 100);
      const gap = midpoint(lower) - midpoint(upper);
      expect(gap).toBeGreaterThanOrEqual(previousGap);
      expect(gap - previousGap).toBeLessThan(2);
      expect([upper[0], upper[3], lower[0], lower[3]]).toEqual([441, 443, 441, 443]);
      previousGap = gap;
    }
    expect(previousGap).toBeGreaterThan(120);
  });
  it('操作区先就绪，品牌填充和导航在角色之后出现', () => {
    expect(samplePortrait(1.8).controls).toBe(1);
    expect(samplePortrait(1.8).brand).toBe(0);
    expect(samplePortrait(5.4).brand).toBeGreaterThan(.9);
    expect(samplePortrait(5.4).brandFill).toBe(0);
  });
});
