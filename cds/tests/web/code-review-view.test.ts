import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CodeReviewTask } from '../../web/src/lib/codeReviews.js';
import { explainReviewError, latestReviewTasks, needsReviewAttention, reviewCoverage, reviewPage, reviewTaskLabel, selectReviewFocus, summarizeReviews } from '../../web/src/lib/codeReviewView.js';
import { ReviewDetail, ReviewTaskList } from '../../web/src/pages/CodeReviewsPage.js';

function task(input: Partial<CodeReviewTask> = {}): CodeReviewTask {
  return { id: 'task', projectId: 'project', title: '模块审查', sourceType: 'zip', sourceName: 'source.zip', status: 'queued', phase: '等待处理', progress: { totalFiles: 0, scannedFiles: 0 }, createdAt: '2026-11-06T08:00:00Z', updatedAt: '2026-11-06T08:00:00Z', delivery: { status: 'not_requested' }, ...input };
}

describe('代码审查结果的可理解性与真实性', () => {
  it('进行中的整仓进度保持正常状态，结束后覆盖不足才提示警告', () => {
    const active = task({ status: 'running', progress: { totalFiles: 6061, scannedFiles: 13 } });
    expect(reviewCoverage(active)).toMatchObject({ kind: 'pending' });
    expect(reviewCoverage(active).text).toContain('审查进行中');
    const html = renderToStaticMarkup(createElement(ReviewDetail, { task: active, now: Date.now(), pending: false, onAction: () => undefined }));
    expect(html).toContain('审查文件进度');
    expect(html).not.toContain('bg-warn-soft');
    expect(reviewCoverage({ ...active, status: 'completed' }).kind).toBe('partial');
  });

  it('上传档案不算 AI 审查报告，也不展示零文件成功', () => {
    const uploaded = task({ sourceType: 'report', status: 'completed', reportId: 'report' });
    expect(reviewTaskLabel(uploaded).label).toBe('上传归档');
    expect(reviewCoverage(uploaded).kind).toBe('external');
    expect(summarizeReviews([uploaded])).toMatchObject({ active: 0, reports: 0, archives: 1, attention: 0 });
    const html = renderToStaticMarkup(createElement(ReviewTaskList, { items: [uploaded], selectedId: '', projectName: () => '项目', onSelect: () => undefined }));
    expect(html).toContain('导入文档');
    expect(html).toContain('已保存');
    expect(html).toContain('未执行源码审查');
    expect(html).not.toContain('已完成');
  });

  it('已结束的 0/0、0/1 和 11/12 必须保留覆盖问题，不能按全量成功统计', () => {
    const variants = [{ totalFiles: 0, scannedFiles: 0 }, { totalFiles: 1, scannedFiles: 0 }, { totalFiles: 12, scannedFiles: 11 }];
    const rows = variants.map((progress, i) => task({ id: `${i}`, status: 'completed', reportId: `${i}`, progress }));
    expect(rows.map(value => reviewCoverage(value).kind)).toEqual(['unknown', 'unknown', 'partial']);
    expect(rows.map(needsReviewAttention)).toEqual([true, true, true]);
    expect(summarizeReviews(rows)).toMatchObject({ reports: 3, partial: 3, attention: 3 });
    for (const value of rows) expect(reviewTaskLabel(value).tone).toBe('warning');
  });

  it('工作台保留全部真实失败，并且失败与邮件失败不会重复计数', () => {
    const failed = task({ status: 'failed', error: 'DeepAudit 任务失败', delivery: { status: 'failed' } });
    const good = task({ id: 'good', status: 'completed', reportId: 'r', progress: { totalFiles: 12, scannedFiles: 12 } });
    const summary = summarizeReviews([failed, good]);
    expect(summary).toMatchObject({ failed: 1, attention: 1, reports: 1 });
    expect(summary.headline).toContain('1 项审查失败');
    expect(reviewCoverage(good).text).toContain('本次审查 12 / 12');
    expect(reviewTaskLabel(good).label).toBe('报告已生成');
  });

  it('技术错误保留可检查的原因与下一步，不凭通用错误猜测具体故障', () => {
    expect(explainReviewError('DeepAudit 任务失败').title).toBe('本次操作未完成');
    expect(explainReviewError('timeout').title).toBe('服务响应超时');
    expect(explainReviewError('模型服务认证失败 401').title).toBe('模型服务认证失败');
    expect(explainReviewError('模型服务认证失败 401').next).not.toContain('私有仓库');
    expect(explainReviewError('模型请求限流，配额不足').title).toBe('模型服务请求受限');
    const html = renderToStaticMarkup(createElement(ReviewDetail, { task: task({ status: 'failed', error: 'DeepAudit 任务失败' }), now: Date.now(), pending: true, onAction: () => undefined }));
    expect(html).toContain('技术详情');
    expect(html).toContain('DeepAudit 任务失败');
    expect(html).toContain('失败不代表代码没有问题');
  });
});

describe('大批量审查任务的筛选和分页', () => {
  const tasks = Array.from({ length: 524 }, (_, i) => task({ id: `batch-${i}`, title: `模块 ${i}`, sourceName: `module-${i}.zip`, status: i < 20 ? 'failed' : 'queued' }));
  it('524 项任务只渲染当前 20 行，页码越界会收敛到最后一页', () => {
    const first = reviewPage(tasks, '', 'all', 0);
    expect(first).toMatchObject({ total: 524, pages: 27, page: 0 });
    expect(first.items).toHaveLength(20);
    const html = renderToStaticMarkup(createElement(ReviewTaskList, { items: first.items, selectedId: '', projectName: () => '项目', onSelect: () => undefined }));
    expect(html.match(/data-code-review-row/g)).toHaveLength(20);
    expect(html).not.toContain('模块 523');
    expect(reviewPage(tasks, '', 'all', 900).items).toHaveLength(4);
    expect(tasks).toHaveLength(524);
  });
  it('搜索和状态共同生效，筛选后的页数与数量匹配', () => {
    expect(reviewPage(tasks, 'module-19.zip', 'attention', 0).items.map(item => item.id)).toEqual(['batch-19']);
    expect(reviewPage(tasks, 'module-19.zip', 'active', 0).total).toBe(0);
    expect(reviewPage(tasks, '', 'attention', 0).total).toBe(20);
    expect(reviewPage(tasks, '', 'active', 0).total).toBe(504);
    expect(reviewPage(tasks, 'missing', 'all', 8)).toMatchObject({ total: 0, pages: 1, page: 0 });
  });
});


describe('整仓审查首页的单任务焦点', () => {
  it('选择优先于最新任务，缺失深链不退回其他任务，上传报告仍可显式选中', () => {
    const old = task({ id: 'old' });
    const current = task({ id: 'new', createdAt: '2026-11-07T00:00:00Z' });
    const archive = task({ id: 'archive', sourceType: 'report', createdAt: '2026-11-08T00:00:00Z' });
    expect(selectReviewFocus([old, current, archive])?.id).toBe('new');
    expect(selectReviewFocus([old, current], 'old')?.id).toBe('old');
    expect(selectReviewFocus([old, current], 'missing')).toBeUndefined();
    expect(selectReviewFocus([old, current, archive], 'archive')?.id).toBe('archive');
    expect(selectReviewFocus([archive])).toBeUndefined();
  });

  it('513 项历史批次的轮询更新时间不抢占较新的整仓审查，也不合并或改动原记录', () => {
    const history = Array.from({ length: 513 }, (_, i) => task({ id: `manual-${i}`, updatedAt: '2026-11-09T00:00:00Z' }));
    const current = task({ id: 'whole-repository', createdAt: '2026-11-08T00:00:00Z' });
    const rows = [...history, current];
    expect(selectReviewFocus(rows)?.id).toBe(current.id);
    expect(selectReviewFocus([...rows].reverse())?.id).toBe(current.id);
    expect(reviewPage(rows, '', 'all', 0).total).toBe(514);
    expect(selectReviewFocus(rows, 'manual-500')?.id).toBe('manual-500');
    expect(rows).toHaveLength(514);
  });

  it('同一创建时间保留原有顺序，不按更新时间或状态选任务', () => {
    const first = task({ id: 'first', status: 'failed' });
    const second = task({ id: 'second', updatedAt: '2026-11-09T00:00:00Z' });
    expect(selectReviewFocus([first, second])?.id).toBe('first');
    expect(selectReviewFocus([])).toBeUndefined();
  });
});


describe('最近审查与历史记录', () => {
  it('默认保留每项目最新源码任务及所有导入档案，历史搜索仍能找到旧提交', () => {
    const old = task({ id: 'old', commitSha: 'abc-old-sha' });
    const recent = task({ id: 'recent', createdAt: '2026-11-07T10:00:00Z', progress: { totalFiles: 10, scannedFiles: 4 } });
    const archive = task({ id: 'import', sourceType: 'report', createdAt: '2026-11-09T00:00:00Z' });
    const other = task({ id: 'other', projectId: 'other' });
    const all = [old, recent, archive, other];
    expect(latestReviewTasks(all).map(item => item.id)).toEqual(['recent', 'other', 'import']);
    expect(latestReviewTasks(all)[0].progress).toEqual({ totalFiles: 10, scannedFiles: 4 });
    expect(reviewPage(all, 'abc-old-sha', 'all', 0).items).toEqual([old]);
    expect(all).toHaveLength(4);
  });
});
