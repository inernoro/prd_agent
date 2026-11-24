/*
 * 守卫：响应曲线的画布必须与元素逐像素同比。
 *
 * 事故形态（2026-09-10 用户反馈第 2、4 条）：viewBox 写死 640×180，元素是
 * `w-full h-44`（宽随容器、高 176px）。两者宽高比不等，浏览器按默认的
 * preserveAspectRatio 把图缩放居中 —— 图只占容器中间一段（「只画了一半」），
 * 且鼠标换算按整宽做，竖线与指针差了一个留白宽度（「差两公分」）。
 *
 * 红绿闭环：把 chartBox 改回返回固定 640，第 1 条用例立刻红。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CHART_FALLBACK_HEIGHT_PX,
  CHART_FALLBACK_WIDTH_PX,
  CHART_MIN_WIDTH_PX,
  chartBox,
  pointerViewBoxX,
} from '../../web/src/lib/latencyChartGeometry.js';

describe('响应曲线画布几何', () => {
  it('viewBox 宽高比恒等于元素像素宽高比，缩放系数为 1', () => {
    // 第二个数是 h-44 在不同根字号下的真实解析值：100% → 176，85% → 149.6。
    for (const [width, height] of [[320, 176], [625, 176], [800, 149.6], [1024, 149.6], [1440, 176]]) {
      const box = chartBox(width, height);
      // 两个比值必须相等，否则 preserveAspectRatio 会留白并把坐标系整体挪走。
      expect(box.w / box.h).toBeCloseTo(width / height, 9);
    }
  });

  it('高度也实测 —— 85% 根字号下不会退回一个写死的 176', () => {
    expect(chartBox(900, 149.6).h).toBe(149.6);
    expect(chartBox(900, 176).h).toBe(176);
  });

  it('绘图区随容器变宽而变宽 —— 不是画在一个固定的 640 画布里', () => {
    expect(chartBox(1200, 176).plotW).toBeGreaterThan(chartBox(700, 176).plotW);
    expect(chartBox(1200, 176).w).toBe(1200);
  });

  it('元素还没布局出来时用兜底画布，不会算出负的绘图区', () => {
    expect(chartBox(0, 0).w).toBe(CHART_FALLBACK_WIDTH_PX);
    expect(chartBox(Number.NaN, Number.NaN).h).toBe(CHART_FALLBACK_HEIGHT_PX);
    expect(chartBox(80, 20).plotW).toBeGreaterThan(0);
    expect(chartBox(80, 20).plotH).toBeGreaterThan(0);
    expect(chartBox(80, 20).w).toBe(CHART_MIN_WIDTH_PX);
  });

  it('缩放系数为 1 时，鼠标横坐标就是 viewBox 横坐标', () => {
    const box = chartBox(900, 176);
    // 元素左边缘在视口 120px 处，鼠标在 420px → 距左 300px。
    expect(pointerViewBoxX(420, 120, box.w, box.w)).toBeCloseTo(300, 6);
  });

  it('页面缩放导致 rect 宽与 viewBox 宽不等时按比例换算', () => {
    // 元素被浏览器缩放到 450px 宽，viewBox 仍是 900：中点应落在 450。
    expect(pointerViewBoxX(225, 0, 450, 900)).toBeCloseTo(450, 6);
  });

  it('rect 宽为 0（元素还没布局）时给 0，不产出 NaN 让竖线飞走', () => {
    expect(pointerViewBoxX(300, 0, 0, 900)).toBe(0);
  });

  it('LatencyChart 真的用了实测宽度，没有把 640 抄回去', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'web/src/pages/status/LatencyChart.tsx'),
      'utf8',
    );
    expect(src).toContain('chartBox(');
    expect(src).toContain('pointerViewBoxX(');
    expect(src).toContain('ResizeObserver');
    // 曾经的写死画布不许复活：W / H 必须来自 chartBox，而不是文件顶部的常数。
    expect(src).not.toMatch(/const\s+W\s*=\s*\d+/);
    expect(src).not.toMatch(/const\s+H\s*=\s*\d+/);
    expect(src).toMatch(/const\s+W\s*=\s*box\.w/);
    expect(src).toMatch(/const\s+H\s*=\s*box\.h/);
  });
});
