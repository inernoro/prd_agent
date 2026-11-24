import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { ScheduledJobService } from '../../src/services/scheduled-job-service.js';
import { createScheduledJobsRouter } from '../../src/routes/scheduled-jobs.js';
import { createReportsRouter } from '../../src/routes/reports.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { renderNoticeFromEvent } from '../../src/services/notice-ledger.js';
import { isAlertCdsEvent, shouldLedgerEvent } from '../../src/services/cds-events-bus.js';

describe('任务健康真实 HTTP 契约', () => {
  let state: StateService, server: Server, dir: string, base: string;
  const post = async (endpoint: string, body: unknown, project = 'a', headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fixture-Project': project, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-task-http-')); state = new StateService(path.join(dir, 'state.json'), dir); state.load();
    for (const id of ['a', 'b']) state.addProject({ id, name: id, slug: id, kind: 'git', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const deny = async (): Promise<never> => { throw Error('禁止执行外部动作'); };
    const service = new ScheduledJobService({ stateService: state, config: { repoRoot: dir, masterPort: 9900 }, shell: { exec: deny }, release: { isTargetBusy: () => ({ busy: false }), preflight: deny, startRelease: deny, startRollback: deny, getRun: () => undefined } });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).cdsProjectKey = { projectId: req.get('X-Fixture-Project') || 'a', keyId: 'fixture' }; next(); });
    app.use('/api', createScheduledJobsRouter({ stateService: state, scheduledJobService: service, assertProjectAccess }));
    app.use('/api', createReportsRouter({ stateService: state }));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await state.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const create = (extra = {}) => post('scheduled-jobs', { projectId: 'a', name: '报告任务', enabled: false, schedule: { type: 'interval', intervalMinutes: 30 }, target: { type: 'command', command: 'report' }, completion: { type: 'reports', minCount: 1, allowedVerdicts: ['pass'] }, ...extra });
  it('暂停状态与产物契约可保存、读取；非法契约被拒绝', async () => {
    const saved = await create(); expect(saved.status).toBe(201); expect(saved.body.job.enabled).toBe(false);
    const res = await fetch(`${base}/api/scheduled-jobs`, { headers: { 'X-Fixture-Project': 'a' } });
    const data = await res.json(); expect(data.jobs[0].health.state).toBe('paused'); expect(data.jobs[0].completion.allowedVerdicts).toEqual(['pass']);
    expect((await create({ completion: { type: 'reports', minCount: 0 } })).status).toBe(400);
  });
  it('跨项目恢复拒绝；归档必须关联真实的同项目运行', async () => {
    const saved = await create(); const job = saved.body.job;
    state.upsertScheduledJobRun({ id: 'sjr_fixture', jobId: job.id, projectId: 'a', status: 'failed', failureKind: 'interrupted', trigger: 'schedule', queuedAt: new Date().toISOString(), completion: job.completion });
    const body = { title: '隔离报告', format: 'md', content: '# 实际产物', projectId: 'a', verdict: 'pass' };
    const headers = { 'X-CDS-Job-Run-Id': 'sjr_fixture' };
    expect((await post('reports', { ...body, projectId: 'b' }, 'b', headers)).status).toBe(400);
    expect((await post(`scheduled-jobs/${job.id}/recover`, { runId: 'sjr_fixture' }, 'b')).status).toBe(403);
    const report = await post('reports', body, 'a', headers); expect(report.status).toBe(201); expect(report.body.report.scheduledJobRunId).toBe('sjr_fixture');
    const recovered = await post(`scheduled-jobs/${job.id}/recover`, { runId: 'sjr_fixture' }); expect(recovered.status).toBe(200); expect(recovered.body.run.artifacts[0].reportId).toBe(report.body.report.id);
    expect(state.getScheduledJob(job.id)!.enabled).toBe(false);
  });
  it('故障走既有通知账本，按任务区分且深链含项目和任务', () => {
    const envelope = (jobId: string) => ({ type: 'scheduled-job.unhealthy' as const, ts: new Date().toISOString(), data: { jobId, projectId: 'a', message: '产物验证失败' } });
    const first = renderNoticeFromEvent(envelope('one')); const second = renderNoticeFromEvent(envelope('two'));
    expect(isAlertCdsEvent('scheduled-job.unhealthy')).toBe(true); expect(shouldLedgerEvent('scheduled-job.unhealthy', {})).toBe(true);
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey); expect(first?.href).toBe('/task-schedule?project=a&job=one');
  });
});
