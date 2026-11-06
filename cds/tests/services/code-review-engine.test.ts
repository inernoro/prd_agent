import { describe, expect, it } from 'vitest';
import { CodeReviewEngine, CodeReviewWorkerStoppedError } from '../../src/services/code-review-engine.js';
import { reviewJsonRequest, type CodeReviewAuditEvent } from '../../src/services/code-review-audit.js';
import { validateCodeReviewZip } from '../../src/services/code-review-source.js';
import { buildZip } from '../../src/utils/zip.js';

describe('DeepAudit five-dimension adapter', () => {
  it('creates ZIP project and scan, reports progress and preserves incomplete coverage', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const events: CodeReviewAuditEvent[] = [];
    const progress: unknown[] = [];
    const responses = [
      { access_token: 'private-jwt' }, { id: 'project' }, { task_id: 'scan' },
      { id: 'scan', status: 'running', total_files: 3, scanned_files: 1, processed_files: 3, failed_files: 1, skipped_files: 1 },
      { id: 'scan', status: 'completed', total_files: 3, scanned_files: 2 },
      [{ file_path: 'a.ts', line_number: 7, issue_type: 'security', severity: 'high', message: 'SQL injection', suggestion: 'Parameterize query' }],
    ];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit.internal:8000', username: 'service@internal.test', password: 'password',
      pollIntervalMs: 1, fetchImpl: (async (url, init) => { calls.push({ url: String(url), init }); return Response.json(responses.shift()); }) as typeof fetch });
    const result = await engine.run({ taskId: 'cds-id', zip: buildZip([{ name: 'a.ts', data: 'const a = 1;' }]), excludePatterns: ['vendor'],
      signal: new AbortController().signal, audit: async (event) => { events.push(event); }, onProgress: async (value) => { progress.push(value); } });
    expect(result.findings[0]).toMatchObject({ filePath: 'a.ts', line: 7, category: 'security', severity: 'high', verified: false });
    expect(result.scannedFiles).toBe(2);
    expect(result.skippedFiles).toBe(1);
    expect(result.notes.join(' ')).toContain('不能视为全量通过');
    expect(calls[2].url).toMatch(/\/scan\/upload-zip$/);
    expect(calls[2].init?.body).toBeInstanceOf(FormData);
    expect(progress).toContainEqual(expect.objectContaining({ engineTaskId: 'scan', scannedFiles: 2 }));
    expect(progress).toContainEqual(expect.objectContaining({ processedFiles: 3, failedFiles: 1, skippedFiles: 1 }));
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
    expect(urls[1]).toBe('http://deepaudit:8000/api/v1/tasks/upstream/issues'); // Legacy keeps the original single-array endpoint.
    expect(urls.every((url) => url.includes('/tasks/upstream'))).toBe(true);
  });

  it.each(['failed', 'cancelled', 'completed'])('explicitly retries a resumable %s task using the same native ID', async (status) => {
    const calls: Array<{ url: string; method?: string }> = [];
    let resumed = false;
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      if (String(url).endsWith('/resume')) { resumed = true; return Response.json({ task_id: 'same-task', status: 'started' }); }
      if (String(url).endsWith('/issues')) return Response.json([{ file_path: 'module/a.ts', message: '已保留的发现' }]);
      return Response.json(resumed ? { status: 'completed', total_files: 40, scanned_files: 40, resumable: false, failed_files: 0 }
        : { status, total_files: 40, scanned_files: 37, resumable: true, failed_files: 3 });
    }) as typeof fetch });
    const result = await engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task', retryFailed: true,
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    expect(result).toMatchObject({ engineTaskId: 'same-task', scannedFiles: 40 });
    expect(calls.filter((call) => call.url.endsWith('/resume'))).toEqual([{ url: 'http://deepaudit/api/v1/tasks/same-task/resume', method: 'POST' }]);
    expect(calls.every((call) => call.url.includes('/tasks/same-task'))).toBe(true);
  });

  it('does not implicitly resume a failed native scan during normal restart tracking', async () => {
    const calls: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) => {
      calls.push(String(url)); return Response.json({ status: 'failed', total_files: 40, scanned_files: 37, resumable: true });
    }) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow('已完成文件的分析结果已保留');
    expect(calls).toEqual(['http://deepaudit/api/v1/tasks/same-task']);
  });

  it.each([true, false])('keeps checkpointed partial completion retryable even when resumable is %s during worker cleanup', async (resumable) => {
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async () =>
      Response.json({ status: 'completed', total_files: 40, scanned_files: 37, failed_files: 3, resumable, checkpoint_version: 1 })) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow(/已分析 37\/40.*重试继续未完成部分/);
  });

  it.each([false, true])('accepts declared native policy skips with truthful coverage, without resuming completed work (retry=%s)', async (retryFailed) => {
    const calls: Array<{ url: string; method?: string }> = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return new URL(String(url)).pathname.endsWith('/issues') ? Response.json([])
        : Response.json({ status: 'completed', checkpoint_version: 1, total_files: 40, scanned_files: 37,
          skipped_files: 3, failed_files: 0, processed_files: 40, resumable: false, issues_count: 0 });
    }) as typeof fetch });
    const result = await engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task', retryFailed,
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    expect(result).toMatchObject({ totalFiles: 40, scannedFiles: 37, skippedFiles: 3, engineTaskId: 'same-task' });
    expect(result.notes).toContain('DeepAudit 按引擎政策跳过 3 个文件；跳过不计为分析成功，不能视为审查通过。');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it.each([0, 2])('does not hide pending or failed files behind declared skips (failed_files=%s)', async (failedFiles) => {
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async () =>
      Response.json({ status: 'completed', checkpoint_version: 1, total_files: 40, scanned_files: 35,
        skipped_files: 3, failed_files: failedFiles, processed_files: 38 + failedFiles, resumable: false })) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow(/已分析 35\/40.*重试继续未完成部分/);
  });

  it.each([41, 4, -1, 1.5, '3'])('rejects invalid native skipped_files=%s instead of fabricating completed coverage', async (skippedFiles) => {
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async () =>
      Response.json({ status: 'completed', checkpoint_version: 1, total_files: 40, scanned_files: 37,
        skipped_files: skippedFiles, failed_files: 0, processed_files: 40, resumable: false })) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow('文件覆盖计数无效');
  });

  it.each([undefined, 0])('falls back to the fixed snapshot only for an explicit retry of legacy checkpoint version %s', async (checkpointVersion) => {
    const calls: string[] = [];
    const snapshot = buildZip([{ name: 'src/a.ts', data: 'const a = 1;' }]);
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith('/tasks/legacy')) return Response.json({ status: 'failed', total_files: 1, scanned_files: 0, checkpoint_version: checkpointVersion });
      if (String(url).endsWith('/projects/')) return Response.json({ id: 'project' });
      if (String(url).endsWith('/scan/upload-zip')) {
        expect(Buffer.from(await ((init!.body as FormData).get('file') as Blob).arrayBuffer())).toEqual(snapshot);
        return Response.json({ task_id: 'replacement' });
      }
      return String(url).endsWith('/issues') ? Response.json([]) : Response.json({ status: 'completed', total_files: 1, scanned_files: 1 });
    }) as typeof fetch });
    const result = await engine.run({ taskId: 'task', zip: snapshot, excludePatterns: [], engineTaskId: 'legacy', retryFailed: true,
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    expect(result.engineTaskId).toBe('replacement'); expect(calls.some((url) => url.endsWith('/resume'))).toBe(false);
  });

  it.each(['failed', 'cancelled', 'completed'])('keeps a checkpointed %s task when native resume is temporarily unavailable', async (status) => {
    const calls: Array<{ url: string; method?: string }> = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return Response.json({ status, total_files: 40, scanned_files: 37, failed_files: 3, resumable: false, checkpoint_version: 1 });
    }) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task', retryFailed: true,
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow(/原生任务暂不可续跑.*已保留原任务编号/);
    expect(calls).toEqual([{ url: 'http://deepaudit/api/v1/tasks/same-task', method: undefined }]);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('does not create a duplicate task when native resume is still busy', async () => {
    const calls: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) => {
      calls.push(String(url)); return String(url).endsWith('/resume') ? Response.json({ detail: 'busy' }, { status: 409 })
        : Response.json({ status: 'cancelled', total_files: 40, scanned_files: 37, resumable: true, checkpoint_version: 1 });
    }) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'same-task', retryFailed: true,
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow('409');
    expect(calls).toHaveLength(2); expect(calls.every((url) => url.includes('/tasks/same-task'))).toBe(true);
  });

  it('retrieves every native finding in stable pages rather than sampling a large repository report', async () => {
    const detail = 'x'.repeat(45_000); // The full result exceeds the 16 MiB per-response bound; each page remains below it.
    const issues = Array.from({ length: 401 }, (_, index) => ({ id: `issue-${String(index).padStart(4, '0')}`, file_path: `module-${index % 4}/file.ts`,
      issue_type: 'bug', severity: 'medium', title: `发现 ${index}`, description: `${detail}完整原因 ${index}`, suggestion: `修复建议 ${index}` }));
    expect(Buffer.byteLength(JSON.stringify(issues))).toBeGreaterThan(16 * 1024 * 1024);
    const offsets: number[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/issues')) {
        expect(target.searchParams.get('limit')).toBe('200');
        const offset = Number(target.searchParams.get('offset')); offsets.push(offset);
        return Response.json(issues.slice(offset, offset + 200));
      }
      return Response.json({ status: 'completed', checkpoint_version: 1, total_files: 40, scanned_files: 40, issues_count: issues.length });
    }) as typeof fetch });
    const result = await engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'native',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    expect(offsets).toEqual([0, 200, 400]); expect(result.findings).toHaveLength(401);
    expect(result.findings.at(-1)?.message.length).toBe('发现 400\n\n完整原因 400'.length + detail.length);
    expect(result.findings.at(-1)?.message.endsWith('完整原因 400')).toBe(true);
    expect(result.findings.at(-1)?.suggestion).toBe('修复建议 400');
  });

  it.each([
    { expected: 2, page: [{ id: 'one', message: '发现' }], error: '与总数不一致' },
    { expected: 1, page: [{ id: 'one' }, { id: 'two' }], error: '与总数不一致' },
    { expected: 2, page: [{ id: 'one' }, { id: 'one' }], error: '编号缺失或重复' },
    { expected: 1, page: [{ message: 'missing id' }], error: '编号缺失或重复' },
    { expected: 201, page: Array.from({ length: 201 }, (_, id) => ({ id: String(id) })), error: '格式无效' },
    { expected: 100001, page: [], error: '安全处理上限' },
  ])('fails explicitly for unsafe native pagination instead of archiving a truncated result: $error', async ({ expected, page, error }) => {
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) =>
      new URL(String(url)).pathname.endsWith('/issues') ? Response.json(page)
        : Response.json({ status: 'completed', checkpoint_version: 1, total_files: 40, scanned_files: 40, issues_count: expected })) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'native',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow(error);
  });

  it('rejects an upstream that repeats a full page instead of looping forever', async () => {
    const offsets: number[] = [];
    const page = Array.from({ length: 200 }, (_, id) => ({ id: String(id), message: '发现' }));
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) => {
      const target = new URL(String(url));
      if (target.pathname.endsWith('/issues')) { offsets.push(Number(target.searchParams.get('offset'))); return Response.json(page); }
      return Response.json({ status: 'completed', checkpoint_version: 1, total_files: 40, scanned_files: 40 });
    }) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'native',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow('编号缺失或重复');
    expect(offsets).toEqual([0, 200]);
  });

  it('sends the fixed snapshot unchanged without replaying boundary-based exclusions as upstream substrings', async () => {
    const excludePatterns = ['cds/src/util'];
    const snapshot = await validateCodeReviewZip(buildZip([
      { name: 'repository/cds/src/utils/zip.ts', data: 'export const selected = true;' },
      { name: 'repository/cds/src/util/omitted.ts', data: 'const excluded = true;' },
    ]), excludePatterns);
    expect(snapshot.totalFiles).toBe(1);
    let upstreamTotal = 0;
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/projects/')) return Response.json({ id: 'project' });
      if (String(url).endsWith('/scan/upload-zip')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init!.body as FormData;
        const scanConfig = JSON.parse(String(form.get('scan_config')));
        expect(scanConfig.exclude_patterns).toEqual([]);
        expect(scanConfig.max_analyze_files).toBe(0);
        expect(scanConfig.file_paths).toEqual(['cds/src/utils/zip.ts']);
        const file = form.get('file');
        expect(file).toBeInstanceOf(Blob);
        expect(Buffer.from(await (file as Blob).arrayBuffer())).toEqual(snapshot.zip);
        // This is DeepAudit's actual substring contract, which must not reinterpret CDS's util rule.
        upstreamTotal = scanConfig.exclude_patterns.some((pattern: string) => 'cds/src/utils/zip.ts'.includes(pattern)) ? 0 : 1;
        return Response.json({ task_id: 'upstream' });
      }
      if (String(url).endsWith('/issues')) return Response.json([]);
      return Response.json({ status: 'completed', total_files: upstreamTotal, scanned_files: upstreamTotal });
    }) as typeof fetch });
    const result = await engine.run({ taskId: 'cds-id', zip: snapshot.zip, excludePatterns,
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    expect(result.totalFiles).toBe(1);
    expect(result.scannedFiles).toBe(1);
    expect(excludePatterns).toEqual(['cds/src/util']); // The task keeps its original configuration as provenance.
  });

  it('submits all repository modules in one native task even when the service account samples twelve files', async () => {
    const files = Array.from({ length: 40 }, (_, index) => ({ name: `${['cds', 'prd-api', 'llmgw', 'prd-admin'][index % 4]}/src/file-${index}.ts`, data: `export const file${index} = ${index};` }));
    const snapshot = await validateCodeReviewZip(buildZip(files));
    let submissions = 0;
    let paths: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/projects/')) return Response.json({ id: 'project' });
      if (String(url).endsWith('/scan/upload-zip')) {
        submissions++;
        const form = init!.body as FormData;
        const config = JSON.parse(String(form.get('scan_config')));
        expect(config.max_analyze_files).toBe(0);
        paths = config.file_paths;
        expect(paths).toEqual(files.map((file) => file.name));
        expect(Buffer.from(await (form.get('file') as Blob).arrayBuffer())).toEqual(snapshot.zip);
        return Response.json({ task_id: 'whole-repository' });
      }
      if (String(url).endsWith('/issues')) return Response.json([]);
      // Actual upstream selection: explicit file_paths take precedence over maxAnalyzeFiles=12.
      const selected = paths.length ? paths : files.slice(0, 12).map((file) => file.name);
      return Response.json({ status: 'completed', total_files: selected.length, scanned_files: selected.length });
    }) as typeof fetch });
    const result = await engine.run({ taskId: 'one-visible-task', zip: snapshot.zip, excludePatterns: [], signal: new AbortController().signal,
      audit: async () => {}, onProgress: async () => {} });
    expect(submissions).toBe(1);
    expect(result).toMatchObject({ engineTaskId: 'whole-repository', totalFiles: 40, scannedFiles: 40, skippedFiles: 0 });
  });

  it('preserves detailed causes from the real ZIP-scanner issue shape without repeating its title', async () => {
    // process_zip_task stores message=title, description=the detailed explanation, suggestion separately.
    const title = '命令拼接可能导致注入';
    const description = '外部输入未经参数化直接拼接到 shell 命令，攻击者可插入额外命令并以服务权限执行。';
    const suggestion = '改用 execFile 并通过参数数组传递外部输入。';
    const issues = [{ file_path: 'server.ts', line_number: 12, issue_type: 'security', severity: 'high',
      title, message: title, description, suggestion },
    { file_path: 'other.ts', issue_type: 'bug', severity: 'low', title: '重复说明', message: ' 重复说明 ', description: '重复说明' }];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) =>
      String(url).endsWith('/issues') ? Response.json(issues)
        : Response.json({ status: 'completed', total_files: 2, scanned_files: 2 })) as typeof fetch });
    const result = await engine.run({ taskId: 'cds-id', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'zip-scan',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    expect(result.findings[0]).toMatchObject({ message: `${title}\n\n${description}`, suggestion });
    expect(result.findings[1].message).toBe('重复说明');
  });

  it('propagates failure rather than reporting an empty successful audit', async () => {
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async () =>
      Response.json({ status: 'failed', total_files: 5, scanned_files: 0 })) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'upstream',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} })).rejects.toThrow(/已分析 0\/5 个文件.*未形成代码质量结论/);
  });

  it.each([
    ['MODEL_POOL_ALL_UNAVAILABLE', '模型服务暂时没有可用模型'],
    ['MODEL_RATE_LIMITED', '模型服务暂时限流'],
    ['MODEL_TIMEOUT', '模型服务响应超时'],
    ['MODEL_AUTH_FAILED', '模型服务认证失败'],
    ['ANALYSIS_FAILED', '请联系管理员检查引擎日志'],
    ['UNKNOWN_PROVIDER_CODE', '请联系管理员检查引擎日志'],
  ])('uses safe optional engine error code %s and never forwards provider details', async (code, expected) => {
    const events: CodeReviewAuditEvent[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async () => Response.json({
      status: 'failed', total_files: 12, scanned_files: 0, error_code: code,
      error_message: 'provider-private-source-and-credential', code_snippet: 'private-source',
    })) as typeof fetch });
    const failed = engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'upstream',
      signal: new AbortController().signal, audit: async (event) => { events.push(event); }, onProgress: async () => {} });
    await expect(failed).rejects.toThrow(expected);
    await expect(failed).rejects.toThrow('已分析 0/12 个文件');
    await expect(failed).rejects.not.toThrow('provider-private');
    const evidence = JSON.stringify(events);
    expect(evidence).not.toContain('provider-private'); expect(evidence).not.toContain('private-source');
    if (code !== 'UNKNOWN_PROVIDER_CODE') expect(evidence).toContain(code);
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

  it('stops local polling without cancelling the upstream task when the CDS worker shuts down', async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url) => {
      urls.push(String(url)); return Response.json({ status: 'running', total_files: 40, scanned_files: 7 });
    }) as typeof fetch });
    await expect(engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'existing-whole-repository',
      signal: controller.signal, audit: async () => {}, onProgress: async () => { controller.abort(new CodeReviewWorkerStoppedError('worker stopped')); } })).rejects.toThrow();
    expect(urls.some((url) => url.endsWith('/cancel'))).toBe(false);
    expect(urls.every((url) => url.endsWith('/tasks/existing-whole-repository'))).toBe(true);
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

  it('refreshes service login once on HTTP 401 and audits both attempts', async () => {
    const statuses = [Response.json({ access_token: 'expired-token' }), Response.json({ detail: 'expired' }, { status: 401 }),
      Response.json({ access_token: 'new-token' }), Response.json({ status: 'completed', total_files: 1, scanned_files: 1 }), Response.json([])];
    const calls: Array<{ url: string; authorization?: string }> = [];
    const events: CodeReviewAuditEvent[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', username: 'service@internal.test', password: 'private',
      fetchImpl: (async (url, init) => { calls.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization') ?? undefined }); return statuses.shift()!; }) as typeof fetch });
    await engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'upstream',
      signal: new AbortController().signal, audit: async (event) => { events.push(event); }, onProgress: async () => {} });
    expect(calls.filter((call) => call.url.endsWith('/auth/login'))).toHaveLength(2);
    expect(calls[1].authorization).toBe('Bearer expired-token');
    expect(calls[3].authorization).toBe('Bearer new-token');
    expect(events.map((event) => event.status)).toEqual([200, 401, 200, 200, 200]);
  });

  it('does not refresh explicit tokens or loop after a second HTTP 401', async () => {
    let logins = 0;
    const fetchImpl = (async (url) => {
      if (String(url).endsWith('/auth/login')) { logins++; return Response.json({ access_token: `token-${logins}` }); }
      return Response.json({ detail: 'expired' }, { status: 401 });
    }) as typeof fetch;
    const run = (engine: CodeReviewEngine) => engine.run({ taskId: 'task', zip: Buffer.alloc(0), excludePatterns: [], engineTaskId: 'upstream',
      signal: new AbortController().signal, audit: async () => {}, onProgress: async () => {} });
    await expect(run(new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'explicit', username: 'user', password: 'pass', fetchImpl }))).rejects.toThrow(/401/);
    expect(logins).toBe(0);
    await expect(run(new CodeReviewEngine({ baseUrl: 'http://deepaudit', username: 'user', password: 'pass', fetchImpl }))).rejects.toThrow(/401/);
    expect(logins).toBe(2);
  });
});
