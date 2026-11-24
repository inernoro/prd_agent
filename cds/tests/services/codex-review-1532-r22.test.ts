/**
 * Codex 第二十二轮（PR #1532，reviewed commit f01258ddf0）两条，仍然是同一个判据没接全。
 *
 * 这次不再逐个消费方补，而是把换算移到唯一的边界 `toRef`：
 * refs 一出生就带生效结论，计数、通过率、簇、日历、发布闸、跨项目流水线全都自动跟上。
 * 报告自己写的那个结论留在 `claimedVerdict` 里，只给「它自称通过」这类措辞用。
 */
import { describe, it, expect } from 'vitest';
import type { AcceptanceReportMeta, BranchEntry, BranchTombstone, Project } from '../../src/types.js';
import { buildReportsOverview, foldReportVersions } from '../../src/services/acceptance-overview.js';
import { buildPipelineOverview } from '../../src/services/acceptance-pipeline.js';

let seq = 0;
function report(partial: Partial<AcceptanceReportMeta> & { title: string; createdAt: string }): AcceptanceReportMeta {
  seq += 1;
  return { id: partial.id ?? `t${seq}`, format: 'md', sizeBytes: 1, projectId: 'proj', updatedAt: partial.createdAt, ...partial };
}
const TO = new Date('2026-09-07T00:00:00Z');

describe('换算只发生在边界，refs 出生即是生效结论', () => {
  it('标为通过但带 P0 的报告，ref 上的 verdict 是 fail，claimedVerdict 仍是 pass', () => {
    const { latest } = foldReportVersions([
      report({ title: '功能验收 · 甲 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p0: 1 } }),
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0].verdict, '生效结论没被压成 fail').toBe('fail');
    expect(latest[0].claimedVerdict, '报告自己写的结论丢了，措辞就说不出「标为通过」').toBe('pass');
  });

  it('干净的报告两个字段一致', () => {
    const { latest } = foldReportVersions([
      report({ title: '功能验收 · 乙 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p2: 9 } }),
    ]);
    expect(latest[0].verdict).toBe('pass');
    expect(latest[0].claimedVerdict).toBe('pass');
  });
});

describe('没写结论但记了阻断缺陷的发布验收，闸门不放行', () => {
  it('它不再被前置过滤丢掉，更早那份通过也撑不开闸门', () => {
    const o = buildReportsOverview([
      report({ title: '发布验收 · 主干 · 2026-09-06', createdAt: '2026-09-06T10:00:00Z', defectCounts: { p0: 1 } }),
      report({ title: '发布验收 · 主干 · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass' }),
    ], [], { to: TO, days: 7 });
    // 前置条件：最新那份确实没写结论，只有缺陷数。
    expect(o.releaseGate.latest?.claimedVerdict ?? null).toBeNull();
    expect(o.releaseGate.state).toBe('blocked');
    expect(o.releaseGate.reason).toContain('阻断缺陷 1 个');
  });
});

describe('跨项目流水线用同一份生效结论', () => {
  const branch = (b: Partial<BranchEntry>): BranchEntry => ({
    id: 'b1', branch: 'feat/x', projectId: 'proj', status: 'running',
    createdAt: '2026-09-01T00:00:00Z', ...b,
  } as BranchEntry);

  it('标为通过但带 P0 的报告合并后，算作「未通过仍进主干」', () => {
    const tomb: BranchTombstone = {
      branch: 'feat/x', projectId: 'proj', reason: 'merged',
      removedAt: '2026-09-06T00:00:00Z', createdAt: '2026-09-01T00:00:00Z',
    } as BranchTombstone;
    const out = buildPipelineOverview(
      [{ id: 'proj', name: '某项目' } as unknown as Project],
      [branch({ lastDeployAt: '2026-09-02T00:00:00Z' })],
      [tomb],
      [report({ title: '功能验收 · feat/x · 2026-09-05', createdAt: '2026-09-05T10:00:00Z', verdict: 'pass', defectCounts: { p0: 1 }, branch: 'feat/x' })],
      { now: TO, recentDays: 30 },
    );
    // 前置条件：这条改动确实被认成已合并，否则测的是别的分支。
    expect(out.total.merged).toBeGreaterThan(0);
    expect(out.total.fail, '流水线仍按报告自称的 pass 计数').toBeGreaterThan(0);
    expect(out.totalLeaks['merged-while-failing'], '带阻断缺陷的合并没被算成「未通过仍进主干」').toBeGreaterThan(0);
  });
});
