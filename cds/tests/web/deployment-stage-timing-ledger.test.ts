import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeploymentRunLedger } from '../../web/src/components/BranchDetailDrawer.js';
import { summarizeDeploymentTiming } from '../../src/services/deployment-stage-timing.js';

const sha = 'a'.repeat(40);
function stage(extra = {}) {
  return { status: 'observed', completedWallMs: 5000, workMs: 9000,
    intervals: 2, open: 0, unknown: 0, completed: 2, failed: 0, cancelled: 0, ...extra };
}
function summary() {
  const s = summarizeDeploymentTiming(undefined);
  s.stages.capacity = stage();
  return s;
}
function render(timingSummary?: unknown, commitSha = sha) {
  return renderToStaticMarkup(createElement(DeploymentRunLedger, { runs: [{
    id: 'dr_owned', projectId: 'p', branchId: 'b', trigger: 'manual', status: 'running', phase: 'running',
    seq: 1, eventCount: 1, commitSha, startedAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:01Z',
    timingSummary,
  } as any], activeRunId: 'dr_owned', expectedRepository: 'owner/repo', expectedBranch: 'main' }));
}
describe('actual Drawer deployment ledger timing presentation (SSR, not visual or runtime acceptance)', () => {
  it('renders backend wall/work facts without adding parallel durations into a total', () => {
    const html = render(summary());
    expect(html).toContain('容量等待'); expect(html).toContain('5s'); expect(html).toContain('9s');
    expect(html).toContain('已观测区间'); expect(html).toContain('工作时长');
    expect(html).not.toContain('总等待'); expect(html).not.toContain('14s');
  });
  it('does not turn missing legacy data into zero or successful timing', () => {
    const html = render(); expect(html).toContain('阶段耗时尚未采集');
    expect(html).not.toContain('0ms');
  });
  it('shows a genuinely measured zero separately from unobserved stages', () => {
    const s = summary(); s.stages.capacity = stage({ completedWallMs: 0, workMs: 0 });
    const html = render(s); expect(html).toContain('0ms'); expect(html).toContain('未采集');
  });
  it('keeps failed and cancelled outcomes visible even when intervals were observed', () => {
    const s = summary(); s.stages.capacity = stage({ completed: 0, failed: 1, cancelled: 1 });
    const html = render(s); expect(html).toContain('失败 1'); expect(html).toContain('取消 1');
    expect(html).not.toContain('全部成功');
  });
  it('marks open and unknown intervals as incomplete without inventing live elapsed time', () => {
    const s = summary(); s.stages.capacity = stage({ status: 'incomplete', open: 1, unknown: 1 });
    const html = render(s); expect(html).toContain('未结束 1'); expect(html).toContain('未知 1');
    expect(html).toContain('数据不完整');
  });
  it('retains explicit truncation and rejects string/null timing values as measurements', () => {
    const s = summary(); s.truncated = true;
    s.stages.capacity = stage({ completedWallMs: '999', workMs: null }) as any;
    const html = render(s); expect(html).toContain('记录已截断'); expect(html).not.toContain('999ms');
  });
  it('renders exact CI provenance and keeps CI job terminology separate from local time', () => {
    const s = summary();
    s.stages['ci-runner'] = stage({ completedWallMs: 2000, workMs: 2000 });
    s.stages['ci-build'] = stage({ completedWallMs: 3000, workMs: 3000 });
    s.ci.provenance = { repository: 'owner/repo', headBranch: 'main', headSha: sha,
      workflowPath: '.github/workflows/branch-image.yml', event: 'push', runId: 123, runAttempt: 2, jobs: 2 };
    const html = render(s); expect(html).toContain('CI job 启动前等待'); expect(html).toContain('CI job 执行');
    expect(html).toContain('https://github.com/owner/repo/actions/runs/123/attempts/2');
    expect(html).toContain('分别统计');
  });
  it('does not link or display CI durations from a different target SHA', () => {
    const s = summary(); s.stages['ci-build'] = stage({ completedWallMs: 777000, workMs: 777000 });
    s.ci.provenance = { repository: 'owner/repo', headBranch: 'main', headSha: 'b'.repeat(40),
      workflowPath: '.github/workflows/branch-image.yml', event: 'push', runId: 123, runAttempt: 2, jobs: 2 };
    const html = render(s); expect(html).toContain('CI 来源待核对');
    expect(html).not.toContain('href="https://github.com/'); expect(html).not.toContain('777s');
  });
});
