/**
 * 执行类发布端点的权限门。
 *
 * 历史缺口：改一行发布目标配置要过 rejectUnscopedAiMutation（必须项目级 Agent Key），
 * 而真正能动生产的四个执行类端点（发起发布 / 回滚 / 重试 / 取消）反而没有这道门——
 * 一把全局 AI key 就能把任意项目发上生产。本测试把「执行不得比配置松」钉死。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { ReleaseService } from '../../src/services/release-service.js';
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

describe('release execution endpoints require a project-scoped key for AI callers', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let releaseService: ReleaseService;

  const KEY_A = 'TEST-KEY-A';
  const UNSCOPED_AI = { 'X-AI-Access-Key': 'global-ai-key' };

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

  function addRun(releaseId: string, status: ReleaseRunStatus): void {
    const now = new Date().toISOString();
    stateService.addReleaseRun({
      releaseId,
      projectId: 'proj-a',
      branchId: 'branch-a',
      commitSha: `${releaseId}-commit`,
      artifact: {
        type: 'branch-preview',
        commitSha: `${releaseId}-commit`,
        branchId: 'branch-a',
        branchName: 'main',
        previewUrl: 'https://a.example.test',
      },
      targetId: 'target-a',
      planId: 'proj-a:ssh-script',
      status,
      startedAt: now,
      heartbeatAt: now,
      ...(status === 'success' ? { finishedAt: now } : {}),
      logs: [],
      seq: 0,
    } as ReleaseRun);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-exec-scope-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    const branch: BranchEntry = {
      id: 'branch-a',
      projectId: 'proj-a',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees', 'branch-a'),
      status: 'running',
      createdAt: now,
      lastDeployAt: now,
      githubCommitSha: 'branch-a-commit',
      services: {},
    };
    stateService.addBranch(branch);
    stateService.upsertReleaseTarget(releaseTarget('target-a', 'proj-a'));
    addRun('rel-success', 'success');
    addRun('rel-inflight', 'running');

    releaseService = new ReleaseService(stateService);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === KEY_A) (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      next();
    });
    app.use('/api', createReleasesRouter({ stateService, releaseService, config: { worktreeBase: path.join(tmpDir, 'wt') } }));

    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it.each(['', undefined])('does not start retry when original SHA is %s', async sha => {
    const source = stateService.getReleaseRun('rel-success')!;
    source.commitSha = sha as string;
    const start = vi.spyOn(releaseService, 'startRelease');
    const before = stateService.getReleaseRuns().length;
    const result = await request(server, 'POST', '/api/releases/runs/rel-success/retry', {}, {});
    expect(result.status).toBe(409);
    expect(result.body.error).toContain('来源版本');
    expect(start).not.toHaveBeenCalled();
    expect(stateService.getReleaseRuns()).toHaveLength(before);
  });

  it('pins retry to the original source version before any execution', async () => {
    const start = vi.spyOn(releaseService, 'startRelease').mockRejectedValueOnce(new Error('版本不一致'));
    const before = stateService.getReleaseRuns().length;
    const result = await request(server, 'POST', '/api/releases/runs/rel-success/retry', {}, {});
    expect(result.status).toBe(409);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'branch-a', targetId: 'target-a', expectedCommitSha: 'rel-success-commit' }));
    expect(stateService.getReleaseRuns()).toHaveLength(before);
  });

  it('refuses an unscoped AI key from starting a release run', async () => {
    const before = stateService.getReleaseRuns({ projectId: 'proj-a' }).length;

    const res = await request(server, 'POST', '/api/releases/branches/branch-a/runs', UNSCOPED_AI, {
      targetId: 'target-a',
      previewUrl: 'https://a.example.test',
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_key_required');
    expect(stateService.getReleaseRuns({ projectId: 'proj-a' })).toHaveLength(before);
  });

  it('refuses an unscoped AI key from rolling back a release run', async () => {
    const before = stateService.getReleaseRuns({ projectId: 'proj-a' }).length;

    const res = await request(server, 'POST', '/api/releases/runs/rel-success/rollback', UNSCOPED_AI, {});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_key_required');
    expect(stateService.getReleaseRuns({ projectId: 'proj-a' })).toHaveLength(before);
  });

  it('refuses an unscoped AI key from retrying a release run', async () => {
    const before = stateService.getReleaseRuns({ projectId: 'proj-a' }).length;

    const res = await request(server, 'POST', '/api/releases/runs/rel-success/retry', UNSCOPED_AI, {});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_key_required');
    expect(stateService.getReleaseRuns({ projectId: 'proj-a' })).toHaveLength(before);
  });

  it('refuses an unscoped AI key from cancelling a release run', async () => {
    const res = await request(server, 'POST', '/api/releases/runs/rel-inflight/cancel', UNSCOPED_AI, {});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_key_required');
    expect(stateService.getReleaseRun('rel-inflight')!.status).toBe('running');
  });

  it('still allows a project-scoped AI key to cancel its own release run', async () => {
    const res = await request(server, 'POST', '/api/releases/runs/rel-inflight/cancel', {
      'X-Test-Key': KEY_A,
      'X-AI-Access-Key': 'scoped-ai-key',
    }, {});

    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
    expect(stateService.getReleaseRun('rel-inflight')!.status).toBe('failed');
  });
});
