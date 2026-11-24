import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineeringPlanningRouter } from '../../src/routes/engineering-planning.js';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';

const project = 'checkup-fixture';
const other = 'other-checkup-fixture';
const sameName = '同名项目成员';
const DAY = 86_400_000;

describe('engineering planning private checkup notices', () => {
  const servers: Server[] = [];
  let origin: string;
  let directory: string;
  let now: Date;
  let service: EngineeringPlanningService;

  function reopen() {
    return new EngineeringPlanningService(new FileEngineeringPlanningStore(directory), () => now);
  }

  async function start(planning: EngineeringPlanningService) {
    const app = express();
    app.use('/api', createEngineeringPlanningRouter({
      service: planning,
      resolveAccess(req, projectId) {
        const id = req.get('x-test-user');
        if (!id || (projectId !== project && (projectId !== other || id !== 'alice'))) return null;
        if (id === 'agent') return { kind: 'agent', id, label: sameName, permissions: ['read', 'write'] };
        return { kind: 'human', id, label: sameName, permissions: id === 'reader' ? ['read'] : ['read', 'write'] };
      },
    }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function request(resource: string, data?: object, user = 'alice', projectId = project, host = origin) {
    const response = await fetch(`${host}/api/projects/${projectId}/planning${resource}`, {
      method: data ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-test-user': user },
      body: data ? JSON.stringify(data) : undefined,
    });
    const raw = await response.text();
    return { status: response.status, body: raw.startsWith('{') ? JSON.parse(raw) : raw, cacheControl: response.headers.get('cache-control') };
  }

  async function write(data: object, user?: string, projectId?: string) {
    const result = await request('/commands', data, user, projectId);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result.body.result;
  }

  async function create(ref: string, title: string, assign = false, user?: string, projectId?: string) {
    return write({ type: 'debt.create', requestId: `create-${ref}`, title,
      source: { type: 'manual', ref }, ...(assign ? { assignToSelf: true } : { owner: sameName }) }, user, projectId);
  }

  async function removal(row: { id: string; version: number }, user?: string, projectId?: string) {
    const bound = await write({ type: 'debt.anchor', requestId: `bind-${row.id}`, debtId: row.id, expectedVersion: row.version,
      anchor: { type: 'route', ref: '/fixture/older-export' }, reason: '绑定旧版导出入口' }, user, projectId);
    return write({ type: 'debt.anchor-missing', requestId: `missing-${row.id}`, debtId: row.id, expectedVersion: bound.version,
      note: '合成的已合入变更移除了此入口', evidence: [{ type: 'change', label: '下线变更', url: 'https://example.com/fixture/pull/142' }] },
    user, projectId);
  }

  beforeEach(async () => {
    now = new Date('2026-11-21T00:00:00.000Z');
    directory = await mkdtemp(path.join(tmpdir(), 'cds-planning-checkup-'));
    service = reopen();
    origin = await start(service);
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server =>
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await rm(directory, { recursive: true, force: true });
  });

  it('only accepts human self-assignment and delivers pending removal to stable recipients with no name lookup', async () => {
    const command = { type: 'debt.create', requestId: 'owner-spoof', title: '测试账号归属',
      source: { type: 'manual', ref: 'owner-spoof' } };
    expect((await request('/commands', { ...command, ownerAccountId: 'alice' })).status).toBe(400);
    expect((await request('/commands', { ...command, assignToSelf: true }, 'agent')).status).toBe(403);
    const owned = await create('assigned', 'Web 导出调用旧路由', true);
    const freeText = await create('free-text', '报表筛选收口权限');
    expect(owned).toMatchObject({ owner: sameName, ownerAccountId: 'alice' });
    expect(freeText).not.toHaveProperty('ownerAccountId');
    await removal(owned, 'bob');
    await removal(freeText, 'bob');
    const response = await request('/checkup');
    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe('private, no-store');
    expect(response.body).toMatchObject({ projectId: project, unread: 1, notices: [{ kind: 'extinct_pending', debtIds: [owned.id] }],
      summary: { pending: 2, closed: 0, duplicates: 0 } });
    expect(response.body.notices[0]).not.toHaveProperty('recipientId');
    expect((await request('/checkup?recipientId=bob')).body.unread).toBe(1);
    expect((await request('/checkup', undefined, 'bob')).body.unread).toBe(2);
    expect((await request('/checkup', undefined, 'reader')).body.unread).toBe(0);
    expect((await request('/checkup', undefined, 'agent')).body.notices).toEqual([]);
  });

  it('marks only the current user’s notices as read, idempotently and across a fresh service', async () => {
    const aliceRow = await removal(await create('alice', '故障日志路由迁移', true));
    await removal(await create('bob', 'SDK 版本兼容问题', true, 'bob'), 'bob');
    const alice = (await request('/checkup')).body.notices[0];
    const bob = (await request('/checkup', undefined, 'bob')).body.notices[0];
    expect(alice.debtIds).toEqual([aliceRow.id]);
    expect((await request('/checkup/read', { id: bob.id })).status).toBe(404);
    expect((await request('/checkup/read', { id: bob.id, recipientId: 'bob' })).status).toBe(400);
    expect((await request('/checkup/read', { id: alice.id })).body).toMatchObject({ changed: 1, unread: 0 });
    expect((await request('/checkup/read', { id: alice.id })).body).toMatchObject({ changed: 0, unread: 0 });
    const second = await start(reopen());
    const after = (await request('/checkup', undefined, 'alice', project, second)).body;
    expect(after.notices[0]).toMatchObject({ id: alice.id, readAt: now.toISOString() });
    expect((await request('/checkup', undefined, 'bob', project, second)).body.unread).toBe(1);
    expect((await request('/checkup/read', { all: true }, 'bob', project, second)).body.unread).toBe(0);
    expect((await request('/checkup/read', { id: alice.id }, 'alice', other, second)).status).toBe(404);
  });

  it('publishes the closure notices once through the atomic background revision', async () => {
    const debt = await removal(await create('system-closed', '自动关闭已移除的支付路径', true));
    const foreign = await removal(await create('foreign', '另项目待关闭的导出路径', true, 'alice', other), 'alice', other);
    now = new Date(now.getTime() + 8 * DAY);
    await Promise.all([service.sweepRecordedRemovals(project, now), reopen().sweepRecordedRemovals(project, now)]);
    const data = (await request('/checkup')).body;
    expect(data).toMatchObject({ unread: 2, summary: { pending: 0, closed: 1, duplicates: 0 } });
    expect(data.notices.filter((row: { kind: string }) => row.kind === 'extinct')).toMatchObject([{ debtIds: [debt.id] }]);
    expect((await request('/checkup', undefined, 'bob')).body.notices).toEqual([]);
    expect((await request('/checkup', undefined, 'alice', other)).body.notices).toMatchObject([{ debtIds: [foreign.id], kind: 'extinct_pending' }]);
    expect((await request('/checkup', undefined, 'bob', other)).status).toBe(404);
  });

  it('leaves a project without debt history uninitialized during background scans', async () => {
    await service.sweepRecordedRemovals(project, now);
    await service.sweepDuplicatePairs(project);
    expect(await new FileEngineeringPlanningStore(directory).read(project, 0)).toEqual([]);
  });

  it('baselines existing duplicate pairs and publishes a new pair only once, honoring exclusions', async () => {
    const title = '归档导出结果重复请求';
    const original = await create('root', title, true);
    let previous = await create('prior', '移动端列表高度错位', true, 'bob');
    previous = await write({ type: 'debt.update', requestId: 'rename-existing-prior', debtId: previous.id, expectedVersion: previous.version, patch: { title } }, 'bob');
    await service.sweepDuplicatePairs(project);
    expect((await request('/checkup')).body.notices).toEqual([]);

    now = new Date(now.getTime() + DAY);
    const third = await create('new', '环境配置写入异常', true, 'bob');
    const newTitle = await write({ type: 'debt.update', requestId: 'rename-new-debt', debtId: third.id, expectedVersion: third.version, patch: { title } }, 'bob');
    await write({ type: 'debt.not-duplicate', requestId: 'disambiguate-prior', debtId: previous.id, expectedVersion: previous.version,
      fromId: newTitle.id, fromVersion: newTitle.version, reason: '一个是本机校验，一个是导出请求' }, 'bob');
    await Promise.all([service.sweepDuplicatePairs(project), reopen().sweepDuplicatePairs(project)]);
    const alice = (await request('/checkup')).body;
    expect(alice).toMatchObject({ unread: 1, summary: { duplicates: 1, pending: 0, closed: 0 } });
    expect(alice.notices[0]).toMatchObject({ kind: 'dup', debtIds: [original.id, third.id] });
    expect((await request('/checkup', undefined, 'bob')).body.notices).toHaveLength(1);
    const details = (await request(`/debts/${original.id}`)).body.events;
    expect(details.filter((event: { type: string }) => event.type === 'dup_flagged')).toMatchObject([
      { relatedDebtId: third.id, actor: { kind: 'system' }, via: 'system' },
    ]);
    expect((await request(`/debts/${previous.id}`)).body.events.some((event: { type: string }) => event.type === 'dup_flagged')).toBe(false);
  });

  it('only reports same-feature pairs at the lower similarity threshold after removing the feature name', async () => {
    const feature = '回归队列权限校验编排';
    const titles = ['队列重试时阻塞最近一笔导出请求', '队列重试时阻塞最近一笔导入任务'];
    const original = await create('same-feature-left', titles[0], true);
    const match = await create('same-feature-right', titles[1], true, 'bob');
    const misleading = await create('feature-name-first', `${feature} 权限验收被锁`, true);
    const unrelated = await create('feature-name-second', `${feature} 权限验收超时`, true, 'bob');
    expect((await request('/debts?view=dup')).body.items).toEqual([]);
    await service.sweepDuplicatePairs(project);

    now = new Date(now.getTime() + DAY);
    for (const [row, user] of [[original, 'alice'], [match, 'bob'], [misleading, 'alice'], [unrelated, 'bob']] as const) {
      await write({ type: 'debt.anchor', requestId: `feature-${row.id}`, debtId: row.id, expectedVersion: row.version,
        anchor: { type: 'feature', ref: feature }, reason: '共同绑定合成验收功能' }, user);
    }
    const duplicateList = (await request('/debts?view=dup')).body.items.map((row: { id: string }) => row.id);
    expect(duplicateList.sort()).toEqual([original.id, match.id].sort());
    expect((await request(`/debts/${original.id}`)).body.duplicateCandidates).toMatchObject([{ id: match.id }]);
    expect((await request(`/debts/${misleading.id}`)).body.duplicateCandidates).toEqual([]);

    await Promise.all([service.sweepDuplicatePairs(project), reopen().sweepDuplicatePairs(project)]);
    for (const [row, recipient, peer] of [[original, 'alice', match.id], [match, 'bob', original.id]] as const) {
      const notices = (await request('/checkup', undefined, recipient)).body.notices;
      expect(notices).toMatchObject([{ kind: 'dup', debtIds: [original.id, match.id] }]);
      expect((await request(`/debts/${row.id}`)).body.events.filter((event: { type: string }) => event.type === 'dup_flagged'))
        .toMatchObject([{ relatedDebtId: peer, via: 'system' }]);
    }
  });
});
