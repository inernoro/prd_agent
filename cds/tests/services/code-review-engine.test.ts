import { describe, expect, it } from 'vitest';
import { CodeReviewEngine } from '../../src/services/code-review-engine.js';
import { reviewJsonRequest, type CodeReviewAuditEvent } from '../../src/services/code-review-audit.js';

describe('DeepAudit five-dimension adapter', () => {
  it('creates ZIP project and scan, reports progress and preserves incomplete coverage', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const events: CodeReviewAuditEvent[] = [];
    const progress: unknown[] = [];
    const responses = [
      { access_token: 'private-jwt' }, { id: 'project' }, { task_id: 'scan' },
      { id: 'scan', status: 'running', total_files: 3, scanned_files: 1 },
      { id: 'scan', status: 'completed', total_files: 3, scanned_files: 2 },
      [{ file_path: 'a.ts', line_number: 7, issue_type: 'security', severity: 'high', message: 'SQL injection', suggestion: 'Parameterize query' }],
    ];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit.internal:8000', username: 'service@internal.test', password: 'password',
      pollIntervalMs: 1, fetchImpl: (async (url, init) => { calls.push({ url: String(url), init }); return Response.json(responses.shift()); }) as typeof fetch });
    const result = await engine.run({ taskId: 'cds-id', zip: Buffer.from('zip'), excludePatterns: ['vendor'],
      signal: new AbortController().signal, audit: async (event) => { events.push(event); }, onProgress: async (value) => { progress.push(value); } });
    expect(result.findings[0]).toMatchObject({ filePath: 'a.ts', line: 7, category: 'security', severity: 'high', verified: false });
    expect(result.scannedFiles).toBe(2);
    expect(result.skippedFiles).toBe(1);
    expect(result.notes.join(' ')).toContain('不能视为全量通过');
    expect(calls[2].url).toMatch(/\/scan\/upload-zip$/);
    expect(calls[2].init?.body).toBeInstanceOf(FormData);
    expect(progress).toContainEqual(expect.objectContaining({ engineTaskId: 'scan', scannedFiles: 2 }));
    expect(JSON.stringify(events)).not.toContain('private-jwt');
    expect(JSON.stringify(events)).not.toContain('SQL injection');
    expect(calls.every((call) => !call.url.includes('agent-tasks'))).toBe(true);
  });

  it('resumes an upstream task without resubmitting the ZIP', async () => {
    const urls: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit:8000', token: 'token', fetchImpl: (async (url) => {
      urls.push(String(url)); return String(url).endsWith('/issues') ? Response.json([])
        : Response.json({ id: 'upstream', status: 'completed', total_files: 1, scanned_files: 1 });
    }) as typeof fetch });
    const result = await engine.run({ taskId: 'cds-id', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'upstream',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    expect(result.engineTaskId).toBe('upstream');
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes('/tasks/upstream'))).toBe(true);
  });

  it('propagates failure rather than reporting an empty successful audit', async () => {
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async () =>
      Response.json({ status: 'failed', total_files: 5, scanned_files: 0 })) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'upstream',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow(/失败/);
  });

  it('cancels upstream when interrupted during polling', async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) => {
      urls.push(String(url)); return Response.json({ status: 'running', total_files: 2, scanned_files: 1 });
    }) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'upstream',
      signal: controller.signal, audit: async () => {}, onProgress: async () => { controller.abort(); } })).rejects.toThrow();
    expect(urls.at(-1)).toMatch(/\/tasks\/upstream\/cancel$/);
  });

  it('persists distinct evidence for HTTP error, invalid JSON and timeout', async () => {
    const events: CodeReviewAuditEvent[] = [];
    const audit = async (event: CodeReviewAuditEvent) => { events.push(event); };
    await expect(reviewJsonRequest('status', 'https://deepaudit/api', {}, audit,
      (async () => Response.json({ detail: 'not authorized' }, { status: 403 })) as typeof fetch)).rejects.toThrow(/403/);
    await expect(reviewJsonRequest('status', 'https://deepaudit/api', {}, audit,
      (async () => new Response('not json', { status: 502 })) as typeof fetch)).rejects.toThrow(/解析/);
    await expect(reviewJsonRequest('status', 'https://deepaudit/api', {}, audit,
      (async () => { throw new Error('timeout'); }) as typeof fetch)).rejects.toThrow(/timeout/);
    expect(events.map((event) => event.outcome)).toEqual(['http_error', 'parse_error', 'network_error']);
    expect(events[0].evidence).toContain('not authorized');
    expect(events[2].evidence).toContain('未收到响应');
  });
});
