/**
 * Codex review（PR #1532）第七轮里两条 A 类（第三条判 B，见 doc/debt.cds.md）。
 *
 * 一条是「结论说了一半」：支撑点最多留三条，凑够四条时被切掉的正好是
 * 「有几个项目查不到」那句，于是「查得到的范围里没有不安全的合并」被读成
 * 「全场没有」——一句假的保证，而且它一定出现在最该谨慎的那一屏。
 * 一条是下钻没复位文件夹筛选，点进一个项目却看到空台账。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPipelineHeadline } from '../../web/src/lib/pipelineHeadline';
import type { PipelineOverview, PipelineProjectRow } from '../../web/src/lib/api';

const page = readFileSync(resolve(__dirname, '../..', 'web/src/pages/ReportsPage.tsx'), 'utf8');

const row = (id: string, githubLinked: boolean, leaks = 0): PipelineProjectRow => ({
  projectId: id, projectName: id, githubLinked,
  funnel: { changes: 10, deployed: 9, accepted: 3, merged: 0, pass: 2, conditional: 0, fail: 1, undetermined: 0 },
  leaks: {
    'merged-not-accepted': 0, 'merged-while-failing': 0,
    'deployed-not-accepted': leaks, 'report-missing-change-key': 0,
  },
  missingKinds: [], staleReports: 0, inFlight: 0, lastActivityAt: null,
} as unknown as PipelineProjectRow);

/** 四条支撑点同时成立的那种输入：多项目 + 有普通漏 + 验过的里有未通过 + 有项目没接 GitHub。 */
function fourPointOverview(): PipelineOverview {
  return {
    generatedAt: '2026-09-15T00:00:00.000Z', recentDays: null,
    total: {
      changes: 20, deployed: 18, accepted: 6, merged: 0,
      pass: 3, conditional: 1, fail: 2, undetermined: 0,
    },
    totalLeaks: {
      'merged-not-accepted': 0, 'merged-while-failing': 0,
      'deployed-not-accepted': 4, 'report-missing-change-key': 2,
    },
    // p1 带漏点，支撑句 1「最集中的是谁」才会成立——四条支撑点同时在场，
    // 才真正复现「slice(0, 3) 切掉最后那句」的场景。行数据不带漏点的话
    // 只凑得出三条，这条用例就测不到它以为在测的东西。
    projects: [row('p1', true, 4), row('p2', true), row('p3', false), row('p4', false)],
    staleReports: 0,
    leaks: [
      { kind: 'deployed-not-accepted', subject: 'feat/a', projectId: 'p1', reportIds: [] },
      { kind: 'deployed-not-accepted', subject: 'feat/b', projectId: 'p1', reportIds: [] },
    ],
  } as unknown as PipelineOverview;
}

describe('结论不许只说一半：「没有不安全合并」与「有几个查不到」必须同生共死', () => {
  const h = buildPipelineHeadline(fourPointOverview());

  it('这组输入确实凑满了截断线（否则下面那条什么都没测到）', () => {
    expect(h.points).toHaveLength(3);
    expect(h.points[0], '支撑句 1 没成立，四条凑不满，截断根本不会发生').toContain('最集中的是');
  });

  it('只要说了「没有不安全的合并」，同一屏必须看得到「有几个项目查不到」', () => {
    const said = h.points.join(' ');
    const claimsClean = said.includes('没验就合并');
    expect(claimsClean, '这组输入本来就该给出那句「没有」').toBe(true);
    expect(said, '说了「没有」却没说有几个项目查不到，这是一句假的保证')
      .toMatch(/没接[^，。]*查不到|查不到/);
    expect(said).toContain('2 个项目没接');
  });

  it('两句合成一句，所以被截断也切不开它们', () => {
    const merged = h.points.filter((s) => s.includes('没验就合并'));
    expect(merged).toHaveLength(1);
    expect(merged[0], '还是两条独立的支撑句，截断随时能把后一条切掉').toContain('查不到');
  });

  it('全都接了 GitHub 时不许凭空多出「查不到」那半句', () => {
    const o = fourPointOverview();
    o.projects = [row('p1', true, 4), row('p2', true)];
    const said = buildPipelineHeadline(o).points.join(' ');
    expect(said).toContain('没验就合并');
    expect(said, '没有项目缺 GitHub，却说有').not.toContain('查不到');
  });

  it('一个都没接 GitHub 时只说查不到，不说「没有」', () => {
    const o = fourPointOverview();
    o.projects = [row('p1', false, 4), row('p2', false)];
    const said = buildPipelineHeadline(o).points.join(' ');
    expect(said, '一条都查不到却宣称没有不安全的合并').not.toContain('没验就合并');
    expect(said).toContain('查不到');
  });

  it('句子里没有修辞标点（沿用既有约定）', () => {
    for (const s of h.points) expect(s, s).not.toMatch(/——|？|！/);
  });
});

describe('下钻到项目要复位文件夹筛选', () => {
  it('onOpenProject 走 handleProjectFilterChange，不是直接设筛选值', () => {
    // 直接 setActiveProjectFilter 的话，读者手上若停着另一个项目的文件夹，
    // 下钻过去台账是空的——而他刚点的就是那个项目。
    expect(page, 'onOpenProject 还在直接设 activeProjectFilter')
      .not.toMatch(/onOpenProject=\{\(pid\) => setActiveProjectFilter\(pid\)\}/);
    expect(page).toMatch(/onOpenProject=\{handleProjectFilterChange\}/);
  });

  it('那条路真的会复位非系统视图的文件夹', () => {
    const fn = page.slice(page.indexOf('const handleProjectFilterChange'), page.indexOf('const handleSelectReport'));
    expect(fn).toMatch(/setActiveFolder\(\(current\) => \(isReportSystemView\(current\) \? current : 'all'\)\)/);
  });
});
