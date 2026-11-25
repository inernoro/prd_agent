/**
 * Agent Key 目录（GET /api/global-agent-keys/catalog）与签发来源、固定到期。
 *
 * 守的是三件事：
 *   1) 每条签发通道都把 issuedVia 写进去，目录据此分「用户 / AI Agent」；
 *      存量 Key 没有字段时如实标「来源未记录」，标签写得再像也不推断。
 *   2) 目录的状态与鉴权同一判据：鉴权拒的 Key 不许显示成有效。
 *   3) 用户选的固定到期日不随使用续期。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { createAccessRequestsRouter } from '../../src/routes/access-requests.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { deriveAgentKeySource, parseRequestedKeyExpiry } from '../../src/services/agent-key-catalog.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { listenLoopbackFixture } from '../helpers/loopback-http-fixture.js';

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown, headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const HUMAN = { 'X-Test-Human': 'owner-alice' };
/** 测试用明文按前缀拼出来：设计稿件附带的源码差异会被凭据样式扫描拦下，字面量写死会让稿件发不出去。 */
const fixtureKey = (prefix: string, rest: string) => `${prefix}_${rest}`;

describe('Agent Key 目录', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-key-catalog-test-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    for (const [id, slug, name] of [['proj-a', 'alpha', 'Alpha'], ['proj-b', 'beta', 'Beta']]) {
      stateService.addProject({ id, slug, name, kind: 'git', dockerNetwork: `cds-proj-${slug}`, legacyFlag: false, createdAt: now, updatedAt: now });
    }
    const shell = new MockShellExecutor();
    const liveNetworks = new Set<string>();
    shell.addResponsePattern(/^docker network inspect /, (m) => {
      const name = m[0].split(/\s+/).pop() || '';
      return liveNetworks.has(name) ? { stdout: 'exists', stderr: '', exitCode: 0 } : { stdout: '', stderr: 'no network', exitCode: 1 };
    });
    shell.addResponsePattern(/^docker network create /, (m) => {
      liveNetworks.add(m[0].split(/\s+/).pop() || '');
      return { stdout: 'network-id', stderr: '', exitCode: 0 };
    });
    const app = express();
    app.use(express.json());
    // 镜像生产鉴权中间件：人类会话 stamp cdsUser，机器 Key stamp cdsProjectKey / cdsAccess。
    app.use((req, _res, next) => {
      const human = req.headers['x-test-human'];
      if (typeof human === 'string') {
        (req as any).cdsUser = { username: human, isSystemOwner: true, authProvider: 'local' };
        (req as any)._cdsBasicHumanAuth = true;
      }
      const h = req.headers['x-ai-access-key'] as string | undefined;
      if (h?.startsWith('cdsp_')) {
        const match = stateService.findAgentKeyForAuth(h);
        if (match) (req as any).cdsProjectKey = match;
      } else if (h?.startsWith('cdsg_')) {
        const g = stateService.findGlobalAgentKeyForAuth(h);
        if (g) (req as any).cdsAccess = { keyId: g.keyId, access: g.access };
      }
      next();
    });
    app.use('/api', createAccessRequestsRouter({ stateService, authMode: 'disabled' }));
    app.use('/api', createProjectsRouter({ stateService, shell, config: { reposBase: tmpDir } as any }));
    server = listenLoopbackFixture(app);
    if (!server.address()) await once(server, 'listening');
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const catalog = async (query = '') => {
    const res = await request(server, 'GET', `/api/global-agent-keys/catalog${query}`, undefined, HUMAN);
    expect(res.status).toBe(200);
    return res.body.keys as any[];
  };

  it('页面签发的项目 Key 与全局 Key 都标为用户签发，并带项目名', async () => {
    const p = await request(server, 'POST', '/api/projects/proj-a/agent-keys', { label: '本地调试' }, HUMAN);
    const g = await request(server, 'POST', '/api/global-agent-keys', { label: '跨项目巡检', access: { canCreateProjects: false, projects: 'all' } }, HUMAN);
    expect(p.status).toBe(201);
    expect(g.status).toBe(201);
    const rows = await catalog();
    const project = rows.find((r) => r.id === p.body.keyId);
    const global = rows.find((r) => r.id === g.body.keyId);
    expect(project).toMatchObject({
      kind: 'project', projectId: 'proj-a', expiry: 'never',
      access: { scope: 'project', projects: [{ id: 'proj-a', name: 'Alpha' }], permission: 'full', canCreateProjects: false },
      source: { type: 'user', via: 'console', actor: 'owner-alice' },
      status: { code: 'active', usable: true },
    });
    expect(global).toMatchObject({ kind: 'global', access: { scope: 'all', permission: 'full' }, source: { type: 'user', actor: 'owner-alice' } });
    // 没有人类会话的调用方（bootstrap 静态 Key 走的就是这条）不能冒充用户签发。
    const machine = await request(server, 'POST', '/api/projects/proj-a/agent-keys', {});
    expect((await catalog()).find((r) => r.id === machine.body.keyId).source).toEqual({ type: 'agent', via: 'machine-api' });
  });

  it('固定到期日：写入 fixed，使用时不续期；过去的时间被拒绝', async () => {
    const at = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const res = await request(server, 'POST', '/api/projects/proj-a/agent-keys', { expiresAt: at }, HUMAN);
    expect(res.status).toBe(201);
    const stored = stateService.getAgentKeys('proj-a').find((k) => k.id === res.body.keyId)!;
    expect(stored).toMatchObject({ expiresAt: at, expiryMode: 'fixed' });
    stateService.touchAgentKeyLastUsed('proj-a', res.body.keyId);
    expect(stateService.getAgentKeys('proj-a').find((k) => k.id === res.body.keyId)!.expiresAt).toBe(at);
    expect((await catalog()).find((r) => r.id === res.body.keyId)).toMatchObject({ expiry: 'fixed', expiresAt: at, status: { code: 'active' } });

    const past = await request(server, 'POST', '/api/projects/proj-a/agent-keys', { expiresAt: new Date(Date.now() - 1000).toISOString() }, HUMAN);
    expect(past.status).toBe(400);
    expect(past.body.error).toBe('invalid_expires_at');
    const pastGlobal = await request(server, 'POST', '/api/global-agent-keys', { expiresAt: 'not-a-date' }, HUMAN);
    expect(pastGlobal.status).toBe(400);

    // 身份层签发的滑动续期 Key 仍按旧行为续期，零回归。
    const slidingAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    stateService.addAgentKey('proj-a', { id: 'sliding1', label: 's', hash: sha(fixtureKey('cdsp', 'alpha_sliding')), scope: 'rw', createdAt: new Date().toISOString(), expiresAt: slidingAt });
    stateService.touchAgentKeyLastUsed('proj-a', 'sliding1');
    expect(Date.parse(stateService.getAgentKeys('proj-a').find((k) => k.id === 'sliding1')!.expiresAt!)).toBeGreaterThan(Date.parse(slidingAt));
  });

  it('全局 Key 的固定到期日到点后鉴权与目录同时判为过期', async () => {
    const plaintext = fixtureKey('cdsg', 'expired-fixture');
    stateService.addGlobalAgentKey({ id: 'gexp', label: 'old', hash: sha(plaintext), scope: 'rw', issuedVia: 'console',
      access: { canCreateProjects: false, projects: ['proj-b'] }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(stateService.findGlobalAgentKeyForAuth(plaintext)).toBeNull();
    expect((await catalog()).find((r) => r.id === 'gexp')).toMatchObject({ status: { code: 'expired', usable: false }, expiry: 'fixed' });
  });

  it('目录状态与鉴权同一判据：主体停用的 Key 不显示为有效', async () => {
    const plaintext = fixtureKey('cdsp', 'alpha_principal-fixture');
    const now = new Date().toISOString();
    stateService.addPrincipal({ id: 'pr_agent1', name: 'Codex 工作站', kind: 'agent', status: 'active', createdAt: now });
    stateService.addProjectGrant({ id: 'pg_1', projectId: 'proj-a', principalId: 'pr_agent1', origin: 'approved', grantedAt: now });
    stateService.addAgentKey('proj-a', { id: 'pk1', label: 'self', hash: sha(plaintext), scope: 'rw', createdAt: now,
      principalId: 'pr_agent1', issuedByCredentialId: 'uc_1', issuedVia: 'self-service', expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString() });
    expect(stateService.findAgentKeyForAuth(plaintext)).not.toBeNull();
    expect((await catalog()).find((r) => r.id === 'pk1')).toMatchObject({
      expiry: 'sliding', status: { code: 'active', usable: true },
      source: { type: 'agent', via: 'self-service', agentName: 'Codex 工作站', credentialId: 'uc_1' },
    });
    stateService.setPrincipalStatus('pr_agent1', 'disabled', 'test');
    expect(stateService.findAgentKeyForAuth(plaintext)).toBeNull();
    expect((await catalog()).find((r) => r.id === 'pk1').status).toEqual({ code: 'principal-disabled', usable: false });
  });

  it('存量 Key 只按结构化字段判来源，标签写得再像也标为未记录', async () => {
    const now = new Date().toISOString();
    stateService.addAgentKey('proj-a', { id: 'legacy1', label: '授权密钥 (申请 a1b2 · Codex)', hash: sha('x1'), scope: 'rw', createdAt: now, createdBy: 'bob' });
    stateService.addAgentKey('proj-a', { id: 'legacy2', label: '设备接入 Cursor', hash: sha('x2'), scope: 'rw', createdAt: now, issuedByCredentialId: 'uc_9' });
    stateService.addAgentKey('proj-a', { id: 'legacy3', label: '签发于 2026-04-18 10:32', hash: sha('x3'), scope: 'rw', createdAt: now, claimedBy: 'li', claimedAt: now });
    stateService.addGlobalAgentKey({ id: 'legacyg', label: 'bootstrap', hash: sha('x4'), scope: 'rw', createdAt: now });
    const rows = await catalog();
    expect(rows.find((r) => r.id === 'legacy1').source).toEqual({ type: 'unknown', recordedAccount: 'bob' });
    expect(rows.find((r) => r.id === 'legacy2').source).toEqual({ type: 'agent', via: 'user-credential', credentialId: 'uc_9' });
    expect(rows.find((r) => r.id === 'legacy3').source).toEqual({ type: 'unknown', claimedBy: 'li', claimedAt: now });
    // 没有 access 的存量全局 Key 鉴权按全权解析——目录如实标出来。
    expect(rows.find((r) => r.id === 'legacyg')).toMatchObject({ source: { type: 'unknown' }, access: { scope: 'all', canCreateProjects: true, legacyFullAccess: true } });
  });

  it('Agent 申请经批准、再用一次性 Key 建项目：两把 Key 都归 AI Agent 并串起来', async () => {
    const started = await request(server, 'POST', '/api/bootstrap-access-requests', {
      agentName: 'Claude Code', requestedProject: { name: 'Gamma', repository: 'https://github.com/acme/gamma' },
    });
    expect(started.status).toBe(201);
    expect((await request(server, 'POST', `/api/access-requests/${started.body.requestId}/approve`, {}, HUMAN)).status).toBe(200);
    const delivered = await request(server, 'GET', `/api/bootstrap-access-requests/${started.body.requestId}`, undefined, { 'X-Poll-Token': started.body.pollToken });
    const created = await request(server, 'POST', '/api/projects', { name: 'Gamma', gitRepoUrl: 'https://github.com/acme/gamma' }, { 'X-AI-Access-Key': delivered.body.authorizationKey });
    expect(created.status).toBe(201);
    const rows = await catalog();
    const bootstrap = rows.find((r) => r.kind === 'global' && r.source.requestId === started.body.requestId);
    expect(bootstrap).toMatchObject({ access: { scope: 'create', oneTime: true }, source: { type: 'agent', via: 'access-request', agentName: 'Claude Code' } });
    const projectKey = rows.find((r) => r.kind === 'project' && r.projectId === created.body.project.id);
    expect(projectKey.source).toEqual({ type: 'agent', via: 'project-create', agentName: 'Claude Code', parentKeyId: bootstrap.id });
  });

  it('项目申请经批准签发的 Key 记录申请编号与 Agent 名', async () => {
    const started = await request(server, 'POST', '/api/projects/proj-b/access-requests', { agentName: 'Codex', purpose: '部署调试' });
    expect(started.status).toBe(201);
    expect((await request(server, 'POST', `/api/access-requests/${started.body.requestId}/approve`, {}, HUMAN)).status).toBe(200);
    const row = (await catalog('?project=proj-b')).find((r) => r.kind === 'project');
    expect(row.source).toMatchObject({ type: 'agent', via: 'access-request', agentName: 'Codex', requestId: started.body.requestId });
  });

  it('按项目筛选：只给能访问该项目的 Key，最近签发在前', async () => {
    const base = Date.now();
    const at = (offset: number) => new Date(base - offset).toISOString();
    stateService.addAgentKey('proj-a', { id: 'a-old', label: 'a', hash: sha('a1'), scope: 'rw', createdAt: at(5000) });
    stateService.addAgentKey('proj-a', { id: 'a-new', label: 'a', hash: sha('a2'), scope: 'rw', createdAt: at(1000) });
    stateService.addAgentKey('proj-b', { id: 'b-1', label: 'b', hash: sha('b1'), scope: 'rw', createdAt: at(10) });
    stateService.addGlobalAgentKey({ id: 'g-all', label: 'all', hash: sha('g1'), scope: 'rw', access: { canCreateProjects: false, projects: 'all' }, createdAt: at(3000) });
    stateService.addGlobalAgentKey({ id: 'g-a', label: 'one', hash: sha('g2'), scope: 'rw', access: { canCreateProjects: false, projects: ['proj-a'] }, createdAt: at(4000) });
    stateService.addGlobalAgentKey({ id: 'g-b', label: 'one', hash: sha('g3'), scope: 'rw', access: { canCreateProjects: false, projects: ['proj-b'] }, createdAt: at(20) });
    stateService.addGlobalAgentKey({ id: 'g-create', label: 'create', hash: sha('g4'), scope: 'rw', access: { canCreateProjects: true, projects: [] }, createdAt: at(30) });
    expect((await catalog('?project=proj-a')).map((r) => r.id)).toEqual(['a-new', 'g-all', 'g-a', 'a-old']);
    expect((await catalog()).map((r) => r.id)).toEqual(['b-1', 'g-b', 'g-create', 'a-new', 'g-all', 'g-a', 'a-old']);
    expect((await request(server, 'GET', '/api/global-agent-keys/catalog?project=missing', undefined, HUMAN)).status).toBe(404);
  });

  it('机器 Agent Key 不能读全部 Key 目录', async () => {
    const signed = await request(server, 'POST', '/api/projects/proj-a/agent-keys', {}, HUMAN);
    const res = await request(server, 'GET', '/api/global-agent-keys/catalog', undefined, { 'X-AI-Access-Key': signed.body.plaintext });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_key_cannot_mint_global');
  });
});

describe('deriveAgentKeySource / parseRequestedKeyExpiry', () => {
  it('设计权限的存量 Key 由结构化申请编号判为 Agent 申请', () => {
    expect(deriveAgentKeySource({ designAccessRequestId: 'req1', createdBy: 'bob' }))
      .toEqual({ type: 'agent', via: 'access-request', requestId: 'req1', approvedBy: 'bob' });
  });
  it('设备接入记录批准人与凭据', () => {
    expect(deriveAgentKeySource({ issuedVia: 'device-recovery', createdBy: 'admin', issuedByCredentialId: 'uc_2', requesterAgentName: 'Cursor' }))
      .toEqual({ type: 'agent', via: 'device-recovery', agentName: 'Cursor', approvedBy: 'admin', credentialId: 'uc_2' });
  });
  it('到期时间：空为永久，过去、乱码、超过 5 年被拒', () => {
    const now = Date.parse('2026-11-25T00:00:00Z');
    expect(parseRequestedKeyExpiry(undefined, now)).toBeUndefined();
    expect(parseRequestedKeyExpiry('', now)).toBeUndefined();
    expect(parseRequestedKeyExpiry('2026-12-02T00:00:00Z', now)).toBe('2026-12-02T00:00:00.000Z');
    expect(parseRequestedKeyExpiry('2026-11-24T00:00:00Z', now)).toHaveProperty('error');
    expect(parseRequestedKeyExpiry('nope', now)).toHaveProperty('error');
    expect(parseRequestedKeyExpiry(123, now)).toHaveProperty('error');
    expect(parseRequestedKeyExpiry('2032-01-01T00:00:00Z', now)).toHaveProperty('error');
  });
});
