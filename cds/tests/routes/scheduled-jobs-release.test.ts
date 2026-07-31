/**
 * /api/scheduled-jobs 对 release 动作的入参校验。
 *
 * 这一层是**跨项目定时发布**的唯一拦截点：ScheduledJob.projectId 与
 * ReleaseTarget.projectId 是两条独立的项目归属，路由里的 assertProjectAccess 只认
 * job.projectId，看不见发布目标那一侧 —— 不在 parseTarget 里比对，A 项目的定时任务
 * 就能按点往 B 项目的生产上发版。
 */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { ScheduledJobService } from '../../src/services/scheduled-job-service.js';
import { createScheduledJobsRouter } from '../../src/routes/scheduled-jobs.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

function request(server: http.Server, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('/api/scheduled-jobs · release 动作校验', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-sched-release-routes-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    for (const id of ['demo', 'other']) {
      stateService.addProject({ id, slug: id, name: id, kind: 'git', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as never);
    }
    stateService.addBranch({
      id: 'b1', projectId: 'demo', branch: 'main', worktreePath: '/tmp/b1', services: {},
      status: 'running', pinnedCommit: 'a'.repeat(40), createdAt: '2026-07-28T00:00:00.000Z',
    } as never);
    for (const [id, projectId] of [['target-prod', 'demo'], ['target-foreign', 'other']] as const) {
      stateService.upsertReleaseTarget({
        id, projectId, name: id, type: 'ssh', createdAt: '2026-07-28T00:00:00.000Z', isEnabled: true,
        ssh: { host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'h1', appPath: '/opt/app', deployCommand: './deploy.sh', healthcheckUrl: 'https://x.test' },
      } as never);
    }

    const scheduledJobService = new ScheduledJobService({
      stateService,
      shell: new MockShellExecutor(),
      config: { masterPort: 9900, repoRoot: tmpDir },
      release: {
        isTargetBusy: () => ({ busy: false }),
        preflight: async () => ({ ok: true, checks: [] }),
        startRelease: async () => { throw new Error('路由套件不应触发真发布'); },
        startRollback: async () => { throw new Error('路由套件不应触发回滚'); },
        getRun: () => undefined,
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createScheduledJobsRouter({ stateService, scheduledJobService, assertProjectAccess: () => null }));
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
  });

  afterEach(async () => {
    await new Promise((r) => server.close(() => r(null)));
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const baseJob = (target: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    projectId: 'demo',
    name: '每日发布',
    schedule: { type: 'daily', timeOfDay: '02:00', timezone: 'Asia/Shanghai' },
    actions: [target],
    ...extra,
  });

  it('缺 targetId 时 400', async () => {
    const res = await request(server, 'POST', '/api/scheduled-jobs', baseJob({ type: 'release', source: { kind: 'branch', branchId: 'b1' } }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('发布目标必填');
  });

  it('targetId 指向不存在的目标时 400', async () => {
    const res = await request(server, 'POST', '/api/scheduled-jobs', baseJob({ type: 'release', targetId: 'nope', source: { kind: 'branch', branchId: 'b1' } }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('发布目标不存在');
  });

  it('发布目标与任务不同项目时 400（跨项目定时发布的唯一拦截点）', async () => {
    const res = await request(server, 'POST', '/api/scheduled-jobs', baseJob({ type: 'release', targetId: 'target-foreign', source: { kind: 'branch', branchId: 'b1' } }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('禁止跨项目定时发布');
  });

  it('来源无效 / 分支跨项目时 400', async () => {
    const noSource = await request(server, 'POST', '/api/scheduled-jobs', baseJob({ type: 'release', targetId: 'target-prod' }));
    expect(noSource.status).toBe(400);
    expect(String(noSource.body.error)).toContain('发布来源无效');

    const badBranch = await request(server, 'POST', '/api/scheduled-jobs', baseJob({ type: 'release', targetId: 'target-prod', source: { kind: 'branch', branchId: 'ghost' } }));
    expect(badBranch.status).toBe(400);
    expect(String(badBranch.body.error)).toContain('来源分支不存在');
  });

  it('提升来源环境跨项目时 400', async () => {
    const res = await request(server, 'POST', '/api/scheduled-jobs', baseJob({ type: 'release', targetId: 'target-prod', source: { kind: 'promote', fromTargetId: 'target-foreign' } }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('与任务所属项目不一致');
  });

  it('合法 release 动作被创建，retryCount 归零、超时给发布量级的默认值', async () => {
    const res = await request(server, 'POST', '/api/scheduled-jobs', baseJob(
      { type: 'release', targetId: 'target-prod', source: { kind: 'branch', branchId: 'b1' }, rollbackOnFailure: true, requireApproval: true },
      { retryCount: 5 },
    ));
    expect(res.status).toBe(201);
    const action = res.body.job.actions[0];
    expect(action.type).toBe('release');
    expect(action.rollbackOnFailure).toBe(true);
    expect(action.requireApproval).toBe(true);
    expect(action.name).toBe('发布到环境');
    // 一次生产部署失败自动重放是危险动作，含 release 的任务重试恒为 0。
    expect(res.body.job.retryCount).toBe(0);
    expect(res.body.job.timeoutSeconds).toBe(3600);
  });

  it('试运行只跑发布前检查，日志首行写明未发布', async () => {
    const res = await request(server, 'POST', '/api/scheduled-jobs/check-target', {
      projectId: 'demo',
      target: { type: 'release', targetId: 'target-prod', source: { kind: 'branch', branchId: 'b1' } },
    });
    expect(res.status).toBe(200);
    expect(String(res.body.result.log).split('\n')[0]).toContain('未发布');
  });
});
