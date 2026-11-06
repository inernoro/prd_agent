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
import type { CodeReviewEngineResult } from '../../src/services/code-review-engine.js';
import type { CodeReviewTask } from '../../src/shared/code-review.js';
import { createHumanProjectAccessMiddleware } from '../../src/middleware/human-project-access.js';

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
    expect(buildPipelineOverview(state.getProjects(), [], [], [report])).toEqual(buildPipelineOverview(state.getProjects(), [], [], []));
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
