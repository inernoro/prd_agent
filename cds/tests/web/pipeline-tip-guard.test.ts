/**
 * 首页悬浮提示的守卫（2026-09-14 随 B 稿重写）。
 *
 * 图上一格就是一条改动，可是光看图不知道它是什么——内容都在悬浮提示里。
 * 这条链路的坏法是 predicate-and-wiring-discipline 形状 2：某一类图形忘了挂
 * data-tip，或者委托没接上 / 提示框没渲染。页面照常、类型照常、测试照绿，
 * 只是鼠标放上去什么都没有。
 *
 * 上一版还守着「箱子按位置取分支名，对不上就一个都不绑」（heapTipsOf）。
 * 厂房换成紧凑条之后一格不再代表一条具体改动，那个函数连同它防的「指鹿为马」
 * 一起没了——不是放松判据，是那种错法不存在了。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { projectTip, tip } from '../../web/src/pages/reports/PipelinePanel';
import type { PipelineFunnel, PipelineProjectRow } from '../../web/src/lib/api';

const read = (p: string): string => readFileSync(resolve(__dirname, '../..', p), 'utf8');
const panel = read('web/src/pages/reports/PipelinePanel.tsx');
const strip = read('web/src/pages/reports/CompactStrip.tsx');

function funnel(p: Partial<PipelineFunnel>): PipelineFunnel {
  return {
    changes: 0, deployed: 0, accepted: 0, merged: 0,
    pass: 0, conditional: 0, fail: 0, undetermined: 0, ...p,
  };
}

function row(p: Partial<PipelineProjectRow>): PipelineProjectRow {
  return {
    projectId: 'p1', projectName: '演示项目', funnel: funnel({}),
    leaks: { 'deployed-not-accepted': 0, 'merged-not-accepted': 0, 'merged-while-failing': 0, 'report-missing-change-key': 0 },
    missingKinds: [], staleReports: 0, inFlight: 0, lastActivityAt: null, githubLinked: true, ...p,
  };
}

describe('项目条的悬浮内容：图上放不下的都要在这里说清', () => {
  it('带上图上没有的那几项', () => {
    const t = projectTip(row({
      projectName: 'BDE(互动营销)',
      funnel: funnel({ changes: 32, deployed: 31, accepted: 0 }),
      lastActivityAt: '2026-09-09T10:00:00.000Z',
    }));
    expect(t).toContain('BDE(互动营销)');
    expect(t).toContain('32');
    expect(t).toContain('31');
    expect(t).toContain('一条都没验过');
    expect(t).toContain('2026-09-09');
    expect(t).toContain('点击进入该项目');
  });

  it('未接 GitHub 要说明「合并这一环查不到」，不能让人读成「没有合并」', () => {
    expect(projectTip(row({ githubLinked: false }))).toContain('未接 GitHub');
    expect(projectTip(row({ githubLinked: true }))).not.toContain('未接 GitHub');
  });

  it('有结论时列三档，没有结论时不硬凑一行 0 · 0 · 0', () => {
    expect(projectTip(row({ funnel: funnel({ changes: 7, accepted: 3, pass: 1, fail: 2 }) }))).toContain('通过 1');
    expect(projectTip(row({ funnel: funnel({ changes: 7 }) }))).toContain('一条都没验过');
  });

  it('tip 会丢掉空行，不产生空白行', () => {
    expect(tip('甲', '', null, false, '乙')).toBe('甲\n乙');
  });
});

describe('接线：委托与提示框都要在', () => {
  it('委托的三个事件与提示框都接在面板上', () => {
    expect(panel).toMatch(/onMouseOver/);
    expect(panel).toMatch(/onMouseMove/);
    expect(panel).toMatch(/onMouseOut/);
    expect(panel).toMatch(/\{\.\.\.handlers\}/);
    expect(panel).toMatch(/tipState \? <TipBox state=\{tipState\} \/> : null/);
  });

  it('委托靠 closest 往上找，挂在子元素上的提示也读得到', () => {
    // 只读 e.target 自己的 data-tip 的话，鼠标压在内层 span 上就什么都没有。
    expect(panel).toMatch(/closest\('\[data-tip\]'\)/);
  });
});

describe('接线：每一类图形都挂得上提示', () => {
  // 五个分区各自代表一种读法，少一个就有一整块「悬浮上去没反应」。
  const zones: Array<[string, RegExp]> = [
    ['总量', /className="z z-total"[\s\S]{0,120}?data-tip=/],
    ['三段', /<div className="stage" data-tip=\{hint\}>/],
    ['结论三行', /className="vrow"[\s\S]{0,80}?data-tip=/],
    ['项目条', /data-tip=\{projectTip\(p\)\}/],
  ];
  it.each(zones)('%s 挂了 data-tip', (_name, re) => {
    expect(strip).toMatch(re);
  });

  it('报告那两行一个都不许漏', () => {
    // 「有一处挂上了」是个太松的判据：两行里坏掉一行照样绿（红绿验证时实测过）。
    // 所以逐个数，每一处 srow 都得在自己那段里带上 data-tip。
    const rows = [...strip.matchAll(/className="srow"/g)];
    expect(rows.length, '报告区的行不见了').toBeGreaterThanOrEqual(2);
    for (const m of rows) {
      const window = strip.slice(m.index!, m.index! + 240);
      expect(window, `这一行没挂 data-tip：${strip.slice(m.index!, m.index! + 60)}`).toMatch(/data-tip=/);
    }
  });

  it('三段的调用处都传了提示，没有漏掉哪一段', () => {
    const stages = [...strip.matchAll(/<Stage\b[\s\S]{0,400}?\/>/g)].map((m) => m[0]);
    expect(stages.length).toBe(3);
    // 只查「有没有 hint=」拦不住占位的空串（TS 只管必填，不管填的是什么），
    // 所以要求它真的带上这一段的条数。
    for (const s of stages) {
      expect(s, `这一段没传 hint：${s.slice(0, 60)}`).toMatch(/hint=\{`/);
      expect(s, `这一段的提示没说清有多少条：${s.slice(0, 60)}`).toMatch(/条/);
    }
  });

  it('放大态的项目行也挂了同一份提示，不是另写一套', () => {
    const expanded = strip.slice(strip.indexOf('export function ExpandedPanel'));
    expect(expanded).toMatch(/data-tip=\{projectTip\(p\)\}/);
  });

  it('没有留下只重复图上已有文字的原生 title', () => {
    expect(strip).not.toMatch(/title=\{p\.projectName\}/);
  });
});
