import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { AcceptanceTaskService } from '../../src/services/acceptance-tasks.js';
import { createReportObjectStore } from '../../src/services/report-object-store.js';
import { createReportsRouter } from '../../src/routes/reports.js';
import { createAcceptanceTasksRouter } from '../../src/routes/acceptance-tasks.js';
import type { AcceptanceReportSource, AcceptanceTask } from '../../src/acceptance-types.js';

describe('结构化任务 → 既有归档 → 绑定：真实 HTTP 闭环', () => {
  let dir: string, state: StateService, tasks: AcceptanceTaskService, server: http.Server;
  let task: AcceptanceTask, source: AcceptanceReportSource, base: string;
  let configuredStore: ReturnType<typeof createReportObjectStore>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-task-report-'));
    process.env.CDS_CACHE_BASE = path.join(dir, 'cache');
    state = new StateService(path.join(dir, 'state.json')); state.load();
    state.addProject({ id: 'p1', slug: 'p1', name: '项目一', kind: 'git', createdAt: '', updatedAt: '' });
    const bucket = new Map<string, Buffer>();
    configuredStore = createReportObjectStore({ endpoint: 'https://objects.example.test', bucket: 'tests', accessKeyId: 'fixture', secretAccessKey: 'fixture' }, {
      upload: async (o) => { bucket.set(o.objectKey, o.body); return { objectKey: o.objectKey, bytes: o.body.length, sha256: 'fixture' }; },
      fetchObject: async (o) => bucket.get(o.objectKey) ?? null,
      remove: async (o) => { bucket.delete(o.objectKey); },
    });
    state.setReportObjectStore(configuredStore);
    tasks = new AcceptanceTaskService(state);
    const template = await tasks.publishTemplate({ projectId: 'p1', title: '核心功能', cases: [{
      caseId: 'WEB-001', title: '公开页面正文可读', module: '网页托管', criticality: 'core', environments: ['production'],
      breadcrumb: ['首页', '网页托管'], entryPath: '/web-pages', preconditions: [], inputs: [],
      steps: [{ id: 'open', action: '打开本轮分享页', expected: '出现正确正文' }], assertions: [{ id: 'body', description: '正文一致' }],
      evidenceRequired: true, cleanup: 'required', cleanupInstructions: '撤销分享并删除本轮站点', owner: '网页负责人',
    }] });
    task = await tasks.createTask({ projectId: 'p1', templateId: template.id, environment: 'production' });
    const claimed = await tasks.claim(task.id, '测试执行者');
    await tasks.submit(task.id, 'WEB-001', claimed.leaseToken, { submissionId: 'result-1', status: 'pass', actual: '正文正确', assertions: [{ id: 'body', passed: true, actual: '逐字一致' }], evidence: [{ kind: 'image', url: 'https://images.example.test/body.png', caption: '分享页正文' }], cleanup: { status: 'pass', details: '撤销且回读无残留' } });
    await tasks.complete(task.id, claimed.leaseToken); source = tasks.reportSource(task.id);
    const app = express();
    app.use((req, _res, next) => {
      if (req.header('x-test-project')) (req as any).cdsProjectKey = { projectId: req.header('x-test-project'), keyId: 'fixture' };
      if (req.header('x-test-global')) (req as any).cdsAccess = { keyId: 'fixture', access: { projects: [] } };
      next();
    });
    app.use('/api/acceptance', createAcceptanceTasksRouter({ service: tasks }));
    app.use('/api', createReportsRouter({ stateService: state }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await state.flush(); delete process.env.CDS_CACHE_BASE; vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function request(method: string, route: string, body?: unknown, headers = { 'x-test-project': 'p1' } as Record<string, string>) {
    const response = await fetch(base + route, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  const payload = (s: AcceptanceReportSource) => ({ ...s, projectId: 'p1', folderPath: '核心功能巡检' });

  it('并发重试归档只建一份，绑定仍待验真且历史不能改写', async () => {
    const pair = await Promise.all([request('POST', '/api/reports', payload(source)), request('POST', '/api/reports', payload(source))]);
    expect(pair.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(pair[0].body.report.id).toBe(pair[1].body.report.id);
    expect(state.listAcceptanceReports('p1')).toHaveLength(1);
    const report = pair[0].body.report;
    expect(report).toMatchObject({ sourceId: task.id, storage: 'object' });
    const bound = await request('POST', `/api/acceptance/tasks/${task.id}/bind-report`, { reportId: report.id });
    expect(bound.status).toBe(200); expect(bound.body.report.verification).toBe('pending');
    expect((await request('PATCH', `/api/reports/${report.id}`, { content: '# 假通过', verdict: 'pass' })).status).toBe(409);
    expect((await request('DELETE', `/api/reports/${report.id}`)).status).toBe(409);
    expect((await request('PATCH', `/api/reports/${report.id}`, { folderId: null })).status).toBe(200);
    expect(await state.readAcceptanceReportContentAsync(report.id)).toBe(source.content);
  });
  it('伪造正文或结论被准入拒绝，不产生报告元数据', async () => {
    expect((await request('POST', '/api/reports', { ...payload(source), content: '# 不是任务结果' })).status).toBe(422);
    expect((await request('POST', '/api/reports', { ...payload(source), verdict: 'fail' })).status).toBe(422);
    expect(state.listAcceptanceReports('p1')).toHaveLength(0);
  });
  it('报告还未绑定也不能改写，避免异步绑定竞态', async () => {
    const created = await request('POST', '/api/reports', payload(source));
    expect((await request('PATCH', `/api/reports/${created.body.report.id}`, { sourceId: 'other' })).status).toBe(409);
  });
  it('普通报告不能通过更新来源冒充任务报告，也不能阻断规范归档', async () => {
    const ordinary = await request('POST', '/api/reports', { title: '普通说明', format: 'md', content: '# 普通正文', projectId: 'p1', sourceId: 'ordinary-doc' });
    expect(ordinary.status).toBe(201);
    const refused = await request('PATCH', `/api/reports/${ordinary.body.report.id}`, { sourceId: task.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('task_report_association_readonly');
    expect(state.getAcceptanceReport(ordinary.body.report.id)?.sourceId).toBe('ordinary-doc');
    const archived = await request('POST', '/api/reports', payload(source));
    expect(archived.status).toBe(201);
    expect(archived.body.report.id).not.toBe(ordinary.body.report.id);
    expect((await request('POST', `/api/acceptance/tasks/${task.id}/bind-report`, { reportId: archived.body.report.id })).status).toBe(200);
    expect((await request('PATCH', `/api/reports/${ordinary.body.report.id}`, { content: '# 普通修订' })).status).toBe(200);
  });
  it('输入含图片且访问域名变化时归档、绑定和重试仍使用创建时的规范正文', async () => {
    vi.stubEnv('CDS_PUBLIC_BASE_URL', '');
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j+ioAAAAASUVORK5CYII=';
    const template = await tasks.publishTemplate({ projectId: 'p1', title: '图片输入', cases: [{ ...task.cases[0], inputs: [{ name: '参考图', value: image }] }] });
    const imageTask = await tasks.createTask({ projectId: 'p1', templateId: template.id, environment: 'production' });
    const claim = await tasks.claim(imageTask.id, 'A');
    await tasks.submit(imageTask.id, 'WEB-001', claim.leaseToken, { ...tasks.getTask(task.id).results['WEB-001'], submissionId: 'image-result', actual: `已核对参考图 ${image}。` });
    await tasks.complete(imageTask.id, claim.leaseToken);
    const imageSource = tasks.reportSource(imageTask.id);
    const archived = await request('POST', '/api/reports', { ...payload(imageSource), inlineAssetBaseUrl: 'https://untrusted.example.test' }, { 'x-test-project': 'p1', 'x-forwarded-host': 'archive.example.test' });
    expect(archived.status).toBe(201);
    const reportId = archived.body.report.id;
    expect(archived.body.report.inlineAssetBaseUrl).toBe('http://archive.example.test');
    const content = await state.readAcceptanceReportContentAsync(reportId);
    expect(content).not.toContain('data:image/');
    expect(content).toContain('/api/reports/assets/');
    expect(content).toContain('http://archive.example.test/api/reports/assets/');
    expect((await request('POST', `/api/acceptance/tasks/${imageTask.id}/bind-report`, { reportId }, { 'x-test-project': 'p1', 'x-forwarded-host': 'bind.example.test' })).status).toBe(200);
    const retried = await request('POST', '/api/reports', payload(imageSource), { 'x-test-project': 'p1', 'x-forwarded-host': 'retry.example.test' });
    expect(retried.status).toBe(200); expect(retried.body.report.id).toBe(reportId);
  });
  it('异步绑定验证期间任务报告不可删除，不留下失效报告关联', async () => {
    const archived = await request('POST', '/api/reports', payload(source));
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const read = vi.spyOn(state, 'readAcceptanceReportContentAsync').mockImplementationOnce(async () => { started(); await waiting; return source.content; });
    const binding = request('POST', `/api/acceptance/tasks/${task.id}/bind-report`, { reportId: archived.body.report.id });
    await reading;
    const deletion = await request('DELETE', `/api/reports/${archived.body.report.id}`);
    release(); const bound = await binding; read.mockRestore();
    expect(deletion.status).toBe(409); expect(bound.status).toBe(200);
    expect(state.getAcceptanceReport(archived.body.report.id)).toBeDefined();
    expect(tasks.getTask(task.id).report?.id).toBe(archived.body.report.id);
  });
  it('受限全局身份不能绕过验收任务作用域归档', async () => {
    expect((await request('POST', '/api/reports', payload(source), { 'x-test-global': 'empty' })).status).toBe(403);
    expect(state.listAcceptanceReports('p1')).toHaveLength(0);
  });
  it('普通报告仍能编辑，不把任务不可变规则扩大到所有报告', async () => {
    const created = await request('POST', '/api/reports', { title: '普通说明', format: 'md', content: '# 初稿', projectId: 'p1', sourceId: 'ordinary-doc' });
    expect(created.status).toBe(201); expect(created.body.report.sourceId).toBe('ordinary-doc');
    expect((await request('PATCH', `/api/reports/${created.body.report.id}`, { content: '# 修订' })).status).toBe(200);
    expect((await request('DELETE', `/api/reports/${created.body.report.id}`)).status).toBe(200);
  });
  it('对象存储缺失在创建前阻断，恢复后相同任务可直接重试', async () => {
    state.setReportObjectStore(createReportObjectStore(null));
    const refused = await request('POST', '/api/reports', payload(source));
    expect(refused.status).toBe(503); expect(refused.body.error).toBe('report_storage_unavailable');
    expect(state.listAcceptanceReports('p1')).toHaveLength(0);
    expect(state.listReportFolders('p1')).toHaveLength(0);
    state.setReportObjectStore(createReportObjectStore({ endpoint: 'https://objects.example.test', bucket: 'tests', accessKeyId: 'fixture', secretAccessKey: 'fixture' }, {
      upload: async (o) => ({ objectKey: o.objectKey, bytes: o.body.length, sha256: 'fixture' }),
    }));
    const recovered = await request('POST', '/api/reports', payload(source));
    expect(recovered.status).toBe(201); expect(recovered.body.report.storage).toBe('object');
  });
  it('旧规范 local 草稿恢复后迁入对象存储，保留同一 ID 且可绑定', async () => {
    state.setReportObjectStore(createReportObjectStore(null));
    const draft = await state.createAcceptanceReportAsync({ ...source, projectId: 'p1', createdBy: 'fixture' });
    expect(draft.storage).toBe('local');
    state.setReportObjectStore(configuredStore);
    const recovered = await request('POST', '/api/reports', payload(source));
    expect(recovered.status).toBe(200); expect(recovered.body.report).toMatchObject({ id: draft.id, storage: 'object' });
    expect(state.listAcceptanceReports('p1')).toHaveLength(1);
    // 删除临时缓存，证明迁移确实上传，而不只是改了 storage 标签。
    fs.rmSync(state.getReportsBase(), { recursive: true, force: true });
    expect(await state.readAcceptanceReportContentAsync(draft.id)).toBe(source.content);
    const bound = await request('POST', `/api/acceptance/tasks/${task.id}/bind-report`, { reportId: draft.id });
    expect(bound.status).toBe(200); expect(bound.body.report.verification).toBe('pending');
  });
});
