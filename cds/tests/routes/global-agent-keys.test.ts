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
import { createProjectsRouter, assertUnscopedAdmin, assertScopedSweep } from '../../src/routes/projects.js';
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
    // Docker network mock so POST /api/projects (create) works in this suite.
    const liveNetworks = new Set<string>();
    shell.addResponsePattern(/^docker network inspect /, (m) => {
      const name = m[0].split(/\s+/).pop() || '';
      return liveNetworks.has(name)
        ? { stdout: 'exists', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'no network', exitCode: 1 };
    });
    shell.addResponsePattern(/^docker network create /, (m) => {
      const name = m[0].split(/\s+/).pop() || '';
      liveNetworks.add(name);
      return { stdout: 'network-id', stderr: '', exitCode: 0 };
    });
    shell.addResponsePattern(/^docker network rm /, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const app = express();
    app.use(express.json());
    // Mirror the production auth middleware: stamp cdsProjectKey for cdsp_
    // and cdsAccess for cdsg_ (unified authorization scope, 2026-07-09).
    app.use((req, _res, next) => {
      const h = req.headers['x-ai-access-key'] as string | undefined;
      if (h && h.startsWith('cdsp_')) {
        const match = stateService.findAgentKeyForAuth(h);
        if (match) (req as any).cdsProjectKey = match;
      } else if (h && h.startsWith('cdsg_')) {
        const gmatch = stateService.findGlobalAgentKeyForAuth(h);
        if (gmatch) {
          (req as any).cdsAccess = { keyId: gmatch.keyId, access: gmatch.access };
          // 镜像 server.ts stampSingleProjectScope:单项目 cdsg_ 同时 stamp cdsProjectKey。
          if (Array.isArray(gmatch.access.projects) && gmatch.access.projects.length === 1) {
            (req as any).cdsProjectKey = { projectId: gmatch.access.projects[0], keyId: gmatch.keyId };
          }
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
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'default',
      slug: 'default',
      name: 'Legacy Default',
      kind: 'legacy',
      legacyFlag: true,
      createdAt: now,
      updatedAt: now,
    });
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
    expect(res.body.error).toBe('agent_key_cannot_mint_global');

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

/**
 * 统一授权作用域(2026-07-09):cdsg_ 全局 key 带 { canCreateProjects, projects }
 * 描述符。这些测试焊死核心安全不变量:
 *   - 签发默认 = create-only(能建项目,碰不到现有项目)
 *   - create-only key 建项目返回新项目 scoped key,但被 assertProjectAccess 挡在现有项目外
 *   - projects:'all' = 旧全权 admin,可操作现有项目
 *   - canCreateProjects:false 的 key 不能建项目
 *   - 存量 key(无 access) 解析为全权 admin(零回归)
 */
describe('Global Agent Keys — 统一授权作用域', () => {
  let tmpDir: string;
  let stateService: StateService;
  let shell: MockShellExecutor;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-keyscope-test-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();

    shell = new MockShellExecutor();
    const liveNetworks = new Set<string>();
    shell.addResponsePattern(/^docker network inspect /, (m) => {
      const name = m[0].split(/\s+/).pop() || '';
      return liveNetworks.has(name)
        ? { stdout: 'exists', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'no network', exitCode: 1 };
    });
    shell.addResponsePattern(/^docker network create /, (m) => {
      const name = m[0].split(/\s+/).pop() || '';
      liveNetworks.add(name);
      return { stdout: 'network-id', stderr: '', exitCode: 0 };
    });
    shell.addResponsePattern(/^docker network rm /, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const h = req.headers['x-ai-access-key'] as string | undefined;
      if (h && h.startsWith('cdsp_')) {
        const match = stateService.findAgentKeyForAuth(h);
        if (match) (req as any).cdsProjectKey = match;
      } else if (h && h.startsWith('cdsg_')) {
        const gmatch = stateService.findGlobalAgentKeyForAuth(h);
        if (gmatch) {
          (req as any).cdsAccess = { keyId: gmatch.keyId, access: gmatch.access };
          // 镜像 server.ts stampSingleProjectScope:单项目 cdsg_ 同时 stamp cdsProjectKey。
          if (Array.isArray(gmatch.access.projects) && gmatch.access.projects.length === 1) {
            (req as any).cdsProjectKey = { projectId: gmatch.access.projects[0], keyId: gmatch.keyId };
          }
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

  function seedProject(id: string): void {
    const now = new Date().toISOString();
    stateService.addProject({
      id, slug: id, name: id, kind: 'git', legacyFlag: false, createdAt: now, updatedAt: now,
    });
  }

  it('默认签发 = create-only（能建项目、carries projects:[]）', async () => {
    const res = await request(server, 'POST', '/api/global-agent-keys', {});
    expect(res.status).toBe(201);
    expect(res.body.access).toEqual({ canCreateProjects: true, projects: [] });
    // list 也回填 access
    const list = await request(server, 'GET', '/api/global-agent-keys');
    expect(list.body.keys[0].access).toEqual({ canCreateProjects: true, projects: [] });
  });

  it('create-only key：能建项目并拿回新项目 scoped key，但碰不到现有项目', async () => {
    seedProject('existing-proj');
    const sign = await request(server, 'POST', '/api/global-agent-keys', {});
    const key = sign.body.plaintext as string;

    // 能建新项目 → 返回 issuedProjectKey（scoped 到新项目）
    const create = await request(server, 'POST', '/api/projects', { name: 'Fresh One' }, { 'X-AI-Access-Key': key });
    expect(create.status).toBe(201);
    expect(create.body.issuedProjectKey?.plaintext).toMatch(/^cdsp_/);
    const newProjectId = create.body.project.id as string;
    // 返回的 scoped key 真的绑在新项目上
    const scopedMatch = stateService.findAgentKeyForAuth(create.body.issuedProjectKey.plaintext);
    expect(scopedMatch?.projectId).toBe(newProjectId);

    // 但 create-only key 无权操作已存在的项目（assertProjectAccess 拦截）
    const blocked = await request(
      server, 'POST', '/api/projects/existing-proj/agent-keys', {}, { 'X-AI-Access-Key': key },
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('project_out_of_scope');
  });

  it("projects:'all' key = 全权 admin：可操作现有项目，且建项目不再另发 key", async () => {
    seedProject('existing-proj');
    const sign = await request(server, 'POST', '/api/global-agent-keys', {
      access: { canCreateProjects: true, projects: 'all' },
    });
    expect(sign.body.access).toEqual({ canCreateProjects: true, projects: 'all' });
    const key = sign.body.plaintext as string;

    // 可操作现有项目（签项目 key 成功）
    const ok = await request(
      server, 'POST', '/api/projects/existing-proj/agent-keys', {}, { 'X-AI-Access-Key': key },
    );
    expect(ok.status).toBe(201);

    // 建项目：'all' 本就能操作所有项目，不再返回 issuedProjectKey
    const create = await request(server, 'POST', '/api/projects', { name: 'Admin Made' }, { 'X-AI-Access-Key': key });
    expect(create.status).toBe(201);
    expect(create.body.issuedProjectKey).toBeUndefined();
  });

  it('canCreateProjects:false 的 key 无权建项目（但可操作授权的现有项目）', async () => {
    seedProject('proj-a');
    const sign = await request(server, 'POST', '/api/global-agent-keys', {
      access: { canCreateProjects: false, projects: ['proj-a'] },
    });
    expect(sign.body.access).toEqual({ canCreateProjects: false, projects: ['proj-a'] });
    const key = sign.body.plaintext as string;

    const create = await request(server, 'POST', '/api/projects', { name: 'Nope' }, { 'X-AI-Access-Key': key });
    expect(create.status).toBe(403);
    expect(create.body.error).toBe('global_key_cannot_create');

    // 授权范围内的项目可操作
    const ok = await request(server, 'POST', '/api/projects/proj-a/agent-keys', {}, { 'X-AI-Access-Key': key });
    expect(ok.status).toBe(201);
  });

  it('access 里的幽灵项目 id 被过滤掉，空授权直接 400', async () => {
    // projects 只填不存在的 id → 过滤后为空 + 不能建 → 400 empty_access
    const res = await request(server, 'POST', '/api/global-agent-keys', {
      access: { canCreateProjects: false, projects: ['ghost-does-not-exist'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('empty_access');
  });

  it('存量 key（state 里无 access 字段）解析为全权 admin —— 零回归', async () => {
    seedProject('legacy-proj');
    // 直接写一条没有 access 的历史 key（模拟旧数据）
    const plaintext = 'cdsg_legacyplaintextsample';
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
    stateService.addGlobalAgentKey({
      id: 'legacy01', label: 'old', hash, scope: 'rw', createdAt: new Date().toISOString(),
    });
    // 解析 = 全权
    const match = stateService.findGlobalAgentKeyForAuth(plaintext);
    expect(match?.access).toEqual({ canCreateProjects: true, projects: 'all' });
    // 能建项目 + 能操作现有项目
    const create = await request(server, 'POST', '/api/projects', { name: 'Legacy Admin' }, { 'X-AI-Access-Key': plaintext });
    expect(create.status).toBe(201);
    const ok = await request(server, 'POST', '/api/projects/legacy-proj/agent-keys', {}, { 'X-AI-Access-Key': plaintext });
    expect(ok.status).toBe(201);
  });

  it('create-only cdsg_ key 无权签发/吊销全局 key（Codex P1：防自我提权）', async () => {
    const sign = await request(server, 'POST', '/api/global-agent-keys', {});
    const createOnlyKey = sign.body.plaintext as string;

    // 用 create-only key 想给自己签一把 projects:'all' 的全权 key → 必须 403
    const mint = await request(
      server, 'POST', '/api/global-agent-keys',
      { access: { canCreateProjects: true, projects: 'all' } },
      { 'X-AI-Access-Key': createOnlyKey },
    );
    expect(mint.status).toBe(403);
    expect(mint.body.error).toBe('agent_key_cannot_mint_global');

    // 也不能吊销别的全局 key
    const preSign = await request(server, 'POST', '/api/global-agent-keys', {});
    const revoke = await request(
      server, 'DELETE', `/api/global-agent-keys/${preSign.body.keyId}`,
      undefined, { 'X-AI-Access-Key': createOnlyKey },
    );
    expect(revoke.status).toBe(403);
    expect(revoke.body.error).toBe('agent_key_cannot_mint_global');
  });

  it('路由级门卫：create-only key 被挡在此前未显式校验的项目变更路由外（Codex P1）', async () => {
    seedProject('guarded-proj');
    const createOnly = (await request(server, 'POST', '/api/global-agent-keys', {})).body.plaintext as string;
    const adminAll = (await request(server, 'POST', '/api/global-agent-keys', {
      access: { canCreateProjects: true, projects: 'all' },
    })).body.plaintext as string;

    // PUT /projects/:id/preview-mode 从不调 assertProjectAccess,但路由级门卫覆盖它。
    const blocked = await request(
      server, 'PUT', '/api/projects/guarded-proj/preview-mode',
      { mode: 'port' }, { 'X-AI-Access-Key': createOnly },
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('project_out_of_scope');

    // 全权 'all' key 照常放行
    const ok = await request(
      server, 'PUT', '/api/projects/guarded-proj/preview-mode',
      { mode: 'port' }, { 'X-AI-Access-Key': adminAll },
    );
    expect(ok.status).toBe(200);
  });

  it('单项目 cdsg_ key 透明继承 cdsp_ 防护:能操作自身项目、挡其它项目、可建项目（Codex P1）', async () => {
    seedProject('own-proj');
    seedProject('other-proj');
    // 单项目 + 允许建项目
    const sign = await request(server, 'POST', '/api/global-agent-keys', {
      access: { canCreateProjects: true, projects: ['own-proj'] },
    });
    expect(sign.status).toBe(201);
    expect(sign.body.access).toEqual({ canCreateProjects: true, projects: ['own-proj'] });
    const key = sign.body.plaintext as string;

    // 能操作自身项目(preview-mode 此前只认 cdsProjectKey,现在单项目 cdsg_ 也被 stamp)
    const own = await request(server, 'PUT', '/api/projects/own-proj/preview-mode', { mode: 'port' }, { 'X-AI-Access-Key': key });
    expect(own.status).toBe(200);
    // 挡其它项目
    const other = await request(server, 'PUT', '/api/projects/other-proj/preview-mode', { mode: 'port' }, { 'X-AI-Access-Key': key });
    expect(other.status).toBe(403);
    expect(other.body.error).toBe('project_mismatch');
    // 仍可建项目(POST /projects 先看 cdsAccess.canCreateProjects,不被别名 cdsProjectKey 挡)
    const create = await request(server, 'POST', '/api/projects', { name: 'From Single Scoped' }, { 'X-AI-Access-Key': key });
    expect(create.status).toBe(201);
  });

  it('多项目(≥2)作用域签发被拒绝（Codex P1：暂不支持,防跨 router 越界）', async () => {
    seedProject('p1');
    seedProject('p2');
    const res = await request(server, 'POST', '/api/global-agent-keys', {
      access: { canCreateProjects: false, projects: ['p1', 'p2'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('multi_project_scope_unsupported');
  });

  it('无项目语境的克隆探针端点拒绝带作用域的 key（Codex P1：detect-runtime）', async () => {
    const createOnly = (await request(server, 'POST', '/api/global-agent-keys', {})).body.plaintext as string;
    // create-only cdsg_ key 借服务器凭据克隆任意仓库 → 必须 403,连 clone 都不许开始
    const res = await request(
      server, 'POST', '/api/detect-runtime',
      { gitRepoUrl: 'https://github.com/some/private-repo' },
      { 'X-AI-Access-Key': createOnly },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('scoped_key_forbidden');
  });
});

/**
 * 作用域门卫纯函数单测（Codex P1）—— 直接断言 assertUnscopedAdmin / assertScopedSweep
 * 的判定逻辑,不经 HTTP。这两个门卫护约「无项目语境的管理员操作」与「跨项目清扫」。
 */
describe('作用域门卫纯函数', () => {
  const allAccess = { keyId: 'g1', access: { canCreateProjects: true, projects: 'all' as const } };
  const createOnly = { keyId: 'g2', access: { canCreateProjects: true, projects: [] as string[] } };
  const scopedA = { keyId: 'g3', access: { canCreateProjects: false, projects: ['a'] } };

  it('assertUnscopedAdmin：仅放行 cookie/bootstrap 与全权 all', () => {
    expect(assertUnscopedAdmin({})).toBeNull(); // 无 stamp(人类/bootstrap)
    expect(assertUnscopedAdmin({ cdsAccess: allAccess })).toBeNull(); // 全权
    expect(assertUnscopedAdmin({ cdsProjectKey: { projectId: 'a' } })?.body.error).toBe('project_key_forbidden');
    expect(assertUnscopedAdmin({ cdsAccess: createOnly })?.body.error).toBe('scoped_key_forbidden');
    expect(assertUnscopedAdmin({ cdsAccess: scopedA })?.body.error).toBe('scoped_key_forbidden');
  });

  it('assertScopedSweep：全权/人类可清全部，作用域 key 必须锁定授权项目', () => {
    // 人类 / 全权 → 保留 filter(可 undefined = 清全部)
    expect(assertScopedSweep({}, undefined)).toEqual({ projectFilter: undefined });
    expect(assertScopedSweep({ cdsAccess: allAccess }, undefined)).toEqual({ projectFilter: undefined });
    // 单项目 cdsp_ 无 filter → 锁到自身
    expect(assertScopedSweep({ cdsProjectKey: { projectId: 'a', keyId: 'k' } }, undefined))
      .toEqual({ projectFilter: 'a' });
    // cdsp_ 带了别的项目 → mismatch
    expect(assertScopedSweep({ cdsProjectKey: { projectId: 'a', keyId: 'k' } }, 'b').mismatch?.body.error)
      .toBe('project_mismatch');
    // create-only cdsg_ 无 filter → 禁止清全部
    expect(assertScopedSweep({ cdsAccess: createOnly }, undefined).mismatch?.body.error)
      .toBe('scoped_key_requires_project_filter');
    // 指定项目 cdsg_:范围内放行,范围外 403
    expect(assertScopedSweep({ cdsAccess: scopedA }, 'a')).toEqual({ projectFilter: 'a' });
    expect(assertScopedSweep({ cdsAccess: scopedA }, 'b').mismatch?.body.error).toBe('project_out_of_scope');
  });
});
