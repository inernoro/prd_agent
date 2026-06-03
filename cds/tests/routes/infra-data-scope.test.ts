/**
 * Project-scope isolation for the infra data + backup routers.
 *
 * Background (PR #711 review, cursor/codex): POST /api/infra/:id/query,
 * /init-sql and GET /api/infra/:id/backup execute arbitrary SQL / stream full
 * DB dumps and return their output. They resolved the service via a GLOBAL
 * lookup with no `assertProjectAccess` guard, so a project-scoped agent key
 * minted for Project A could read or destroy Project B's database.
 *
 * This pins the fix: a project-scoped key gets 403 project_mismatch on another
 * project's infra; the owning key (and admin / cookie auth, i.e. no project
 * key) are allowed through to the running-state check. All assertions stop
 * BEFORE any `docker exec` so the suite needs no Docker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInfraDataRouter } from '../../src/routes/infra-data.js';
import { createInfraBackupRouter } from '../../src/routes/infra-backup.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { InfraService } from '../../src/types.js';

async function request(
  server: http.Server, method: string, urlPath: string,
  headers?: Record<string, string>, body?: unknown,
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

describe('infra data/backup project-scope isolation', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;

  const KEY_A = 'TEST-KEY-A';
  const KEY_B = 'TEST-KEY-B';

  function seedInfra(id: string, projectId: string): void {
    stateService.addInfraService({
      id, projectId, name: id, dockerImage: 'mongo:7', containerPort: 27017,
      hostPort: 27117, containerName: `cds-infra-${projectId}-${id}`,
      status: 'stopped', volumes: [], env: {}, createdAt: new Date().toISOString(),
    } as InfraService);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-infra-scope-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addProject({ id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now });
    seedInfra('mongo-a', 'proj-a');
    seedInfra('mongo-b', 'proj-b');

    const shell = new MockShellExecutor();
    shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === KEY_A) (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      if (h === KEY_B) (req as any).cdsProjectKey = { projectId: 'proj-b', keyId: 'k-b' };
      next();
    });
    app.use('/api', createInfraDataRouter({ stateService, shell, assertProjectAccess: assertProjectAccess as any }));
    app.use('/api', createInfraBackupRouter({ stateService, shell, assertProjectAccess: assertProjectAccess as any }));

    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  describe('POST /api/infra/:id/query', () => {
    it('refuses Project B key querying Project A database (403 project_mismatch)', async () => {
      const res = await request(server, 'POST', '/api/infra/mongo-a/query', { 'X-Test-Key': KEY_B }, { sql: 'db.users.find()' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
    });

    it('refuses even with an explicit cross-project ?project= filter', async () => {
      const res = await request(server, 'POST', '/api/infra/mongo-a/query?project=proj-a', { 'X-Test-Key': KEY_B }, { sql: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
    });

    it('allows the owning project key through the guard (409 since stopped, not 403)', async () => {
      const res = await request(server, 'POST', '/api/infra/mongo-a/query', { 'X-Test-Key': KEY_A }, { sql: 'x' });
      expect(res.status).toBe(409); // guard passed; blocked only by not-running state
    });

    it('allows admin / cookie auth (no project key) — guard is a no-op', async () => {
      const res = await request(server, 'POST', '/api/infra/mongo-a/query?project=proj-a', undefined, { sql: 'x' });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/infra/:id/init-sql', () => {
    it('refuses Project B key running init-sql on Project A database', async () => {
      const res = await request(server, 'POST', '/api/infra/mongo-a/init-sql', { 'X-Test-Key': KEY_B }, { sql: 'DROP DATABASE app;' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
    });
  });

  describe('GET /api/infra/:id/backup (sibling router hardened too)', () => {
    it('refuses Project B key dumping Project A database', async () => {
      const res = await request(server, 'GET', '/api/infra/mongo-a/backup', { 'X-Test-Key': KEY_B });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
    });

    it('allows the owning project key through the guard (409 since stopped)', async () => {
      const res = await request(server, 'GET', '/api/infra/mongo-a/backup', { 'X-Test-Key': KEY_A });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/infra/:id/restore', () => {
    it('refuses Project B key restoring over Project A database', async () => {
      const res = await request(server, 'POST', '/api/infra/mongo-a/restore', { 'X-Test-Key': KEY_B });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
    });
  });

  describe('same infra id across projects honors ?project= (backup route)', () => {
    // Both projects own a service called "shared" (e.g. catalog-created `postgres`).
    // proj-a's is seeded FIRST, so the global first-match lookup would return A's.
    beforeEach(() => {
      seedInfra('shared', 'proj-a');
      seedInfra('shared', 'proj-b');
    });

    it('owner key + ?project=own resolves its OWN service (409 stopped), not the global first-match (would 403)', async () => {
      const res = await request(server, 'GET', '/api/infra/shared/backup?project=proj-b', { 'X-Test-Key': KEY_B });
      // With ?project= scoping: B's own "shared" → guard passes → 409 (stopped).
      // Without it (global first-match → A's): assertProjectAccess(Bkey, proj-a) → 403.
      expect(res.status).toBe(409);
    });

    it('still refuses a cross-project ?project= (B key cannot target proj-a)', async () => {
      const res = await request(server, 'GET', '/api/infra/shared/backup?project=proj-a', { 'X-Test-Key': KEY_B });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('project_mismatch');
    });

    it('admin + ?project= streams the requested project, not the global first-match', async () => {
      // admin (no key) asking for proj-b's "shared" must resolve B's (409 stopped), proving
      // the ?project= filter is honored rather than silently returning A's first-match.
      const res = await request(server, 'GET', '/api/infra/shared/backup?project=proj-b', undefined);
      expect(res.status).toBe(409);
    });
  });
});
