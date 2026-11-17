import { describe, expect, it } from 'vitest';
import { CLOSED_LID, eyeControlPoints, samplePortrait, structureVisibility, materialFront, PORTRAIT_DURATION } from './portraitTimeline';
const midpoint = (points: readonly number[]) => (points[0] + 3 * points[1] + 3 * points[2] + points[3]) / 8;
describe('角色成形的阶段与眼睑几何', () => {
  it('白场退去时已有线条，闭眼材质与品牌先于睁眼建立', () => {
    expect(samplePortrait(.25).line).toBeGreaterThan(0);
    expect(samplePortrait(1.1)).toMatchObject({ material: 0, eye: 0, brand: 0, chrome: 0 });
    expect(samplePortrait(1.5).line).toBe(1);
    expect(samplePortrait(1.5).grid).toBe(1);
    expect(samplePortrait(2.7)).toMatchObject({ material: 1, eye: 0, chrome: 0, grid: 0 });
    expect(samplePortrait(2.7).brand).toBeGreaterThan(0);
    expect(samplePortrait(3.55).eye).toBeCloseTo(.5);
    expect(samplePortrait(3.55).brandFill).toBeGreaterThan(0);
    expect(samplePortrait(4.25).eye).toBe(1);
    expect(samplePortrait(4.25).chrome).toBeGreaterThan(0);
    expect(samplePortrait(4.25).welcome).toBe(0);
    expect(samplePortrait(PORTRAIT_DURATION)).toMatchObject({ eye: 1, chrome: 1, welcome: 1, brandFill: 1, grid: 0, lineOpacity: 0 });
  });
  it('同一材质前沿逐点清退结构，已成形处不继续叠网格，未成形处仍有结构', () => {
    for (let exposure = .2; exposure <= .8; exposure += .1) {
      const front = materialFront(exposure);
      expect(structureVisibility(front - 50, exposure)).toBe(0);
      expect(structureVisibility(front + 60, exposure)).toBe(1);
      let previous = 0;
      for (let y = front - 42; y <= front + 48; y += 1) {
        const value = structureVisibility(y, exposure);
        expect(value).toBeGreaterThanOrEqual(previous);
        expect(value - previous).toBeLessThan(.02);
        previous = value;
      }
    }
    for (let y = 0; y <= 941; y += 20) {
      expect(structureVisibility(y, 0)).toBe(1);
      expect(structureVisibility(y, 1)).toBe(0);
    }
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
    const half = eyeControlPoints(.5);
    expect(midpoint(CLOSED_LID) - midpoint(half.upper)).toBeGreaterThan(3 * (midpoint(half.lower) - midpoint(CLOSED_LID)));
    expect(eyeControlPoints(1).upper).toEqual([441,350,347,443]);
    expect(eyeControlPoints(1).lower).toEqual([441,550,510,443]);
  });
  it('操作区先就绪，品牌与睁眼并行，导航随后轻入，问候最后接棒', () => {
    expect(samplePortrait(1).controls).toBe(1);
    expect(samplePortrait(1).brand).toBe(0);
    expect(samplePortrait(3.6).brandFill).toBeGreaterThan(0);
    expect(samplePortrait(3.6).chrome).toBe(0);
    expect(samplePortrait(4.6).chrome).toBe(1);
    expect(samplePortrait(4.6).welcome).toBeGreaterThan(0);
  });
});
