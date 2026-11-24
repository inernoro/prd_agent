/**
 * Codex review（PR #1532）第五轮的前端一条：7 日均的开头六天并不是 7 日均。
 *
 * 钉的是「先滚再裁」这个顺序。反过来（或者压根没有预热段）图照画、数照出，
 * 只有左边缘那一小截是假的——正是这一类最难被验收看出来的坏法。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { layerScale, rolling } from '../../web/src/pages/reports/TrendCharts';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/TrendCharts.tsx'), 'utf8');
const WIN = 7;

/** 面板里那个 roll 的等价实现，用来说明「先滚再裁」与「直接滚」差在哪。 */
const rollWith = (head: number[], xs: number[]): number[] =>
  rolling([...head, ...xs], WIN).slice(head.length);

describe('滚动均值必须在含预热段的完整序列上算', () => {
  it('窗口之前有活动时，头几天的均值与「直接滚」不同', () => {
    const head = [4, 4, 4, 4, 4, 4];          // 窗口前六天每天 4 件
    const body = [0, 0, 0, 0, 0, 0, 0, 0];    // 窗口内一件都没有
    const withWarm = rollWith(head, body);
    const without = rolling(body, WIN);

    // 没有预热段：第一天就是 0，图上看起来「一直都没有活动」。
    expect(without[0]).toBe(0);
    // 有预热段：第一天是 24/7，读者看得到那一波刚刚过去。
    expect(withWarm[0]).toBeCloseTo(24 / 7, 6);
    expect(withWarm).toHaveLength(body.length);
  });

  it('预热段为空时退回旧行为，不崩也不变形', () => {
    const body = [1, 2, 3];
    expect(rollWith([], body)).toEqual(rolling(body, WIN));
  });

  it('预热段比窗口长时也只裁掉预热段那么多', () => {
    const head = new Array(20).fill(1);
    const body = [5, 5];
    expect(rollWith(head, body)).toHaveLength(2);
  });
});

describe('接线：滚动只在面板算一次，Chart 只管画', () => {
  it('面板里有且只有一处 rolling 入口（roll），其余都走它', () => {
    const panel = src.slice(src.indexOf('export function TrendCharts('));
    expect(panel, 'roll 不在了，说明滚动又散回各处').toMatch(/const roll = \(head: number\[\] \| undefined, xs: number\[\]\)/);
    expect(panel).toMatch(/rolling\(\[\.\.\.h, \.\.\.xs\], WIN\)\.slice\(h\.length\)/);
    // 面板里除了 roll 自己那一处，不许再直接调 rolling。
    expect([...panel.matchAll(/\brolling\(/g)]).toHaveLength(1);
  });

  it('Chart 与 layerScale 都不再自己滚——滚了就等于绕过了预热段', () => {
    const chart = src.slice(src.indexOf('function Chart('), src.indexOf('export function TrendCharts('));
    expect(chart).not.toMatch(/\brolling\(/);
    const scale = src.slice(src.indexOf('export function layerScale('), src.indexOf('function Chart('));
    expect(scale).not.toMatch(/\brolling\(/);
  });

  it('layerScale 直接收已滚好的层，紧凑态取 roll、放大态取 raw', () => {
    const line = { raw: [0, 0, 9, 0], roll: [1, 1, 1, 1] };
    const bars = { raw: [0, 0, 20, 0], roll: [2, 2, 2, 2] };
    expect(layerScale([line], bars, false).barVals).toEqual(bars.roll);
    expect(layerScale([line], bars, true).barVals).toEqual(bars.raw);
    // 紧凑态不许被当日峰值撑高刻度（那是放大态的事）。
    expect(layerScale([line], bars, false).max).toBeLessThan(layerScale([line], bars, true).max);
  });
});
