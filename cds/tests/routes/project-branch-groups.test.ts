/**
 * 分支自定义分组接口测试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectsRouter } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
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
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed: any = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}


/**
 * 分支自定义分组的读写契约（2026-09-29）。
 *
 * 断言「写得进、读得回、脏值进不来、两个人同时改不会互相静默覆盖」。
 * 最后一条靠 baseUpdatedAt 乐观并发：别人先保存了，后保存的人拿到 409 与最新版本。
 */
describe('项目分支自定义分组', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  /** 模拟登录中间件挂上的 req.cdsUser（CdsUser 的真实字段名） */
  let currentUser: { githubLogin?: string; username?: string } | null = null;

  beforeEach(() => {
    currentUser = null;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-branch-groups-test-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-a',
      slug: 'proj-a',
      name: 'Project A',
      kind: 'git',
      dockerNetwork: 'cds-proj-a',
      legacyFlag: false,
      createdAt: now,
      updatedAt: now,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (currentUser) (req as unknown as { cdsUser?: unknown }).cdsUser = currentUser;
      next();
    });
    app.use('/api', createProjectsRouter({ stateService, shell: new MockShellExecutor() }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const claudeGroup = {
    id: 'g-claude',
    name: '  Claude 在做  ',
    color: 'orange',
    rules: [{ kind: 'prefix', value: ' claude/ ' }, { kind: 'tag', value: '' }],
    pinnedBranchIds: ['b-1'],
  };

  it('真人保存记下登录名：GitHub 登录取 githubLogin，本地账号取 username', async () => {
    currentUser = { githubLogin: 'alice-gh', username: 'alice' };
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(first.status).toBe(200);
    expect(first.body.updatedBy).toBe('alice-gh');
    currentUser = { username: 'bob' };
    const second = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt });
    expect(second.status).toBe(200);
    expect(second.body.updatedBy).toBe('bob');
  });

  it('没配过时返回空列表与 null 版本，不编默认分组', async () => {
    const res = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.updatedAt).toBeNull();
  });

  it('保存后读得回：名字与规则值去空白、空规则丢掉、带上版本与修改人', async () => {
    const put = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(put.status).toBe(200);
    expect(put.body.groups[0]).toEqual({
      id: 'g-claude',
      name: 'Claude 在做',
      color: 'orange',
      rules: [{ kind: 'prefix', value: 'claude/' }],
      pinnedBranchIds: ['b-1'],
    });
    expect(typeof put.body.updatedAt).toBe('string');
    expect(put.body.updatedBy).toBe('user');

    const get = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(get.body.groups).toEqual(put.body.groups);
    expect(get.body.updatedAt).toBe(put.body.updatedAt);
  });

  it('同一分支被钉进多个组时只留第一个（一个分支只归一组）', async () => {
    const put = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', {
      groups: [
        { id: 'a', name: 'A', color: 'blue', rules: [], pinnedBranchIds: ['b-1', 'b-2'] },
        { id: 'b', name: 'B', color: 'green', rules: [], pinnedBranchIds: ['b-2', 'b-3'] },
      ],
      baseUpdatedAt: null,
    });
    expect(put.status).toBe(200);
    expect(put.body.groups[0].pinnedBranchIds).toEqual(['b-1', 'b-2']);
    expect(put.body.groups[1].pinnedBranchIds).toEqual(['b-3']);
  });

  it('颜色不在五色里、规则类型未知、分组名为空、id 重复都 400 并指出位置', async () => {
    const cases: Array<[unknown, string]> = [
      [[{ ...claudeGroup, color: '#ff0000' }], 'groups[0].color'],
      [[{ ...claudeGroup, rules: [{ kind: 'regex', value: '.*' }] }], 'groups[0].rules[0].kind'],
      [[{ ...claudeGroup, name: '   ' }], 'groups[0].name'],
      [[claudeGroup, { ...claudeGroup, name: 'X' }], 'groups[1].id'],
      ['not-an-array', 'groups'],
      [[{ ...claudeGroup, id: '__ungrouped__' }], 'groups[0].id'],
    ];
    for (const [groups, field] of cases) {
      const res = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups, baseUpdatedAt: null });
      expect(res.status, JSON.stringify(groups)).toBe(400);
      expect(res.body.field).toBe(field);
    }
    const get = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(get.body.groups).toEqual([]);
  });

  it('别人先保存了：拿旧版本保存得到 409 与最新版本，不静默覆盖', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(first.status).toBe(200);
    const stale = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', {
      groups: [{ id: 'mine', name: '我的', color: 'gray', rules: [], pinnedBranchIds: [] }],
      baseUpdatedAt: null,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.latest.groups[0].id).toBe('g-claude');
    const fresh = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', {
      groups: [{ id: 'mine', name: '我的', color: 'gray', rules: [], pinnedBranchIds: [] }],
      baseUpdatedAt: first.body.updatedAt,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.groups.map((g: { id: string }) => g.id)).toEqual(['mine']);
  });

  it('不带版本号一律 400，不许跳过并发检查去整份覆盖（Codex P2）', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(first.status).toBe(200);
    for (const body of [{ groups: [] }, { groups: [], baseUpdatedAt: 42 }]) {
      const res = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.field).toBe('baseUpdatedAt');
    }
    const get = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(get.body.groups.map((g: { id: string }) => g.id)).toEqual(['g-claude']);
  });

  it('父实例镜像来的项目只读：GET 标明 readOnly，PUT 409 且不落盘（Codex P2）', async () => {
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'proj-m', slug: 'proj-m', name: 'Mirrored', kind: 'git', dockerNetwork: 'cds-proj-m',
      legacyFlag: false, createdAt: now, updatedAt: now,
      mirror: { capturedAt: now, source: 'parent-cds' },
    } as any);
    const get = await request(server, 'GET', '/api/projects/proj-m/branch-groups');
    expect(get.body.readOnly).toBe(true);
    const put = await request(server, 'PUT', '/api/projects/proj-m/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(put.status).toBe(409);
    expect(put.body.error).toBe('mirror_read_only');
    expect((await request(server, 'GET', '/api/projects/proj-m/branch-groups')).body.groups).toEqual([]);
    expect((await request(server, 'GET', '/api/projects/proj-a/branch-groups')).body.readOnly).toBe(false);
  });

  it('同一毫秒内连续两次写入，版本号也不同，持旧版本的写入仍然 409（Codex P2）', async () => {
    const frozen = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(frozen);
    try {
      const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
      const second = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt });
      expect(second.status).toBe(200);
      expect(second.body.updatedAt).not.toBe(first.body.updatedAt);
      const stale = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: first.body.updatedAt });
      expect(stale.status).toBe(409);
    } finally {
      spy.mockRestore();
    }
  });

  it('项目不存在时 404', async () => {
    expect((await request(server, 'GET', '/api/projects/nope/branch-groups')).status).toBe(404);
    expect((await request(server, 'PUT', '/api/projects/nope/branch-groups', { groups: [] })).status).toBe(404);
  });
});
