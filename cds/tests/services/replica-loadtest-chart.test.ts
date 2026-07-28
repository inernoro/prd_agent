/**
 * 压测面板的展示计算回归。
 *
 * 图表画错不会让编译失败，只会让用户拿着一张错的曲线去下结论——比不画更坏。
 * 这里钉住三处最容易出事的边界：空序列（不许画假线）、单点（不许消失）、
 * 超出上界（不许溢出画布）。
 */
import { describe, expect, it } from 'vitest';
import {
  LOADTEST_LINE_COLORS,
  describeErrors,
  formatEta,
  lineColor,
  polylinePoints,
} from '../../web/src/lib/loadtestChart.js';

describe('压测曲线点串', () => {
  it('空序列返回空串——调用方据此渲染「正在采集第一个采样点」而不是一条假线', () => {
    expect(polylinePoints([], 100, 50, 10)).toBe('');
  });

  it('单点画成一条水平线，一秒钟的采样也看得见', () => {
    expect(polylinePoints([5], 100, 50, 10)).toBe('0,25 100,25');
  });

  it('按最大值归一：最高点贴顶，0 值贴底', () => {
    expect(polylinePoints([0, 10], 100, 50, 10)).toBe('0,50 100,0');
  });

  it('max 为 0（还没有任何吞吐）时不除零，全部贴底', () => {
    expect(polylinePoints([0, 0, 0], 100, 50, 0)).toBe('0,50 50,50 100,50');
  });

  it('超过上界的值夹到顶，不溢出画布', () => {
    expect(polylinePoints([999], 100, 50, 10)).toBe('0,0 100,0');
  });

  it('线条配色在索引越界/负数时安全回绕，且不含红与琥珀（红=错误、黄=草稿）', () => {
    expect(lineColor(0)).toBe(LOADTEST_LINE_COLORS[0]);
    expect(lineColor(LOADTEST_LINE_COLORS.length)).toBe(LOADTEST_LINE_COLORS[0]);
    expect(lineColor(-1)).toBe(LOADTEST_LINE_COLORS[1]);
    expect(LOADTEST_LINE_COLORS.some((c) => /^#(ef|dc|f5|f9|fb|d9)/i.test(c))).toBe(false);
  });
});

describe('等待期文案（禁止空白等待）', () => {
  it('跑动中同时给出已耗时与预计剩余', () => {
    expect(formatEta(7, 13, 'running')).toBe('已跑 7s · 预计还需 13s');
  });

  it('结束后只报总耗时', () => {
    expect(formatEta(20, 0, 'done')).toBe('总耗时 20s');
    expect(formatEta(6, 14, 'cancelled')).toBe('总耗时 6s');
  });

  it('负数被夹到 0，不出现「预计还需 -3s」这种吓人文案', () => {
    expect(formatEta(-1, -3, 'running')).toBe('已跑 0s · 预计还需 0s');
  });
});

describe('错误分类文案', () => {
  it('全 0 时明说「无」，不留一排 0 让人自己数', () => {
    expect(describeErrors({ timeout: 0, connect: 0, http5xx: 0, http4xx: 0, cancelled: 0, other: 0 })).toBe('无');
    expect(describeErrors(undefined)).toBe('无');
  });

  it('只列出真的发生了的错误类别，用中文', () => {
    expect(describeErrors({ timeout: 2, connect: 0, http5xx: 5, http4xx: 0, cancelled: 0, other: 0 }))
      .toBe('超时 2 · 5xx 5');
  });
});
