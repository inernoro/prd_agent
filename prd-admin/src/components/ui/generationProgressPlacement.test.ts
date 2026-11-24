import { describe, expect, it } from 'vitest';
import { generationProgressMetaStyle, generationProgressPlacement } from './generationProgressPlacement';

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

describe('generationProgressMetaStyle：屏幕像素定位换算成卡片上的世界像素 style', () => {
  const viewport = { left: 0, top: 0, right: 1440, bottom: 830 };

  it('2026-09-14 稳定冒烟复现：1001 世界像素方图 0.5 倍下，底边一行必须整体落在画框内', () => {
    const zoom = 0.5;
    const world = 1001;
    const node = { left: 0, top: 0, right: world * zoom, bottom: world * zoom };
    const placement = generationProgressPlacement(node, viewport, 44)!;
    expect(placement).not.toBeNull();

    const style = generationProgressMetaStyle(placement, zoom);
    // 修复前宿主把中心点当左缘：left = 250.25 / 0.5 ≈ 500，右缘落到 1181 世界像素（屏幕 590.75）。
    expect(style.left).toBeGreaterThanOrEqual(0);
    expect(style.left + style.width).toBeLessThanOrEqual(world);
    // 屏幕像素口径同样成立：右缘不许超过卡片右缘 501。
    expect((style.left + style.width) * zoom).toBeLessThanOrEqual(node.right + 1);
    // 仍然居中，不是靠贴左边缘蒙混过关。
    expect(Math.abs((style.left + style.width / 2) * zoom - world * zoom / 2)).toBeLessThan(1);
  });

  it.each([0.25, 1, 2])('%s 倍下 left 是左缘、width 与 bottom 按同一比例换算', (zoom) => {
    const size = 1024 * zoom;
    const node = { left: 300, top: 100, right: 300 + size, bottom: 100 + size };
    const placement = generationProgressPlacement(node, viewport, 44)!;
    const style = generationProgressMetaStyle(placement, zoom);
    expect(style.width).toBeCloseTo(placement.width / zoom, 6);
    expect(style.bottom).toBeCloseTo(placement.bottom / zoom, 6);
    expect(style.left).toBeCloseTo((placement.left - placement.width / 2) / zoom, 6);
    expect(style.left).toBeGreaterThanOrEqual(0);
    expect((style.left + style.width) * zoom).toBeLessThanOrEqual(size + 1e-6);
  });

  it('scale 非法时退回 1，不产生 Infinity 或 NaN', () => {
    const style = generationProgressMetaStyle({ left: 200, bottom: 40, width: 340 }, 0);
    expect(style).toEqual({ left: 30, bottom: 40, width: 340 });
  });
});
