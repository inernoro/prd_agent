import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from '../../web/node_modules/react-router-dom/dist/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeDeploymentTiming } from '../../src/services/deployment-stage-timing.js';

const fixture = vi.hoisted(() => ({ state: null as any }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: (initial: any) => initial?.status === 'loading'
    ? [fixture.state, () => {}] : actual.useState(initial) };
});
vi.mock('@/components/layout/AppShell', async () => {
  const { createElement } = await import('react');
  const frame = ({ children }: any) => createElement('div', null, children);
  return { AppShell: frame, Workspace: frame, TopBar: () => null, Crumb: () => null,
    useCanManageConsole: () => false, canUseConsolePreview: () => false, MEMBER_PREVIEW_MODE_NOTICE: '未启用预览' };
});
import { BranchDetailPage, branchScopedDeploymentRuns } from '../../web/src/pages/BranchDetailPage.js';

const sha = 'a'.repeat(40);
function render(runs: any[], runsUnavailable = false) {
  fixture.state = { status: 'ok', project: { id: 'p', name: 'Owned', slug: 'owned' },
    branch: { id: 'b', projectId: 'p', branch: 'main', status: 'running', services: {},
      createdAt: '2026-10-11T00:00:00Z', githubRepoFullName: 'owner/repo', lastDeploymentRunId: 'dr_owned' },
    operationLogs: [], commits: [], profiles: [], aliases: { aliases: [] }, proxyLogs: [],
    bridgeActive: false, previewMode: 'multi', config: {}, deploymentRuns: runs, deploymentRunsUnavailable: runsUnavailable };
  vi.stubGlobal('window', { location: { search: '?project=p&branch=b' } });
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(BranchDetailPage)));
}
function run(summary?: unknown, extra = {}) {
  return { id: 'dr_owned', projectId: 'p', branchId: 'b', trigger: 'manual', status: 'running', phase: 'running',
    seq: 1, eventCount: 1, commitSha: sha, startedAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:01Z',
    timingSummary: summary, ...extra };
}
afterEach(() => vi.unstubAllGlobals());
describe('actual /branch-panel page consumer (SSR with supplied state, not runtime or visual)', () => {
  it('renders the actual backend timing summary and current run in the page main area', () => {
    const s = summarizeDeploymentTiming(undefined);
    s.stages.capacity = { status: 'observed', completedWallMs: 5000, workMs: 9000, intervals: 2,
      open: 0, unknown: 0, completed: 2, failed: 0, cancelled: 0 };
    const html = render([run(s)]);
    expect(html).toContain('部署事实账本'); expect(html).toContain('分支当前运行');
    expect(html).toContain('容量等待'); expect(html).toContain('5s'); expect(html).toContain('9s');
    expect(html).not.toContain('14s');
  });
  it('keeps missing stage measurements, failure and suggested action visible', () => {
    const html = render([run(undefined, { status: 'failed', phase: 'artifact', failure: {
      code: 'artifact_missing', owner: 'external', retryable: true, summary: '指定提交缺镜像', suggestedAction: '等待 CI 制品' } })]);
    expect(html).toContain('阶段耗时尚未采集'); expect(html).toContain('指定提交缺镜像');
    expect(html).toContain('等待 CI 制品'); expect(html).not.toContain('0ms');
  });
  it('uses current repository and branch to qualify CI facts instead of trusting the record alone', () => {
    const s = summarizeDeploymentTiming(undefined);
    s.ci.provenance = { repository: 'owner/repo', headBranch: 'main', headSha: sha,
      workflowPath: '.github/workflows/branch-image.yml', event: 'push', runId: 123, runAttempt: 2, jobs: 2 };
    const good = render([run(s)]);
    expect(good).toContain('https://github.com/owner/repo/actions/runs/123/attempts/2');
    s.ci.provenance.headBranch = 'other';
    const bad = render([run(s)]);
    expect(bad).toContain('CI 来源待核对'); expect(bad).not.toContain('href="https://github.com/');
  });
  it('distinguishes an empty list from an unavailable list and retains a supplied stale snapshot', () => {
    expect(render([])).toContain('暂无部署事实记录');
    expect(render([], true)).toContain('部署事实账本暂不可读');
    const html = render([run()], true);
    expect(html).toContain('部署事实账本暂不可读'); expect(html).toContain('dr_owned');
    expect(html).toContain('上次成功记录');
  });
});


describe('branch list packet qualification', () => {
  it('rejects malformed and mixed-scope packets instead of treating them as an empty successful list', () => {
    for (const packet of [undefined, { runs: null }, { runs: {} }, { runs: [null] },
      { runs: [run(), run(undefined, { projectId: 'foreign' })] }, { runs: [run(undefined, { branchId: 'other' })] }]) {
      expect(branchScopedDeploymentRuns(packet, 'p', 'b')).toBeNull();
    }
    expect(branchScopedDeploymentRuns({ runs: [] }, 'p', 'b')).toEqual([]);
  });
  it('rejects matching-scope rows that cannot be safely rendered rather than accepting a crashing ledger', () => {
    const rows = branchScopedDeploymentRuns({ runs: [{ projectId: 'p', branchId: 'b' }] }, 'p', 'b');
    expect(render(rows ?? [], rows === null)).toContain('部署事实账本暂不可读');
    for (const row of [{ projectId: 'p', branchId: 'b' }, run(undefined, { id: null }),
      run(undefined, { id: 37 }), run(undefined, { status: 'other' }), run(undefined, { eventCount: -1 }),
      run(undefined, { commitSha: {} }), run(undefined, { failure: { summary: {} } }),
      run(undefined, { latestEvent: { message: {} } })]) {
      expect(branchScopedDeploymentRuns({ runs: [row] }, 'p', 'b')).toBeNull();
    }
  });
  it('keeps valid failure facts and the list bounded without mutating the received packet', () => {
    const runs = Array.from({ length: 12 }, (_, i) => run(undefined, { id: `dr_${i}`, status: 'failed' }));
    const accepted = branchScopedDeploymentRuns({ runs }, 'p', 'b');
    expect(accepted).toHaveLength(10); expect(accepted?.[0].status).toBe('failed'); expect(runs).toHaveLength(12);
    const legacy = run() as any; delete legacy.seq; delete legacy.startedAt; delete legacy.timingSummary;
    expect(branchScopedDeploymentRuns({ runs: [legacy] }, 'p', 'b')).toEqual([legacy]);
  });
});
