/**
 * 凭据自检路由测试。
 *
 * 除了端点本身，这里还钉住两条**会静默退化**的接线（predicate-and-wiring
 * -discipline 形状 2 / 形状 7）：
 *
 *   - 路由必须真的挂进 server.ts；
 *   - 路径必须同时出现在 server.ts 的 isPublicAccessRequestRoute 与
 *     middleware/github-auth.ts 的 PUBLIC_PATHS 里。
 *
 * 少任何一处，这条端点就会被鉴权挡在门外、只回一句「未授权」—— 而那正是
 * 它要治的病。这种退化不会报错、不会红、通读也挑不出来，所以必须有守卫。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCredentialSelfCheckRouter } from '../../src/routes/credential-self-check.js';
import { hashCredential } from '../../src/services/credential-self-check.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../src');
const SELF_CHECK_PATH = '/api/credentials/self-check';

async function get(
  server: http.Server,
  urlPath: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET', headers: headers || {} },
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
    req.end();
  });
}

describe('GET /api/credentials/self-check', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let activeKey: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-selfcheck-route-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-a', slug: 'proj-alpha', name: 'Alpha', kind: 'git',
      dockerNetwork: 'cds-proj-a', legacyFlag: false, createdAt: now, updatedAt: now,
    });
    activeKey = 'cdsp_proj-alpha_activesuffix000000';
    stateService.addAgentKey('proj-a', {
      id: 'key-active', label: '有效钥匙', hash: hashCredential(activeKey),
      scope: 'rw', createdAt: now,
    });
    const revokedKey = 'cdsp_proj-alpha_revokedsuffix00000';
    stateService.addAgentKey('proj-a', {
      id: 'key-revoked', label: '已吊销', hash: hashCredential(revokedKey),
      scope: 'rw', createdAt: now, revokedAt: now,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createCredentialSelfCheckRouter({ stateService }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('从 Authorization: Bearer 读凭据，有效时给出项目身份', async () => {
    const res = await get(server, SELF_CHECK_PATH, { Authorization: `Bearer ${activeKey}` });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.projectId).toBe('proj-a');
    expect(res.body.keyId).toBe('key-active');
  });

  it('从 x-ai-access-key 读凭据，效果与 Bearer 一致', async () => {
    const res = await get(server, SELF_CHECK_PATH, { 'x-ai-access-key': activeKey });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  it('已吊销的凭据答「revoked」而不是「从未签发」', async () => {
    const res = await get(server, SELF_CHECK_PATH, {
      Authorization: 'Bearer cdsp_proj-alpha_revokedsuffix00000',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
    expect(res.body.keyId).toBe('key-revoked');
    expect(res.body.revokedAt).toBeTruthy();
  });

  it('不带任何凭据也返回 200 与可读结论（这条端点本来就是给进不来的人用的）', async () => {
    const res = await get(server, SELF_CHECK_PATH);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('malformed');
    expect(typeof res.body.nextStep).toBe('string');
  });

  it('响应里不出现明文凭据', async () => {
    const res = await get(server, SELF_CHECK_PATH, { Authorization: `Bearer ${activeKey}` });
    expect(JSON.stringify(res.body)).not.toContain(activeKey);
  });

  it('路由把身份层的事实一起装进快照——签出来的用户级凭证当场自检得出 active', async () => {
    // 端到端复现发布当天的那条 bug：判据认得 cdsu_，但路由没把
    // state.userCredentials 装进 facts，结论照样会塌回 never-issued。
    const plaintext = 'cdsu_routewiring0000000000000000';
    stateService.addPrincipal({
      id: 'pr_route',
      name: '接线守卫主体',
      kind: 'machine',
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    stateService.addUserCredential({
      id: 'uc_route',
      principalId: 'pr_route',
      hash: crypto.createHash('sha256').update(plaintext).digest('hex'),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    const res = await get(server, SELF_CHECK_PATH, { 'x-ai-access-key': plaintext });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('user');
    expect(res.body.status).toBe('active');
    expect(res.body.keyId).toBe('uc_route');
  });

  it('主体被停用时端点答 principal-disabled，不谎报 active', async () => {
    const plaintext = 'cdsu_routedisabled00000000000000';
    stateService.addPrincipal({
      id: 'pr_off',
      name: '已停用主体',
      kind: 'machine',
      status: 'disabled',
      createdAt: new Date().toISOString(),
    });
    stateService.addUserCredential({
      id: 'uc_off',
      principalId: 'pr_off',
      hash: crypto.createHash('sha256').update(plaintext).digest('hex'),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    const res = await get(server, SELF_CHECK_PATH, { 'x-ai-access-key': plaintext });
    expect(res.body.status).toBe('principal-disabled');
  });

  it('节流按转发来的客户端地址分桶，一个人打满不影响别人（Codex P2）', async () => {
    // nginx 后面 req.ip 对所有外部调用方是同一个值。若按它分桶，一个人打满
    // 配额其他人全吃 429 —— 而这条端点存在的全部理由就是给进不来的人自查。
    let sawThrottle = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await get(server, SELF_CHECK_PATH, { 'x-forwarded-for': '203.0.113.7' });
      if (res.status === 429) { sawThrottle = true; break; }
    }
    expect(sawThrottle).toBe(true);

    // 另一个来源不受影响
    const other = await get(server, SELF_CHECK_PATH, { 'x-forwarded-for': '198.51.100.9' });
    expect(other.status).toBe(200);
  });

  it('同来源高频调用会被节流成 429', async () => {
    let sawThrottle = false;
    for (let i = 0; i < 40; i += 1) {
      const res = await get(server, SELF_CHECK_PATH, { Authorization: `Bearer ${activeKey}` });
      if (res.status === 429) { sawThrottle = true; break; }
    }
    expect(sawThrottle).toBe(true);
  });
});

describe('接线守卫：自检端点必须被挂上且免鉴权', () => {
  const serverSource = fs.readFileSync(path.join(SRC, 'server.ts'), 'utf-8');
  const githubAuthSource = fs.readFileSync(path.join(SRC, 'middleware/github-auth.ts'), 'utf-8');

  it('server.ts 挂载了自检路由', () => {
    expect(serverSource).toContain('createCredentialSelfCheckRouter');
    expect(serverSource).toContain("createCredentialSelfCheckRouter({ stateService: deps.stateService })");
  });

  it('server.ts 的公开路由表放行了自检路径（basic-auth 模式）', () => {
    const fnStart = serverSource.indexOf('function isPublicAccessRequestRoute');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = serverSource.slice(fnStart, serverSource.indexOf('\n}', fnStart));
    expect(fnBody).toContain(SELF_CHECK_PATH);
  });

  it('github-auth 的 PUBLIC_PATHS 放行了自检路径（github 模式）', () => {
    const listStart = githubAuthSource.indexOf('const PUBLIC_PATHS');
    expect(listStart).toBeGreaterThan(-1);
    const listBody = githubAuthSource.slice(listStart, githubAuthSource.indexOf('\n];', listStart));
    expect(listBody).toContain(SELF_CHECK_PATH);
  });
});
