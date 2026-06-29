import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Router } from 'express';
import { createScheduledJobsRouter } from '../../src/routes/scheduled-jobs.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { ScheduledJobService } from '../../src/services/scheduled-job-service.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { StateService } from '../../src/services/state.js';
import type { Project, ScheduledJob, ScheduledJobRun } from '../../src/types.js';

async function request(
  router: Router,
  method: string,
  urlPath: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, 'http://127.0.0.1');
    const req: any = {
      method,
      url: `${url.pathname}${url.search}`,
      originalUrl: `${url.pathname}${url.search}`,
      baseUrl: '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: headers || {},
    };
    const h = headers?.['X-Test-Key'] || headers?.['x-test-key'];
    if (h === 'TEST-KEY-A') req.cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
    if (h === 'TEST-KEY-B') req.cdsProjectKey = { projectId: 'proj-b', keyId: 'k-b' };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: any) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    router.handle(req, res, reject);
  });
}

describe('scheduled job routes project-scope isolation', () => {
  let tmpDir: string;
  let router: Router;
  let stateService: StateService;
  let service: ScheduledJobService;

  const KEY_A = 'TEST-KEY-A';
  const KEY_B = 'TEST-KEY-B';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-scheduled-jobs-scope-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = '2026-01-01T00:00:00.000Z';
    const projects: Project[] = [
      { id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now },
      { id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now },
    ];
    for (const project of projects) stateService.addProject(project);

    const shell = new MockShellExecutor();
    service = new ScheduledJobService({
      stateService,
      shell,
      config: { masterPort: 9900, repoRoot: tmpDir },
    });
    seedJob('job-a', 'proj-a', 'A secret command');
    seedJob('job-b', 'proj-b', 'B secret command');
    seedRun('run-a', 'job-a', 'proj-a', 'A private log');
    seedRun('run-b', 'job-b', 'proj-b', 'B private log');

    router = createScheduledJobsRouter({
      stateService,
      scheduledJobService: service,
      assertProjectAccess: assertProjectAccess as any,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  it('narrows unscoped scheduled job lists to the project key scope', async () => {
    const res = await request(router, 'GET', '/scheduled-jobs', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(200);
    expect(res.body.jobs.map((job: ScheduledJob) => job.id)).toEqual(['job-a']);
    expect(JSON.stringify(res.body)).toContain('A secret command');
    expect(JSON.stringify(res.body)).not.toContain('B secret command');
  });

  it('rejects explicit cross-project scheduled job lists', async () => {
    const res = await request(router, 'GET', '/scheduled-jobs?project=proj-b', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
  });

  it('narrows unscoped run logs to the project key scope', async () => {
    const res = await request(router, 'GET', '/scheduled-jobs/runs', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(200);
    expect(res.body.runs.map((run: ScheduledJobRun) => run.id)).toEqual(['run-a']);
    expect(JSON.stringify(res.body)).toContain('A private log');
    expect(JSON.stringify(res.body)).not.toContain('B private log');
  });

  it('rejects jobId run lookup when the job belongs to another project', async () => {
    const res = await request(router, 'GET', '/scheduled-jobs/runs?jobId=job-b', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
  });

  function seedJob(id: string, projectId: string, command: string): void {
    const now = '2026-01-01T00:00:00.000Z';
    stateService.upsertScheduledJob(service.normalizeJob({
      id,
      projectId,
      name: id,
      enabled: true,
      schedule: { type: 'manual', timezone: 'Asia/Shanghai' },
      target: { type: 'command', command },
      timeoutSeconds: 30,
      retryCount: 0,
      concurrencyPolicy: 'skip',
      createdAt: now,
      updatedAt: now,
    }));
  }

  function seedRun(id: string, jobId: string, projectId: string, log: string): void {
    stateService.upsertScheduledJobRun({
      id,
      jobId,
      projectId,
      trigger: 'manual',
      status: 'success',
      queuedAt: id === 'run-a' ? '2026-01-01T00:00:01.000Z' : '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: '2026-01-01T00:00:02.000Z',
      durationMs: 1000,
      log,
    });
  }
});
