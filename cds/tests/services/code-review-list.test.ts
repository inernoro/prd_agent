import { describe, expect, it } from 'vitest';
import { pageCodeReviewTasks } from '../../src/shared/code-review-list.js';
import type { CodeReviewTask } from '../../src/shared/code-review.js';

const task = (id: string, override: Partial<CodeReviewTask> = {}): CodeReviewTask => ({ id, projectId: 'a', title: `审查 ${id}`, excludePatterns: [], createdBy: 'test', ownerScope: 'test', sourceType: 'cds', sourceName: 'repo', branchName: 'main', status: 'completed', phase: '已归档', progress: { totalFiles: 10, scannedFiles: 10 }, delivery: { status: 'not_requested' }, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T01:00:00Z', ...override });
const options = { source: 'all' as const, status: 'all' as const, query: '', history: true, offset: 0, limit: 10 };

describe('审查列表分页、来源与刷新快照', () => {
  it('612条只返回当前10条，越界页定位最后一页，同一创建时间的顺序确定', () => {
    const tasks = Array.from({ length: 612 }, (_, i) => task(String(i).padStart(4, '0')));
    const first = pageCodeReviewTasks(tasks.reverse(), options);
    expect(first.tasks.map(t => t.id)).toEqual(Array.from({ length: 10 }, (_, i) => String(i).padStart(4, '0')));
    expect(first.page).toEqual({ offset: 0, limit: 10, total: 612, nextOffset: 10 });
    const last = pageCodeReviewTasks(tasks, { ...options, offset: 9999 });
    expect(last.tasks).toHaveLength(2); expect(last.page).toEqual({ offset: 610, limit: 10, total: 612, nextOffset: null });
  });
  it('概览每项目取最近源码、所有文档独立保留，历史分批不自动相加', () => {
    const tasks = [task('older'), task('newer', { createdAt: '2026-11-09T01:00:00Z', progress: { totalFiles: 100, scannedFiles: 2 } }), task('b', { projectId: 'b' }), task('doc', { sourceType: 'report', projectId: 'a' })];
    const page = pageCodeReviewTasks(tasks, { ...options, source: 'source', history: false });
    expect(page.tasks.map(t => t.id)).toEqual(['newer', 'b']); expect(page.tasks[0].progress.scannedFiles).toBe(2);
    expect(page.totals).toEqual({ source: 2, report: 1, all: 3 }); expect(page.historyCount).toBe(1);
    expect(pageCodeReviewTasks(tasks, { ...options, source: 'report' }).tasks.map(t => t.id)).toEqual(['doc']);
  });
  it('后台新记录只计数，状态更新原地显示；显式取新快照才插入', () => {
    const tasks = [task('old')], snapshotAt = '2026-11-09T01:00:00Z';
    const initial = pageCodeReviewTasks(tasks, { ...options, snapshotAt });
    tasks[0].status = 'failed'; tasks.push(task('new', { createdAt: '2026-11-09T02:00:00Z' }));
    const refresh = pageCodeReviewTasks(tasks, { ...options, snapshotAt });
    expect(refresh.tasks.map(t => t.id)).toEqual(initial.tasks.map(t => t.id)); expect(refresh.tasks[0].status).toBe('failed');
    expect(refresh.newCount).toBe(1); expect(refresh.historyCount).toBe(0);
    expect(pageCodeReviewTasks(tasks, options).tasks.map(t => t.id)).toEqual(['new', 'old']);
  });
  it('部分覆盖只对结束任务判定，活动任务不冒充部分完成；关键字支持分支和SHA', () => {
    const tasks = [task('partial', { progress: { totalFiles: 10, scannedFiles: 2 }, branchName: 'feature/settlement', commitSha: 'abc123' }), task('active', { status: 'running', progress: { totalFiles: 10, scannedFiles: 2 } }), task('unknown', { progress: { totalFiles: 0, scannedFiles: 0 } })];
    expect(pageCodeReviewTasks(tasks, { ...options, status: 'partial' }).tasks.map(t => t.id)).toEqual(['partial']);
    expect(pageCodeReviewTasks(tasks, { ...options, status: 'attention' }).tasks.map(t => t.id)).toEqual(['partial', 'unknown']);
    expect(pageCodeReviewTasks(tasks, { ...options, query: 'SETTLEMENT' }).tasks.map(t => t.id)).toEqual(['partial']);
    expect(pageCodeReviewTasks(tasks, { ...options, query: 'abc123' }).tasks).toHaveLength(1);
    expect(pageCodeReviewTasks(tasks, { ...options, query: '不存在' }).page.total).toBe(0);
  });
});
