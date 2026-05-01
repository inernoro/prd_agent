/**
 * Cross-project isolation regression tests for branches.ts.
 *
 * Background: a 2026-04-24 audit found that PUT/DELETE on
 *   /api/build-profiles/:id
 *   /api/routing-rules/:id
 * had no `assertProjectAccess` guard, so a project-scoped Agent Key
 * minted for Project A could mutate or delete Project B's profiles
 * and routing rules. This file pins the fix.
 *
 * The same audit found that GET /api/export-config returned every
 * project's data in one YAML when no ?project= filter was passed —
 * also covered here for the per-project scoping case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBranchRouter } from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { CdsConfig } from '../../src/types.js';

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
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

describe('Cross-project isolation on profiles/rules/export', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;
  let shell: MockShellExecutor;

  // Two project-scoped agent-key markers we attach to requests via
  // a custom header. The middleware below stamps req.cdsProjectKey
  // accordingly, mirroring server.ts auth wiring.
  const KEY_PROJ_A = 'TEST-KEY-PROJ-A';
  const KEY_PROJ_B = 'TEST-KEY-PROJ-B';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-iso-'));
    const config: CdsConfig = {
      repoRoot: tmpDir,
      worktreeBase: path.join(tmpDir, 'worktrees'),
      masterPort: 9900,
      workerPort: 5500,
      dockerNetwork: 'cds-network',
      portStart: 10001,
      sharedEnv: {},
      jwt: { secret: 'test-secret', issuer: 'cds' },
    };
    fs.mkdirSync(config.worktreeBase, { recursive: true });

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    // Project A and B coexist alongside the legacy default created
    // by migration().
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now,
    });
    stateService.addProject({
      id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now,
    });

    // Seed a build profile + routing rule under each project so we can
    // cross-modify them.
    stateService.addBuildProfile({
      id: 'profile-a', projectId: 'proj-a', name: 'A profile',
      dockerImage: 'node:20', containerPort: 3000, command: 'npm start', workDir: '/app',
    } as any);
    stateService.addBuildProfile({
      id: 'profile-b', projectId: 'proj-b', name: 'B profile',
      dockerImage: 'node:20', containerPort: 3000, command: 'npm start', workDir: '/app',
    } as any);
    stateService.addRoutingRule({
      id: 'rule-a', projectId: 'proj-a', name: 'A route', type: 'domain',
      match: 'a.example.com', branch: 'main', priority: 0, enabled: true,
    } as any);
    stateService.addRoutingRule({
      id: 'rule-b', projectId: 'proj-b', name: 'B route', type: 'domain',
      match: 'b.example.com', branch: 'main', priority: 0, enabled: true,
    } as any);

    shell = new MockShellExecutor();
    shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const worktreeService = new WorktreeService(shell, config.repoRoot);
    const containerService = new ContainerService(shell, config);

    const app = express();
    app.use(express.json());
    // Test middleware: stamp req.cdsProjectKey based on a fixed header
    // so we don't need to mint real agent keys.
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === KEY_PROJ_A) (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      if (h === KEY_PROJ_B) (req as any).cdsProjectKey = { projectId: 'proj-b', keyId: 'k-b' };
      next();
    });
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell, config,
    }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  describe('PUT /api/build-profiles/:id', () => {
    it('refuses Project B key trying to mutate Project A profile (403 project_mismatch)', async () => {
      const res = await request(server, 'PUT', '/api/build-profiles/profile-a',
        { name: 'hijacked by B' }, { 'X-Test-Key': KEY_PROJ_B });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
      // State must not have been touched.
      expect(stateService.getBuildProfile('profile-a')!.name).toBe('A profile');
    });

    it('allows Project A key on its own profile', async () => {
      const res = await request(server, 'PUT', '/api/build-profiles/profile-a',
        { name: 'A renamed' }, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('profile-a')!.name).toBe('A renamed');
    });

    it('allows bootstrap / cookie auth (no project key) — back-compat', async () => {
      const res = await request(server, 'PUT', '/api/build-profiles/profile-a',
        { name: 'admin update' });
      expect(res.status).toBe(200);
    });

    it('refuses cross-project re-attribution via body.projectId (closes silent move loophole)', async () => {
      const res = await request(server, 'PUT', '/api/build-profiles/profile-a',
        { projectId: 'proj-b' }, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('projectId 不可通过 PUT 修改');
    });

    it('returns 404 for unknown profile id', async () => {
      const res = await request(server, 'PUT', '/api/build-profiles/nope',
        { name: 'x' }, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/build-profiles/:id', () => {
    it('refuses Project A key trying to delete Project B profile', async () => {
      const res = await request(server, 'DELETE', '/api/build-profiles/profile-b',
        undefined, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(403);
      // Profile must still exist.
      expect(stateService.getBuildProfile('profile-b')).toBeDefined();
    });

    it('allows the owning project key', async () => {
      const res = await request(server, 'DELETE', '/api/build-profiles/profile-b',
        undefined, { 'X-Test-Key': KEY_PROJ_B });
      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('profile-b')).toBeUndefined();
    });
  });

  describe('PUT /api/routing-rules/:id', () => {
    it('refuses cross-project mutation', async () => {
      const res = await request(server, 'PUT', '/api/routing-rules/rule-a',
        { enabled: false }, { 'X-Test-Key': KEY_PROJ_B });
      expect(res.status).toBe(403);
      // State unchanged
      const rule = stateService.getRoutingRule('rule-a');
      expect(rule!.enabled).toBe(true);
    });

    it('allows owning project', async () => {
      const res = await request(server, 'PUT', '/api/routing-rules/rule-a',
        { enabled: false }, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(200);
      expect(stateService.getRoutingRule('rule-a')!.enabled).toBe(false);
    });
  });

  describe('DELETE /api/routing-rules/:id', () => {
    it('refuses cross-project delete', async () => {
      const res = await request(server, 'DELETE', '/api/routing-rules/rule-a',
        undefined, { 'X-Test-Key': KEY_PROJ_B });
      expect(res.status).toBe(403);
      expect(stateService.getRoutingRule('rule-a')).toBeDefined();
    });

    it('allows owning project', async () => {
      const res = await request(server, 'DELETE', '/api/routing-rules/rule-a',
        undefined, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(200);
      expect(stateService.getRoutingRule('rule-a')).toBeUndefined();
    });
  });

  describe('GET /api/export-config', () => {
    it('?project=proj-a only includes A\'s profiles + rules (no leak)', async () => {
      const res = await request(server, 'GET', '/api/export-config?project=proj-a');
      expect(res.status).toBe(200);
      const yaml = res.body as string;
      expect(yaml).toContain('profile-a');
      expect(yaml).toContain('rule-a');
      // B's resources must NOT appear in A's export.
      expect(yaml).not.toContain('profile-b');
      expect(yaml).not.toContain('b.example.com');
    });

    it('without ?project= keeps the legacy "everything" behaviour for back-compat', async () => {
      const res = await request(server, 'GET', '/api/export-config');
      expect(res.status).toBe(200);
      const yaml = res.body as string;
      expect(yaml).toContain('profile-a');
      expect(yaml).toContain('profile-b');
    });
  });

  // F9 (2026-05-02 onboarding UAT): a project-scoped key cannot read details
  // of a branch in a different project, even with read-only GET. The endpoint
  // is `GET /api/branches/:id` introduced in this commit.
  describe('GET /api/branches/:id (F9 cross-project guard)', () => {
    it('refuses Project B key reading Project A branch (403)', async () => {
      // Seed a branch under proj-a directly via state to skip POST validation
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'a-feature', projectId: 'proj-a', branch: 'feature',
        worktreePath: '/tmp/wt/a-feature', services: {}, status: 'idle',
        createdAt: now,
      });
      const res = await request(server, 'GET', '/api/branches/a-feature',
        undefined, { 'X-Test-Key': KEY_PROJ_B });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
    });

    it('allows Project A key on its own branch', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'a-feature', projectId: 'proj-a', branch: 'feature',
        worktreePath: '/tmp/wt/a-feature', services: {}, status: 'idle',
        createdAt: now,
      });
      const res = await request(server, 'GET', '/api/branches/a-feature',
        undefined, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(200);
      expect(res.body.branch.id).toBe('a-feature');
    });

    it('returns 404 for unknown id (no info leak about other projects)', async () => {
      const res = await request(server, 'GET', '/api/branches/nope',
        undefined, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(404);
    });
  });

  // F15 (HIGH severity, 2026-05-02 onboarding UAT): `docker exec` output
  // and `docker logs` output must mask sensitive env values by default.
  // Admin can opt out with ?unmask=1 (logged via activity stream).
  describe('container-exec + container-logs masking (F15)', () => {
    beforeEach(() => {
      // Reset shell patterns so our docker-specific pattern wins over the
      // outer beforeEach's `/.*/` catch-all (first-match wins). We
      // re-install the catch-all AFTER docker patterns have been added by
      // each individual test below.
      shell.clearPatterns();

      // Seed a running branch + service so the routes don't 404 first.
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'a-svc', projectId: 'proj-a', branch: 'svc',
        worktreePath: '/tmp/wt/a-svc',
        services: {
          api: {
            profileId: 'api', containerName: 'cds_a-svc_api',
            hostPort: 12345, status: 'running',
          },
        },
        status: 'running',
        createdAt: now,
      });
    });

    /** Helper: install docker exec output, then re-install catch-all last. */
    function installExecMock(stdout: string, stderr: string, exitCode: number) {
      shell.clearPatterns();
      shell.addResponsePattern(/docker exec/, () => ({ stdout, stderr, exitCode }));
      // Catch-all for everything else (e.g. status reconciliation calls).
      shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    }

    it('container-exec masks GITHUB_PAT/PASSWORD/TOKEN by default', async () => {
      // Inject realistic `env` output into docker exec — must include at
      // least one sensitive line and one non-sensitive line so we can
      // assert both masking AND non-mangling of safe vars.
      installExecMock(
        [
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'GITHUB_PAT=ghp_DontLeakThisSecret',
          'MYSQL_ROOT_PASSWORD=p4ssw0rd',
          'NODE_ENV=production',
          'JWT_SECRET=a-very-secret-jwt-value',
        ].join('\n'),
        '', 0,
      );
      const res = await request(server, 'POST', '/api/branches/a-svc/container-exec',
        { profileId: 'api', command: 'env' }, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(200);
      expect(res.body.masked).toBe(true);
      // Sensitive values are gone
      expect(res.body.stdout).not.toContain('ghp_DontLeakThisSecret');
      expect(res.body.stdout).not.toContain('p4ssw0rd');
      expect(res.body.stdout).not.toContain('a-very-secret-jwt-value');
      // Mask markers present
      expect(res.body.stdout).toContain('GITHUB_PAT=***[masked]***');
      expect(res.body.stdout).toContain('MYSQL_ROOT_PASSWORD=***[masked]***');
      expect(res.body.stdout).toContain('JWT_SECRET=***[masked]***');
      // Non-sensitive values preserved
      expect(res.body.stdout).toContain('NODE_ENV=production');
      expect(res.body.stdout).toContain('PATH=/usr/local/sbin');
    });

    it('container-exec opts out via ?unmask=1', async () => {
      installExecMock('GITHUB_PAT=ghp_RawValue', '', 0);
      const res = await request(server, 'POST', '/api/branches/a-svc/container-exec?unmask=1',
        { profileId: 'api', command: 'env' }, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(200);
      expect(res.body.masked).toBe(false);
      // Raw value passes through when unmask is requested
      expect(res.body.stdout).toBe('GITHUB_PAT=ghp_RawValue');
    });

    it('container-exec masks stderr too', async () => {
      installExecMock(
        '',
        'connecting to db: postgres://app:s3cretPwd@db:5432\nDB_PASSWORD=s3cretPwd',
        1,
      );
      const res = await request(server, 'POST', '/api/branches/a-svc/container-exec',
        { profileId: 'api', command: 'app diagnose' }, { 'X-Test-Key': KEY_PROJ_A });
      expect(res.status).toBe(200);
      expect(res.body.masked).toBe(true);
      // The KEY=VALUE form must be masked. The connection string form
      // (postgres://user:pw@host) is a known limitation tracked by
      // future hardening — flagged in the masker doc.
      expect(res.body.stderr).toContain('DB_PASSWORD=***[masked]***');
    });
  });
});
