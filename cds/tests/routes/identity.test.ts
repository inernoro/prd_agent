/**
 * 身份层路由测试 —— 重点是**自愈链路**与**权限边界**。
 *
 * 这两件事都属于「不测就会静默坏掉」：
 *   - 自愈：仓库里的凭据丢了，有授权就该当场补一张、零人工；没授权才走页面批准。
 *     少了它，用户挪个目录就得重新申请重新批 —— 那正是这一层要消灭的痛点。
 *   - 边界：用户级凭证只能到达白名单路由。少了它，「发钥匙的钥匙」会悄悄长成
 *     万能钥匙，回到第一阶段那把 access key 的老路（权限太大、容易删错项目）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createIdentityRouter,
  resolveUserCredential,
  userCredentialRouteAllowed,
} from '../../src/routes/identity.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

async function call(
  server: http.Server, method: string, urlPath: string, body?: unknown, headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString()));
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

describe('userCredentialRouteAllowed —— 只授权不操作的落点', () => {
  it('放行「建项目 / 列项目 / 发钥匙 / 我是谁」四件事', () => {
    expect(userCredentialRouteAllowed('POST', '/api/identity/project-credentials')).toBe(true);
    expect(userCredentialRouteAllowed('GET', '/api/identity/whoami')).toBe(true);
    expect(userCredentialRouteAllowed('GET', '/api/projects')).toBe(true);
    expect(userCredentialRouteAllowed('POST', '/api/projects')).toBe(true);
  });

  it('一切改动项目内部的路由都不放行 —— 它不是万能钥匙', () => {
    expect(userCredentialRouteAllowed('DELETE', '/api/branches/x')).toBe(false);
    expect(userCredentialRouteAllowed('POST', '/api/branches/x/deploy')).toBe(false);
    expect(userCredentialRouteAllowed('POST', '/api/operator/request')).toBe(false);
    expect(userCredentialRouteAllowed('DELETE', '/api/projects/x')).toBe(false);
    expect(userCredentialRouteAllowed('GET', '/api/identity/overview')).toBe(false);
  });
});

describe('身份层路由', () => {
  let tmp: string;
  let stateService: StateService;
  let server: http.Server;

  /** 模拟 server.ts 的鉴权：带 cdsu 头就解析成主体上下文；带 x-project-key 就当项目级凭证。 */
  function start(): http.Server {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userKey = req.headers['x-user-credential'] as string | undefined;
      if (userKey) {
        if (!userCredentialRouteAllowed(req.method, req.path)) return next();
        const ctx = resolveUserCredential(stateService, userKey);
        if (ctx) (req as any).cdsPrincipal = ctx;
      }
      if (req.headers['x-project-key']) {
        (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k1' };
      }
      next();
    });
    app.use('/api', createIdentityRouter({ stateService }));
    return app.listen(0, '127.0.0.1');
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-identity-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-a', slug: 'proj-alpha', name: 'Alpha', kind: 'git',
      dockerNetwork: 'cds-a', legacyFlag: false, createdAt: now, updatedAt: now,
    });
    stateService.addProject({
      id: 'proj-b', slug: 'proj-beta', name: 'Beta', kind: 'git',
      dockerNetwork: 'cds-b', legacyFlag: false, createdAt: now, updatedAt: now,
    });
    server = start();
    await new Promise<void>((r) => server.once('listening', r));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    flushAllJsonStateStores();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function issueUserCredential(name = '我的笔记本'): Promise<{ plaintext: string; principalId: string; credentialId: string }> {
    const res = await call(server, 'POST', '/api/identity/user-credentials', { name });
    expect(res.status).toBe(201);
    return {
      plaintext: res.body.plaintext,
      principalId: res.body.principal.id,
      credentialId: res.body.credential.id,
    };
  }

  it('签发用户级凭证：明文只给一次，并写清它能到达什么', async () => {
    const res = await call(server, 'POST', '/api/identity/user-credentials', { name: '我的笔记本' });
    expect(res.status).toBe(201);
    expect(res.body.plaintext.startsWith('cdsu_')).toBe(true);
    expect(res.body.reach).toContain('不能删分支');
    // 明文不落库
    expect(JSON.stringify(stateService.getUserCredentials())).not.toContain(res.body.plaintext);
  });

  it('自愈：有授权就当场补一张项目级凭证，零人工', async () => {
    const cred = await issueUserCredential();
    await call(server, 'POST', '/api/identity/grants', { principalId: cred.principalId, projectId: 'proj-a', origin: 'created' });

    const res = await call(server, 'POST', '/api/identity/project-credentials',
      { projectId: 'proj-a' }, { 'x-user-credential': cred.plaintext });

    expect(res.status).toBe(201);
    expect(res.body.plaintext.startsWith('cdsp_proj-alpha_')).toBe(true);
    expect(res.body.grantOrigin).toBe('created');
    // 新签的项目级凭证是短命的，并且能被既有鉴权路径认出来
    const issued = stateService.getAgentKeys('proj-a')[0];
    expect(issued.expiresAt).toBeTruthy();
    expect(issued.principalId).toBe(cred.principalId);
    expect(issued.issuedByCredentialId).toBe(cred.credentialId);
    expect(stateService.findAgentKeyForAuth(res.body.plaintext)).toEqual({ projectId: 'proj-a', keyId: issued.id });
    // 签发留痕
    expect(stateService.getUserCredentials()[0].issuedCount).toBe(1);
  });

  it('没授权：不给签，并明确指路走一次页面批准（不是丢一句 403）', async () => {
    const cred = await issueUserCredential();
    const res = await call(server, 'POST', '/api/identity/project-credentials',
      { projectId: 'proj-b' }, { 'x-user-credential': cred.plaintext });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_grant');
    expect(res.body.nextStep).toContain('批准');
    expect(res.body.nextStep).toContain('换机器');
    expect(stateService.getAgentKeys('proj-b')).toHaveLength(0);
  });

  it('撤销用户级凭证会级联撤掉它签出的全部下游', async () => {
    const cred = await issueUserCredential();
    await call(server, 'POST', '/api/identity/grants', { principalId: cred.principalId, projectId: 'proj-a' });
    await call(server, 'POST', '/api/identity/grants', { principalId: cred.principalId, projectId: 'proj-b' });
    const a = await call(server, 'POST', '/api/identity/project-credentials', { projectId: 'proj-a' }, { 'x-user-credential': cred.plaintext });
    const b = await call(server, 'POST', '/api/identity/project-credentials', { projectId: 'proj-b' }, { 'x-user-credential': cred.plaintext });
    expect(stateService.findAgentKeyForAuth(a.body.plaintext)).not.toBeNull();
    expect(stateService.findAgentKeyForAuth(b.body.plaintext)).not.toBeNull();

    const res = await call(server, 'POST', `/api/identity/user-credentials/${cred.credentialId}/revoke`, {});
    expect(res.status).toBe(200);
    expect(res.body.cascadedCount).toBe(2);

    // 撤了源头，下游同时失效 —— 否则撤了等于没撤
    expect(stateService.findAgentKeyForAuth(a.body.plaintext)).toBeNull();
    expect(stateService.findAgentKeyForAuth(b.body.plaintext)).toBeNull();
    // 用户级凭证本身也不再能用
    expect(resolveUserCredential(stateService, cred.plaintext)).toBeNull();
  });

  it('停用主体后，它的用户级凭证立刻不可用', async () => {
    const cred = await issueUserCredential();
    expect(resolveUserCredential(stateService, cred.plaintext)).not.toBeNull();
    const res = await call(server, 'POST', `/api/identity/principals/${cred.principalId}/status`, { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(resolveUserCredential(stateService, cred.plaintext)).toBeNull();
  });

  it('撤销项目授权后不能再自助补发', async () => {
    const cred = await issueUserCredential();
    const grant = await call(server, 'POST', '/api/identity/grants', { principalId: cred.principalId, projectId: 'proj-a' });
    await call(server, 'POST', `/api/identity/grants/${grant.body.grant.id}/revoke`, {});
    const res = await call(server, 'POST', '/api/identity/project-credentials',
      { projectId: 'proj-a' }, { 'x-user-credential': cred.plaintext });
    expect(res.status).toBe(403);
  });

  it('权限总览按主体聚合，并把没认领主体的存量凭证明说成「未认领」', async () => {
    const cred = await issueUserCredential('构建机');
    stateService.addAgentKey('proj-b', {
      id: 'legacy1', label: '存量钥匙', hash: 'a'.repeat(64), scope: 'rw',
      createdAt: new Date().toISOString(),
    });

    const res = await call(server, 'GET', '/api/identity/overview');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].principal.name).toBe('构建机');
    expect(res.body.rows[0].activeCredentials.map((c: any) => c.id)).toEqual([cred.credentialId]);
    expect(res.body.unclaimed.map((c: any) => c.id)).toEqual(['legacy1']);
  });

  it('项目级凭证管不了身份：总览与撤销一律 403', async () => {
    const overview = await call(server, 'GET', '/api/identity/overview', undefined, { 'x-project-key': '1' });
    expect(overview.status).toBe(403);
    const revoke = await call(server, 'POST', '/api/identity/user-credentials/uc_x/revoke', {}, { 'x-project-key': '1' });
    expect(revoke.status).toBe(403);
  });

  it('不带用户级凭证调自愈端点：明说要用哪一类凭证', async () => {
    const res = await call(server, 'POST', '/api/identity/project-credentials', { projectId: 'proj-a' });
    expect(res.status).toBe(401);
    expect(res.body.message).toContain('cdsu_');
  });
});
