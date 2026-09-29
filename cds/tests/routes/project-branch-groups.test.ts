/**
 * 分支自定义分组接口测试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectsRouter, isBranchGroupsSaveRequest } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { BRANCH_GROUP_LIMITS } from '../../src/services/branch-groups.js';

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
  /** 模拟服务端中间件按 Agent Key（含 ai-access-key / Bearer 写法）盖上的 req.cdsProjectKey */
  let currentProjectKey: { projectId: string; keyId: string } | null = null;
  /** 模拟全局 Agent Key（cdsg_）鉴权通过后盖上的 req.cdsAccess */
  let currentAccess: { keyId: string; access: unknown } | null = null;

  beforeEach(() => {
    currentUser = null;
    currentProjectKey = null;
    currentAccess = null;
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
      if (currentProjectKey) (req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey = currentProjectKey;
      if (currentAccess) (req as unknown as { cdsAccess?: unknown }).cdsAccess = currentAccess;
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

  it('带项目级 Agent Key 的保存记成 Agent，哪怕请求头不是 x-ai-access-key（Bearer / ai-access-key 写法）', async () => {
    currentProjectKey = { projectId: 'proj-a', keyId: 'key-1' };
    const res = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(res.status).toBe(200);
    expect(res.body.updatedBy).toBe('ai');
  });

  it('带全局 Agent Key（cdsg_）的保存同样记成 Agent', async () => {
    currentAccess = { keyId: 'g-key-1', access: { projects: 'all' } };
    const res = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(res.status).toBe(200);
    expect(res.body.updatedBy).toBe('ai');
  });

  it('写入存储失败：返回 500，内存里的分组与版本号恢复成保存前，之后照常能存', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(first.status).toBe(200);
    const saveSpy = vi.spyOn(stateService, 'save').mockImplementationOnce(() => { throw new Error('disk full'); });
    const failed = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('persist_failed');
    saveSpy.mockRestore();
    const after = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(after.body.groups.map((g: { id: string }) => g.id)).toEqual(['g-claude']);
    expect(after.body.updatedAt).toBe(first.body.updatedAt);
    // 版本号没被那次失败推进：拿失败前的版本号照常能存
    const retry = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt });
    expect(retry.status).toBe(200);
  });

  it('落盘（flush）失败：返回 500、恢复保存前的版本，响应里不带存储层原始报错', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flushSpy = vi.spyOn(stateService, 'flush').mockImplementationOnce(async () => { throw new Error('ENOSPC /var/lib/cds/state.json'); });
    const failed = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt });
    flushSpy.mockRestore();
    errSpy.mockRestore();
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('persist_failed');
    expect(failed.body.restored).toBe(true);
    expect(JSON.stringify(failed.body)).not.toContain('ENOSPC');
    expect(JSON.stringify(failed.body)).not.toContain('/var/lib');
    const after = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(after.body.groups.map((g: { id: string }) => g.id)).toEqual(['g-claude']);
    expect(after.body.updatedAt).toBe(first.body.updatedAt);
  });

  it('同一项目的写入排队：前一个落盘失败回滚后，并发的后一个照常存进去，不被回滚冲掉', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flushSpy = vi.spyOn(stateService, 'flush').mockImplementationOnce(
      () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('slow failure')), 80)),
    );
    const otherGroup = { ...claudeGroup, id: 'g-other', name: '另一组' };
    const [a, b] = await Promise.all([
      request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt }),
      request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup, otherGroup], baseUpdatedAt: first.body.updatedAt }),
    ]);
    flushSpy.mockRestore();
    errSpy.mockRestore();
    expect(a.status).toBe(500);
    expect(b.status).toBe(200);
    const after = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(after.body.groups.map((g: { id: string }) => g.id)).toEqual(['g-claude', 'g-other']);
  });

  it('落盘等待期间别的接口推进了项目时间戳：回滚只撤分组，不把那次更新的时间倒拨回去', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const concurrentAt = new Date(Date.now() + 60_000).toISOString();
    const flushSpy = vi.spyOn(stateService, 'flush').mockImplementationOnce(async () => {
      // 模拟同一时刻另一个接口改了项目（改名 / 改配置）并盖上自己的时间戳
      const live = stateService.getProject('proj-a');
      if (live) live.updatedAt = concurrentAt;
      throw new Error('slow failure');
    });
    const failed = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt });
    flushSpy.mockRestore();
    errSpy.mockRestore();
    expect(failed.status).toBe(500);
    expect(stateService.getProject('proj-a')?.updatedAt).toBe(concurrentAt);
    const after = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(after.body.groups.map((g: { id: string }) => g.id)).toEqual(['g-claude']);
  });

  it('恢复写入也没落盘时，不对用户说「已恢复」', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flushSpy = vi.spyOn(stateService, 'flush').mockImplementation(async () => { throw new Error('disk gone'); });
    const failed = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt });
    flushSpy.mockRestore();
    errSpy.mockRestore();
    expect(failed.status).toBe(500);
    expect(failed.body.restored).toBe(false);
    expect(failed.body.message).not.toContain('已恢复为保存前的版本');
  });

  it('用 id 与不同大小写的 slug 访问同一项目时进同一条写入队列', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flushSpy = vi.spyOn(stateService, 'flush').mockImplementationOnce(
      () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('slow failure')), 80)),
    );
    const otherGroup = { ...claudeGroup, id: 'g-other', name: '另一组' };
    const [a, b] = await Promise.all([
      request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: first.body.updatedAt }),
      request(server, 'PUT', '/api/projects/PROJ-A/branch-groups', { groups: [claudeGroup, otherGroup], baseUpdatedAt: first.body.updatedAt }),
    ]);
    flushSpy.mockRestore();
    errSpy.mockRestore();
    expect(a.status).toBe(500);
    expect(b.status).toBe(200);
    const after = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(after.body.groups.map((g: { id: string }) => g.id)).toEqual(['g-claude', 'g-other']);
  });

  it('排队期间客户端已断开的写入不再执行，不占着队列', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    let flushCalls = 0;
    const realFlush = stateService.flush.bind(stateService);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // 前面那个慢请求最后落盘失败、回滚到原版本：排在后面的请求版本号又对得上，只能靠「已放弃就跳过」拦住
    const flushSpy = vi.spyOn(stateService, 'flush').mockImplementation(async () => {
      flushCalls += 1;
      if (flushCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new Error('slow failure');
      }
      await realFlush();
    });
    // 慢请求要真改内容：与已存内容相同的提交不落盘（直接回当前版本），就走不到落盘这一步了
    const slow = request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup, { ...claudeGroup, id: 'g-slow', name: '慢请求' }], baseUpdatedAt: first.body.updatedAt });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 第二个请求排在慢的那个后面，客户端随即放弃
    await new Promise<void>((resolve) => {
      const { port } = server.address() as { port: number };
      const payload = JSON.stringify({ groups: [], baseUpdatedAt: first.body.updatedAt });
      const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/projects/proj-a/branch-groups', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } });
      req.on('error', () => resolve());
      req.write(payload);
      req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 30);
    });
    const slowRes = await slow;
    await new Promise((resolve) => setTimeout(resolve, 50));
    flushSpy.mockRestore();
    errSpy.mockRestore();
    expect(slowRes.status).toBe(500);
    // 放弃的那次没有执行：只有慢请求的落盘与它回滚后的恢复落盘两次，分组仍是最初那份（没被放弃的请求清空）
    expect(flushCalls).toBe(2);
    const after = await request(server, 'GET', '/api/projects/proj-a/branch-groups');
    expect(after.body.groups.map((g: { id: string }) => g.id)).toEqual(['g-claude']);
  });

  it('大体量的合法分组（数百 KB）能存进去：路由自带解析器，不受全局 100kb 上限限制', async () => {
    // 与生产同形：全局解析器对这条路径放行，由路由自带的解析器接手
    const bare = express();
    bare.use('/api', createProjectsRouter({ stateService, shell: new MockShellExecutor() }));
    const bareServer = bare.listen(0);
    try {
      const pins = Array.from({ length: 200 }, (_, i) => `branch-${'x'.repeat(40)}-${i}`);
      const groups = Array.from({ length: 12 }, (_, g) => ({
        id: `g-big-${g}`,
        name: `大组 ${g}`,
        color: 'blue',
        rules: Array.from({ length: 20 }, (_, r) => ({ kind: 'contains', value: `${'y'.repeat(80)}-${g}-${r}` })),
        pinnedBranchIds: pins.map((id) => `${id}-${g}`),
      }));
      const body = { groups, baseUpdatedAt: null };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(150 * 1024);
      const res = await request(bareServer, 'PUT', '/api/projects/proj-a/branch-groups', body);
      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(12);
    } finally {
      await new Promise<void>((resolve) => bareServer.close(() => resolve()));
    }
  });

  it('校验能接受的最大请求也在解析上限之内：钉入 id 限长限字符，超长或带转义字符的 id 回 400 而不是 413（Codex P2）', async () => {
    const bare = express();
    bare.use('/api', createProjectsRouter({ stateService, shell: new MockShellExecutor() }));
    const bareServer = bare.listen(0);
    try {
      // 最坏情形：30 组 × 200 个最长钉入 id，每组 20 条每个字符都要转义成 \\u0001 的最长规则值
      const worstRule = '\u0001'.repeat(BRANCH_GROUP_LIMITS.ruleValueLength);
      const groups = Array.from({ length: BRANCH_GROUP_LIMITS.groups }, (_, g) => ({
        id: `g-worst-${g}`,
        name: '组'.repeat(BRANCH_GROUP_LIMITS.nameLength),
        color: 'blue',
        rules: Array.from({ length: BRANCH_GROUP_LIMITS.rulesPerGroup }, () => ({ kind: 'contains', value: worstRule })),
        pinnedBranchIds: Array.from({ length: BRANCH_GROUP_LIMITS.pinsPerGroup }, (_, i) => `${g}-${i}-`.padEnd(BRANCH_GROUP_LIMITS.pinIdLength, 'x')),
      }));
      const body = { groups, baseUpdatedAt: null };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(2 * 1024 * 1024);
      const ok = await request(bareServer, 'PUT', '/api/projects/proj-a/branch-groups', body);
      expect(ok.status).toBe(200);
      // 超长 id / 带需要转义字符的 id：校验拒绝（400），不靠解析上限兜底
      const tooLong = await request(bareServer, 'PUT', '/api/projects/proj-a/branch-groups', {
        groups: [{ ...claudeGroup, pinnedBranchIds: ['x'.repeat(BRANCH_GROUP_LIMITS.pinIdLength + 1)] }],
        baseUpdatedAt: ok.body.updatedAt,
      });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.field).toBe('groups[0].pinnedBranchIds');
      const escaped = await request(bareServer, 'PUT', '/api/projects/proj-a/branch-groups', {
        groups: [{ ...claudeGroup, pinnedBranchIds: ['a"b'] }],
        baseUpdatedAt: ok.body.updatedAt,
      });
      expect(escaped.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => bareServer.close(() => resolve()));
    }
  });

  it('CDS 能建出的最长分支 id（项目 slug 50 + 「-」+ 分支名 slug 255）可以钉入（Codex P2）', async () => {
    const longestBranchId = `${'p'.repeat(50)}-${'b'.repeat(255)}`;
    const res = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', {
      groups: [{ ...claudeGroup, pinnedBranchIds: [longestBranchId] }],
      baseUpdatedAt: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.groups[0].pinnedBranchIds).toEqual([longestBranchId]);
  });

  it('项目列表不带分组数据（分组只走专门的接口）', async () => {
    await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    const list = await request(server, 'GET', '/api/projects');
    expect(list.status).toBe(200);
    const projects = (list.body.projects || list.body) as Array<{ id: string; branchGroups?: unknown }>;
    const mine = projects.find((p) => p.id === 'proj-a');
    expect(mine).toBeTruthy();
    expect(mine?.branchGroups).toBeUndefined();
  });

  it('全局 JSON 解析器对分组保存放行，由路由自带的大上限解析器接手', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '../../src/server.ts'), 'utf-8');
    expect(serverSource).toContain('if (isBranchGroupsSaveRequest(req.method, req.path)) return next();');
  });

  it('放行判据与 Express 路由同一套匹配：大小写不敏感、接受末尾斜杠，其他路径与方法不放行（Codex P2）', () => {
    expect(isBranchGroupsSaveRequest('PUT', '/api/projects/proj-a/branch-groups')).toBe(true);
    expect(isBranchGroupsSaveRequest('PUT', '/api/projects/proj-a/branch-groups/')).toBe(true);
    expect(isBranchGroupsSaveRequest('PUT', '/api/projects/proj-a/Branch-Groups')).toBe(true);
    expect(isBranchGroupsSaveRequest('GET', '/api/projects/proj-a/branch-groups')).toBe(false);
    expect(isBranchGroupsSaveRequest('PUT', '/api/projects/proj-a/branch-groups/x')).toBe(false);
    expect(isBranchGroupsSaveRequest('PUT', '/api/projects/proj-a/env')).toBe(false);
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

  it('提交与已存内容相同：不推进版本号、不改修改人；成功响应丢了后带旧版本号原样重试也不判冲突', async () => {
    const first = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    expect(first.status).toBe(200);
    const flushSpy = vi.spyOn(stateService, 'flush');
    // 同内容、带当前版本号：空保存
    const same = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [{ ...claudeGroup, name: ` ${claudeGroup.name} ` }], baseUpdatedAt: first.body.updatedAt });
    // 同内容、带过期版本号（上一次的成功响应丢了，原样重试）
    const retried = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [claudeGroup], baseUpdatedAt: null });
    const flushes = flushSpy.mock.calls.length;
    flushSpy.mockRestore();
    expect(same.status).toBe(200);
    expect(same.body.updatedAt).toBe(first.body.updatedAt);
    expect(same.body.updatedBy).toBe(first.body.updatedBy);
    expect(retried.status).toBe(200);
    expect(retried.body.updatedAt).toBe(first.body.updatedAt);
    expect(flushes).toBe(0);
    // 内容不同的过期写入照旧 409
    const stale = await request(server, 'PUT', '/api/projects/proj-a/branch-groups', { groups: [], baseUpdatedAt: null });
    expect(stale.status).toBe(409);
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
