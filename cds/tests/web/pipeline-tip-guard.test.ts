/**
 * 首页厂房悬浮提示的守卫（2026-09-11）。
 *
 * 图上一只箱子就是一条改动，可是光看图不知道是哪一条——这一版把内容放进悬浮提示。
 * 两种坏法要防，都不会报错：
 *
 * 1. **指鹿为马**：箱子按位置去取分支名，两边条数一旦对不上（聚合口径变了、
 *    某一类漏点被拆开），剩下的箱子会静默错位，悬浮上去显示的是别人的分支。
 *    这比没有提示更糟，所以对不上时必须一个都不绑。
 * 2. **只建一半**：某一类实体忘了挂 data-tip，或者委托没接上 / 提示框没渲染。
 *    页面照常、测试照绿，只是鼠标放上去什么都没有——正是
 *    predicate-and-wiring-discipline 形状 2。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { heapTipsOf, projectTip, tip } from '../../web/src/pages/reports/PipelinePanel';
import type { PipelineFunnel, PipelineOverview, PipelineProjectRow } from '../../web/src/lib/api';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/PipelinePanel.tsx'), 'utf8');

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

function overview(changes: number, deployed: number, accepted: number, subjects: string[]): PipelineOverview {
  return {
    generatedAt: '2026-09-11T00:00:00.000Z',
    recentDays: null,
    total: funnel({ changes, deployed, accepted }),
    totalLeaks: { 'deployed-not-accepted': subjects.length, 'merged-not-accepted': 0, 'merged-while-failing': 0, 'report-missing-change-key': 0 },
    projects: [row({ projectId: 'prd-agent', projectName: 'MAP' })],
    staleReports: 0,
    leaks: subjects.map((s) => ({ kind: 'deployed-not-accepted' as const, subject: s, projectId: 'prd-agent', reportIds: [] })),
  };
}

describe('货箱的分支名：对得上才绑，对不上一个都不绑', () => {
  it('条数一致时每只箱子都拿到自己的分支名', () => {
    const tips = heapTipsOf(overview(3, 3, 1, ['feat/a', 'feat/b']));
    expect(tips).toHaveLength(2);
    expect(tips[0]).toContain('feat/a');
    expect(tips[0]).toContain('MAP');
    expect(tips[1]).toContain('feat/b');
  });

  it('条数对不上时返回空——宁可退回通用提示，也不能张冠李戴', () => {
    expect(heapTipsOf(overview(3, 3, 1, ['feat/a']))).toEqual([]);
    expect(heapTipsOf(overview(3, 3, 1, ['feat/a', 'feat/b', 'feat/c']))).toEqual([]);
  });

  it('项目 ID 找不到名字时退回 ID，不留空白', () => {
    const o = overview(2, 2, 1, ['feat/x']);
    o.leaks[0].projectId = '未登记的项目';
    expect(heapTipsOf(o)[0]).toContain('未登记的项目');
  });

  it('长分支名原样保留，不截断', () => {
    const long = 'codex/implement-finance-crm-workbench-customer-20260902';
    expect(heapTipsOf(overview(2, 2, 1, [long]))[0]).toContain(long);
  });
});

describe('项目垛的悬浮内容：图上放不下的都要在这里说清', () => {
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

describe('接线：每一类实体都要挂得上，委托与提示框都要在', () => {
  it('委托的三个事件与提示框都接在面板上', () => {
    expect(src).toMatch(/onMouseOver/);
    expect(src).toMatch(/onMouseMove/);
    expect(src).toMatch(/onMouseOut/);
    expect(src).toMatch(/\{\.\.\.handlers\}/);
    expect(src).toMatch(/tipState \? <TipBox state=\{tipState\} \/> : null/);
  });

  const anchors: Array<[string, string]> = [
    ['货堆的箱子', 'className="f-crate s-hairstrong pp-crate"'],
    ['掉下去的箱子', 'className="pp-fall"'],
    ['带面缺口', 'className="f-sunken s-hair"'],
    ['场外的点', 'className="f-hairstrong pp-dot"'],
  ];
  it.each(anchors)('%s 都带 data-tip', (_name, anchor) => {
    const re = new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const hits = [...src.matchAll(re)];
    expect(hits.length).toBeGreaterThan(0);
    for (const m of hits) {
      const window = src.slice(m.index!, m.index! + 420);
      expect(window, `这一处没挂 data-tip：${src.slice(Math.max(0, m.index! - 60), m.index! + 60)}`).toMatch(/data-tip=/);
    }
  });

  it('三道闸、料仓、项目垛都挂上了', () => {
    expect([...src.matchAll(/<g data-tip=\{hint\}>/g)].length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/<g key=\{label\} data-tip=\{hint\}>/);
    expect(src).toMatch(/data-tip=\{projectTip\(p\)\}/);
  });

  it('三道闸的调用处都传了提示，没有漏掉哪一道', () => {
    const gates = [...src.matchAll(/<Gate[HV]\b[\s\S]{0,300}?\/>/g)].map((m) => m[0]);
    expect(gates.length).toBe(6);
    // 只查「有没有 hint=」拦不住占位的空串（TS 只管必填，不管填的是什么），
    // 所以要求它真的由 tip() 构造且说清这是哪道闸。
    for (const g of gates) {
      expect(g, `这道闸没传 hint：${g.slice(0, 60)}`).toMatch(/hint=\{tip\(/);
      expect(g, `这道闸的提示没说清是哪一道：${g.slice(0, 60)}`).toMatch(/闸/);
    }
  });

  it('没有留下只重复图上已有文字的原生 title', () => {
    expect(src).not.toMatch(/<title>\{p\.projectName\}<\/title>/);
    expect(src).not.toMatch(/title=\{p\.projectName\}/);
  });
});
