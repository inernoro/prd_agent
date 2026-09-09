/**
 * 流水线总览的行为守卫（2026-09-09）。
 *
 * 每条断言对应一条需求：
 *  - 改动单元 = 在途分支 ∪ 最近撤下的分支，同名以在途为准
 *  - 环与环之间的落差就是「漏」，四种漏各自的判定（含「报告没记它验的是谁」）
 *  - 没接 GitHub 的项目查不到合并记录，不能算成漏
 *  - 报告先折叠再计数，重复归档不许把「验过」这一环撑大
 *  - 报告没记标识是真缺口；记了标识却对不上只是分支被回收，不许当漏喊
 */
import { describe, it, expect } from 'vitest';
import type { AcceptanceReportMeta, BranchEntry, BranchTombstone, Project } from '../../src/types.js';
import { buildPipelineOverview } from '../../src/services/acceptance-pipeline.js';

const NOW = new Date('2026-09-09T12:00:00Z');

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, slug: id, ...extra } as Project;
}
let bseq = 0;
function branch(projectId: string, name: string, extra: Partial<BranchEntry> = {}): BranchEntry {
  bseq += 1;
  return {
    id: `b${bseq}`, projectId, branch: name, services: {}, status: 'idle',
    createdAt: '2026-09-01T00:00:00Z', ...extra,
  } as BranchEntry;
}
function tomb(projectId: string, name: string, extra: Partial<BranchTombstone> = {}): BranchTombstone {
  return {
    previewSlug: `${projectId}-${name}`, branch: name, projectId, reason: 'merged',
    removedAt: '2026-09-08T00:00:00Z', ...extra,
  } as BranchTombstone;
}
let rseq = 0;
function report(partial: Partial<AcceptanceReportMeta> & { title: string; createdAt: string }): AcceptanceReportMeta {
  rseq += 1;
  return {
    id: `r${rseq}`, format: 'md', sizeBytes: 1, projectId: 'p1',
    updatedAt: partial.createdAt, ...partial,
  } as AcceptanceReportMeta;
}

describe('buildPipelineOverview', () => {
  it('改动单元是在途分支与最近撤下的分支的并集，同名只算一个', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [branch('p1', 'feat/a', { services: { web: {} as never } })],
      [tomb('p1', 'feat/a'), tomb('p1', 'feat/b')],
      [],
      { now: NOW },
    );
    expect(o.total.changes).toBe(2);
    // 同名的那条以在途为准，但墓碑带来的「已合并」要合上去
    expect(o.total.merged).toBe(2);
  });

  it('流转类的三种漏各自成立，且严重度排序是「合并了没验」最前', () => {
    const o = buildPipelineOverview(
      [project('p1', { githubRepoFullName: 'x/y' } as Partial<Project>)],
      [branch('p1', 'feat/deployed-only', { lastDeployAt: '2026-09-08T00:00:00Z' })],
      [
        tomb('p1', 'feat/merged-unverified', { prNumber: 11 }),
        tomb('p1', 'feat/merged-failing', { prNumber: 12 }),
      ],
      [
        report({ title: 'PR验收 · 结算 · 2026-09-08', createdAt: '2026-09-08T01:00:00Z', verdict: 'fail', prNumber: 12 }),
        report({ title: '功能验收 · 谁也不认识 · 2026-09-08', createdAt: '2026-09-08T02:00:00Z', verdict: 'pass', branch: 'feat/nowhere' }),
      ],
      { now: NOW },
    );
    expect(o.totalLeaks).toEqual({
      'deployed-not-accepted': 1,
      'merged-not-accepted': 1,
      'merged-while-failing': 1,
      'report-missing-change-key': 0,
    });
    // 那份「谁也不认识」的报告记了 branch，只是分支已回收——是背景数，不是漏
    expect(o.staleReports).toBe(1);
    expect(o.leaks.map((l) => l.kind)).toEqual([
      'merged-not-accepted', 'merged-while-failing', 'deployed-not-accepted',
    ]);
  });

  it('没接 GitHub 的项目标出来，好让读者知道「没有合并记录」不等于「没漏」', () => {
    const o = buildPipelineOverview([project('p1'), project('p2', { githubRepoFullName: 'x/y' } as Partial<Project>)], [], [], [], { now: NOW });
    const byId = new Map(o.projects.map((r) => [r.projectId, r]));
    expect(byId.get('p1')!.githubLinked).toBe(false);
    expect(byId.get('p2')!.githubLinked).toBe(true);
  });

  it('报告先折叠：同一目标归档三次只算验过一次，结论取最新那一版', () => {
    const three = ['2026-09-08T01:00:00Z', '2026-09-08T02:00:00Z', '2026-09-08T03:00:00Z'].map((t, i) =>
      report({ title: '功能验收 · 订单导出 · 2026-09-08', createdAt: t, verdict: i === 2 ? 'conditional' : 'fail', branch: 'feat/order' }));
    const o = buildPipelineOverview([project('p1')], [branch('p1', 'feat/order', { lastDeployAt: '2026-09-08T00:00:00Z' })], [], three, { now: NOW });
    expect(o.total.accepted).toBe(1);
    expect([o.total.pass, o.total.conditional, o.total.fail]).toEqual([0, 1, 0]);
    expect(o.totalLeaks['deployed-not-accepted']).toBe(0);
  });

  it('三把钥匙都对不上就是对不上，不许硬挂到某条分支上', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [branch('p1', 'feat/real', { githubPrNumber: 7, githubCommitSha: 'abc1234', lastDeployAt: '2026-09-08T00:00:00Z' })],
      [],
      [report({ title: '功能验收 · 别处 · 2026-09-08', createdAt: '2026-09-08T01:00:00Z', verdict: 'pass', prNumber: 999, commitSha: 'zzz9999', branch: 'feat/other' })],
      { now: NOW },
    );
    expect(o.total.accepted).toBe(0);
    // 不硬挂 = 这份报告不算「验过」；但它也不是漏，只是它验的分支不在了
    expect(o.staleReports).toBe(1);
    expect(o.totalLeaks['deployed-not-accepted']).toBe(1);
  });

  // 下面三条守同一件事：「对不上」不许一股脑喊成漏。
  // 主实例真实数据核过：153 份对不上的报告里 152 份点名的分支根本不在现存的 71 条分支里，
  // 全报成漏 = 首页喊一次狼，以后真的漏出现时没人再信。
  it('记了标识却对不上：它验的分支已被回收，算背景数不算漏', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [branch('p1', 'feat/live', { createdAt: '2026-09-05T00:00:00Z', lastDeployAt: '2026-09-08T00:00:00Z' })],
      [],
      [report({ title: '功能验收 · 半年前那条 · 2026-03-01', createdAt: '2026-03-01T00:00:00Z', verdict: 'pass', branch: 'feat/long-gone' })],
      { now: NOW },
    );
    expect(Object.values(o.totalLeaks).reduce((n, v) => n + v, 0)).toBe(1); // 只剩「部署了没人验」
    expect(o.staleReports).toBe(1);
    expect(o.projects[0].staleReports).toBe(1);
  });

  it('三个标识全空的报告是归档流程的真缺口，单独一档点名，不混进「对不上」', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [branch('p1', 'feat/live', { createdAt: '2026-09-05T00:00:00Z', lastDeployAt: '2026-09-08T00:00:00Z' })],
      [],
      [report({ title: '功能验收 · 没记标识 · 2026-03-01', createdAt: '2026-03-01T00:00:00Z', verdict: 'pass' })],
      { now: NOW },
    );
    // 没标识是流程缺口，不是「分支被回收」能解释的，照样点名
    expect(o.totalLeaks['report-missing-change-key']).toBe(1);
    expect(o.staleReports).toBe(0);
  });

  it('项目一条改动都没有时，整批报告全是背景数，不许喊成漏', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [],
      [],
      [
        report({ title: '功能验收 · 甲 · 2026-09-08', createdAt: '2026-09-08T01:00:00Z', verdict: 'pass', branch: 'feat/a' }),
        report({ title: '功能验收 · 乙 · 2026-09-08', createdAt: '2026-09-08T02:00:00Z', verdict: 'pass', branch: 'feat/b' }),
      ],
      { now: NOW },
    );
    expect(Object.values(o.totalLeaks).reduce((n, v) => n + v, 0)).toBe(0);
    expect(o.staleReports).toBe(2);
  });

  it('recentDays 只筛「最近完成」，不影响在途改动', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [branch('p1', 'feat/live', { lastDeployAt: '2026-09-08T00:00:00Z' })],
      [tomb('p1', 'feat/old', { removedAt: '2026-06-01T00:00:00Z' })],
      [],
      { now: NOW, recentDays: 7 },
    );
    expect(o.total.changes).toBe(1);
    expect(o.total.merged).toBe(0);
  });

  it('九类前缀里一次都没跑过的要点名', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [],
      [],
      [report({ title: 'PR验收 · 结算 · 2026-09-08', createdAt: '2026-09-08T01:00:00Z', verdict: 'pass', branch: 'x' })],
      { now: NOW },
    );
    expect(o.projects[0].missingKinds).toContain('缺陷复测');
    expect(o.projects[0].missingKinds).toContain('规范演练');
    expect(o.projects[0].missingKinds).not.toContain('PR验收');
  });

  it('不给通过率——只给三档计数（分母失真且规范未定义）', () => {
    const o = buildPipelineOverview([project('p1')], [], [], [], { now: NOW });
    expect(Object.keys(o.total)).toEqual(['changes', 'deployed', 'accepted', 'merged', 'pass', 'conditional', 'fail', 'undetermined']);
    expect(JSON.stringify(o)).not.toContain('passRate');
  });
});
