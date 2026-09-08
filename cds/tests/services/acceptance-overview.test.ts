/**
 * 验收主页聚合的行为守卫（2026-09-08，验收报告主页重做 · 方向 A）。
 *
 * 每条断言对应一条规则：
 *  - 标题合同解析（§4.1.2）
 *  - 同一目标只计最新版（debt.acceptance-center-cds「分母失真」）
 *  - 产品失败与验收失败分开（§7.0），uncovered 不翻译成不通过（§7.1）
 *  - 同根因合并 + 口径冲突单列（conclusion-before-numbers §三）
 *  - 合并记录 × 报告元数据 = 合并未验
 */
import { describe, it, expect } from 'vitest';
import type { AcceptanceReportMeta, BranchTombstone } from '../../src/types.js';
import { buildReportsOverview, foldReportVersions, localDateOf, parseReportTitle } from '../../src/services/acceptance-overview.js';

let seq = 0;
function report(partial: Partial<AcceptanceReportMeta> & { title: string; createdAt: string }): AcceptanceReportMeta {
  seq += 1;
  return {
    id: partial.id ?? `r${seq}`,
    format: 'md',
    sizeBytes: 1,
    projectId: 'proj',
    updatedAt: partial.createdAt,
    ...partial,
  };
}

const TO = new Date('2026-09-07T00:00:00Z');

describe('parseReportTitle', () => {
  it('解析九类前缀标题合同，未知前缀归其他', () => {
    expect(parseReportTitle('功能验收 · 开放平台 / 授权表主题 · 2026-07-23')).toEqual({ kind: '功能验收', target: '开放平台 / 授权表主题', targetDate: '2026-07-23' });
    expect(parseReportTitle('PR验收 · #1227 / 授权表主题 · 2026-07-23').kind).toBe('PR验收');
    expect(parseReportTitle('随手写的标题')).toEqual({ kind: '其他', target: '随手写的标题', targetDate: null });
  });
});

describe('foldReportVersions', () => {
  it('同一（项目 · 前缀 · 对象 · 目标日）只保留最新一版，早期版本记入 supersedes', () => {
    const a = report({ id: 'a', title: '功能验收 · 冒烟 · 2026-09-01', createdAt: '2026-09-01T10:00:00Z', verdict: 'fail' });
    const b = report({ id: 'b', title: '功能验收 · 冒烟 · 2026-09-01', createdAt: '2026-09-01T12:00:00Z', verdict: 'conditional' });
    const c = report({ id: 'c', title: '功能验收 · 冒烟 · 2026-09-02', createdAt: '2026-09-02T12:00:00Z', verdict: 'pass' });
    const { latest, folded } = foldReportVersions([a, b, c]);
    expect(folded).toBe(1);
    const cluster = latest.find((r) => r.id === 'b');
    expect(cluster?.version).toBe(2);
    expect(cluster?.supersedes).toEqual(['a']);
    expect(latest.map((r) => r.id)).toEqual(['c', 'b']);
  });
});

describe('buildReportsOverview', () => {
  it('通过率分母只计最新版，被取代的版本不进分母', () => {
    const reports = [
      report({ title: '功能验收 · 冒烟 · 2026-09-01', createdAt: '2026-09-01T10:00:00Z', verdict: 'fail', defectCounts: { p0: 1 } }),
      report({ title: '功能验收 · 冒烟 · 2026-09-01', createdAt: '2026-09-01T12:00:00Z', verdict: 'fail', defectCounts: { p0: 1 } }),
      report({ title: '功能验收 · 冒烟 · 2026-09-01', createdAt: '2026-09-01T14:00:00Z', verdict: 'pass' }),
      report({ title: '功能验收 · 登录 · 2026-09-02', createdAt: '2026-09-02T10:00:00Z', verdict: 'pass' }),
    ];
    const o = buildReportsOverview(reports, [], { to: TO, days: 7 });
    expect(o.totals.archived).toBe(4);
    expect(o.totals.folded).toBe(2);
    expect(o.totals.counted).toBe(2);
    expect(o.passRate).toMatchObject({ kind: '功能验收', numerator: 2, denominator: 2, rate: 1 });
    expect(o.headline.status).toBe('ok');
    expect(o.headline.statusLabel).toBe('可以正常使用');
  });

  it('存在带 P0/P1 的未通过 → 有功能坏了；同根因合并进一行并算连续时间窗', () => {
    const reports = [
      report({ title: '功能验收 · 核心业务稳定冒烟 · 2026-08-25', createdAt: '2026-08-25T10:00:00Z', verdict: 'fail', defectCounts: { p0: 1 } }),
      report({ title: '功能验收 · 核心业务稳定冒烟 · 2026-09-01', createdAt: '2026-09-01T10:00:00Z', verdict: 'fail', defectCounts: { p0: 1, p2: 3 } }),
      report({ title: '发布验收 · 核心业务稳定冒烟 · 2026-09-04', createdAt: '2026-09-04T10:00:00Z', verdict: 'fail', defectCounts: { p0: 1, p1: 2 } }),
      report({ title: '视觉回归 · 四个入口 · 2026-09-04', createdAt: '2026-09-04T11:00:00Z', verdict: 'fail', defectCounts: { p1: 1 } }),
      report({ title: '每日验收 · 全量变更 · 2026-09-05', createdAt: '2026-09-05T02:00:00Z', verdict: 'conditional', defectCounts: { p2: 2 } }),
    ];
    const o = buildReportsOverview(reports, [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('broken');
    expect(o.headline.sentence).toContain('3 份未通过里有 2 份指向同一处：核心业务稳定冒烟');
    expect(o.headline.sentence).toContain('连续第 2 个时间窗');
    const top = o.clusters[0];
    expect(top).toMatchObject({ verdict: 'fail', target: '核心业务稳定冒烟', count: 2, streakWindows: 2 });
    expect(top.kinds).toEqual(['发布验收', '功能验收']);
    expect(top.defectCounts).toEqual({ p0: 2, p1: 2, p2: 3 });
    expect(o.clusters.map((c) => c.verdict)).toEqual(['fail', 'fail', 'conditional']);
    // 发布闸：最近一次发布验收未通过 → 红。
    expect(o.releaseGate.state).toBe('blocked');
    expect(o.releaseGate.reason).toContain('阻断缺陷 3 个');
    expect(o.headline.supports.some((s) => s.kind === 'decision')).toBe(true);
  });

  it('未通过但缺陷计数全零 → 验收链路失败，写「这次没测出来」而不是「有功能坏了」', () => {
    const o = buildReportsOverview([
      report({ title: '每日验收 · 全量变更 · 2026-09-05', createdAt: '2026-09-05T02:00:00Z', verdict: 'fail', defectCounts: { p0: 0, p1: 0 } }),
    ], [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('untested');
    expect(o.headline.statusLabel).toBe('这次没测出来');
  });

  it('同一对象同一目标日既有未通过又有有条件 → 口径冲突单列', () => {
    const o = buildReportsOverview([
      report({ title: '缺陷复测 · 分享页锚点 · 2026-09-02', createdAt: '2026-09-02T10:00:00Z', verdict: 'fail', defectCounts: { p1: 1 } }),
      report({ id: 'x', title: '缺陷复测 · 分享页锚点 / 正文问答 · 2026-09-02', createdAt: '2026-09-02T11:00:00Z', verdict: 'conditional' }),
      report({ title: '缺陷复测 · 分享页锚点 · 2026-09-02', createdAt: '2026-09-02T09:00:00Z', verdict: 'conditional', projectId: 'other' }),
    ], [], { to: TO, days: 7 });
    // 不同对象名不会被强行合并；同对象跨项目也不合并。
    expect(o.clusters.map((c) => `${c.projectId}:${c.target}:${c.verdict}`)).toEqual([
      'proj:分享页锚点:fail',
      'proj:分享页锚点 / 正文问答:conditional',
      'other:分享页锚点:conditional',
    ]);
    const conflict = buildReportsOverview([
      report({ title: '缺陷复测 · 分享页锚点 · 2026-09-02', createdAt: '2026-09-02T10:00:00Z', verdict: 'fail', defectCounts: { p1: 1 } }),
      report({ title: '功能验收 · 分享页锚点 · 2026-09-02', createdAt: '2026-09-02T11:00:00Z', verdict: 'conditional' }),
    ], [], { to: TO, days: 7 });
    expect(conflict.clusters[0].verdict).toBe('conflict');
  });

  it('每日验收连续性按调用方时区落日，无报告的天 worst 为 null', () => {
    const o = buildReportsOverview([
      report({ title: '每日验收 · 全量变更 · 2026-09-05', createdAt: '2026-09-05T18:30:00Z', verdict: 'conditional' }),
      report({ title: '每日验收 · 昨日变更 · 2026-09-05', createdAt: '2026-09-05T19:30:00Z', verdict: 'fail', defectCounts: { p1: 1 } }),
    ], [], { to: TO, days: 7, dailyDays: 3, tzOffsetMinutes: -480 });
    // 窗口终点 09-07T00:00Z 在东八区已是 09-07 08:00，所以最后一天是 09-07。
    expect(o.daily.map((d) => d.date)).toEqual(['2026-09-05', '2026-09-06', '2026-09-07']);
    // 18:30Z 在东八区是 09-06 02:30 → 落在 09-06。
    expect(o.daily[1]).toMatchObject({ date: '2026-09-06', worst: 'fail' });
    expect(o.daily[1].reports).toHaveLength(2);
    expect(o.daily[0]).toMatchObject({ date: '2026-09-05', worst: null, reports: [] });
    expect(localDateOf('2026-09-05T18:30:00Z', -480)).toBe('2026-09-06');
  });

  it('合并记录 × 报告元数据：按 PR 号、合并 SHA 或分支名匹配，零命中就是零验收', () => {
    const tomb = (t: Partial<BranchTombstone> & { branch: string; removedAt: string }): BranchTombstone => ({
      previewSlug: t.branch, projectId: 'proj', reason: 'merged', ...t,
    });
    const o = buildReportsOverview([
      report({ title: 'PR验收 · #1493 / 接入台 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', prNumber: 1493 }),
      report({ title: '功能验收 · 数据库隔离 · 2026-09-04', createdAt: '2026-09-04T10:00:00Z', verdict: 'fail', defectCounts: { p1: 1 }, commitSha: '5f0a2b8d' }),
      report({ title: '分支验收 · 授权健康中心 · 2026-09-01', createdAt: '2026-09-01T10:00:00Z', verdict: 'conditional', branch: 'feat/auth-health' }),
    ], [
      tomb({ branch: 'feat/agent-hub', prNumber: 1493, removedAt: '2026-09-05T12:00:00Z' }),
      tomb({ branch: 'feat/db-isolation', mergeCommitSha: '5f0a2b8d1234567890', removedAt: '2026-09-05T13:00:00Z' }),
      tomb({ branch: 'feat/auth-health', removedAt: '2026-09-05T14:00:00Z' }),
      tomb({ branch: 'feat/identity', prNumber: 1478, removedAt: '2026-09-02T14:00:00Z' }),
      tomb({ branch: 'feat/old', prNumber: 1400, removedAt: '2026-08-20T14:00:00Z' }),
      tomb({ branch: 'feat/closed', reason: 'abandoned', removedAt: '2026-09-05T14:00:00Z' }),
    ], { to: TO, days: 7 });
    expect(o.mergeCoverage.counts).toEqual({ verified: 1, failed: 1, conditional: 1, unverified: 1 });
    expect(o.mergeCoverage.items.map((i) => [i.branch, i.status])).toEqual([
      ['feat/auth-health', 'conditional'],
      ['feat/db-isolation', 'failed'],
      ['feat/agent-hub', 'verified'],
      ['feat/identity', 'unverified'],
    ]);
    const coverage = o.headline.supports.find((s) => s.kind === 'coverage');
    expect(coverage?.text).toContain('4 条分支里 1 条零验收');
    expect(coverage?.text).toContain('证据空白，不是产品缺陷');
  });

  it('窗口内没有报告 → 这次没测出来，发布闸未知', () => {
    const o = buildReportsOverview([], [], { to: TO, days: 7 });
    expect(o.headline.status).toBe('untested');
    expect(o.releaseGate.state).toBe('unknown');
    expect(o.totals.counted).toBe(0);
    expect(o.passRate.rate).toBeNull();
  });
});
