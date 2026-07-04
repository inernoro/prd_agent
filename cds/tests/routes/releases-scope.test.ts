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

  function releaseTarget(id: string, projectId: string, privateKeyRef = `${projectId}-host-key`): ReleaseTarget {
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
        privateKeyRef,
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
    stateService.addRemoteHost({
      id: 'proj-a-host-key',
      name: 'A production host',
      host: '127.0.0.1',
      sshPort: 22,
      sshUser: 'root',
      sshPrivateKeyEncrypted: 'test-private-key-a',
      sshPrivateKeyFingerprint: 'fingerprint-a',
      tags: ['prod'],
      isEnabled: true,
      createdAt: now,
    });
    stateService.addRemoteHost({
      id: 'proj-b-host-key',
      name: 'B production host',
      host: '127.0.0.2',
      sshPort: 2222,
      sshUser: 'deploy',
      sshPrivateKeyEncrypted: 'test-private-key-b',
      sshPrivateKeyFingerprint: 'fingerprint-b',
      tags: ['prod'],
      isEnabled: true,
      createdAt: now,
    });
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

  it('creates a simplified local production target with inferred script and healthcheck', async () => {
    const res = await request(server, 'POST', '/api/releases/targets/local-prod', { 'X-Test-Key': KEY_A }, {
      projectId: 'proj-a',
      privateKeyRef: 'proj-a-host-key',
      domain: 'https://www.a.example.test/admin',
      webPort: 13000,
      healthPath: '/api/health',
    });

    expect(res.status).toBe(201);
    expect(res.body.target.projectId).toBe('proj-a');
    expect(res.body.target.name).toBe('www.a.example.test 本机生产');
    expect(res.body.target.ssh.host).toBe('127.0.0.1');
    expect(res.body.target.ssh.user).toBe('root');
    expect(res.body.target.ssh.appPath).toBe('/opt/a-prod');
    expect(res.body.target.ssh.healthcheckUrl).toBe('https://www.a.example.test/api/health');
    expect(res.body.target.ssh.deployCommand).toContain('CDS_LOCAL_PROD_PORT=');
    expect(res.body.target.ssh.deployCommand).toContain('local-prod-release.sh');
  });

  it('refuses Project A key creating a quick local production target for Project B', async () => {
    const res = await request(server, 'POST', '/api/releases/targets/local-prod', { 'X-Test-Key': KEY_A }, {
      projectId: 'proj-b',
      privateKeyRef: 'proj-b-host-key',
      domain: 'www.b.example.test',
      webPort: 13000,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
  });

  it('refuses Project A key patching Project B target command', async () => {
    const res = await request(server, 'PATCH', '/api/releases/targets/target-b', { 'X-Test-Key': KEY_A }, {
      deployCommand: 'echo hijacked',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
    expect(stateService.getReleaseTarget('target-b')!.ssh!.deployCommand).toBe('./deploy.sh');
  });

  it('refuses Project A key creating its own target with a Project B provisioned RemoteHost key', async () => {
    const res = await request(server, 'POST', '/api/releases/targets', { 'X-Test-Key': KEY_A }, {
      id: 'target-a-using-b-key',
      projectId: 'proj-a',
      name: 'A using B key',
      host: 'proj-b.example.test',
      port: 22,
      user: 'deploy',
      privateKeyRef: 'proj-b-host-key',
      appPath: '/srv/app',
      deployCommand: 'echo hijacked',
      healthcheckUrl: 'https://proj-b.example.test/healthz',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('remote_host_scope');
    expect(stateService.getReleaseTarget('target-a-using-b-key')).toBeUndefined();
  });

  it('refuses Project A key patching its own target onto a Project B provisioned RemoteHost key', async () => {
    const res = await request(server, 'PATCH', '/api/releases/targets/target-a', { 'X-Test-Key': KEY_A }, {
      privateKeyRef: 'proj-b-host-key',
      host: 'proj-b.example.test',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('remote_host_scope');
    expect(stateService.getReleaseTarget('target-a')!.ssh!.privateKeyRef).toBe('proj-a-host-key');
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

  it('creates a rollback run for the selected successful target version', async () => {
    const now = new Date().toISOString();
    stateService.addReleaseRun({
      releaseId: 'run-a-current',
      projectId: 'proj-a',
      branchId: 'branch-a',
      commitSha: 'branch-a-current',
      artifact: { type: 'branch-preview', commitSha: 'branch-a-current', branchId: 'branch-a', branchName: 'main', previewUrl: 'https://a.example.test' },
      targetId: 'target-a',
      planId: 'proj-a:ssh-script',
      status: 'failed',
      startedAt: now,
      logs: [],
      seq: 0,
    } as ReleaseRun);
    stateService.addReleaseRun({
      releaseId: 'run-a-previous',
      projectId: 'proj-a',
      branchId: 'branch-a',
      commitSha: 'branch-a-previous',
      artifact: { type: 'branch-preview', commitSha: 'branch-a-previous', branchId: 'branch-a', branchName: 'main', previewUrl: 'https://a.example.test' },
      targetId: 'target-a',
      planId: 'proj-a:ssh-script',
      status: 'success',
      startedAt: now,
      finishedAt: now,
      logs: [],
      seq: 0,
    } as ReleaseRun);

    const res = await request(server, 'POST', '/api/releases/runs/run-a-current/rollback', { 'X-Test-Key': KEY_A }, {
      targetReleaseId: 'run-a-previous',
    });

    expect(res.status).toBe(202);
    expect(res.body.run.status).toBe('rollback_running');
    expect(res.body.run.rollbackOf).toBe('run-a-current');
    expect(res.body.run.rollbackTargetReleaseId).toBe('run-a-previous');
    expect(res.body.run.commitSha).toBe('branch-a-previous');
  });
});
