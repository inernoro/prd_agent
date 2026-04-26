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

    const shell = new MockShellExecutor();
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
});
