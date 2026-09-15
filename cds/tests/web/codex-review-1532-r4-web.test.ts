/**
 * Codex review（PR #1532）第四轮的前端一条：台账空把整块流水线一起吞了。
 *
 * 一份报告都没有的时候，「有几条改动在跑、几条部署了还没验」恰恰是最该被看见的一句，
 * 而那个 early return 让这一屏变成一张「还没有报告」的空卡片。
 * 顺带钉住走向图对「柱子会随分支回收变矮」的照实说明——算不出来的不画，
 * 但也不能不说（no-rootless-tree）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const page = read('web/src/pages/ReportsPage.tsx');
const trends = read('web/src/pages/reports/TrendCharts.tsx');

describe('台账空 ≠ 整页空', () => {
  it('整页让位给空状态的条件里，带上了「流水线也没东西可讲」', () => {
    expect(page, 'allReports 为空就直接 return 空状态，流水线被一起吞掉')
      .toMatch(/if \(allReports\.length === 0 && !pipelineHasSomething\)/);
  });

  it('「有东西可讲」的判据是首页作用域 + 流水线加载成功 + 真有改动', () => {
    const block = page.slice(page.indexOf('const pipelineHasSomething'), page.indexOf('if (allReports.length === 0'));
    expect(block).toContain('isGlobalScope');
    expect(block).toContain("pipelineState.status === 'ok'");
    expect(block).toMatch(/pipeline\.total\.changes > 0/);
  });

  it('台账那一格自己说清是「一份都没有」还是「被筛掉了」，并给出下一步', () => {
    // 两者的下一步完全不同：前者要新建，后者要清筛选。压成一句等于什么都没说。
    const cell = page.slice(page.indexOf('{pageRows.length === 0 ? ('), page.indexOf('{pageRows.length === 0 ? (') + 900);
    expect(cell).toContain('还没有归档任何验收报告');
    expect(cell).toContain('当前筛选下没有报告');
    expect(cell).toMatch(/onClick=\{onCreate\}/);
  });
});

describe('算不出来的不画，但必须说', () => {
  it('走向图照实说明「新开改动」的柱子会随分支回收而变矮', () => {
    expect(trends).toContain('柱子会随分支回收而变矮');
    expect(trends, '要说清为什么：墓碑不记当初建于哪一天').toContain('不记当初建于哪一天');
  });

  it('没有拿墓碑的撤下时刻冒充改动开启时刻', () => {
    // 那样柱子是满的，但画的是「什么时候撤下的」，比缺一段更糟。
    expect(trends).not.toMatch(/removedAt/);
  });
});
