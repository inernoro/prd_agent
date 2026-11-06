import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  codeReviewAction, codeReviewReportUrl, downloadCodeReviewReport, listCodeReviews, submitCodeReview,
  type CodeReviewTask,
} from '../../web/src/lib/codeReviews.js';
import { buildCodeReviewDocument, ReviewDetail } from '../../web/src/pages/CodeReviewsPage.js';
import { AppRail } from '../../web/src/components/layout/AppShell.js';

const { MemoryRouter } = createRequire(path.resolve('web/package.json'))('react-router-dom');

const task: CodeReviewTask = {
  id: 'review/123', projectId: 'project & private', title: '业务代码审查', sourceType: 'zip', sourceName: 'source.zip',
  status: 'running', phase: '正在分析', progress: { totalFiles: 30, scannedFiles: 12 },
  createdAt: '2026-11-06T08:00:00Z', updatedAt: '2026-11-06T08:00:12Z', delivery: { status: 'not_requested' },
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('code review API client', () => {
  it('fetches report downloads with credentials and preserves the exact archived bytes', async () => {
    const body = '# 审查报告\n\n固定提交：abc123\n';
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    const blob = await downloadCodeReviewReport(task.id, controller.signal);
    expect(fetcher).toHaveBeenCalledWith('/api/code-reviews/review%2F123/report/download', {
      credentials: 'include', signal: controller.signal,
    });
    expect(await blob.text()).toBe(body);
    expect(blob.size).toBe(Buffer.byteLength(body));
  });

  it('rejects authentication and server failures instead of saving error bodies as reports', async () => {
    const denied = new Response(JSON.stringify({ message: '请重新登录' }), { status: 401 });
    const readBlob = vi.spyOn(denied, 'blob');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(denied));
    await expect(downloadCodeReviewReport(task.id)).rejects.toThrow('请重新登录');
    expect(readBlob).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 502 })));
    await expect(downloadCodeReviewReport(task.id)).rejects.toThrow('报告下载失败（HTTP 502）');
  });

  it('keeps GitHub submissions structured and omits browser file fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task }), { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    await submitCodeReview({ projectId: task.projectId, sourceType: 'github', githubUrl: 'https://github.com/acme/private', ref: 'release/next', excludePatterns: ['thirdparty'], email: 'reviewer@example.com' });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/code-reviews');
    expect(JSON.parse(init.body)).toEqual({ projectId: task.projectId, sourceType: 'github', githubUrl: 'https://github.com/acme/private', ref: 'release/next', excludePatterns: ['thirdparty'], email: 'reviewer@example.com' });
    expect(init.credentials).toBe('include');
  });

  it('uploads ZIP with FormData and browser multipart boundary, preserving project and exclusions', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ task }), { status: 202 }));
    vi.stubGlobal('fetch', fetcher);
    const file = new File(['PK fixture'], 'source.zip', { type: 'application/zip' });
    const result = await submitCodeReview({ projectId: task.projectId, sourceType: 'zip', file, excludePatterns: ['vendor'], email: 'reviewer@example.com' });
    const [, init] = fetcher.mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('file').name).toBe('source.zip');
    expect(init.body.get('projectId')).toBe(task.projectId);
    expect(init.body.get('excludePatterns')).toBe('["vendor"]');
    expect(init.body.get('email')).toBe('reviewer@example.com');
    expect(init.headers).toBeUndefined();
    expect(init.credentials).toBe('include');
    expect(result.id).toBe(task.id);
  });

  it('reports upload rejection without claiming a task was created', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '压缩包展开体积超限' }), { status: 413 })));
    await expect(submitCodeReview({ projectId: task.projectId, sourceType: 'zip', file: new File(['PK'], 'large.zip') })).rejects.toThrow('压缩包展开体积超限');
  });

  it('rejects missing ZIP locally and keeps project-scoped list and task actions encoded', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('?') ? { tasks: [task] } : { task })));
    vi.stubGlobal('fetch', fetcher);
    await expect(submitCodeReview({ projectId: task.projectId, sourceType: 'zip' })).rejects.toThrow('请选择 ZIP');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await listCodeReviews(task.projectId)).toEqual([task]);
    expect(fetcher.mock.calls[0][0]).toBe('/api/code-reviews?projectId=project+%26+private');
    await codeReviewAction(task.id, 'delivery/retry');
    expect(fetcher.mock.calls[1][0]).toBe('/api/code-reviews/review%2F123/delivery/retry');
  });
});

function renderDetail(value: CodeReviewTask): string {
  return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ReviewDetail, {
    task: value, now: Date.parse('2026-11-06T08:01:00Z'), pending: false, onAction: () => undefined,
  })));
}

describe('code review task reading', () => {
  it('makes the review entry available to project members without exposing owner report controls', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AppRail, {
      active: 'code-reviews', canManageSettings: false, canLogout: false, logoutState: 'idle',
      onLogout() {}, onAgentAccess() {}, onBugReport() {},
    })));
    expect(html).toContain('href="/code-reviews"');
    expect(html).toContain('代码审查报告');
    expect(html).not.toContain('href="/reports"');
    expect(html).not.toContain('href="/release-console"');
  });

  it('shows real file progress and cancellation while running, without offering an absent report', () => {
    const html = renderDetail(task);
    expect(html).toContain('12 / 30');
    expect(html).toContain('取消审查');
    expect(html).not.toContain('阅读审查报告');
    expect(html).not.toContain('重试邮件');
    expect(codeReviewReportUrl(task)).toBeNull();
  });

  it('keeps completed reports readable when email fails and offers email retry independently', () => {
    const completed: CodeReviewTask = { ...task, status: 'completed', reportId: 'report/id', delivery: { status: 'failed', error: 'SMTP 暂时不可达', email: 'reviewer@example.com' } };
    const html = renderDetail(completed);
    expect(html).toContain('阅读审查报告');
    expect(html).toContain('重试邮件');
    expect(html).toContain('SMTP 暂时不可达');
    expect(html).not.toContain('取消审查');
    expect(html).not.toContain('重新审查');
    expect(codeReviewReportUrl(completed)).toBe('/code-reviews?project=project+%26+private&task=review%2F123&report=1');
  });

  it('shows source failure and re-review without fabricating a successful report', () => {
    const html = renderDetail({ ...task, status: 'failed', error: '私有仓库尚未授权' });
    expect(html).toContain('私有仓库尚未授权');
    expect(html).toContain('重新审查');
    expect(html).not.toContain('阅读审查报告');
  });

  it('wraps both report formats in a CSP that blocks scripts and remote requests', () => {
    for (const format of ['html', 'md'] as const) {
      const html = buildCodeReviewDocument('# 发现\n<script>alert(1)</script>', format, 'light');
      expect(html).toContain("default-src 'none'");
      expect(html).toContain("form-action 'none'");
      expect(html).toContain('color-scheme:light');
    }
    expect(buildCodeReviewDocument('# 质量审查', 'md', 'dark')).toContain('<h1>质量审查</h1>');
  });
});
