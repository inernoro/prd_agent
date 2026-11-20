/**
 * Tests for project-scoped Agent Keys.
 *
 * Covers:
 *   1) sign → list → revoke happy path
 *   2) auth with project-key permits project-scoped routes for its own project
 *   3) project list discovery is isolated to the key's own project
 *   4) auth with project-key rejects another project's routes with 403
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter, assertProjectAccess } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { createServer } from '../../src/server.js';
import type { CdsConfig, Project } from '../../src/types.js';

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Agent Keys (project-scoped)', () => {
  let tmpDir: string;
  let stateService: StateService;
  let shell: MockShellExecutor;
  let server: http.Server;

  function seedLegacyProject(project: Partial<Project> = {}): void {
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'default',
      slug: 'default',
      name: 'Legacy Default',
      kind: 'git',
      dockerNetwork: 'cds-proj-default',
      legacyFlag: true,
      createdAt: now,
      updatedAt: now,
      ...project,
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agentkeys-test-'));
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();
    seedLegacyProject();

    // Two projects: legacy default + a second one ("alt-project") so we
    // can cover cross-project mismatch.
    stateService.addProject({
      id: 'alt-proj-id',
      slug: 'alt-project-abc',
      name: 'Alt Project',
      kind: 'git',
      dockerNetwork: 'cds-proj-alt',
      legacyFlag: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    shell = new MockShellExecutor();

    const app = express();
    app.use(express.json());
    // Minimal middleware mirroring the server: stamp req.cdsProjectKey
    // whenever the X-AI-Access-Key header matches a known project key.
    app.use((req, _res, next) => {
      const h = req.headers['x-ai-access-key'] as string | undefined;
      if (h && h.startsWith('cdsp_')) {
        const match = stateService.findAgentKeyForAuth(h);
        if (match) {
          (req as any).cdsProjectKey = match;
        }
      }
      next();
    });
    app.use('/api', createProjectsRouter({ stateService, shell }));

    server = app.listen(0);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('sign + list + revoke happy path', async () => {
    // Sign
    const signRes = await request(server, 'POST', '/api/projects/default/agent-keys', {});
    expect(signRes.status).toBe(201);
    expect(signRes.body.plaintext).toMatch(/^cdsp_/);
    expect(typeof signRes.body.keyId).toBe('string');
    expect(typeof signRes.body.preview).toBe('string');
    const keyId = signRes.body.keyId as string;

    // List — should see one active key, no plaintext/hash exposed.
    const listRes = await request(server, 'GET', '/api/projects/default/agent-keys');
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(1);
    const entry = listRes.body.keys[0];
    expect(entry.id).toBe(keyId);
    expect(entry.status).toBe('active');
    expect(entry.scope).toBe('rw');
    expect(entry.hash).toBeUndefined();
    expect(entry.plaintext).toBeUndefined();

    // Revoke
    const revokeRes = await request(
      server,
      'DELETE',
      `/api/projects/default/agent-keys/${keyId}`,
    );
    expect(revokeRes.status).toBe(200);

    // List again — still visible but revoked.
    const listRes2 = await request(server, 'GET', '/api/projects/default/agent-keys');
    expect(listRes2.status).toBe(200);
    expect(listRes2.body.keys).toHaveLength(1);
    expect(listRes2.body.keys[0].status).toBe('revoked');
    expect(listRes2.body.keys[0].revokedAt).toBeTruthy();
  });

  it('manages the credential lifecycle and tracks completed requests through the real auth middleware', async () => {
    vi.stubEnv('CDS_AUTH_MODE', 'basic');
    vi.stubEnv('CDS_USERNAME', 'fixture-admin');
    vi.stubEnv('CDS_PASSWORD', 'fixture-password');
    vi.stubEnv('CDS_AI_ACCESS_KEY', 'fixture-cds-bootstrap');
    vi.stubEnv('CDS_SSO_ENABLED', '');
    const config: CdsConfig = {
      repoRoot: tmpDir, worktreeBase: path.join(tmpDir, 'worktrees'), masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'fixture-network', portStart: 10001, sharedEnv: {},
      jwt: { secret: 'fixture-jwt-secret', issuer: 'fixture' }, mode: 'standalone', executorPort: 9901,
    };
    const app = createServer({ stateService, shell, config,
      worktreeService: new WorktreeService(shell, tmpDir), containerService: {} as any,
      bridgeService: {} as any,
      proxyService: { getProxyLog: () => [], setOnProxyLog: () => {}, handleSwitchFromExpress() {} } as any,
    });
    const live = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => { live.on('listening', resolve); live.on('error', reject); });
      const operator = { 'X-AI-Access-Key': 'fixture-cds-bootstrap' };
      const base = '/api/projects/default/agent-keys';
      const signed = await request(live, 'POST', base, { label: 'Cloud worker' }, operator);
      expect(signed.status).toBe(201);
      const key = { Authorization: `Bearer ${signed.body.plaintext}` };
      const keyUrl = `${base}/${signed.body.keyId}`;
      expect((await request(live, 'DELETE', `${keyUrl}/record`, undefined, operator)).status).toBe(409);
      expect((await request(live, 'PATCH', keyUrl, { label: '  ' }, operator)).status).toBe(400);
      expect((await request(live, 'PATCH', keyUrl, { label: 'Renamed worker', archived: true }, operator)).status).toBe(200);
      expect((await request(live, 'GET', base, undefined, operator)).body.keys[0]).toMatchObject({
        label: 'Renamed worker', archivedAt: expect.any(String), requestCount: 0,
      });
      for (let hit = 0; hit < 22; hit += 1) {
        expect((await request(live, 'GET', '/api/projects/default?private=fixture-private-value', undefined, key)).status).toBe(200);
      }
      expect((await request(live, 'GET', `/api/projects/alt-proj-id/agent-keys/${signed.body.keyId}`, undefined, key)).status).toBe(403);
      const details = (await request(live, 'GET', keyUrl, undefined, operator)).body;
      expect(details.key.requestCount).toBe(23);
      expect(details.requests).toHaveLength(20);
      expect(details.requests[0].status).toBe(403);
      expect(details.requests[1]).toMatchObject({ method: 'GET', route: '/projects/:id', status: 200, durationMs: expect.any(Number) });
      expect(JSON.stringify(details)).not.toContain('fixture-private-value');
      expect(JSON.stringify(details)).not.toContain(signed.body.plaintext);
      expect(details.key.hash).toBeUndefined();
      expect((await request(live, 'PATCH', keyUrl, { archived: false }, operator)).status).toBe(200);
      expect((await request(live, 'GET', base, undefined, operator)).body.keys[0].archivedAt).toBeUndefined();
      expect((await request(live, 'DELETE', keyUrl, undefined, operator)).status).toBe(200);
      expect((await request(live, 'GET', '/api/projects/default', undefined, key)).status).toBe(401);
      expect((await request(live, 'DELETE', `${keyUrl}/record`, undefined, operator)).status).toBe(200);
      expect((await request(live, 'GET', base, undefined, operator)).body.keys).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => live.close(() => resolve()));
      vi.unstubAllEnvs();
    }
  });

  it('project-key authenticates requests against its own project', async () => {
    // Sign a key for 'default' (behind cookie auth, no header).
    const signRes = await request(server, 'POST', '/api/projects/default/agent-keys', {});
    expect(signRes.status).toBe(201);
    const plaintext = signRes.body.plaintext as string;

    // State service resolves the plaintext → same project.
    const match = stateService.findAgentKeyForAuth(plaintext);
    expect(match).not.toBeNull();
    expect(match!.projectId).toBe('default');

    // A request carrying the project key can PUT its own project.
    const putRes = await request(
      server,
      'PUT',
      '/api/projects/default',
      { description: 'touched by project key' },
      { 'X-AI-Access-Key': plaintext },
    );
    expect(putRes.status).toBe(200);
    expect(putRes.body.project.description).toBe('touched by project key');

    // And it can list / revoke within the same project.
    const listRes = await request(
      server,
      'GET',
      '/api/projects/default/agent-keys',
      undefined,
      { 'X-AI-Access-Key': plaintext },
    );
    expect(listRes.status).toBe(200);

    // assertProjectAccess helper: direct unit check too.
    const allow = assertProjectAccess({ cdsProjectKey: match! }, 'default');
    expect(allow).toBeNull();
  });

  it('project-key only discovers its bound project in the project list', async () => {
    const signRes = await request(server, 'POST', '/api/projects/default/agent-keys', {});
    expect(signRes.status).toBe(201);
    const plaintext = signRes.body.plaintext as string;

    const scopedList = await request(
      server,
      'GET',
      '/api/projects',
      undefined,
      { 'X-AI-Access-Key': plaintext },
    );
    expect(scopedList.status).toBe(200);
    expect(scopedList.body.total).toBe(1);
    expect(scopedList.body.projects.map((project: Project) => project.id)).toEqual(['default']);

    const unscopedList = await request(server, 'GET', '/api/projects');
    expect(unscopedList.status).toBe(200);
    expect(unscopedList.body.total).toBe(2);
    expect(unscopedList.body.projects.map((project: Project) => project.id).sort()).toEqual([
      'alt-proj-id',
      'default',
    ]);
  });

  it('project-key is refused on a different project (403 project_mismatch)', async () => {
    // Sign a key under 'default'.
    const signRes = await request(server, 'POST', '/api/projects/default/agent-keys', {});
    const plaintext = signRes.body.plaintext as string;

    // Attempt to PUT a different project with the default-project key.
    const res = await request(
      server,
      'PUT',
      '/api/projects/alt-proj-id',
      { description: 'should be rejected' },
      { 'X-AI-Access-Key': plaintext },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_mismatch');
    expect(res.body.expected).toBe('default');
    expect(res.body.got).toBe('alt-proj-id');

    // Read routes must use the same scope guard. Filtering only the project
    // list is insufficient because callers can address a known id directly.
    const getRes = await request(
      server,
      'GET',
      '/api/projects/alt-proj-id',
      undefined,
      { 'X-AI-Access-Key': plaintext },
    );
    expect(getRes.status).toBe(403);
    expect(getRes.body.error).toBe('project_mismatch');

    const listOtherKeysRes = await request(
      server,
      'GET',
      '/api/projects/alt-proj-id/agent-keys',
      undefined,
      { 'X-AI-Access-Key': plaintext },
    );
    expect(listOtherKeysRes.status).toBe(403);
    expect(listOtherKeysRes.body.error).toBe('project_mismatch');

    // And DELETE of the other project's keys is equally blocked.
    const delRes = await request(
      server,
      'DELETE',
      '/api/projects/alt-proj-id/agent-keys/whatever',
      undefined,
      { 'X-AI-Access-Key': plaintext },
    );
    expect(delRes.status).toBe(403);
    expect(delRes.body.error).toBe('project_mismatch');

    // Creating a new project is also refused for project-keys.
    const createRes = await request(
      server,
      'POST',
      '/api/projects',
      { name: 'Should Fail' },
      { 'X-AI-Access-Key': plaintext },
    );
    expect(createRes.status).toBe(403);
    expect(createRes.body.error).toBe('project_key_cannot_create');
  });

  it('assertProjectAccess is a no-op when no project key is attached', () => {
    // Bootstrap-key / cookie-auth case: cdsProjectKey undefined.
    expect(assertProjectAccess({}, 'anything')).toBeNull();
    expect(assertProjectAccess({ cdsProjectKey: undefined }, 'anything')).toBeNull();
  });
});
