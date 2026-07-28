/**
 * 取消端点 POST /api/releases/runs/:id/cancel 的路由语义。
 *
 * 背景：CDS 自更新是日常操作，在途发布的执行体随进程消失后 run 永远停在 running，
 * 在途守卫会拒绝该目标的一切新发布。取消端点是把这个目标手动救回来的最短路径，
 * 所以它的三种情形（在途 / 已终态 / 不存在）都必须有明确且稳定的返回契约。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, ReleaseRun, ReleaseRunStatus, ReleaseTarget } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1',
      port: addr.port,
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('release cancel endpoint', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  const KEY_A = 'TEST-KEY-A';
  const KEY_B = 'TEST-KEY-B';

  function releaseTarget(id: string, projectId: string): ReleaseTarget {
    const now = new Date().toISOString();
    return {
      id,
      projectId,
      name: `${projectId} target`,
      type: 'ssh',
      createdAt: now,
      updatedAt: now,
      isEnabled: true,
      ssh: {
        host: `${projectId}.example.test`,
        port: 22,
        user: 'deploy',
        privateKeyRef: `${projectId}-host-key`,
        appPath: '/srv/app',
        deployCommand: './deploy.sh',
        rollbackCommand: './rollback.sh',
        healthcheckUrl: `http://${projectId}.example.test/healthz`,
      },
    };
  }

  function branch(id: string, projectId: string): BranchEntry {
    const now = new Date().toISOString();
    return {
      id,
      projectId,
      branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees', id),
      status: 'running',
      createdAt: now,
      lastDeployAt: now,
      githubCommitSha: `${id}-commit`,
      services: {},
    };
  }

  function addRun(releaseId: string, projectId: string, targetId: string, status: ReleaseRunStatus): void {
    const now = new Date().toISOString();
    stateService.addReleaseRun({
      releaseId,
      projectId,
      branchId: `branch-${projectId.slice(-1)}`,
      commitSha: `${releaseId}-commit`,
      artifact: {
        type: 'branch-preview',
        commitSha: `${releaseId}-commit`,
        branchId: `branch-${projectId.slice(-1)}`,
        branchName: 'main',
        previewUrl: `https://${projectId}.example.test`,
      },
      targetId,
      planId: `${projectId}:ssh-script`,
      status,
      startedAt: now,
      heartbeatAt: now,
      ...(status === 'success' ? { finishedAt: now } : {}),
      logs: [],
      seq: 0,
    } as ReleaseRun);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-cancel-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addProject({ id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addBranch(branch('branch-a', 'proj-a'));
    stateService.addBranch(branch('branch-b', 'proj-b'));
    stateService.upsertReleaseTarget(releaseTarget('target-a', 'proj-a'));
    stateService.upsertReleaseTarget(releaseTarget('target-b', 'proj-b'));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === KEY_A) (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      if (h === KEY_B) (req as any).cdsProjectKey = { projectId: 'proj-b', keyId: 'k-b' };
      next();
    });
    app.use('/api', createReleasesRouter({ stateService, config: { worktreeBase: path.join(tmpDir, 'wt') } }));

    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('terminates an in-flight release run and releases the target guard', async () => {
    addRun('rel-inflight', 'proj-a', 'target-a', 'running');

    const res = await request(server, 'POST', '/api/releases/runs/rel-inflight/cancel', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(res.body.alreadyTerminal).toBe(false);
    expect(res.body.run.status).toBe('failed');
    expect(res.body.run.finishedAt).toBeTruthy();
    expect(res.body.run.failure?.code).toBe('release.cancelled');
    expect(stateService.getReleaseRun('rel-inflight')!.status).toBe('failed');
  });

  it('terminates an in-flight rollback run into rollback_failed', async () => {
    addRun('rel-rollback', 'proj-a', 'target-a', 'rollback_running');

    const res = await request(server, 'POST', '/api/releases/runs/rel-rollback/cancel', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(stateService.getReleaseRun('rel-rollback')!.status).toBe('rollback_failed');
  });

  it('is idempotent for an already terminal run and never rewrites its status', async () => {
    addRun('rel-done', 'proj-a', 'target-a', 'success');

    const res = await request(server, 'POST', '/api/releases/runs/rel-done/cancel', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(200);
    expect(res.body.alreadyTerminal).toBe(true);
    expect(res.body.cancelled).toBe(false);
    expect(res.body.run.status).toBe('success');
    expect(stateService.getReleaseRun('rel-done')!.status).toBe('success');
    expect(stateService.getReleaseRun('rel-done')!.errorMessage).toBeUndefined();
  });

  it('returns 404 for an unknown release run', async () => {
    const res = await request(server, 'POST', '/api/releases/runs/rel-missing/cancel', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ReleaseRun not found');
  });

  it('refuses Project A key cancelling a Project B release run', async () => {
    addRun('rel-b-inflight', 'proj-b', 'target-b', 'running');

    const res = await request(server, 'POST', '/api/releases/runs/rel-b-inflight/cancel', { 'X-Test-Key': KEY_A });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
    expect(stateService.getReleaseRun('rel-b-inflight')!.status).toBe('running');
  });
});
