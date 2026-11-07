import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { StateService } from '../../src/services/state.js';
import { CodeReviewService } from '../../src/services/code-review.js';
import { createCodeReviewsRouter } from '../../src/routes/code-reviews.js';
import { buildZip } from '../../src/utils/zip.js';
import { buildReportsOverview } from '../../src/services/acceptance-overview.js';
import { buildPipelineOverview, buildPipelineSeries } from '../../src/services/acceptance-pipeline.js';
import { CodeReviewEngine, type CodeReviewEngineResult } from '../../src/services/code-review-engine.js';
import { publicCodeReviewTask, type CodeReviewTask } from '../../src/shared/code-review.js';
import { createHumanProjectAccessMiddleware } from '../../src/middleware/human-project-access.js';
import { CodeReviewUpstreamHttpError } from '../../src/services/code-review-audit.js';

describe('代码审查任务完整闭环', () => {
  let dir: string, state: StateService, service: CodeReviewService, server: Server | undefined;
  const blobs = new Map<string, Buffer>();
  const reports = new Map<string, string>();
  const run = vi.fn();
  const send = vi.fn();
  const zip = () => buildZip([{ name: 'src/index.ts', data: Buffer.from('const value = 1;') }]);
  const result = (): CodeReviewEngineResult => ({ engineTaskId: 'upstream-1', findings: [{
    filePath: 'index.ts', line: 1, category: 'maintainability', severity: 'low', message: '<script>bad()</script>',
    suggestion: '改进命名', verified: false, tool: 'DeepAudit AI',
  }], totalFiles: 1, scannedFiles: 1, skippedFiles: 0, notes: ['未执行 PoC'] });
  const inputs = { configured: () => true, put: async (id: string, _project: string, data: Buffer) => { blobs.set(id, data); return id; },
    get: async (id: string) => { if (!blobs.has(id)) throw new Error('快照缺失'); return blobs.get(id)!; } };
  const make = () => new CodeReviewService({ state, inputs, engine: { run }, mail: { configured: () => true, send },
    ownerScope: 'test', publicBaseUrl: 'https://cds.example', autoStart: false });
  const submit = (overrides = {}) => service.submit({ projectId: 'a', sourceType: 'zip', zip: zip(), filename: 'source.zip', createdBy: 'test', ...overrides });
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-review-'));
    process.env.CDS_CACHE_BASE = path.join(dir, 'cache');
    state = new StateService(path.join(dir, 'state.json')); state.load();
    for (const id of ['a', 'b']) state.addProject({ id, name: id, slug: id, kind: 'manual', dockerNetwork: `cds-${id}`,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    state.setReportObjectStore({ isConfigured: () => true,
      put: async (meta, content) => { reports.set(meta.id, content); return meta.id; },
      get: async (key) => reports.get(key) ?? null, remove: async (key) => { reports.delete(key); } });
    blobs.clear(); reports.clear(); run.mockReset(); send.mockReset();
    run.mockImplementation(async (input) => {
      await input.onProgress({ phase: '分析中', totalFiles: 1, scannedFiles: 1, engineTaskId: 'upstream-1' });
      return result();
    });
    send.mockResolvedValue(undefined); service = make();
  });
  afterEach(async () => {
    service.stop();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined; await state.flush(); delete process.env.CDS_CACHE_BASE;
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('归档前持久化任务和固定源码，报告可在新 StateService 中读取且正文已转义', async () => {
    const task = await submit(); expect(task.status).toBe('queued');
    const reloaded = new StateService(path.join(dir, 'state.json')); reloaded.load();
    expect(reloaded.getCodeReviewTask(task.id)?.inputKey).toBeTruthy();
    await service.pump();
    const done = service.get(task.id); expect(done.status).toBe('completed');
    const report = state.getAcceptanceReport(done.reportId!)!;
    expect(report.reportType).toBe('code-review'); expect(report.reviewTaskId).toBe(task.id);
    const content = await state.readAcceptanceReportContentAsync(report.id);
    expect(content).toContain('&lt;script&gt;'); expect(content).not.toContain('<script>');
    expect(content).toContain(task.sourceHash!); expect(send).not.toHaveBeenCalled();
  });
  it('邮件失败仅重试投递，不重复扫描和报告归档', async () => {
    send.mockRejectedValueOnce(new Error('SMTP 连接失败'));
    const task = await submit({ email: 'owner@example.com' }); await service.pump();
    expect(service.get(task.id)).toMatchObject({ status: 'completed', delivery: { status: 'failed' } });
    await service.deliver(task.id);
    expect(service.get(task.id).delivery.status).toBe('sent');
    expect(run).toHaveBeenCalledTimes(1); expect(state.listAcceptanceReports('a')).toHaveLength(1);
    expect(send.mock.calls[1][0].url).toContain('/code-reviews?project=a&task=');
    await expect(service.deliver(task.id)).rejects.toThrow('已发送');
  });
  it('报告归档失败后重试复用已完成的引擎任务', async () => {
    const archive = state.createAcceptanceReportAsync.bind(state);
    vi.spyOn(state, 'createAcceptanceReportAsync').mockRejectedValueOnce(new Error('对象存储暂时不可用')).mockImplementation(archive);
    const task = await submit(); await service.pump();
    expect(service.get(task.id)).toMatchObject({ status: 'failed', engineTaskId: 'upstream-1', engineCompleted: true });
    await service.retry(task.id); await service.pump();
    expect(run.mock.calls[1][0].engineTaskId).toBe('upstream-1');
    expect(service.get(task.id).status).toBe('completed'); expect(state.listAcceptanceReports('a')).toHaveLength(1);
  });
  it('引擎零文件结果不得伪装成完成或归档质量报告', async () => {
    run.mockImplementationOnce(async () => ({ ...result(), totalFiles: 0, scannedFiles: 0, findings: [] }));
    const task = await submit(); await service.pump();
    expect(service.get(task.id)).toMatchObject({ status: 'failed', progress: { totalFiles: 1, scannedFiles: 0 } });
    expect(service.get(task.id).error).toContain('已分析 0/1 个文件');
    expect(service.get(task.id).error).toContain('未形成代码质量结论');
    expect(service.get(task.id).reportId).toBeUndefined(); expect(state.listAcceptanceReports('a')).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    await service.retry(task.id); await service.pump();
    expect(run.mock.calls[1][0].engineTaskId).toBeUndefined();
    expect(service.get(task.id).status).toBe('completed');
  });
  it('部分文件成功的归档明确展示剩余文件未完成分析', async () => {
    run.mockImplementation(async (input) => {
      await input.onProgress({ phase: '分析中', totalFiles: 2, scannedFiles: 1, engineTaskId: 'upstream-1' });
      return { ...result(), totalFiles: 2, scannedFiles: 1, skippedFiles: 1 };
    });
    const task = await submit({ zip: buildZip([{ name: 'src/a.ts', data: 'const a = 1;' }, { name: 'src/b.ts', data: 'const b = 2;' }]) }); await service.pump();
    expect(service.get(task.id)).toMatchObject({ status: 'completed', phase: '部分文件未完成分析，报告已归档', progress: { totalFiles: 2, scannedFiles: 1 } });
    expect(service.get(task.id).reportId).toBeTruthy();
  });
  it.each(['zip', 'github'] as const)('%s整仓一次提交一个可见任务，原生部分失败后同编号续跑并归档唯一完整报告', async (sourceType) => {
    const files = Array.from({ length: 40 }, (_, index) => ({ name: `repository/module-${index % 4}/src/file-${index}.ts`, data: `export const value = ${index};` }));
    const archive = buildZip(files);
    const sha = 'a'.repeat(40);
    let uploads = 0, resumes = 0;
    const paths: string[] = [];
    const engine = new CodeReviewEngine({ baseUrl: 'http://deepaudit', token: 'token', fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/projects/')) return Response.json({ id: 'native-project' });
      if (String(url).endsWith('/scan/upload-zip')) {
        uploads++;
        const config = JSON.parse(String((init!.body as FormData).get('scan_config')));
        expect(config.max_analyze_files).toBe(0); paths.push(...config.file_paths);
        expect(paths).toHaveLength(40); expect(paths.every((name) => name.startsWith('module-'))).toBe(true);
        return Response.json({ task_id: 'one-native-task' });
      }
      if (String(url).endsWith('/resume')) { resumes++; return Response.json({ task_id: 'one-native-task', status: 'started' }); }
      if (String(url).endsWith('/issues')) return Response.json([{ file_path: paths[0], title: '已保留的问题', description: '首轮文件分析的原因', suggestion: '修复建议', issue_type: 'bug', severity: 'high' }]);
      return Response.json({ status: 'completed', total_files: 40, scanned_files: resumes ? 40 : 37,
        processed_files: 40, failed_files: resumes ? 0 : 3, resumable: !resumes });
    }) as typeof fetch });
    const makeNative = () => new CodeReviewService({ state, inputs, engine, mail: { configured: () => true, send },
      ownerScope: 'test', publicBaseUrl: 'https://cds.example', autoStart: false });
    vi.stubGlobal('fetch', (async (url) => {
      if (String(url).endsWith(`/zipball/${sha}`)) return new Response(new Uint8Array(archive), { headers: { 'content-type': 'application/zip' } });
      if (String(url).includes('/commits/')) return Response.json({ sha });
      return Response.json({ default_branch: 'main' });
    }) as typeof fetch);
    try {
      service = makeNative();
      const task = await service.submit({ projectId: 'a', sourceType, ...(sourceType === 'zip' ? { zip: archive } : { githubUrl: 'https://github.com/org/repo' }), createdBy: 'test' });
      await service.pump();
      const failed = service.get(task.id);
      expect(failed).toMatchObject({ status: 'failed', engineTaskId: 'one-native-task', progress: { totalFiles: 40, scannedFiles: 37 } });
      expect(failed.error).toContain('已完成文件的分析结果已保留'); expect(failed.reportId).toBeUndefined();
      const original = { sourceHash: failed.sourceHash, inputKey: failed.inputKey };
      expect(uploads).toBe(1); expect(resumes).toBe(0); expect(service.list('a')).toHaveLength(1);
      await service.retry(task.id);
      expect(service.get(task.id).engineRetryRequested).toBe(true);
      expect(publicCodeReviewTask(service.get(task.id))).not.toHaveProperty('engineRetryRequested');
      // The explicit retry intent survives a CDS restart; it is consumed by this one resume attempt.
      service.stop(); service = makeNative(); await service.start();
      await vi.waitFor(() => expect(service.get(task.id).status).toBe('completed'));
      expect(service.get(task.id)).toMatchObject({ ...original, engineTaskId: 'one-native-task', progress: { totalFiles: 40, scannedFiles: 40 } });
      expect(service.get(task.id).commitSha).toBe(sourceType === 'github' ? sha : undefined);
      expect(service.get(task.id).engineRetryRequested).toBeUndefined();
      expect(uploads).toBe(1); expect(resumes).toBe(1); expect(service.list('a')).toHaveLength(1);
      expect(state.listAcceptanceReports('a')).toHaveLength(1);
      const content = await state.readAcceptanceReportContentAsync(service.get(task.id).reportId!);
      expect(content).toContain('40/40'); expect(content).toContain('首轮文件分析的原因'); expect(content).toContain('修复建议');
    } finally { vi.unstubAllGlobals(); }
  });
  it('派发间引擎暂不可用时保留原排队任务，恢复探测后使用原 ID 和源码继续', async () => {
    let available = true;
    run.mockImplementationOnce(async () => { available = false; return result(); });
    service = new CodeReviewService({ state, inputs, resolveEngine: () => available ? { run } : undefined,
      mail: { configured: () => true, send }, ownerScope: 'test', publicBaseUrl: 'https://cds.example', autoStart: false });
    const first = await submit({ idempotencyKey: 'before-runtime-change' });
    const queued = await submit({ title: '等待中的原任务', idempotencyKey: 'after-runtime-change' });
    const original = { id: queued.id, sourceHash: queued.sourceHash, inputKey: queued.inputKey };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await service.pump();
      expect(service.get(first.id).status).toBe('completed');
      expect(service.get(queued.id)).toMatchObject({ ...original, status: 'queued' });
      expect(service.get(queued.id).error).toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(service.get(queued.id)).toMatchObject({ ...original, status: 'queued' });
      expect(run).toHaveBeenCalledTimes(1);
      available = true;
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(service.get(queued.id).status).toBe('completed'));
      expect(service.get(queued.id)).toMatchObject(original);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { service.stop(); vi.useRealTimers(); }
  });
  it('停止服务会清理引擎恢复探测，不再派发仍排队的任务', async () => {
    let available = true;
    service = new CodeReviewService({ state, inputs, resolveEngine: () => available ? { run } : undefined,
      mail: { configured: () => true, send }, ownerScope: 'test', publicBaseUrl: 'https://cds.example', autoStart: false });
    const queued = await submit(); available = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await service.pump();
      service.stop(); available = true;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(service.get(queued.id).status).toBe('queued'); expect(run).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { service.stop(); vi.useRealTimers(); }
  });
  it('连续连接失败每次冷却30秒，保护后续原任务并在恢复后继续而不自动重试失败单', async () => {
    run.mockRejectedValueOnce(new TypeError('fetch failed', { cause: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }) }))
      .mockRejectedValueOnce(new CodeReviewUpstreamHttpError('deepaudit.task_status', 503));
    const first = await submit({ idempotencyKey: 'transport-first' });
    const second = await submit({ idempotencyKey: 'transport-second' });
    const third = await submit({ idempotencyKey: 'transport-third' });
    // 同毫秒提交仍应按原提交顺序执行，不能因列表反转先处理第三单。
    for (const task of [first, second, third]) {
      task.createdAt = '2026-01-01T00:00:00.000Z';
      await state.putCodeReviewTask(task);
    }
    const originals = [second, third].map(({ id, sourceHash, inputKey }) => ({ id, sourceHash, inputKey }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await service.pump();
      expect(service.get(first.id).status).toBe('failed');
      for (const original of originals) expect(service.get(original.id)).toMatchObject({ ...original, status: 'queued' });
      await service.pump(); await vi.advanceTimersByTimeAsync(29_999);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(service.get(second.id).status).toBe('failed'));
      expect(service.get(third.id)).toMatchObject({ ...originals[1], status: 'queued' });
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(service.get(third.id).status).toBe('completed'));
      expect(service.get(third.id)).toMatchObject(originals[1]);
      expect(run.mock.calls.map(([input]) => input.taskId)).toEqual([first.id, second.id, third.id]);
    } finally { service.stop(); vi.useRealTimers(); }
  });
  it.each([
    new Error('ZIP 含不安全路径'),
    new CodeReviewUpstreamHttpError('deepaudit.task_status', 403),
    new Error('DeepAudit 审查引擎执行失败：模型任务未完成'),
  ])('文件、权限或模型任务失败不触发网络冷却：%s', async (error) => {
    run.mockRejectedValueOnce(error);
    const failed = await submit({ idempotencyKey: 'isolated-error' });
    const next = await submit({ idempotencyKey: 'next-after-isolated-error' });
    await service.pump();
    expect(service.get(failed.id).status).toBe('failed'); expect(service.get(next.id).status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('停止服务清理连接故障冷却，不再派发队列', async () => {
    run.mockRejectedValueOnce(new CodeReviewUpstreamHttpError('deepaudit.task_status', 504));
    const failed = await submit({ idempotencyKey: 'cooldown-stop-first' });
    const queued = await submit({ idempotencyKey: 'cooldown-stop-queued' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      await service.pump(); expect(service.get(failed.id).status).toBe('failed');
      service.stop(); await vi.advanceTimersByTimeAsync(60_000);
      expect(service.get(queued.id).status).toBe('queued'); expect(run).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { service.stop(); vi.useRealTimers(); }
  });
  it('并发重复提交幂等且不同项目保持隔离', async () => {
    const [a, b] = await Promise.all([submit({ idempotencyKey: 'same' }), submit({ idempotencyKey: 'same' })]);
    expect(a.id).toBe(b.id); expect(service.list('b')).toEqual([]);
    expect(await submit({ projectId: 'b', idempotencyKey: 'same' })).not.toMatchObject({ id: a.id });
  });
  it('取消后异步扫描结果不得覆盖取消状态或归档报告', async () => {
    let entered!: () => void; const ready = new Promise<void>((resolve) => { entered = resolve; });
    run.mockImplementation(async (input) => {
      await input.onProgress({ phase: '分析中', totalFiles: 1, scannedFiles: 0, engineTaskId: 'upstream-1' });
      entered(); await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      return result();
    });
    const task = await submit(); const pumping = service.pump(); await ready;
    await service.cancel(task.id); await pumping;
    expect(service.get(task.id).status).toBe('cancelled'); expect(state.listAcceptanceReports()).toHaveLength(0);
  });
  it('实例重启恢复已知引擎编号，重复恢复不重复归档', async () => {
    const task = await submit(); task.status = 'running'; task.engineTaskId = 'upstream-1'; await state.putCodeReviewTask(task);
    service = make(); await service.start(); await vi.waitFor(() => expect(service.get(task.id).status).toBe('completed'));
    expect(run.mock.calls[0][0].engineTaskId).toBe('upstream-1');
    service = make(); await service.start(); await service.pump();
    expect(run).toHaveBeenCalledTimes(1); expect(state.listAcceptanceReports()).toHaveLength(1);
  });
  it('持续推进的整仓任务超过两小时仍可用一个任务归档一份报告', async () => {
    const files = Array.from({ length: 14 }, (_, index) => ({ name: `module-${index}/index.ts`, data: `export const value = ${index};` }));
    let finish!: () => void;
    run.mockImplementation(async (input) => {
      await input.onProgress({ phase: '整仓分析中', totalFiles: files.length, scannedFiles: 0, engineTaskId: 'whole-repository' });
      return new Promise<CodeReviewEngineResult>((resolve, reject) => {
        finish = () => resolve({ ...result(), engineTaskId: 'whole-repository', totalFiles: files.length, scannedFiles: files.length });
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
    });
    const task = await submit({ zip: buildZip(files) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pumping = service.pump();
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      for (let scanned = 1; scanned <= 13; scanned++) {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await run.mock.calls[0][0].onProgress({ phase: '整仓分析中', totalFiles: files.length, scannedFiles: scanned, engineTaskId: 'whole-repository' });
      }
      expect(run.mock.calls[0][0].signal.aborted).toBe(false);
      finish(); await pumping;
      expect(service.get(task.id)).toMatchObject({ status: 'completed', engineTaskId: 'whole-repository', progress: { totalFiles: 14, scannedFiles: 14 } });
      expect(run).toHaveBeenCalledTimes(1); expect(state.listAcceptanceReports('a')).toHaveLength(1);
    } finally { service.stop(); vi.useRealTimers(); }
  });
  it('重复状态轮询不延长文件空闲超时，失败仍保留已有覆盖与原引擎编号', async () => {
    vi.stubEnv('CDS_CODE_REVIEW_IDLE_TIMEOUT_MS', '60000');
    let entered = false;
    run.mockImplementation(async (input) => {
      await input.onProgress({ phase: '整仓分析中', totalFiles: 40, scannedFiles: 7, engineTaskId: 'whole-repository' });
      entered = true;
      return new Promise<CodeReviewEngineResult>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    });
    const task = await submit();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pumping = service.pump(); await vi.waitFor(() => expect(entered).toBe(true));
      for (let index = 0; index < 2; index++) {
        await vi.advanceTimersByTimeAsync(20_000);
        await run.mock.calls[0][0].onProgress({ phase: '仍在轮询', totalFiles: 40, scannedFiles: 7, engineTaskId: 'whole-repository' });
      }
      await vi.advanceTimersByTimeAsync(20_000); await pumping;
      expect(service.get(task.id)).toMatchObject({ status: 'failed', engineTaskId: 'whole-repository', progress: { totalFiles: 40, scannedFiles: 7 } });
      expect(service.get(task.id).error).toContain('长时间没有文件分析进展');
      expect(state.listAcceptanceReports('a')).toHaveLength(0);
    } finally { service.stop(); vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it.each(['processedFiles', 'failedFiles', 'skippedFiles'])('%s实际增加可延长空闲期限，同值轮询最终仍超时', async (counter) => {
    vi.stubEnv('CDS_CODE_REVIEW_IDLE_TIMEOUT_MS', '60000');
    let entered = false;
    run.mockImplementation(async (input) => {
      await input.onProgress({ phase: '整仓分析中', totalFiles: 40, scannedFiles: 7, engineTaskId: 'whole-repository', [counter]: 0 });
      entered = true;
      return new Promise<CodeReviewEngineResult>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    });
    const task = await submit();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pumping = service.pump(); await vi.waitFor(() => expect(entered).toBe(true));
      for (let count = 1; count <= 3; count++) {
        await vi.advanceTimersByTimeAsync(40_000);
        await run.mock.calls[0][0].onProgress({ phase: '整仓分析中', totalFiles: 40, scannedFiles: 7, engineTaskId: 'whole-repository', [counter]: count });
        expect(run.mock.calls[0][0].signal.aborted).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(40_000);
      await run.mock.calls[0][0].onProgress({ phase: '重复状态', totalFiles: 40, scannedFiles: 7, engineTaskId: 'whole-repository', [counter]: 3 });
      await vi.advanceTimersByTimeAsync(20_000); await pumping;
      expect(service.get(task.id).status).toBe('failed'); expect(service.get(task.id).error).toContain('长时间没有文件分析进展');
      expect(service.get(task.id).progress.scannedFiles).toBe(7);
    } finally { service.stop(); vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it('整仓最长执行时间可配置且下限一小时，不无限等待', async () => {
    vi.stubEnv('CDS_CODE_REVIEW_MAX_DURATION_MS', '1');
    vi.stubEnv('CDS_CODE_REVIEW_IDLE_TIMEOUT_MS', String(6 * 60 * 60_000));
    let entered = false;
    run.mockImplementation(async (input) => {
      await input.onProgress({ phase: '整仓分析中', totalFiles: 40, scannedFiles: 1, engineTaskId: 'whole-repository' });
      entered = true;
      return new Promise<CodeReviewEngineResult>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    });
    const task = await submit();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pumping = service.pump(); await vi.waitFor(() => expect(entered).toBe(true));
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 1000);
      expect(run.mock.calls[0][0].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000); await pumping;
      expect(service.get(task.id).status).toBe('failed'); expect(service.get(task.id).error).toContain('最长执行时间');
    } finally { service.stop(); vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it('CDS停止仅暂停本地跟踪，重启保持同一引擎编号和已分析进度', async () => {
    let entered = false;
    run.mockImplementationOnce(async (input) => {
      await input.onProgress({ phase: '整仓分析中', totalFiles: 40, scannedFiles: 7, engineTaskId: 'whole-repository' });
      entered = true;
      return new Promise<CodeReviewEngineResult>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    });
    const task = await submit(); const pumping = service.pump(); await vi.waitFor(() => expect(entered).toBe(true));
    service.stop(); await pumping;
    expect(run.mock.calls[0][0].signal.reason.constructor.name).toBe('CodeReviewWorkerStoppedError');
    expect(service.get(task.id)).toMatchObject({ status: 'running', engineTaskId: 'whole-repository', progress: { totalFiles: 40, scannedFiles: 7 } });
    run.mockImplementationOnce(async (input) => {
      expect(input.engineTaskId).toBe('whole-repository');
      await input.onProgress({ phase: '恢复跟踪', totalFiles: 0, scannedFiles: 0, engineTaskId: 'whole-repository' });
      expect(service.get(task.id).progress.scannedFiles).toBe(7);
      return { ...result(), engineTaskId: 'whole-repository', totalFiles: 40, scannedFiles: 40 };
    });
    service = make(); await service.start(); await vi.waitFor(() => expect(service.get(task.id).status).toBe('completed'));
    expect(run).toHaveBeenCalledTimes(2); expect(state.listAcceptanceReports('a')).toHaveLength(1);
  });
  it('所有上游尝试保留可分页的对象证据，不随元数据摘要截断而丢失', async () => {
    run.mockImplementation(async (input) => {
      for (let i = 0; i < 23; i++) await input.audit({ operation: 'deepaudit.status', sequence: i, outcome: 'success' });
      return result();
    });
    const task = await submit(); await service.pump();
    expect(service.get(task.id).audit).toHaveLength(20);
    const page = await service.auditPage(task.id);
    expect(page.events).toHaveLength(23); expect(page.events.at(-1)).toMatchObject({ sequence: 0 });
  });
  it('重启时无引擎编号的运行任务明确失败，不偷偷创建第二次扫描', async () => {
    const task = await submit(); task.status = 'running'; await state.putCodeReviewTask(task);
    service = make(); await service.start();
    expect(service.get(task.id).status).toBe('failed'); expect(run).not.toHaveBeenCalled();
  });
  it('审查报告保留在台账但不影响验收通过率、发布闸和合并覆盖', async () => {
    const now = new Date();
    const report = state.createAcceptanceReport({ title: `代码审查报告 · main · ${now.toISOString().slice(0, 10)}`, format: 'md',
      content: '# review', projectId: 'a', reportType: 'code-review', verdict: 'fail', defectCounts: { p0: 10 }, commitSha: 'a'.repeat(40) });
    const overview = buildReportsOverview([report], []);
    expect(overview.totals.counted).toBe(0); expect(overview.reports).toHaveLength(1);
    expect(overview.releaseGate.state).toBe('unknown'); expect(overview.passRate.denominator).toBe(0);
    expect(buildPipelineOverview(state.getProjects(), [], [], [report], { now })).toEqual(buildPipelineOverview(state.getProjects(), [], [], [], { now }));
    expect(buildPipelineSeries(state.getProjects(), [], [report], { now })).toEqual(buildPipelineSeries(state.getProjects(), [], [], { now }));
  });
  async function serve() {
    const app = express();
    app.use((req, _res, next) => {
      if (req.headers['x-project']) (req as any).cdsProjectKey = { projectId: req.headers['x-project'], keyId: 'test' };
      if (req.headers['x-human']) {
        (req as any).cdsUser = { id: String(req.headers['x-human']), authProvider: 'local', isSystemOwner: false };
        (req as any).cdsSession = {};
      }
      next();
    });
    app.use(createHumanProjectAccessMiddleware(state));
    app.use('/api', createCodeReviewsRouter({ state, service }));
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return `http://127.0.0.1:${(server.address() as any).port}/api/code-reviews`;
  }
  it('结构化结果持久化后可独立读取，分页与原始报告不触发再次分析', async () => {
    run.mockImplementation(async () => ({ ...result(), findings: Array.from({ length: 125 }, (_, i) => ({
      ...result().findings[0], severity: i < 3 ? 'high' : 'low', title: `问题 ${i}`, codeSnippet: '<script>not executed</script>', aiExplanation: '原始解释',
    })) }));
    const task = await submit(); await service.pump(); await state.flush();
    expect(state.getCodeReviewTask(task.id)?.resultKey).toBeTruthy();
    expect(publicCodeReviewTask(service.get(task.id))).not.toHaveProperty('resultKey');
    const original = await state.readAcceptanceReportContentAsync(service.get(task.id).reportId!);
    const restored = new StateService(path.join(dir, 'state.json')); restored.load();
    state = restored; service = make();
    const first = await service.result(task.id, { limit: 2 });
    expect(first.result).toMatchObject({ projectId: 'a', taskId: task.id, summary: { high: 3, low: 122 },
      page: { offset: 0, limit: 2, total: 125, nextOffset: 2 }, coverage: { complete: true, scannedFiles: 1, totalFiles: 1 } });
    expect(first.result?.findings[0]).toMatchObject({ codeSnippet: '<script>not executed</script>', aiExplanation: '原始解释', verified: false });
    expect((await service.result(task.id, { offset: 124, limit: 2 })).result?.page.nextOffset).toBeNull();
    expect((await service.result(task.id, { severity: 'high', query: '问题 1' })).result?.page.total).toBe(1);
    expect(first.reportUrl).toContain(`project=a&task=${task.id}&report=1`);
    expect(original).toContain('代码审查报告'); expect(run).toHaveBeenCalledTimes(1);
  });
  it('读取既有中断任务只取回原生结果并缓存，不重试、不归档、不改变失败状态', async () => {
    const readExisting = vi.fn(async () => ({ ...result(), totalFiles: 2, scannedFiles: 1 }));
    run.mockImplementationOnce(async input => {
      await input.onProgress({ totalFiles: 2, scannedFiles: 1, phase: '分析中', engineTaskId: 'stopped-native' });
      throw new Error('模型服务不可用');
    });
    service = new CodeReviewService({ ...service.deps, engine: { run, readExisting } });
    const task = await submit(); await service.pump();
    const pages = await Promise.all([service.result(task.id), service.result(task.id)]);
    expect(pages[0]).toMatchObject({ result: null, resultLoading: true });
    await vi.waitFor(async () => expect((await service.result(task.id)).result).toMatchObject({ coverage: { complete: false, scannedFiles: 1, totalFiles: 2 }, findings: [{ verified: false }] }));
    await service.result(task.id);
    expect(readExisting).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
    expect(service.get(task.id)).toMatchObject({ status: 'failed', engineTaskId: 'stopped-native' });
    expect(service.get(task.id).reportId).toBeUndefined(); expect(state.listAcceptanceReports('a')).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    const base = await serve();
    const downloaded = await fetch(`${base}/${task.id}/report/download`, { headers: { 'x-project': 'a' } });
    expect(downloaded.status).toBe(200); expect(await downloaded.text()).toContain('部分代码审查结果');
    expect(service.get(task.id).status).toBe('failed'); expect(state.listAcceptanceReports('a')).toHaveLength(0);
    expect(readExisting).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
    await service.retry(task.id);
    expect(service.get(task.id).resultKey).toBeUndefined(); expect(service.get(task.id).findingsSummary).toBeUndefined();
    expect((await service.result(task.id)).result).toBeNull(); expect(readExisting).toHaveBeenCalledTimes(1);
  });
  it('一万多条中断结果在后台单次整理，HTTP立即返回可轮询状态并复用热缓存', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const readExisting = vi.fn(async () => { await gate; return { ...result(), findings: Array.from({ length: 14_441 }, () => result().findings[0]) }; });
    run.mockImplementationOnce(async input => { await input.onProgress({ totalFiles: 2, scannedFiles: 1, phase: '已停止', engineTaskId: 'large-native' }); throw new Error('模型已停止'); });
    service = new CodeReviewService({ ...service.deps, engine: { run, readExisting } });
    const task = await submit(); await service.pump(); const base = await serve();
    const response = await fetch(`${base}/${task.id}?includeResult=1`, { headers: { 'x-project': 'a' } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: null, resultLoading: true, task: { status: 'failed' } });
    await service.result(task.id); expect(readExisting).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(async () => expect((await service.result(task.id, { limit: 2 })).result?.page.total).toBe(14_441));
    const read = vi.spyOn(inputs, 'get');
    expect((await service.result(task.id, { offset: 100, limit: 2 })).result?.findings).toHaveLength(2);
    expect(read).not.toHaveBeenCalled(); expect(run).toHaveBeenCalledTimes(1);
    expect(service.get(task.id)).toMatchObject({ status: 'failed', progress: { totalFiles: 2, scannedFiles: 1 } });
    expect(state.listAcceptanceReports('a')).toHaveLength(0);
  });
  it('整理错误作为结果读取状态返回，冷却期间不重复请求且不产生未处理拒绝', async () => {
    const readExisting = vi.fn().mockRejectedValue(new Error('private upstream failure'));
    run.mockImplementationOnce(async input => { await input.onProgress({ totalFiles: 2, scannedFiles: 1, phase: '已停止', engineTaskId: 'error-native' }); throw new Error('模型已停止'); });
    service = new CodeReviewService({ ...service.deps, engine: { run, readExisting } });
    const task = await submit(); await service.pump();
    expect((await service.result(task.id)).resultLoading).toBe(true);
    await vi.waitFor(async () => expect((await service.result(task.id)).resultLoading).toBe(false));
    const failed = await service.result(task.id); expect(failed.result).toBeNull(); expect(failed.resultUnavailableReason).toContain('稍后重新读取');
    expect(JSON.stringify(failed)).not.toContain('private upstream failure'); expect(readExisting).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(1);
  });
  it('停止CDS会中止已有结果整理，不将停止后的响应写成新结果', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let signal!: AbortSignal;
    const readExisting = vi.fn(async (_id, input) => { signal = input.signal; await gate; return result(); });
    run.mockImplementationOnce(async input => { await input.onProgress({ totalFiles: 2, scannedFiles: 1, phase: '已停止', engineTaskId: 'shutdown-native' }); throw new Error('模型已停止'); });
    service = new CodeReviewService({ ...service.deps, engine: { run, readExisting } });
    const task = await submit(); await service.pump(); await service.result(task.id);
    service.stop(); expect(signal.aborted).toBe(true); release();
    await vi.waitFor(async () => expect((await service.result(task.id)).resultLoading).toBe(false));
    expect(service.get(task.id).resultKey).toBeUndefined(); expect(service.get(task.id).status).toBe('failed'); expect(readExisting).toHaveBeenCalledTimes(1);
  });
  it('结果接口沿用项目权限并拒绝无效分页，失败与无报告不冒充零问题', async () => {
    const task = await submit(); const base = await serve();
    const read = async (suffix: string, projectId = 'a') => fetch(`${base}/${task.id}?includeResult=1${suffix}`, { headers: { 'x-project': projectId } });
    expect((await read('', 'b')).status).toBe(403);
    for (const suffix of ['&offset=-1', '&limit=101', '&limit=0', '&severity=unknown', '&offset=Infinity']) expect((await read(suffix)).status).toBe(400);
    const pending = await (await read('')).json();
    expect(pending.result).toBeNull(); expect(pending.resultUnavailableReason).toContain('尚无已保存');
    await service.pump();
    const completed = await (await read('&limit=1')).json();
    expect(completed.result.findings).toHaveLength(1); expect(completed.result.page.total).toBe(1);
    expect(completed.task).not.toHaveProperty('resultKey'); expect(completed.task).not.toHaveProperty('inputKey');
    expect((await (await fetch(`${base}/${task.id}`, { headers: { 'x-project': 'a' } })).json())).not.toHaveProperty('result');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('能力声明条件重试，HTTP匹配失败版本时仍使用原任务与固定源码', async () => {
    run.mockRejectedValueOnce(new Error('模型任务失败'));
    const task = await submit(); await service.pump(); const failed = service.get(task.id); const base = await serve();
    expect((await (await fetch(`${base}/capabilities`, { headers: { 'x-project': 'a' } })).json()).conditionalRetry).toBe(true);
    const response = await fetch(`${base}/${task.id}/retry`, { method: 'POST', headers: { 'x-project': 'a', 'X-CDS-Review-Expected-Updated-At': failed.updatedAt } });
    expect(response.status).toBe(200);
    expect(service.get(task.id)).toMatchObject({ status: 'queued', id: task.id, sourceHash: failed.sourceHash, inputKey: failed.inputKey });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('人工重试后又取消时，守护的旧条件重试被拒绝且不会复活已取消任务', async () => {
    run.mockRejectedValueOnce(new Error('模型任务失败'));
    const task = await submit(); await service.pump(); const failed = service.get(task.id); const base = await serve();
    expect((await fetch(`${base}/${task.id}/retry`, { method: 'POST', headers: { 'x-project': 'a' } })).status).toBe(200);
    expect((await fetch(`${base}/${task.id}/cancel`, { method: 'POST', headers: { 'x-project': 'a' } })).status).toBe(200);
    const cancelled = service.get(task.id);
    const response = await fetch(`${base}/${task.id}/retry`, { method: 'POST', headers: { 'x-project': 'a', 'X-CDS-Review-Expected-Updated-At': failed.updatedAt } });
    expect(response.status).toBe(409); expect(service.get(task.id)).toEqual(cancelled);
    expect(cancelled).toMatchObject({ status: 'cancelled', id: task.id, sourceHash: failed.sourceHash, inputKey: failed.inputKey });
    expect(run).toHaveBeenCalledTimes(1);
    // An explicit human retry without the conditional header still supports cancelled tasks.
    expect((await fetch(`${base}/${task.id}/retry`, { method: 'POST', headers: { 'x-project': 'a' } })).status).toBe(200);
  });
  it('失败状态的updatedAt改变也拒绝旧条件重试，不修改原任务', async () => {
    run.mockRejectedValueOnce(new Error('模型任务失败'));
    const task = await submit(); await service.pump(); const failed = service.get(task.id); const expected = failed.updatedAt;
    failed.updatedAt = new Date(Date.parse(expected) + 1).toISOString(); await state.putCodeReviewTask(failed);
    const base = await serve();
    const response = await fetch(`${base}/${task.id}/retry`, { method: 'POST', headers: { 'x-project': 'a', 'X-CDS-Review-Expected-Updated-At': expected } });
    expect(response.status).toBe(409); expect(service.get(task.id)).toEqual(failed);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('条件检查到入队内存写入不跨await，并发取消后第二个条件重试不能改写状态', async () => {
    run.mockRejectedValueOnce(new Error('模型任务失败'));
    const task = await submit(); await service.pump(); const failed = service.get(task.id);
    const persist = state.putCodeReviewTask.bind(state);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(state, 'putCodeReviewTask').mockImplementation((next) => {
      const flushed = persist(next); // Original StateService replaces its in-memory row before its first await.
      return next.status === 'queued' ? flushed.then(() => gate) : flushed;
    });
    const retrying = service.retry(task.id, failed.updatedAt);
    expect(service.get(task.id).status).toBe('queued');
    await service.cancel(task.id);
    const cancelled = service.get(task.id);
    await expect(service.retry(task.id, failed.updatedAt)).rejects.toMatchObject({ status: 409 });
    expect(service.get(task.id)).toEqual(cancelled);
    release(); await retrying;
    expect(service.get(task.id)).toEqual(cancelled);
    expect(service.get(task.id)).toMatchObject({ status: 'cancelled', id: task.id, sourceHash: failed.sourceHash });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('真实 HTTP ZIP 上传、状态、报告读取和跨项目拒绝', async () => {
    const base = await serve(); const form = new FormData();
    form.set('projectId', 'a'); form.set('sourceType', 'zip'); form.set('file', new Blob([new Uint8Array(zip())]), 'source.zip');
    const posted = await fetch(base, { method: 'POST', headers: { 'x-project': 'a' }, body: form });
    expect(posted.status).toBe(202); const task = (await posted.json()).task;
    expect(task.inputKey).toBeUndefined(); expect(task.ownerScope).toBeUndefined();
    await service.pump();
    expect((await fetch(`${base}/${task.id}/report`, { headers: { 'x-project': 'a' } })).status).toBe(200);
    expect((await fetch(`${base}/${task.id}`, { headers: { 'x-project': 'b' } })).status).toBe(403);
    expect((await fetch(`${base}/${task.id}/report/download`, { headers: { 'x-project': 'b' } })).status).toBe(403);
    const listed = await (await fetch(base, { headers: { 'x-project': 'b' } })).json(); expect(listed.tasks).toEqual([]);
  });
  it('已有报告上传按内容去重、生成可阅读任务且不会自动分享', async () => {
    const base = await serve();
    const post = () => fetch(`${base}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-project': 'a' },
      body: JSON.stringify({ projectId: 'a', title: '人工复核', format: 'md', content: '# 人工报告' }) });
    const first = await post(); expect(first.status).toBe(201); const data = await first.json();
    expect(data.report.shareToken).toBeFalsy(); expect(data.report.reportType).toBe('code-review');
    expect((await post()).status).toBe(200); expect(state.listAcceptanceReports('a')).toHaveLength(1);
    expect((await fetch(`${base}/${data.task.id}/report`, { headers: { 'x-project': 'a' } })).status).toBe(200);
  });
  it('普通项目成员仅能阅读获授权项目的报告，未授权成员不能借任务编号越权', async () => {
    state.addProjectGrant({ id: 'grant-a', principalId: 'human:member', projectId: 'a', origin: 'approved',
      grantedAt: new Date().toISOString(), grantedBy: 'owner' });
    const task = await submit(); await service.pump(); const base = await serve();
    expect((await fetch(`${base}/${task.id}/report`, { headers: { 'x-human': 'member' } })).status).toBe(200);
    expect((await fetch(`${base}/${task.id}/report`, { headers: { 'x-human': 'stranger' } })).status).toBe(403);
    expect((await (await fetch(base, { headers: { 'x-human': 'stranger' } })).json()).tasks).toEqual([]);
  });
});
