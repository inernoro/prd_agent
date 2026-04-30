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
import type { Project } from '../../src/types.js';

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

const NOW = '2026-01-01T00:00:00.000Z';

function addEmptyLegacyProject(stateService: StateService): Project {
  const project: Project = {
    id: 'default',
    slug: 'default',
    name: 'default',
    kind: 'git',
    legacyFlag: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
  stateService.addProject(project);
  return project;
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
    it('does not flag migration for an empty default project placeholder', async () => {
      addEmptyLegacyProject(stateService);
      const res = await request(server, 'GET', '/api/legacy-cleanup/status');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.counts.hasLegacyProject).toBe(true);
      expect(body.needsMigration).toBe(false);
      expect(body.residualOnly).toBe(false);
      expect(body.legacyInUse).toBe(false);
    });

    it('flags residualOnly when project + resources are gone but the worktree dir remains', async () => {
      // Leave an empty `default/` dir behind as the real rename flow can do.
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

    it('routes a non-empty customEnv["default"] scope to needsMigration, not residualOnly (round-5 PR #498 review fix)', async () => {
      // Round-1 added a 409 guard in cleanup-residual when env scope
      // has real keys, but /status was still flagging that state as
      // residualOnly → UI showed "清理残留" button that always 409'd.
      // Now the env scope routes to needsMigration so the user goes
      // through rename-default which copies the secrets into the new
      // project's scope.
      stateService.setCustomEnvVar('JWT_SECRET', 'still-here', 'default');
      stateService.save();

      const res = await request(server, 'GET', '/api/legacy-cleanup/status');
      const body = res.body as any;
      expect(body.counts.customEnvScopeExists).toBe(true);
      expect(body.needsMigration).toBe(true);
      expect(body.residualOnly).toBe(false);
      expect(body.legacyInUse).toBe(true);
      expect(body.recommendation).toMatch(/迁移/);
    });

    it('reports clean state when nothing is left', async () => {
      const res = await request(server, 'GET', '/api/legacy-cleanup/status');
      const body = res.body as any;
      expect(body.needsMigration).toBe(false);
      expect(body.residualOnly).toBe(false);
      expect(body.legacyInUse).toBe(false);
    });
  });

  describe('POST /api/legacy-cleanup/cleanup-residual', () => {
    it('removes the empty default/ dir when no resources remain', async () => {
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

    it('drops an empty default project placeholder', async () => {
      addEmptyLegacyProject(stateService);
      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.cleaned).toBe(true);
      expect(body.actions).toContain('dropped empty project "default"');
      expect(stateService.getProject('default')).toBeUndefined();
    });

    it('refuses with 409 when a branch still points at projectId=default', async () => {
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
      // No state data remains, but dir has orphan content — should NOT
      // silently rm -rf user data. Bail loudly.
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
      const res = await request(server, 'POST', '/api/legacy-cleanup/cleanup-residual');
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.cleaned).toBe(true);
      expect(body.actions).toHaveLength(0);
      expect(body.message).toMatch(/已经是干净状态/);
    });
  });
});
