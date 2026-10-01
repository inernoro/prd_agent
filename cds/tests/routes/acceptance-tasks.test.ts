import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAcceptanceTasksRouter } from '../../src/routes/acceptance-tasks.js';
import { AcceptanceTaskService } from '../../src/services/acceptance-tasks.js';
import { StateService } from '../../src/services/state.js';
import type { AcceptanceCase, AcceptanceTask, AcceptanceTemplate } from '../../src/acceptance-types.js';

const testcase: AcceptanceCase = {
  caseId: 'WEB-001', title: '分享网页能阅读并撤销', module: '网页托管', criticality: 'core', environments: ['production', 'cds'],
  breadcrumb: ['百宝箱', '网页托管'], entryPath: '/web-pages', preconditions: [], inputs: [{ name: '标题', value: 'stsmk-任务' }],
  steps: [{ id: 'share', action: '分享并撤销', expected: '正文可读，撤销后失效' }], assertions: [{ id: 'revoked', description: '撤销后分享失效' }],
  evidenceRequired: true, cleanup: 'required', cleanupInstructions: '删除本轮站点并回读', owner: '网页负责人',
};

describe('验收API真实HTTP与项目隔离', () => {
  let dir: string, state: StateService, service: AcceptanceTaskService, server: http.Server;
  let templates: Record<string, AcceptanceTemplate>, tasks: Record<string, AcceptanceTask>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-acceptance-route-'));
    state = new StateService(path.join(dir, 'state.json')); state.load();
    service = new AcceptanceTaskService(state);
    templates = {}; tasks = {};
    for (const projectId of ['p1', 'p2']) {
      state.addProject({ id: projectId, slug: projectId, name: projectId, kind: 'git', createdAt: '', updatedAt: '' });
      templates[projectId] = await service.publishTemplate({ projectId, title: `${projectId}核心清单`, cases: [testcase] });
      tasks[projectId] = await service.createTask({ projectId, templateId: templates[projectId].id, environment: 'production' });
    }
    const app = express();
    app.use((req, _res, next) => {
      const id = req.header('x-test-project');
      if (id) (req as any).cdsProjectKey = { projectId: id, keyId: `key-${id}` };
      if (req.header('x-test-global') === 'empty') (req as any).cdsAccess = { keyId: 'global', access: { projects: [] } };
      next();
    });
    app.use('/api/acceptance', createAcceptanceTasksRouter({ service }));
    server = app.listen(0);
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(method: string, route: string, body?: unknown, headers: Record<string, string> = { 'x-test-project': 'p1' }) {
    const port = (server.address() as { port: number }).port;
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: `/api/acceptance${route}`, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); } catch (err) { reject(err); } });
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  it('列表缺省锁定项目，明确跨项目读取拒绝', async () => {
    expect((await request('GET', '/templates')).body.templates.map((t: AcceptanceTemplate) => t.projectId)).toEqual(['p1']);
    expect((await request('GET', '/tasks')).body.tasks.map((t: AcceptanceTask) => t.projectId)).toEqual(['p1']);
    for (const route of ['/templates?projectId=p2', '/tasks?projectId=p2', '/matrix?projectId=p2', '/health?projectId=p2', `/templates/${templates.p2.id}`, `/tasks/${tasks.p2.id}`, `/matrix?templateId=${templates.p2.id}`]) {
      expect((await request('GET', route)).status, route).toBe(403);
    }
  });
  it.each(['claim', 'heartbeat', 'release', 'results/WEB-001', 'complete', 'cancel', 'report', 'bind-report'])('跨项目 %s 必须在操作之前拒绝', async (operation) => {
    const response = await request('POST', `/tasks/${tasks.p2.id}/${operation}`, { agentName: 'A', leaseToken: 'unknown', reportId: 'report-other' });
    expect(response.status).toBe(403); expect(service.getTask(tasks.p2.id).status).toBe('pending');
  });
  it('跨项目创建或引用模板不得绕过作用域，全局空授权也拒绝', async () => {
    expect((await request('POST', '/templates', { projectId: 'p2', title: '越权', cases: [testcase] })).status).toBe(403);
    expect((await request('POST', '/templates', { projectId: 'p1', templateId: templates.p2.id, expectedVersion: 1, title: '越权版本', cases: [testcase] })).status).toBe(403);
    expect((await request('POST', '/tasks', { projectId: 'p1', templateId: templates.p2.id, environment: 'production' })).status).toBe(403);
    expect((await request('GET', '/tasks?projectId=p1', undefined, { 'x-test-global': 'empty' })).status).toBe(403);
    expect((await request('GET', '/tasks', undefined, {})).status).toBe(400);
  });
  it('HTTP完整路径：领取、心跳、回填、完成、报告、矩阵与重建回读', async () => {
    const claimed = await request('POST', `/tasks/${tasks.p1.id}/claim`, { agentName: '执行Agent' });
    expect(claimed.status).toBe(200); const leaseToken = claimed.body.leaseToken;
    const read = await request('GET', `/tasks/${tasks.p1.id}`);
    expect(read.body.task.lease.agentName).toBe('执行Agent'); expect(JSON.stringify(read.body)).not.toContain(leaseToken); expect(read.body.task).not.toHaveProperty('leaseTokenHash');
    expect((await request('POST', `/tasks/${tasks.p1.id}/heartbeat`, { leaseToken })).status).toBe(200);
    const submission = { leaseToken, submissionId: 'web-result-1', status: 'pass', actual: '正文可读，撤销后失效', assertions: [{ id: 'revoked', passed: true, actual: '刷新分享页面不能再读取' }], evidence: [{ kind: 'image', url: 'https://images.example.com/share.png', caption: '撤销后的页面' }], cleanup: { status: 'pass', details: '本轮站点回读无残留' } };
    const submitted = await request('POST', `/tasks/${tasks.p1.id}/results/WEB-001`, submission);
    expect(submitted.status).toBe(200); expect(submitted.body.task.summary).toMatchObject({ planned: 1, pass: 1, gate: 'pass' });
    const complete = await request('POST', `/tasks/${tasks.p1.id}/complete`, { leaseToken });
    expect(complete.body.task.status).toBe('completed');
    const report = await request('POST', `/tasks/${tasks.p1.id}/report`);
    expect(report.body.report).toMatchObject({ sourceId: tasks.p1.id, format: 'md', verdict: 'pass', verification: 'pending' });
    expect(report.body.report.content).toContain('WEB-001'); expect(state.listAcceptanceReports('p1')).toHaveLength(0);
    const matrix = await request('GET', '/matrix');
    expect(matrix.body.rows[0].cells[0]).toMatchObject({ status: 'pass', flaky: false });
    const rebuilt = new StateService(path.join(dir, 'state.json')); rebuilt.load();
    expect(new AcceptanceTaskService(rebuilt).getTask(tasks.p1.id).summary.pass).toBe(1); await rebuilt.flush();
  });
  it('正文无效或过大使用用户可读错误而不是HTML', async () => {
    const response = await request('POST', '/templates', { title: '大正文', cases: [testcase], padding: 'a'.repeat(1_100_000) });
    expect(response.status).toBe(413); expect(response.body.message).toContain('超过请求容量');
  });
  it('非法模板版本、环境和重复用例不给假通过', async () => {
    expect((await request('GET', `/templates/${templates.p1.id}?version=bad`)).status).toBe(400);
    expect((await request('GET', '/matrix?environment=test')).status).toBe(400);
    expect((await request('POST', '/templates', { title: '重复', cases: [testcase, testcase] })).body.error).toBe('duplicate_id');
    expect((await request('POST', '/tasks', { templateId: templates.p1.id, environment: 'cds', caseIds: ['NOT-IN-TEMPLATE'] })).body.error).toBe('invalid_scope');
  });
  it('HTTP取消运行任务必须当前票据，管理员也不能绕过', async () => {
    const claim = await request('POST', `/tasks/${tasks.p1.id}/claim`, { agentName: 'A' });
    expect((await request('POST', `/tasks/${tasks.p1.id}/cancel`, {})).status).toBe(409);
    expect((await request('POST', `/tasks/${tasks.p1.id}/cancel`, {}, {})).status).toBe(409);
    expect((await request('POST', `/tasks/${tasks.p1.id}/cancel`, { leaseToken: claim.body.leaseToken })).body.task.status).toBe('cancelled');
    expect((await request('POST', `/tasks/${tasks.p2.id}/cancel`, {}, { 'x-test-project': 'p2' })).body.task.status).toBe('cancelled');
  });
});
