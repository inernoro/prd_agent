/**
 * Tests for /api/legacy-cleanup/* — split between:
 *   - GET /status                  (classifies the legacy state)
 *   - POST /cleanup-residual       (safely removes stale dir/env scope)
 *   - POST /rename-default         (full migration, existing behaviour)
 *
 * Regression focus: after rename-default successfully flips `default` →
 * a real project id, the only thing left is an empty `<worktreeBase>/
 * default/` directory (and sometimes an empty customEnv scope). The
 * UI used to surface the same "迁移 →" banner for that state,
 * confusing users into thinking they hadn't migrated. The new
 * `residualOnly` flag + `cleanup-residual` endpoint give a clean
 * "just remove the leftover" path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createLegacyCleanupRouter } from '../../src/routes/legacy-cleanup.js';

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('Legacy-Cleanup Routes', () => {
  let tmpDir: string;
  let worktreeBase: string;
  let stateService: StateService;
  let server: http.Server;
  let shell: MockShellExecutor;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-legacy-'));
    worktreeBase = path.join(tmpDir, 'worktrees');
    fs.mkdirSync(worktreeBase, { recursive: true });

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();

    shell = new MockShellExecutor();

    const app = express();
    app.use(express.json());
    app.use('/api', createLegacyCleanupRouter({ stateService, shell, worktreeBase }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
  });

  describe('GET /api/legacy-cleanup/status', () => {
    it('flags needsMigration when the default project record still exists', async () => {
      // Fresh load() auto-creates the legacy default project via migration.
      const res = await request(server, 'GET', '/api/legacy-cleanup/status');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.counts.hasLegacyProject).toBe(true);
      expect(body.needsMigration).toBe(true);
      expect(body.residualOnly).toBe(false);
      expect(body.legacyInUse).toBe(true);
    });

    it('flags residualOnly when project + resources are gone but the worktree dir remains', async () => {
      // Simulate post-rename state: flip legacy project to a real id.
      const legacy = stateService.getLegacyProject()!;
      legacy.id = 'prd-agent';
      legacy.legacyFlag = false;
      stateService.save();
      // Leave an empty `default/` dir behind as the real rename flow does.
      fs.mkdirSync(path.join(worktreeBase, 'default'));

      const res = await request(server, 'GET', '/api/legacy-cleanup/status');
      const body = res.body as any;
      expect(body.counts.hasLegacyProject).toBe(false);
      expect(body.counts.branches).toBe(0);
      expect(body.counts.legacyWorktreeExists).toBe(true);
      expect(body.needsMigration).toBe(false);
      expect(body.residualOnly).toBe(true);
      expect(body.legacyInUse).toBe(true);  // banner still shows, but with cleanup copy
      expect(body.recommendation).toMatch(/清理残留/);
    });

    it('reports clean state when nothing is left', async () => {
      // Rename done AND dir cleaned up.
      const legacy = stateService.getLegacyProject()!;
      legacy.id = 'prd-agent';
      legacy.legacyFlag = false;
      stateService.save();
      // no default/ dir created

      const res = await request(server, 'GET', '/api/legacy-cleanup/status');
      const body = res.body as any;
      expect(body.needsMigration).toBe(false);
      expect(body.residualOnly).toBe(false);
      expect(body.legacyInUse).toBe(false);
    });
  });

  describe('POST /api/legacy-cleanup/cleanup-residual', () => {
    it('removes the empty default/ dir when no resources remain', async () => {
      // Post-rename + leftover dir
      const legacy = stateService.getLegacyProject()!;
      legacy.id = 'prd-agent';
      legacy.legacyFlag = false;
      stateService.save();
      const leftoverDir = path.join(worktreeBase, 'default');
      fs.mkdirSync(leftoverDir);
      expect(fs.existsSync(leftoverDir)).toBe(true);

      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.cleaned).toBe(true);
      expect(body.actions.some((a: string) => a.includes('removed empty dir'))).toBe(true);
      expect(fs.existsSync(leftoverDir)).toBe(false);
    });

    it('refuses with 409 when the default project still exists', async () => {
      // Default legacy project still present from migration() — NOT residual.
      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(409);
      const body = res.body as any;
      expect(body.error).toBe('not_residual');
      expect(body.counts.hasLegacyProject).toBe(true);
    });

    it('refuses with 409 when a branch still points at projectId=default', async () => {
      // Rename the project but leave a stranded branch attributed to 'default'.
      const legacy = stateService.getLegacyProject()!;
      legacy.id = 'prd-agent';
      legacy.legacyFlag = false;
      stateService.addBranch({
        id: 'leftover',
        projectId: 'default',
        branch: 'leftover',
        worktreePath: '',
        services: {},
        status: 'idle',
        createdAt: new Date().toISOString(),
      });

      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(409);
      expect((res.body as any).error).toBe('not_residual');
      expect((res.body as any).counts.branches).toBe(1);
    });

    it('refuses with 409 when customEnv["default"] still has values (PR #498 review fix)', async () => {
      // Post-rename, no project record, no resources, but the legacy
      // env scope still contains a real secret (e.g. user manually
      // edited state, or rename-default was bypassed). Cleanup-residual
      // must NOT silently drop these values — that would lose user
      // secrets. Migration path is rename-default; cleanup-residual
      // only handles empty placeholders.
      const legacy = stateService.getLegacyProject()!;
      legacy.id = 'prd-agent';
      legacy.legacyFlag = false;
      stateService.setCustomEnvVar('JWT_SECRET', 'real-secret-still-here', 'default');
      stateService.save();

      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(409);
      expect((res.body as any).error).toBe('not_residual');
      expect((res.body as any).counts.customEnvKeys).toBe(1);
      // Secret must still be there in the default scope — we bailed,
      // didn't drop.
      expect(stateService.getCustomEnvScope('default')['JWT_SECRET']).toBe('real-secret-still-here');
    });

    it('refuses with 409 when the default/ dir is non-empty', async () => {
      // Post-rename, residual-only by state, but dir has orphan content —
      // should NOT silently rm -rf user data. Bail loudly.
      const legacy = stateService.getLegacyProject()!;
      legacy.id = 'prd-agent';
      legacy.legacyFlag = false;
      stateService.save();
      const residualDir = path.join(worktreeBase, 'default');
      fs.mkdirSync(residualDir);
      fs.writeFileSync(path.join(residualDir, 'unknown-file.txt'), 'not mine');

      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(409);
      expect((res.body as any).error).toBe('dir_not_empty');
      // File must still be there — we bailed, didn't delete.
      expect(fs.existsSync(path.join(residualDir, 'unknown-file.txt'))).toBe(true);
    });

    it('is idempotent when already clean', async () => {
      const legacy = stateService.getLegacyProject()!;
      legacy.id = 'prd-agent';
      legacy.legacyFlag = false;
      stateService.save();

      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.cleaned).toBe(true);
      expect(body.actions).toHaveLength(0);
      expect(body.message).toMatch(/已经是干净状态/);
    });
  });
});
