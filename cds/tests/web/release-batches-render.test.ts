import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BatchReleaseResult, type BatchTarget, type ReleaseBatch } from '../../web/src/pages/release-center/BatchReleasePanel';
import type { ReleaseRun } from '../../web/src/pages/release-center/types';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const target = (targetId: string, status: string, extra: Partial<BatchTarget> = {}): BatchTarget => ({
  targetId,
  targetName: `隔离目标 ${targetId}`,
  status,
  runId: `run-${targetId}`,
  previousReleaseId: `before-${targetId}`,
  attempts: [{ id: `attempt-${targetId}`, kind: 'deploy', runId: `run-${targetId}`, createdAt: '2026-11-12T08:00:00Z' }],
  ...extra,
});
function batch(targets: BatchTarget[], status = 'partial_success'): ReleaseBatch {
  return {
    id: 'batch-1', projectId: 'project-1', versionId: 'version-1', reportId: 'report-1',
    branchId: 'branch-1', branchName: 'main', commitSha: COMMIT, status,
    createdAt: '2026-11-12T08:00:00Z', updatedAt: '2026-11-12T08:00:10Z', targets,
  };
}
function render(result: ReleaseBatch, runs: Record<string, ReleaseRun> = {}, busy = false, rollbackTargetId = ''): string {
  return renderToStaticMarkup(createElement(BatchReleaseResult, {
    batch: result, runs, busy, rollbackTargetId,
    onRetry: () => {}, onPrepareRollback: () => {}, onRollback: () => {}, onLogs: () => {},
  }));
}

describe('批次发布结果 · 保留各目标真实结果', () => {
  it('第二目标失败时保留第一目标成功与实际提交，只给失败目标提供重试', () => {
    const html = render(batch([
      target('A', 'success', { observedCommitSha: COMMIT }),
      target('B', 'failed', { error: '目标 B 的发布脚本检查失败', observedCommitSha: OTHER_COMMIT }),
    ]));
    expect(html).toContain('部分成功');
    expect(html).toContain('1/2 个目标发布成功');
    expect(html).toContain(COMMIT);
    expect(html).toContain(OTHER_COMMIT);
    expect(html).toContain('目标 B 的发布脚本检查失败');
    expect(html.match(/仅重试此目标/g)).toHaveLength(1);
    const firstTarget = html.slice(html.indexOf('隔离目标 A'), html.indexOf('隔离目标 B'));
    expect(firstTarget).toContain('发布成功');
    expect(firstTarget).not.toContain('仅重试此目标');
  });

  it('严格按批次顺序显示，不根据成功或失败排序', () => {
    const html = render(batch([target('B', 'failed'), target('A', 'success', { observedCommitSha: COMMIT })]));
    expect(html.indexOf('隔离目标 B')).toBeLessThan(html.indexOf('隔离目标 A'));
  });

  it('取消和中断不会覆盖已经成功目标的证据', () => {
    for (const status of ['cancelled', 'interrupted']) {
      const html = render(batch([target('A', 'success', { observedCommitSha: COMMIT }), target('B', status)], status));
      expect(html).toContain('隔离目标 A');
      expect(html).toContain(COMMIT);
      expect(html).toContain('1/2 个目标发布成功');
      expect(html).toContain(status === 'cancelled' ? '已取消' : '执行中断，需核对现场');
    }
  });

  it('未知现场版本明确写未知，不把期望提交填入实际版本位置', () => {
    const html = render(batch([target('A', 'success', { observedCommitSha: COMMIT }), target('B', 'success')], 'inconsistent'));
    expect(html).toContain('版本不一致或尚未核实');
    expect(html).toContain('实际运行提交：</span><code>未知，尚未核实</code>');
    expect(html).not.toContain('全部目标发布成功');
  });

  it('执行成功但读回不同提交时显示版本不一致与读回的提交', () => {
    const html = render(batch([target('A', 'success', { observedCommitSha: COMMIT }), target('B', 'success', { observedCommitSha: OTHER_COMMIT })], 'inconsistent'));
    expect(html).toContain('版本不一致');
    expect(html).toContain(OTHER_COMMIT);
    expect(html).not.toContain('全部目标发布成功');
  });

  it('回滚失败保留失败原因和现场版本，不渲染成全部成功', () => {
    const html = render(batch([
      target('A', 'rolled_back', { rollbackRunId: 'rollback-A', observedCommitSha: OTHER_COMMIT }),
      target('B', 'rollback_failed', { rollbackRunId: 'rollback-B', error: '恢复原版本后的入口检查失败', observedCommitSha: COMMIT }),
    ], 'rollback_failed'));
    expect(html).toContain('回滚失败');
    expect(html).toContain('恢复原版本后的入口检查失败');
    expect(html).toContain(OTHER_COMMIT);
    expect(html).not.toContain('全部目标发布成功');
  });

  it('回滚确认明确指向被选择目标及批次开始前版本', () => {
    const html = render(batch([target('A', 'success'), target('B', 'success')]), {}, false, 'B');
    expect(html).toContain('确认将「隔离目标 B」恢复到本批次开始前的版本记录 before-B');
    expect(html.match(/确认恢复此目标/g)).toHaveLength(1);
    expect(html).not.toContain('确认将「隔离目标 A」');
  });

  it('批次执行中禁止单目标重试和回滚，避免插入重复部署', () => {
    const html = render(batch([target('A', 'failed'), target('B', 'running')], 'running'), {}, true);
    const buttons = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((entry) => entry[0]);
    const retry = buttons.find((button) => button.includes('仅重试此目标'));
    expect(retry).toContain('disabled=""');
    expect(buttons.filter((button) => button.includes('恢复原版本')).every((button) => button.includes('disabled=""'))).toBe(true);
  });

  it('同屏展示阻断预检与其恢复提示', () => {
    const html = render(batch([target('A', 'ready'), target('B', 'failed', {
      checks: [{ id: 'release-ci', label: '同提交 CI 成功', status: 'fail', blocking: true, message: 'CI 尚未完成，请等待同提交 CI 成功后重新检查' }],
    })], 'blocked'));
    expect(html).toContain('预检未通过');
    expect(html).toContain('阻断 · 同提交 CI 成功');
    expect(html).toContain('CI 尚未完成，请等待同提交 CI 成功后重新检查');
  });

  it('显示服务端步骤进度，并保留每次重试和恢复的日志入口', () => {
    const targetB = target('B', 'running', { attempts: [
      { id: 'first-B', kind: 'deploy', runId: 'run-first-B', createdAt: '2026-11-12T08:00:00Z', error: '首次发布失败' },
      { id: 'second-B', kind: 'deploy', runId: 'run-B', createdAt: '2026-11-12T08:00:10Z' },
    ] });
    const run = { releaseId: 'run-B', status: 'running', logs: [], progress: { steps: [
      { id: 'connect', title: '连接目标', state: 'done' },
      { id: 'deploy', title: '执行固定提交脚本', state: 'running' },
    ] } } as unknown as ReleaseRun;
    const html = render(batch([target('A', 'success'), targetB], 'running'), { 'run-B': run }, true);
    expect(html).toContain('执行进度：2/2 · 执行固定提交脚本');
    expect(html).toContain('全部尝试与恢复记录（2）');
    expect(html).toContain('首次发布失败');
    expect(html.match(/查看日志/g)).toHaveLength(2);
  });
});
