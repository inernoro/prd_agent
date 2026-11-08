import { describe, expect, it, vi } from 'vitest';
import { archivedCodeReviewResult } from '../../src/services/code-review-result.js';
import { renderCodeReviewReport } from '../../src/services/code-review.js';
import type { CodeReviewTask } from '../../src/shared/code-review.js';
import { CodeReviewEngine, type CodeReviewEngineResult } from '../../src/services/code-review-engine.js';

const task: CodeReviewTask = { id: 'legacy-1', projectId: 'p', title: '报告', sourceName: 'source.zip', sourceType: 'zip',
  excludePatterns: [], status: 'completed', phase: '已归档', progress: { totalFiles: 2, scannedFiles: 1 },
  createdBy: 'test', createdAt: '', updatedAt: '', ownerScope: 'test', delivery: { status: 'not_requested' } };
const result: CodeReviewEngineResult = { engineTaskId: 'engine', totalFiles: 2, scannedFiles: 1, skippedFiles: 1, notes: [], findings: [{
  filePath: 'src/a.ts', line: 12, category: 'security', severity: 'high', message: '标题\n\n原因含 <tag> & [方括号] 和 `code`',
  suggestion: '校验授权\n保留边界', tool: 'DeepAudit AI', verified: false,
}] };
describe('历史 CDS 报告的可追溯兼容', () => {
  it('只用读取请求取回中断任务的原生问题，保留源码、解释和问题原编号', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      return new Response(JSON.stringify(parsed.pathname.endsWith('/issues') ? [{ id: 'finding-original', title: '原版标题',
        description: '原版原因', file_path: 'src/a.ts', line_number: 12, issue_type: 'security', severity: 'high',
        suggestion: '原版建议', code_snippet: '<script>source only</script>', ai_explanation: '原版 AI 解释' }]
        : { id: 'stopped-1', status: 'failed', checkpoint_version: 1, total_files: 2, scanned_files: 1, failed_files: 1, processed_files: 2, issues_count: 1 }), { headers: { 'Content-Type': 'application/json' } });
    });
    const engine = new CodeReviewEngine({ baseUrl: 'https://deepaudit.example', token: 'fixture-service-key', fetchImpl: fetcher });
    const read = await engine.readExisting('stopped-1', { signal: new AbortController().signal, audit: async () => undefined });
    expect(read).toMatchObject({ scannedFiles: 1, totalFiles: 2, findings: [{ id: 'finding-original', title: '原版标题',
      codeSnippet: '<script>source only</script>', aiExplanation: '原版 AI 解释', verified: false }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.method || 'GET').toBe('GET'); expect(url).not.toMatch(/resume|scan|projects/);
    }
  });
  it('不读取身份不匹配或仍运行的上游任务问题', async () => {
    for (const status of [{ id: 'other', status: 'failed' }, { id: 'running-1', status: 'running' }]) {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(status)));
      const engine = new CodeReviewEngine({ baseUrl: 'https://deepaudit.example', token: 'fixture', fetchImpl: fetcher });
      const read = engine.readExisting('running-1', { signal: new AbortController().signal, audit: async () => undefined });
      if (status.id === 'other') await expect(read).rejects.toThrow('身份不匹配');
      else expect(await read).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('仅完整还原自身格式，保留原始文本与未验证状态，不补写缺失源码', () => {
    const restored = archivedCodeReviewResult(task, renderCodeReviewReport(task, result));
    expect(restored?.origin).toBe('archived-markdown'); expect(restored?.findings).toEqual(result.findings);
    expect(restored?.findings[0].codeSnippet).toBeUndefined();
  });
  it('上传报告、其他任务、不完整列表与任意 Markdown 不被当作扫描证据', () => {
    const content = renderCodeReviewReport(task, result);
    expect(archivedCodeReviewResult({ ...task, sourceType: 'report' }, content)).toBeNull();
    expect(archivedCodeReviewResult({ ...task, id: 'other' }, content)).toBeNull();
    expect(archivedCodeReviewResult(task, content.replace('共发现 1 项', '共发现 2 项'))).toBeNull();
    expect(archivedCodeReviewResult(task, '# 用户自己的报告')).toBeNull();
    expect(archivedCodeReviewResult(task, renderCodeReviewReport(task, { ...result, findings: [] }))?.findings).toEqual([]);
  });
});
