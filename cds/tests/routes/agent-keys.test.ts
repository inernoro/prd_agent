/**
 * Tests for project-scoped Agent Keys.
 *
 * Covers:
 *   1) sign → list → revoke happy path
 *   2) auth with project-key permits project-scoped routes for its own project
 *   3) auth with project-key rejects another project's routes with 403
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter, assertProjectAccess } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';

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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-agentkeys-test-'));
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
