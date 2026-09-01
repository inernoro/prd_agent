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
import { decideProjectCredentialIssue } from '../../src/services/identity.js';
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
      // 全权 cdsg_ 机器钥匙：server.ts 不会给它盖 cdsProjectKey，只盖 cdsAccess ——
      // 正是这个差别让「只挡项目级」的门卫把机器钥匙当成了管理员。
      if (req.headers['x-global-key']) {
        (req as any).cdsAccess = { keyId: 'g1', access: { projects: 'all' } };
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

/**
 * Codex P1：`no_grant` 的下一步指向「发起接入申请、由人批准一次」，但那条流程
 * 只签一把无主的 AgentKey，从不写 ProjectGrant。于是批准之后同一把用户级凭证
 * 再来自愈仍然是 no_grant，钥匙一丢又得重新批 —— 「批一次就够」这条本 PR 的
 * 单一目标，走这条路根本走不通。
 */
describe('接入申请批准 = 写授权，不只是发钥匙', () => {
  let tmpDir: string;
  let svc: StateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-approve-grant-'));
    svc = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    svc.load();
    svc.addProject({ id: 'p1', slug: 'demo', name: '演示项目', kind: 'git' } as never);
    svc.addPrincipal({
      id: 'pr_a', name: '某个智能体', kind: 'agent', status: 'active',
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('申请里带了主体时，批准要写一条 approved 授权，自愈随即成立', () => {
    // 申请阶段记下发起方是谁
    svc.addAccessRequest({
      id: 'req1', kind: 'project', projectId: 'p1',
      pollTokenHash: 'x', agentName: '某个智能体', purpose: '测试',
      status: 'pending', createdAt: new Date().toISOString(),
      principalId: 'pr_a',
    });
    // 批准前：没授权，自愈会被拒
    expect(decideProjectCredentialIssue(svc.getPrincipal('pr_a'), svc.getProjectGrants(), 'p1').allowed).toBe(false);

    // 批准（路由做的事：发钥匙 + 写授权）
    svc.addProjectGrant({
      id: 'pg_1', projectId: 'p1', principalId: 'pr_a',
      origin: 'approved', grantedAt: new Date().toISOString(),
    });

    // 批准后：自愈成立，且丢了钥匙也不必再批
    expect(decideProjectCredentialIssue(svc.getPrincipal('pr_a'), svc.getProjectGrants(), 'p1').allowed).toBe(true);
  });

  it('批准路由源码里真的写了授权（不是只在测试里手动补一行）', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'routes', 'access-requests.ts'),
      'utf-8',
    );
    // 接线守卫：删掉这段，批准就退回「只发钥匙」，而上面那条用例照样绿
    expect(source).toContain('addProjectGrant');
    expect(source).toContain("origin: 'approved'");
    // 申请阶段必须认一次主体，否则批准时无从写起
    expect(source).toContain('resolveUserCredential');
  });
});

/**
 * Codex P1（安全）：身份管理的门卫只挡项目级凭证，而全权 `cdsg_` 机器钥匙
 * （projects: 'all'）不会被盖 `cdsProjectKey` —— 于是一把机器钥匙就能给任意主体
 * 签凭证、停用主体、增删项目授权。而签发/吊销全局通行证那几条路由早就用
 * `assertNotMachineAgentKey` 把所有机器钥匙一律挡在门外了：同样杀伤力的动作，
 * 两套判据，宽的那套赢。
 */
describe('身份管理只认人，不认机器钥匙', () => {
  let tmp: string;
  let stateService: StateService;
  let server: http.Server;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-identity-admin-'));
    stateService = new StateService(path.join(tmp, 'state.json'), tmp);
    stateService.load();
    stateService.addPrincipal({
      id: 'pr_v', name: '受害主体', kind: 'machine', status: 'active',
      createdAt: new Date().toISOString(),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-global-key']) {
        (req as never as { cdsAccess: unknown }).cdsAccess = { keyId: 'g1', access: { projects: 'all' } };
      }
      if (req.headers['x-project-key']) {
        (req as never as { cdsProjectKey: unknown }).cdsProjectKey = { projectId: 'p', keyId: 'k' };
      }
      next();
    });
    app.use('/api', createIdentityRouter({ stateService }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    flushAllJsonStateStores();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const H = { 'x-global-key': '1' };

  it('全权机器钥匙不能给已有主体签凭证（拿到就等于冒充那个主体）', async () => {
    const res = await call(server, 'POST', '/api/identity/user-credentials', { principalId: 'pr_v' }, H);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('全权机器钥匙不能停用主体（那是一键切断别人访问）', async () => {
    const res = await call(server, 'POST', '/api/identity/principals/pr_v/status', { status: 'disabled' }, H);
    expect(res.status).toBe(403);
    expect(stateService.getPrincipal('pr_v')?.status).toBe('active');
  });

  it('全权机器钥匙不能增删项目授权', async () => {
    const grant = await call(server, 'POST', '/api/identity/grants', { principalId: 'pr_v', projectId: 'p1' }, H);
    expect(grant.status).toBe(403);
    const revoke = await call(server, 'POST', '/api/identity/grants/pg_x/revoke', {}, H);
    expect(revoke.status).toBe(403);
  });

  it('全权机器钥匙也读不了权限总览（那是一份完整的凭据地图）', async () => {
    const res = await call(server, 'GET', '/api/identity/overview', undefined, H);
    expect(res.status).toBe(403);
  });

  it('项目级凭证同样被挡（原来的判据没被放宽）', async () => {
    const res = await call(server, 'GET', '/api/identity/overview', undefined, { 'x-project-key': '1' });
    expect(res.status).toBe(403);
  });

  it('没盖任何机器钥匙时放行（判据不是恒假）', async () => {
    const res = await call(server, 'GET', '/api/identity/overview');
    expect(res.status).toBe(200);
  });
});

/**
 * 用户级凭证的「发现自己能干什么」入口必须按授权收窄（Codex 第四轮 P2）。
 *
 * 我把 GET /api/projects 放进了用户级凭证的白名单，但那条列表路由只按项目级
 * 凭证过滤 —— 于是一把 cdsu_ 能看到**全部**项目的仓库地址与配置摘要。放行一条
 * 路由的同时没收窄它的可见范围，是「加了入口没加围栏」。
 */
describe('项目列表按主体授权收窄', () => {
  it('列表路由源码里按 cdsPrincipal + 授权过滤，不是只看项目级凭证', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'routes', 'projects.ts'),
      'utf-8',
    );
    const idx = source.indexOf("router.get('/projects', (req, res) => {");
    expect(idx).toBeGreaterThan(-1);
    const handler = source.slice(idx, idx + 2000);
    expect(handler).toContain('cdsPrincipal');
    expect(handler).toContain('hasActiveGrant');
  });

  it('放行清单里确实有这条路由（否则上面那条守卫是空转的）', () => {
    expect(userCredentialRouteAllowed('GET', '/api/projects')).toBe(true);
  });
});
