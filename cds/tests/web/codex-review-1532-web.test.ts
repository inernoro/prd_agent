/**
 * Codex review（PR #1532）前端三条的回归守卫。
 *
 * 共同点：三条都不会报错，页面照常渲染，只是数对不上账或者内容悄悄过期。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitFunnel, rowSplit } from '../../web/src/pages/reports/CompactStrip';
import { splitChanges } from '../../web/src/pages/reports/PipelinePanel';
import type { PipelineFunnel } from '../../web/src/lib/api';

const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8');

function funnel(p: Partial<PipelineFunnel>): PipelineFunnel {
  return {
    changes: 0, deployed: 0, accepted: 0, merged: 0,
    pass: 0, conditional: 0, fail: 0, undetermined: 0, ...p,
  };
}

describe('三段分流：脏数据下也必须恒等于 changes', () => {
  const dirty: Array<[string, PipelineFunnel]> = [
    ['验过的比部署的还多', funnel({ changes: 10, deployed: 2, accepted: 9 })],
    ['部署的比总数还多', funnel({ changes: 3, deployed: 9, accepted: 1 })],
    ['三个都超', funnel({ changes: 1, deployed: 5, accepted: 7 })],
    ['负数', funnel({ changes: -4, deployed: -2, accepted: -9 })],
    ['真实形状', funnel({ changes: 71, deployed: 70, accepted: 5 })],
    ['全零', funnel({})],
  ];

  it.each(dirty)('%s：三段相加等于 changes', (_name, f) => {
    const s = splitFunnel(f);
    expect(s.undeployed).toBeGreaterThanOrEqual(0);
    expect(s.heap).toBeGreaterThanOrEqual(0);
    expect(s.accepted).toBeGreaterThanOrEqual(0);
    expect(s.undeployed + s.heap + s.accepted).toBe(Math.max(0, f.changes));
  });

  it.each(dirty)('%s：总览与每行是同一个口径，不是两份实现', (_name, f) => {
    // 此前 splitChanges 只对每段各自 max(0,…)，rowSplit 逐级夹取，
    // 于是同一份数据在总览与明细里能给出不同的三段。
    expect(splitChanges(f)).toEqual(splitFunnel(f));
    expect(rowSplit(f)).toEqual(splitFunnel(f));
  });

  it('两处都只是转给同一个函数，没有各自再算一遍', () => {
    expect(read('web/src/pages/reports/PipelinePanel.tsx')).toMatch(/return splitFunnel\(f\);/);
    expect(read('web/src/pages/reports/CompactStrip.tsx')).toMatch(/return splitFunnel\(f\);/);
  });
});

describe('项目线：后端给多少画多少，不自己再截一刀', () => {
  const src = read('web/src/pages/reports/TrendCharts.tsx');

  it('不对 series.projects 做二次截断', () => {
    // 后端默认给 4 条并把第 5 名之后算进 otherProjects；前端再切成 3 条的话，
    // 第 4 名既没画线也不在「其余 N 个项目」里，图例与总数对不上账。
    expect(src, '又对 projects 切了一刀').not.toMatch(/series\.projects\.slice\(/);
    expect(src).toMatch(/series\.projects\.map\(/);
  });

  it('灰阶档位不够时有兜底，不会给出 undefined 的 class', () => {
    expect(src).toMatch(/GREY_CLS\[i\] \?\? GREY_CLS\[GREY_CLS\.length - 1\]/);
    expect(src).toMatch(/GREY_DASH\[i\] \?\? GREY_DASH\[GREY_DASH\.length - 1\]/);
  });
});

describe('报告增删之后，流水线要跟着重算', () => {
  const src = read('web/src/pages/ReportsPage.tsx');

  it('state 变化的那个 effect 同时刷新头条与流水线', () => {
    const block = src.slice(src.indexOf('// state 变化（新建 / 删除 / 移动报告）'));
    const effect = block.slice(0, block.indexOf('}, ['));
    expect(effect, '只刷了头条，漏斗与走向会停在旧数据上').toMatch(/loadOverview\(\)/);
    expect(effect).toMatch(/loadPipeline\(true\)/);
  });

  it('刷新走静默模式，不把已有内容打回 loading', () => {
    // 每次删报告整块图表闪一下再回来，比不刷新还难看。
    expect(src).toMatch(/if \(!quiet\) setPipelineState\(\{ status: 'loading' \}\)/);
  });

  it('静默刷新失败时保留原内容，不把一屏图换成一行报错', () => {
    expect(src).toMatch(/quiet && prev\.status === 'ok'/);
  });
});
