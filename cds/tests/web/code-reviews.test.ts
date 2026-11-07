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
import { FindingDetail, readableAiExplanation } from '../../web/src/pages/code-reviews/ReviewReportReader.js';
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
      if (format === 'md') expect(html).toContain('color-scheme:light');
      else expect(html).not.toContain('body{'); // Imported HTML retains its own presentation.
    }
    expect(buildCodeReviewDocument('# 质量审查', 'md', 'dark')).toContain('<h1>质量审查</h1>');
  });
});


describe('原始证据与原版文档', () => {
  it('发现中的 HTML 仅作为源码文本展示，缺失的代码与解释不补写', () => {
    const finding = { filePath: 'src/a.ts', line: 12, category: 'security' as const, severity: 'high' as const, message: '<script>unsafe()</script>', tool: 'DeepAudit', verified: false as const };
    const missing = renderToStaticMarkup(createElement(FindingDetail, { finding }));
    expect(missing).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
    expect(missing).not.toContain('<script>'); expect(missing).not.toContain('代码证据'); expect(missing).not.toContain('AI 解释');
    const full = renderToStaticMarkup(createElement(FindingDetail, { finding: { ...finding, codeSnippet: '<img onerror="unsafe()">', aiExplanation: '原始解释' } }));
    expect(full).toContain('代码证据'); expect(full).toContain('&lt;img'); expect(full).toContain('原始解释');
  });
  it('原版 HTML 保留布局，仅允许可信尺寸脚本运行，非法 nonce 不启用脚本', () => {
    const original = '<html><style>body{background:navy}</style><body>原版</body></html>';
    const token = '12345678-1234-1234-1234-123456789abc';
    const document = buildCodeReviewDocument(original, 'html', 'dark', token);
    expect(document).toContain(original); expect(document).toContain(`script-src 'nonce-${token}'`);
    expect(document).toContain(`<script nonce="${token}">`);
    expect(document).not.toContain('color-scheme:dark');
    expect(buildCodeReviewDocument(original, 'html', 'dark', 'injected')).not.toContain('<script');
  });
});


describe('报告自动跳转隔离', () => {
  it('使用 HTML 解析器移除编码和大小写变体的刷新标签，保留正文布局及代码文本', () => {
    const input = '<html><head><meta HTTP-EQUIV="&#114;efresh" content="0;url=https://blocked.invalid"><style>body{color:navy}</style></head><body class="original"><pre>&lt;meta http-equiv="refresh"&gt;</pre></body></html>';
    for (const format of ['html', 'md'] as const) {
      const rendered = buildCodeReviewDocument(input, format, 'light');
      expect(rendered).not.toContain('blocked.invalid');
      expect(rendered).toContain('body{color:navy}'); expect(rendered).toContain('class="original"');
      expect(rendered).toContain('&lt;meta http-equiv="refresh"&gt;');
    }
  });
});


describe('原生解释面向人阅读', () => {
  it('解开 JSON Unicode 并展示中文字段，保留原文与参考资料', () => {
    const raw = '{"what":"\\u8bf7\\u6c42\\u4f2a\\u9020","why":"地址缺少校验","how":"限制上游","learn_more":["CWE-918"]}';
    expect(readableAiExplanation(raw)).toEqual([{ label: '问题说明', text: '请求伪造' }, { label: '形成原因', text: '地址缺少校验' }, { label: '修复思路', text: '限制上游' }, { label: '参考资料', text: 'CWE-918' }]);
    expect(readableAiExplanation('原始解释')).toEqual([{ text: '原始解释' }]);
    expect(readableAiExplanation('null')).toEqual([]); expect(readableAiExplanation('{}')).toEqual([]);
  });
  it('只去除重复标题，JSON 内 HTML 与特殊键始终按文本显示', () => {
    const finding = { title: '唯一标题', message: '唯一标题\n\n真正原因', filePath: 'src/a.ts', category: 'security' as const, severity: 'high' as const, verified: false as const, tool: 'DeepAudit', aiExplanation: '{"what":"<script>unsafe()</script>","__proto__":"原始字段"}' };
    const rendered = renderToStaticMarkup(createElement(FindingDetail, { finding }));
    expect(rendered.match(/唯一标题/g)).toHaveLength(1); expect(rendered).toContain('真正原因');
    expect(rendered).toContain('&lt;script&gt;unsafe()&lt;/script&gt;'); expect(rendered).not.toContain('<script>'); expect(rendered).toContain('原始字段');
    expect(finding.aiExplanation).toContain('what');
  });
});
