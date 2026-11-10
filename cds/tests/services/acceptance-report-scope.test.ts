import { describe, expect, it } from 'vitest';
import type { AcceptanceReportMeta, BranchEntry, Project } from '../../src/types.js';
import { buildReportsOverview } from '../../src/services/acceptance-overview.js';
import { buildPipelineOverview, buildPipelineSeries } from '../../src/services/acceptance-pipeline.js';

const now = new Date('2026-11-10T12:00:00Z');
const projects = [{ id: 'project', name: '项目' } as Project];
const branches = [{ id: 'branch', projectId: 'project', branch: 'feat/live', services: {},
  createdAt: '2026-11-09T00:00:00Z', lastDeployAt: '2026-11-09T01:00:00Z' } as BranchEntry];
function report(id: string, extra: Partial<AcceptanceReportMeta> = {}): AcceptanceReportMeta {
  return { id, projectId: 'project', title: id, format: 'md', sizeBytes: 1,
    createdAt: '2026-11-09T02:00:00Z', updatedAt: '2026-11-09T02:00:00Z', ...extra };
}
function aggregates(reports: AcceptanceReportMeta[]) {
  return {
    overview: buildReportsOverview(reports, [], { to: now, days: 7 }),
    pipeline: buildPipelineOverview(projects, branches, [], reports, { now }),
    series: buildPipelineSeries(projects, branches, reports, { now, days: 7 }),
  };
}

describe('运营监控报告与验收聚合分离', () => {
  it.each(['open', 'recovered', 'drill'] as const)('%s 监控报告既不制造漏项，也不能充当分支验收', state => {
    const ordinary = report('未归类的真实验收', { verdict: 'pass' });
    const review = report('代码审查报告 · 改动 · 2026-11-09', { reportType: 'code-review', verdict: 'fail' });
    const baseline = aggregates([ordinary, review]);
    const operational = ['branchless', 'matched'].map(id => report(id, {
      // Even an acceptance-looking title or a matching branch cannot turn an
      // operational snapshot into acceptance evidence.
      title: `功能验收 · ${id} · 2026-11-09`, verdict: 'fail', defectCounts: { p0: 1 },
      ...(id === 'matched' ? { branch: 'feat/live' } : {}),
      monitorEvent: { eventId: id, targetId: 'target', state, snapshots: [] },
    }));
    expect(aggregates([ordinary, review, ...operational])).toEqual(baseline);
    expect(baseline.pipeline.totalLeaks['report-missing-change-key']).toBe(1);
    expect(baseline.pipeline.totalLeaks['deployed-not-accepted']).toBe(1);
    expect(baseline.pipeline.total.accepted).toBe(0);
    expect(baseline.overview.totals.counted).toBe(1);
    expect(baseline.overview.reports.map(r => r.id)).toContain(review.id);
    expect(baseline.series.pass.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(baseline.series.fail.every(count => count === 0)).toBe(true);
  });

  it('只有无分支监控事件时，不产生验收归档质量告警或日序列', () => {
    const operational = report('监控告警', { monitorEvent: { eventId: 'incident', targetId: 'target', state: 'open', snapshots: [] } });
    const pipeline = buildPipelineOverview(projects, [], [], [operational], { now });
    expect(Object.values(pipeline.totalLeaks).every(count => count === 0)).toBe(true);
    expect(aggregates([operational])).toEqual(aggregates([]));
  });
});
