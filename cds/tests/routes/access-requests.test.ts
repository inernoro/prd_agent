/**
 * Tests for 被动授权(passive access grant)— 最短路径版(免密发起 + 一次性 pollToken)。
 *
 * Covers the security-critical properties:
 *   1) 免密发起:无任何凭据即可 POST 发起,返回一次性 pollToken
 *   2) 轮询必须带正确 pollToken;无/错 token → 403(攻击者取不走别人批准的密钥)
 *   3) 防刷:同项目 pending 超过上限 → 429
 *   4) 全生命周期:发起 → 操作员批准 → 凭 token 取授权密钥一次 → 再轮询无明文
 *   5) 操作员列表不暴露授权密钥明文,也不暴露 pollTokenHash
 *   6) 拒绝路径
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

describe('Access Requests (被动授权 · 最短路径)', () => {
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

    const app = express();
    app.use(express.json());
    // Faithfully replicate server.ts auth gate:
    //  - the two access-request endpoints are public (no auth);
    //  - everything else: simulate operator cookie auth.
    app.use((req, _res, next) => {
      if (req.method === 'POST' && /^\/api\/projects\/[^/]+\/access-requests$/.test(req.path)) return next();
      if (req.method === 'GET' && /^\/api\/projects\/[^/]+\/access-requests\/[^/]+$/.test(req.path)) return next();
      // 默认模拟人类 cookie 登录;带 x-machine-key 头时模拟「机器密钥通过全局鉴权
      // 但不是人」—— 用于验证 approve/reject 拒绝机器密钥。
      if (req.headers['x-machine-key'] !== '1') (req as any)._cdsCookieAuth = true;
      next();
    });
    app.use('/api', createAccessRequestsRouter({ stateService }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('免密发起 → 返回 requestId + 一次性 pollToken', async () => {
    const res = await request(server, 'POST', '/api/projects/proj-a/access-requests', { agentName: 'Claude', purpose: 'x' });
    expect(res.status).toBe(201);
    expect(typeof res.body.requestId).toBe('string');
    expect(typeof res.body.pollToken).toBe('string');
    expect(res.body.status).toBe('pending');
  });

  it('轮询必须带正确 pollToken:无/错 token → 403', async () => {
    const init = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'x' });
    const reqId = init.body.requestId as string;
    // 无 token
    expect((await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`)).status).toBe(403);
    // 错 token
    expect((await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, { 'X-Poll-Token': 'wrong' })).status).toBe(403);
    // 对 token → 200 pending
    const ok = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, { 'X-Poll-Token': init.body.pollToken });
    expect(ok.body).toEqual({ status: 'pending' });
  });

  it('防刷:同项目 pending 超过上限 → 429', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: `p${i}` });
      expect(r.status).toBe(201);
    }
    const over = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'overflow' });
    expect(over.status).toBe(429);
  });

  it('全生命周期:发起 → 批准 → 凭 token 取授权密钥一次', async () => {
    const init = await request(server, 'POST', '/api/projects/proj-a/access-requests',
      { agentName: 'Claude', purpose: '需要全权读环境变量' });
    const reqId = init.body.requestId as string;
    const token = init.body.pollToken as string;

    // 操作员列表:看得到 pending,但不暴露 pollTokenHash / issuedKeyPlaintext
    const list = await request(server, 'GET', '/api/access-requests');
    expect(list.body.pendingCount).toBe(1);
    expect(list.body.requests[0]).not.toHaveProperty('pollTokenHash');
    expect(list.body.requests[0]).not.toHaveProperty('issuedKeyPlaintext');

    // 批准 → 操作员响应不含明文
    const approve = await request(server, 'POST', `/api/access-requests/${reqId}/approve`, {});
    expect(approve.status).toBe(200);
    expect(JSON.stringify(approve.body)).not.toContain('cdsp_');

    // 凭 token 轮询 → 取到授权密钥一次,且它是可用的全权项目 key
    const deliver = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, { 'X-Poll-Token': token });
    expect(deliver.body.status).toBe('approved');
    expect(deliver.body.authorizationKey).toMatch(/^cdsp_/);
    expect(stateService.findAgentKeyForAuth(deliver.body.authorizationKey)).toEqual(
      { projectId: 'proj-a', keyId: expect.any(String) },
    );

    // 再轮询 → 无明文(一次性交付)
    const deliver2 = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, { 'X-Poll-Token': token });
    expect(deliver2.body).toEqual({ status: 'approved', delivered: true });
  });

  it('拒绝路径:发起方凭 token 轮询看到 rejected + 原因', async () => {
    const init = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'x' });
    const reqId = init.body.requestId as string;
    const rej = await request(server, 'POST', `/api/access-requests/${reqId}/reject`, { reason: '不批' });
    expect(rej.status).toBe(200);
    const poll = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, { 'X-Poll-Token': init.body.pollToken });
    expect(poll.body).toEqual({ status: 'rejected', rejectReason: '不批' });
  });

  it('发起到不存在的项目 → 404', async () => {
    const res = await request(server, 'POST', '/api/projects/nope/access-requests', { purpose: 'x' });
    expect(res.status).toBe(404);
  });

  // 回归(Cursor):CDS_AUTH_MODE=disabled 本地 dev 全站无鉴权,审批盒所在 dashboard
  // 用户即操作员,approve/reject/list 必须放行,否则本地 dev 用不了。
  it('disabled 模式:无 cookie 身份也能列出/批准', async () => {
    const app2 = express();
    app2.use(express.json());
    app2.use((req, _res, next) => { next(); }); // 不 stamp 任何身份(模拟 disabled)
    app2.use('/api', createAccessRequestsRouter({ stateService, authMode: 'disabled' }));
    const srv2 = app2.listen(0);
    try {
      const init = await request(srv2, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'disabled' });
      expect(init.status).toBe(201);
      const reqId = init.body.requestId as string;
      expect((await request(srv2, 'GET', '/api/access-requests')).status).toBe(200);
      expect((await request(srv2, 'POST', `/api/access-requests/${reqId}/approve`, {})).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => srv2.close(() => resolve()));
    }
  });

  // 回归(Cursor/Codex 评审):approve/reject 必须是登录的人,机器密钥(API key)→ 403。
  // 否则项目 A 的 cdsp_ key 能批准项目 B 的申请 = 跨项目越权。
  it('机器密钥不能批准/拒绝(只有登录用户可以)', async () => {
    const init = await request(server, 'POST', '/api/projects/proj-a/access-requests', { purpose: 'x' });
    const reqId = init.body.requestId as string;
    const machine = { 'x-machine-key': '1' };
    expect((await request(server, 'POST', `/api/access-requests/${reqId}/approve`, {}, machine)).status).toBe(403);
    expect((await request(server, 'POST', `/api/access-requests/${reqId}/reject`, {}, machine)).status).toBe(403);
    // 列表也只给登录用户:机器密钥不得跨项目枚举别人的申请
    expect((await request(server, 'GET', '/api/access-requests', undefined, machine)).status).toBe(403);
    // 申请仍 pending(没被机器密钥动过)
    const poll = await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, { 'X-Poll-Token': init.body.pollToken });
    expect(poll.body.status).toBe('pending');
    // 人类(默认 cookie)可以批准
    expect((await request(server, 'POST', `/api/access-requests/${reqId}/approve`, {})).status).toBe(200);
  });

  // 回归(真实环境抓到):发起存的是 project.id,调用方用 slug 轮询时不能误判 404。
  it('slug 与 id 混用:用 slug 发起 + 用 slug/id 任一轮询都能命中', async () => {
    // proj-a 的 slug 是 proj-alpha
    const init = await request(server, 'POST', '/api/projects/proj-alpha/access-requests', { purpose: 'slug' });
    expect(init.status).toBe(201);
    const reqId = init.body.requestId as string;
    const token = init.body.pollToken as string;
    // 用 slug 轮询
    expect((await request(server, 'GET', `/api/projects/proj-alpha/access-requests/${reqId}`, undefined, { 'X-Poll-Token': token })).body)
      .toEqual({ status: 'pending' });
    // 用 id 轮询(同一项目)
    expect((await request(server, 'GET', `/api/projects/proj-a/access-requests/${reqId}`, undefined, { 'X-Poll-Token': token })).body)
      .toEqual({ status: 'pending' });
  });
});
