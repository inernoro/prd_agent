/**
 * Tests for 被动授权(passive access grant)— 请求密钥 + 授权密钥两级凭据。
 *
 * Covers the security-critical properties:
 *   1) mint request key (cdsr_) → findRequestKeyForAuth resolves it
 *   2) request key default-deny: only the 2 access-request endpoints accept it;
 *      operator endpoints (approve/reject/list) reject a request key
 *   3) request key for project A cannot poll project B (403)
 *   4) full lifecycle: initiate → operator approve → poll delivers the
 *      authorization key ONCE → second poll returns delivered:true (no key)
 *   5) operator list never exposes the authorization key plaintext
 *   6) reject path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAccessRequestsRouter } from '../../src/routes/access-requests.js';
import { StateService } from '../../src/services/state.js';

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

/** cdsr_ header helper. */
function rk(key: string): Record<string, string> {
  return { 'X-AI-Access-Key': key };
}

describe('Access Requests (被动授权)', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-accessreq-test-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-a', slug: 'proj-alpha', name: 'Alpha', kind: 'git',
      dockerNetwork: 'cds-proj-a', legacyFlag: false, createdAt: now, updatedAt: now,
    });
    stateService.addProject({
      id: 'proj-b', slug: 'proj-beta', name: 'Beta', kind: 'git',
      dockerNetwork: 'cds-proj-b', legacyFlag: false, createdAt: now, updatedAt: now,
    });

    const app = express();
    app.use(express.json());
    // Faithfully replicate server.ts auth gate intent:
    //  - cdsr_ request key: default-deny, only the 2 access-request endpoints.
    //  - otherwise: simulate operator cookie auth (allow all).
    app.use((req, res, next) => {
      const ak = req.headers['x-ai-access-key'];
      const key = typeof ak === 'string' && ak.startsWith('cdsr_') ? ak : '';
      if (key) {
        if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/access-requests$/.test(req.path)) return next();
        if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/access-requests\/[^/]+$/.test(req.path)) return next();
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      (req as any)._cdsCookieAuth = true;
      next();
    });
    app.use('/api', createAccessRequestsRouter({ stateService }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function mintRequestKey(projectId = 'proj-a'): Promise<string> {
    const res = await request(server, 'POST', `/api/projects/${projectId}/request-keys`, {});
    expect(res.status).toBe(201);
    expect(res.body.plaintext).toMatch(/^cdsr_/);
    return res.body.plaintext as string;
  }

  it('mint request key → findRequestKeyForAuth resolves it', async () => {
    const key = await mintRequestKey('proj-a');
    const match = stateService.findRequestKeyForAuth(key);
    expect(match).toEqual({ projectId: 'proj-a', keyId: expect.any(String) });
  });

  it('request key default-deny: rejected on operator endpoints', async () => {
    const key = await mintRequestKey('proj-a');
    // list / approve / reject are operator endpoints — gate blocks cdsr_.
    expect((await request(server, 'GET', '/api/access-requests', undefined, rk(key))).status).toBe(401);
    expect((await request(server, 'POST', '/api/access-requests/x/approve', {}, rk(key))).status).toBe(401);
    expect((await request(server, 'POST', '/api/access-requests/x/reject', {}, rk(key))).status).toBe(401);
    // even minting more request keys is operator-only
    expect((await request(server, 'POST', '/api/projects/proj-a/request-keys', {}, rk(key))).status).toBe(401);
  });

  it('request key for project A cannot poll project B (403)', async () => {
    const keyA = await mintRequestKey('proj-a');
    // initiate under A
    const init = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'x' }, rk(keyA));
    expect(init.status).toBe(201);
    const reqId = init.body.requestId;
    // poll the same request id but under project B's path with A's key → 403
    const cross = await request(server, 'GET', `/api/projects/proj-b/access-requests/${reqId}`, undefined, rk(keyA));
    expect(cross.status).toBe(403);
  });

  it('full lifecycle: initiate → approve → deliver key once', async () => {
    const key = await mintRequestKey('proj-a');

    // 1. agent initiates
    const init = await request(server, 'POST', '/api/projects/proj-a/access-requests',
      { agentName: 'Claude', purpose: '需要全权读环境变量' }, rk(key));
    expect(init.status).toBe(201);
    const reqId = init.body.requestId as string;

    // 2. poll while pending
    const p1 = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, rk(key));
    expect(p1.body).toEqual({ status: 'pending' });

    // 3. operator sees it in the inbox, no plaintext exposed
    const list = await request(server, 'GET', '/api/access-requests');
    expect(list.body.pendingCount).toBe(1);
    expect(list.body.requests[0]).not.toHaveProperty('issuedKeyPlaintext');

    // 4. operator approves → mints an authorization key (cdsp_)
    const approve = await request(server, 'POST', `/api/access-requests/${reqId}/approve`, {});
    expect(approve.status).toBe(200);
    expect(approve.body.approved).toBe(true);
    // operator response must NOT contain the plaintext key
    expect(JSON.stringify(approve.body)).not.toContain('cdsp_');

    // 5. agent polls → gets the authorization key ONCE
    const deliver = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, rk(key));
    expect(deliver.body.status).toBe('approved');
    expect(deliver.body.authorizationKey).toMatch(/^cdsp_/);
    // the delivered authorization key is a real, working full project key
    expect(stateService.findAgentKeyForAuth(deliver.body.authorizationKey)).toEqual(
      { projectId: 'proj-a', keyId: expect.any(String) },
    );

    // 6. second poll → no more plaintext (one-time delivery)
    const deliver2 = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, rk(key));
    expect(deliver2.body).toEqual({ status: 'approved', delivered: true });
  });

  it('reject path: agent poll sees rejected + reason', async () => {
    const key = await mintRequestKey('proj-a');
    const init = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'x' }, rk(key));
    const reqId = init.body.requestId as string;
    const rej = await request(server, 'POST', `/api/access-requests/${reqId}/reject`, { reason: '不批' });
    expect(rej.status).toBe(200);
    const poll = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, rk(key));
    expect(poll.body).toEqual({ status: 'rejected', rejectReason: '不批' });
  });

  it('invalid / missing request key is rejected by route self-auth', async () => {
    // valid path but no key → route's authRequestKey returns 401
    const noKey = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'x' });
    expect(noKey.status).toBe(401);
    // a cdsr_ shaped but unknown key → 401
    const bogus = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'x' },
      rk('cdsr_proj-alpha_deadbeef'));
    expect(bogus.status).toBe(401);
  });
});
