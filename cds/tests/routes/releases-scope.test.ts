/**
 * Project-scope isolation for the release control plane.
 *
 * A project-scoped cdsp_ key must not be able to create or run releases for
 * another project. Release targets can execute SSH commands through saved
 * RemoteHost private keys, so missing project guards here are high impact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
import type { BranchEntry, ReleaseRun, ReleaseTarget } from '../../src/types.js';

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

describe('release control plane project-scope isolation', () => {
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
        privateKeyRef: 'prod-host-key',
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

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-scope-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addProject({ id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addBranch(branch('branch-a', 'proj-a'));
    stateService.addBranch(branch('branch-b', 'proj-b'));
    stateService.upsertReleaseTarget(releaseTarget('target-a', 'proj-a'));
    stateService.upsertReleaseTarget(releaseTarget('target-b', 'proj-b'));
    stateService.addReleaseRun({
      releaseId: 'run-b',
      projectId: 'proj-b',
      branchId: 'branch-b',
      commitSha: 'branch-b-commit',
      artifact: { type: 'branch-preview', commitSha: 'branch-b-commit', branchId: 'branch-b', branchName: 'main', previewUrl: 'https://b.example.test' },
      targetId: 'target-b',
      planId: 'proj-b:ssh-script',
      status: 'success',
      startedAt: now,
      logs: [],
      seq: 0,
    } as ReleaseRun);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === KEY_A) (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      if (h === KEY_B) (req as any).cdsProjectKey = { projectId: 'proj-b', keyId: 'k-b' };
      next();
    });
    app.use('/api', createReleasesRouter({ stateService }));

    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('filters release targets to the project key scope when no ?project is provided', async () => {
    const res = await request(server, 'GET', '/api/releases/targets', { 'X-Test-Key': KEY_A });
    expect(res.status).toBe(200);
    expect(res.body.targets.map((target: ReleaseTarget) => target.id)).toEqual(['target-a']);
  });

  it('refuses Project A key creating a Project B SSH release target', async () => {
    const res = await request(server, 'POST', '/api/releases/targets', { 'X-Test-Key': KEY_A }, {
      id: 'target-b-hijack',
      projectId: 'proj-b',
      name: 'B hijack',
      host: 'prod.example.test',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'prod-host-key',
      appPath: '/srv/app',
      deployCommand: 'echo hijacked',
      healthcheckUrl: 'https://prod.example.test/healthz',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
    expect(stateService.getReleaseTarget('target-b-hijack')).toBeUndefined();
  });

  it('refuses Project A key patching Project B target command', async () => {
    const res = await request(server, 'PATCH', '/api/releases/targets/target-b', { 'X-Test-Key': KEY_A }, {
      deployCommand: 'echo hijacked',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
    expect(stateService.getReleaseTarget('target-b')!.ssh!.deployCommand).toBe('./deploy.sh');
  });

  it('refuses Project A key starting a Project B release run', async () => {
    const res = await request(server, 'POST', '/api/releases/branches/branch-b/runs', { 'X-Test-Key': KEY_A }, {
      targetId: 'target-b',
      previewUrl: 'https://b.example.test',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
    expect(stateService.getReleaseRuns({ branchId: 'branch-b' })).toHaveLength(1);
  });

  it('refuses Project A key reading a Project B release run directly', async () => {
    const res = await request(server, 'GET', '/api/releases/runs/run-b', { 'X-Test-Key': KEY_A });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
  });

  it('blocks branch and target from different projects even for admin callers', async () => {
    const res = await request(server, 'POST', '/api/releases/branches/branch-a/preflight', undefined, {
      targetId: 'target-b',
      previewUrl: 'https://a.example.test',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.checks.some((check: { id: string; status: string }) => (
      check.id === 'project-scope' && check.status === 'fail'
    ))).toBe(true);
  });
});
