/**
 * 首页那句判断的守卫（2026-09-10）。
 *
 * 用户看完上一版首页说「我看不懂」——根因是只有计数没有结论。这组断言钉住的就是
 * conclusion-before-numbers.md 的三条自律：句子必须挂真实数字、严重的先说、
 * 说不出结论时不许拿空话凑（「整体表现良好」放到任何团队都成立，等于没说）。
 */
import { describe, it, expect } from 'vitest';
import { buildPipelineHeadline } from '../../web/src/lib/pipelineHeadline.js';
import type { PipelineOverview, PipelineProjectRow, LeakKind } from '../../web/src/lib/api.js';

function leaks(partial: Partial<Record<LeakKind, number>> = {}): Record<LeakKind, number> {
  return {
    'merged-not-accepted': 0, 'merged-while-failing': 0,
    'deployed-not-accepted': 0, 'report-missing-change-key': 0, ...partial,
  };
}
function row(name: string, extra: Partial<PipelineProjectRow> = {}): PipelineProjectRow {
  return {
    projectId: name, projectName: name,
    funnel: { changes: 0, deployed: 0, accepted: 0, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 },
    leaks: leaks(), missingKinds: [], staleReports: 0, inFlight: 0,
    lastActivityAt: null, githubLinked: true, ...extra,
  };
}
function overview(partial: Partial<PipelineOverview> = {}): PipelineOverview {
  return {
    generatedAt: '2026-09-10T00:00:00Z', recentDays: null,
    total: { changes: 0, deployed: 0, accepted: 0, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 },
    totalLeaks: leaks(), projects: [], staleReports: 0, leaks: [], ...partial,
  };
}

describe('buildPipelineHeadline', () => {
  it('最危险的先说：没验就合并压过部署了没验', () => {
    const h = buildPipelineHeadline(overview({
      total: { changes: 9, deployed: 9, accepted: 2, merged: 3, pass: 2, conditional: 0, fail: 0, undetermined: 0 },
      totalLeaks: leaks({ 'merged-not-accepted': 2, 'deployed-not-accepted': 5 }),
      leaks: [
        { kind: 'merged-not-accepted', subject: 'feat/a', projectId: 'p1', reportIds: [] },
        { kind: 'deployed-not-accepted', subject: 'feat/b', projectId: 'p1', reportIds: [] },
      ],
      projects: [row('p1', { leaks: leaks({ 'merged-not-accepted': 2, 'deployed-not-accepted': 5 }) })],
    }));
    expect(h.tone).toBe('bad');
    expect(h.sentence).toBe('2 条改动一次验收都没做，已经进了主干');
    // 下一步必须指到具体分支，不许写「请关注」
    expect(h.action).toBe('补验：feat/a');
  });

  it('判断句必须挂真实数字，不许出现放到任何团队都成立的空话', () => {
    const cases = [
      overview({ total: { changes: 5, deployed: 4, accepted: 1, merged: 0, pass: 0, conditional: 1, fail: 0, undetermined: 0 }, totalLeaks: leaks({ 'deployed-not-accepted': 3 }) }),
      overview({ total: { changes: 3, deployed: 3, accepted: 3, merged: 0, pass: 3, conditional: 0, fail: 0, undetermined: 0 }, projects: [row('p1')] }),
      overview({ totalLeaks: leaks({ 'merged-while-failing': 1 }) }),
    ];
    for (const c of cases) {
      const h = buildPipelineHeadline(c);
      expect(h.sentence, h.sentence).toMatch(/\d/);
      for (const bad of ['整体表现良好', '情况正常', '请关注', '总体可控']) {
        expect(h.sentence).not.toContain(bad);
        expect(h.points.join('|')).not.toContain(bad);
      }
    }
  });

  it('全验过就说全验过，不硬造问题', () => {
    const h = buildPipelineHeadline(overview({
      total: { changes: 4, deployed: 4, accepted: 4, merged: 0, pass: 4, conditional: 0, fail: 0, undetermined: 0 },
      projects: [row('p1', { funnel: { changes: 4, deployed: 4, accepted: 4, merged: 0, pass: 4, conditional: 0, fail: 0, undetermined: 0 } })],
    }));
    expect(h.tone).toBe('ok');
    expect(h.sentence).toBe('4 条在改的分支都验过了');
    expect(h.action).toBeNull();
  });

  it('一条改动都没有时不编判断', () => {
    const h = buildPipelineHeadline(overview());
    expect(h.sentence).toBe('现在没有在改的分支');
    expect(h.points).toEqual([]);
  });

  it('说「没有没验就合并」的前提是查得到；查不到必须同句点明', () => {
    const linked = buildPipelineHeadline(overview({
      total: { changes: 2, deployed: 2, accepted: 2, merged: 1, pass: 2, conditional: 0, fail: 0, undetermined: 0 },
      projects: [row('p1')],
    }));
    expect(linked.points).toContain('没有「没验就合并」或「没过还合并」的情况');

    const unlinked = buildPipelineHeadline(overview({
      total: { changes: 2, deployed: 2, accepted: 2, merged: 0, pass: 2, conditional: 0, fail: 0, undetermined: 0 },
      projects: [row('p1', { githubLinked: false })],
    }));
    // 没接 GitHub 的项目根本查不到合并，绝不能让读者把「没有」读成保证
    expect(unlinked.points.join('|')).not.toContain('没有「没验就合并」');
    expect(unlinked.points.join('|')).toContain('查不到');
  });

  it('只有一个项目时不说「最集中的是它」——那是废话', () => {
    const one = buildPipelineHeadline(overview({
      total: { changes: 5, deployed: 4, accepted: 1, merged: 0, pass: 0, conditional: 1, fail: 0, undetermined: 0 },
      totalLeaks: leaks({ 'deployed-not-accepted': 3 }),
      projects: [row('演示项目', { leaks: leaks({ 'deployed-not-accepted': 3 }) })],
    }));
    expect(one.points.join('|')).not.toContain('最集中');

    const many = buildPipelineHeadline(overview({
      total: { changes: 9, deployed: 8, accepted: 1, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 },
      totalLeaks: leaks({ 'deployed-not-accepted': 7 }),
      projects: [
        row('甲', { leaks: leaks({ 'deployed-not-accepted': 5 }) }),
        row('乙', { leaks: leaks({ 'deployed-not-accepted': 2 }) }),
      ],
    }));
    expect(many.points[0]).toBe('最集中的是「甲」，占 5 条');
  });

  it('结论构成只在有未通过或原则性通过时才说，全通过不占位置', () => {
    const mixed = buildPipelineHeadline(overview({
      total: { changes: 6, deployed: 6, accepted: 4, merged: 0, pass: 1, conditional: 2, fail: 1, undetermined: 0 },
      totalLeaks: leaks({ 'deployed-not-accepted': 2 }),
      projects: [row('p1', { leaks: leaks({ 'deployed-not-accepted': 2 }) })],
    }));
    expect(mixed.points.join('|')).toContain('验过的 4 条里，未通过 1 条、原则性通过 2 条');

    const allPass = buildPipelineHeadline(overview({
      total: { changes: 6, deployed: 6, accepted: 4, merged: 0, pass: 4, conditional: 0, fail: 0, undetermined: 0 },
      totalLeaks: leaks({ 'deployed-not-accepted': 2 }),
      projects: [row('p1', { leaks: leaks({ 'deployed-not-accepted': 2 }) })],
    }));
    expect(allPass.points.join('|')).not.toContain('验过的');
  });
});
