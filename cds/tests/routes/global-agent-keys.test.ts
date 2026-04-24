/**
 * Tests for global (bootstrap-equivalent) Agent Keys.
 *
 * These differ from project-scoped keys in three ways:
 *   1) prefix is `cdsg_` (vs `cdsp_`)
 *   2) auth match returns only a keyId (no projectId)
 *   3) they are NOT blocked by assertProjectAccess — they can create
 *      new projects, cross project boundaries, etc.
 *
 * A project-scoped key MUST NOT be able to mint or revoke globals —
 * that would be privilege escalation. We assert that boundary here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectsRouter } from '../../src/routes/projects.js';
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

describe('Global Agent Keys (bootstrap-equivalent)', () => {
  let tmpDir: string;
  let stateService: StateService;
  let shell: MockShellExecutor;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-globalkeys-test-'));
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    shell = new MockShellExecutor();

    const app = express();
    app.use(express.json());
    // Mirror the production auth middleware: stamp cdsProjectKey for
    // cdsp_ and do nothing for cdsg_ (bootstrap-equivalent).
    app.use((req, _res, next) => {
      const h = req.headers['x-ai-access-key'] as string | undefined;
      if (h && h.startsWith('cdsp_')) {
        const match = stateService.findAgentKeyForAuth(h);
        if (match) (req as any).cdsProjectKey = match;
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

  it('sign + list + revoke happy path for cdsg_ keys', async () => {
    // Sign (no auth → behaves as cookie-auth path in prod)
    const signRes = await request(server, 'POST', '/api/global-agent-keys', { label: 'bootstrap claude' });
    expect(signRes.status).toBe(201);
    expect(signRes.body.plaintext).toMatch(/^cdsg_/);
    // Suffix is 32 random bytes encoded as base64url, which may itself
    // contain `_`. So plaintext === 'cdsg_' + <suffix with possibly more
    // underscores>. Shape check: exactly one `cdsg_` header segment, no
    // project slug in between.
    expect(signRes.body.plaintext.indexOf('cdsg_')).toBe(0);
    expect(signRes.body.plaintext.length).toBeGreaterThan(10);
    const keyId = signRes.body.keyId as string;
    expect(typeof keyId).toBe('string');

    // List — one active key, no plaintext/hash
    const listRes = await request(server, 'GET', '/api/global-agent-keys');
    expect(listRes.status).toBe(200);
    expect(listRes.body.keys).toHaveLength(1);
    const entry = listRes.body.keys[0];
    expect(entry.label).toBe('bootstrap claude');
    expect(entry.status).toBe('active');
    expect(entry.hash).toBeUndefined();
    expect(entry.plaintext).toBeUndefined();

    // State-level lookup finds the key
    const match = stateService.findGlobalAgentKeyForAuth(signRes.body.plaintext);
    expect(match).not.toBeNull();
    expect(match!.keyId).toBe(keyId);

    // Revoke
    const revokeRes = await request(server, 'DELETE', `/api/global-agent-keys/${keyId}`);
    expect(revokeRes.status).toBe(200);

    // After revoke: listing still shows it (audit) but status=revoked,
    // and auth lookup returns null.
    const listRes2 = await request(server, 'GET', '/api/global-agent-keys');
    expect(listRes2.body.keys[0].status).toBe('revoked');
    expect(stateService.findGlobalAgentKeyForAuth(signRes.body.plaintext)).toBeNull();
  });

  it('project-scoped key CANNOT mint a global key (no privilege escalation)', async () => {
    // Seed a project-scoped key first.
    const projSign = await request(server, 'POST', '/api/projects/default/agent-keys', {});
    expect(projSign.status).toBe(201);
    const projectPlaintext = projSign.body.plaintext as string;

    // Using the project key as auth, try to mint a global. Must 403.
    const res = await request(
      server,
      'POST',
      '/api/global-agent-keys',
      { label: 'escalation attempt' },
      { 'X-AI-Access-Key': projectPlaintext },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('project_key_cannot_mint_global');

    // And must not be able to revoke someone else's global either.
    const preSign = await request(server, 'POST', '/api/global-agent-keys', {});
    const globalKeyId = preSign.body.keyId as string;
    const revokeRes = await request(
      server,
      'DELETE',
      `/api/global-agent-keys/${globalKeyId}`,
      undefined,
      { 'X-AI-Access-Key': projectPlaintext },
    );
    expect(revokeRes.status).toBe(403);
  });

  it('revoked key is not matched by findGlobalAgentKeyForAuth', async () => {
    const signRes = await request(server, 'POST', '/api/global-agent-keys', {});
    const keyId = signRes.body.keyId as string;
    const plaintext = signRes.body.plaintext as string;

    expect(stateService.findGlobalAgentKeyForAuth(plaintext)).not.toBeNull();
    stateService.revokeGlobalAgentKey(keyId);
    expect(stateService.findGlobalAgentKeyForAuth(plaintext)).toBeNull();
  });

  it('findGlobalAgentKeyForAuth returns null for malformed / unknown keys', () => {
    expect(stateService.findGlobalAgentKeyForAuth('')).toBeNull();
    expect(stateService.findGlobalAgentKeyForAuth('cdsp_foo_bar')).toBeNull();
    expect(stateService.findGlobalAgentKeyForAuth('cdsg_nonexistent')).toBeNull();
  });
});
