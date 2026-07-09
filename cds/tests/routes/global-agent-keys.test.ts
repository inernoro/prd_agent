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
        if (gmatch) (req as any).cdsAccess = { keyId: gmatch.keyId, access: gmatch.access };
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
        if (gmatch) (req as any).cdsAccess = { keyId: gmatch.keyId, access: gmatch.access };
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
});
