import { describe, expect, it } from 'vitest';
import { generationProgressPlacement } from './generationProgressPlacement';

describe('生成进度条可见区域定位', () => {
  const viewport = { left: 0, top: 0, right: 1440, bottom: 830 };
  it.each([0.25, 0.3, 0.66, 1, 1.31, 2])('方图 %s 倍仍完整处于可见交集', (zoom) => {
    const size = 1024 * zoom;
    const node = { left: 720 - size / 2, right: 720 + size / 2, top: 415 - size / 2, bottom: 415 + size / 2 };
    const result = generationProgressPlacement(node, viewport, 44)!;
    expect(result).not.toBeNull();
    expect(node.left + result.left - result.width / 2).toBeGreaterThanOrEqual(Math.max(node.left, viewport.left) + 12);
    expect(node.left + result.left + result.width / 2).toBeLessThanOrEqual(Math.min(node.right, viewport.right) - 12);
    expect(node.bottom - result.bottom).toBeLessThanOrEqual(Math.min(node.bottom, viewport.bottom) - 12);
    expect(node.bottom - result.bottom - 44).toBeGreaterThanOrEqual(Math.max(node.top, viewport.top) + 12);
  });
  it.each([[1536, 1024], [1024, 1536], [2048, 512], [512, 2048]])('横竖图 %s×%s 平移后保持可读', (w, h) => {
    const node = { left: -w / 3, top: -h / 3, right: w * 2 / 3, bottom: h * 2 / 3 };
    const result = generationProgressPlacement(node, viewport, 44)!;
    expect(result).not.toBeNull();
    expect(node.left + result.left - result.width / 2).toBeGreaterThanOrEqual(12 - 1e-6);
    expect(node.bottom - result.bottom).toBeLessThanOrEqual(viewport.bottom - 12);
    expect(result.width).toBeGreaterThanOrEqual(176);
  });
  it.each([
    { left: 1500, top: 0, right: 2000, bottom: 500 },
    { left: 0, top: -1000, right: 500, bottom: -1 },
    { left: 0, top: 0, right: 199, bottom: 500 },
    { left: 0, top: 720, right: 500, bottom: 1500 },
  ])('移出视口或可见区域过小时不叠加标签', (node) => {
    expect(generationProgressPlacement(node, viewport, 44)).toBeNull();
  });
  it('正常完整卡片维持原来的底部位置', () => {
    expect(generationProgressPlacement({ left: 100, top: 100, right: 500, bottom: 500 }, viewport, 44))
      .toEqual({ left: 200, bottom: 40, width: 340 });
  });
});
