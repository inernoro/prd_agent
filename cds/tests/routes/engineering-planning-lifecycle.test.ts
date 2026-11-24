import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineeringPlanningRouter } from '../../src/routes/engineering-planning.js';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';

const project = 'planning-lifecycle-fixture';
const otherProject = 'planning-lifecycle-other';
const anchor = { type: 'route', ref: '/fixture/export' };
const change = { type: 'change', label: '移除旧版导出路由', url: 'https://example.com/fixtures/pull/12' };
const DAY = 86_400_000;

describe('engineering planning debt verification and recorded removals', () => {
  const servers: Server[] = [];
  let directory: string;
  let origin: string;
  let now: Date;

  async function serve() {
    const app = express();
    app.use('/api', createEngineeringPlanningRouter({
      service: new EngineeringPlanningService(new FileEngineeringPlanningStore(directory), () => now),
      resolveAccess(req, id) {
        if (id !== project && id !== otherProject) return null;
        const caller = req.get('x-fixture-caller');
        if (caller === 'writer') return { kind: 'human', id: 'owner', label: '项目负责人', permissions: ['read', 'write'] };
        if (id !== project) return null;
        if (caller === 'agent') return { kind: 'agent', id: 'agent', label: '录入助手', permissions: ['read', 'write'] };
        if (caller === 'reader') return { kind: 'human', id: 'reader', label: '只读成员', permissions: ['read'] };
        return null;
      },
    }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback address');
    return `http://127.0.0.1:${address.port}`;
  }

  async function request(resource: string, data?: object, options: { caller?: string; project?: string; origin?: string } = {}) {
    const response = await fetch(`${options.origin ?? origin}/api/projects/${options.project ?? project}/planning${resource}`, {
      method: data ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-fixture-caller': options.caller ?? 'writer' },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, body: await response.json() };
  }

  async function write(data: object) {
    const response = await request('/commands', data);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.result;
  }

  async function create(name: string, decisionId?: string) {
    return write({ type: 'debt.create', requestId: `create-${name}`, title: `合成债务 ${name}`,
      source: { type: 'manual', ref: `lifecycle-fixture-${name}` }, ...(decisionId ? { decisionId } : {}) });
  }

  async function bind(row: { id: string; version: number }, target = anchor) {
    return write({ type: 'debt.anchor', requestId: `bind-${row.id}`, debtId: row.id, expectedVersion: row.version,
      anchor: target, reason: '绑定债务发生的功能位置' });
  }

  async function report(row: { id: string; version: number }) {
    return write({ type: 'debt.anchor-missing', requestId: `record-${row.id}`, debtId: row.id, expectedVersion: row.version,
      note: '变更记录确认旧版路由已移除', evidence: [change] });
  }

  function moveBy(start: Date, days: number, offset = 0) {
    now = new Date(start.getTime() + days * DAY + offset);
  }

  beforeEach(async () => {
    now = new Date('2026-11-20T23:00:00.000Z');
    directory = await mkdtemp(path.join(tmpdir(), 'cds-planning-lifecycle-'));
    origin = await serve();
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server =>
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    await rm(directory, { recursive: true, force: true });
  });

  it('records the chosen verification method and evidence with the server time and expires verification without changing status', async () => {
    const before = now;
    const debt = await create('verified-record');
    const input = { type: 'debt.verify', requestId: 'write-verification', debtId: debt.id, expectedVersion: debt.version,
      method: 'test', note: '合成导出用例仍失败', validDays: 14, evidence: [{ type: 'test', label: '验证失败的用例' }] };
    expect((await request('/commands', { ...input, method: 'guess' })).status).toBe(400);
    expect((await request('/commands', { ...input, validDays: 7 })).status).toBe(400);
    expect((await request('/commands', { ...input, at: '2026-10-01T00:00:00Z' })).status).toBe(400);
    expect((await request('/commands', input, { caller: 'reader' })).status).toBe(403);
    expect((await request('/commands', input, { caller: 'agent' })).status).toBe(403);

    const output = await write(input);
    const expiresAt = new Date(before.getTime() + 14 * DAY).toISOString();
    expect(output).toMatchObject({ status: 'open', verify: { method: 'test', at: before.toISOString(),
      by: { id: 'owner' }, note: input.note, validDays: 14, expiresAt, evidence: input.evidence } });
    expect((await request('/commands', input)).body.reused).toBe(true);
    expect((await request(`/debts/${debt.id}`)).body.events.filter((event: { type: string }) => event.type === 'verified')).toMatchObject([
      { type: 'verified', verification: { method: 'test', expiresAt }, evidence: input.evidence },
    ]);
    moveBy(before, 14, -1);
    expect((await request('/stats?analytics=evolution')).body.snapshot.pendingVerification).toBe(0);
    moveBy(before, 14);
    expect((await request('/stats?analytics=projection')).body.snapshot.pendingVerification).toBe(1);
    expect((await request(`/debts/${debt.id}`)).body.debt.status).toBe('open');
  });

  it('requires a bound feature and linked change evidence before starting the seven-day window', async () => {
    const before = now;
    const original = await create('waiting');
    const noProof = { type: 'debt.anchor-missing', requestId: 'without-deletion-evidence', debtId: original.id,
      expectedVersion: original.version, note: '删除证据检查', evidence: [change] };
    expect((await request('/commands', noProof)).status).toBe(409);
    const bound = await bind(original);
    expect(bound.anchor).toMatchObject({ ...anchor, status: 'alive' });
    const next = { ...noProof, expectedVersion: bound.version };
    expect((await request('/commands', { ...next, evidence: [{ type: 'change', label: '未提供链接' }] })).status).toBe(400);
    expect((await request('/commands', { ...next, source: { kind: 'github-file' } })).status).toBe(400);
    const pending = await report(bound);
    const present = await bind(await create('unchanged-feature'), { type: 'route', ref: '/fixture/still-in-use' });
    const cutoff = new Date(before.getTime() + 7 * DAY).toISOString();
    expect(pending).toMatchObject({ status: 'open', anchor: { ...anchor, status: 'missing', missingAt: before.toISOString(),
      closeAt: cutoff, evidence: [change], source: { kind: 'human' } } });
    expect((await request('/debts?view=pending_extinct')).body.items.map((row: { id: string }) => row.id)).toEqual([pending.id]);
    expect((await request('/stats?analytics=evolution')).body).toMatchObject({ backlogEnd: 2, extinct: 0 });

    for (const day of [1, 6]) {
      moveBy(before, day);
      const sweep = await write({ type: 'debt.sweep', requestId: `sweep-day-${day}` });
      expect(sweep).toMatchObject({ pending: [pending.id], closed: [] });
      expect((await request(`/debts/${pending.id}`)).body.health.daysUntilClosure).toBe(7 - day);
    }
    moveBy(before, 7, -1);
    expect(await write({ type: 'debt.sweep', requestId: 'sweep-before-boundary' })).toMatchObject({ closed: [] });
    moveBy(before, 7);
    expect(await write({ type: 'debt.sweep', requestId: 'sweep-at-boundary' })).toMatchObject({ pending: [], closed: [pending.id] });
    const ended = (await request(`/debts/${pending.id}`)).body;
    expect(ended.debt).toMatchObject({ status: 'dropped', anchor: { status: 'gone', closedAt: cutoff },
      outcome: { kind: 'extinct', closedAt: cutoff, evidence: [change] } });
    expect(ended.events[0]).toMatchObject({ type: 'extinct', at: cutoff, effectiveAt: cutoff, via: 'system',
      actor: { kind: 'system', label: 'CDS 巡检' }, evidence: [change] });
    expect((await request('/stats?analytics=graph')).body).toMatchObject({ extinct: 1, repaid: 0, backlogEnd: 1 });
    expect((await request(`/debts/${present.id}`)).body.debt).toMatchObject({ status: 'open', anchor: { status: 'alive' } });
  });

  it('withdraws a recorded removal with a reason and records human confirmation and reopening with no stale bindings', async () => {
    const before = now;
    const pending = await report(await bind(await create('renamed')));
    const keep = { type: 'debt.anchor', requestId: 'withdraw-removal', debtId: pending.id, expectedVersion: pending.version,
      anchor: { type: 'route', ref: '/fixture/export-v2' }, reason: '路由换了地址，问题仍可复现' };
    expect((await request('/commands', { ...keep, reason: ' ' })).status).toBe(400);
    const kept = await write(keep);
    expect(kept.anchor).toMatchObject({ status: 'alive', ref: '/fixture/export-v2' });
    expect(kept.anchor).not.toHaveProperty('missingAt');
    const unbinding = await report(await bind(await create('withdraw-binding')));
    const unbound = await write({ type: 'debt.anchor', requestId: 'unbind-recorded-feature',
      debtId: unbinding.id, expectedVersion: unbinding.version, anchor: null, reason: '问题仍在其他未绑定入口发生' });
    expect(unbound.status).toBe('open');
    expect(unbound).not.toHaveProperty('anchor');
    const confirmed = await report(await bind(await create('manual-confirmation')));
    const command = { type: 'debt.anchor-confirm', requestId: 'confirm-feature-removal', debtId: confirmed.id,
      expectedVersion: confirmed.version, note: '此功能的入口与消费者均已移除' };
    expect((await request('/commands', command, { caller: 'agent' })).status).toBe(403);
    const ended = await write(command);
    expect(ended).toMatchObject({ status: 'dropped', outcome: { kind: 'extinct', evidence: [change] } });
    const opened = await write({ type: 'debt.reopen', requestId: 'reopen-after-removal', debtId: ended.id,
      expectedVersion: ended.version, reason: '导出问题在独立模块中复发' });
    expect(opened).toMatchObject({ status: 'open', reopenCount: 1 });
    expect(opened).not.toHaveProperty('anchor');
    const reopen = (await request(`/debts/${opened.id}`)).body.events[0];
    expect(reopen).toMatchObject({ type: 'reopened', anchorChange: { before: anchor, after: null },
      actor: { id: 'owner' } });
    moveBy(before, 8);
    expect(await write({ type: 'debt.sweep', requestId: 'sweep-kept-debts' })).toMatchObject({ closed: [], pending: [] });
  });

  it('sweeps only the chosen scope and applies a concurrent or replayed closure once', async () => {
    const before = now;
    const decision = await write({ type: 'decision.create', requestId: 'create-fixture-decision', title: '迁移导出计划',
      source: { type: 'adr', ref: 'fixture-doc-for-scope' } });
    const scoped = await report(await bind(await create('scoped', decision.id)));
    const elsewhere = await report(await bind(await create('unassigned')));
    moveBy(before, 10);
    const secondOrigin = await serve();
    const command = { type: 'debt.sweep', requestId: 'sweep-parallel-first', branch: decision.id };
    expect((await request('/commands', command, { caller: 'agent' })).status).toBe(403);
    expect((await request('/commands', command, { caller: 'reader', project: otherProject })).status).toBe(404);
    const runs = await Promise.all([
      request('/commands', command),
      request('/commands', { ...command, requestId: 'sweep-parallel-second' }, { origin: secondOrigin }),
    ]);
    expect(runs.map(run => run.status)).toEqual([201, 201]);
    expect(runs.flatMap(run => run.body.result.closed)).toEqual([scoped.id]);
    const replay = await request('/commands', command, { origin: secondOrigin });
    expect(replay).toMatchObject({ status: 200, body: { reused: true, result: runs[0].body.result } });
    const scope = (await request(`/debts/${scoped.id}`, undefined, { origin: secondOrigin })).body;
    expect(scope.events.filter((event: { type: string }) => event.type === 'extinct')).toMatchObject([{
      at: now.toISOString(), effectiveAt: new Date(before.getTime() + 7 * DAY).toISOString(), via: 'system',
      triggeredBy: { id: 'owner' },
    }]);
    expect((await request(`/debts/${elsewhere.id}`)).body.debt.status).toBe('open');
    expect(await write({ type: 'debt.sweep', requestId: 'sweep-unassigned', branch: 'none' })).toMatchObject({ closed: [elsewhere.id] });
  });

  it('keeps historic branch balances when a debt moves after the deadline and before a delayed sweep', async () => {
    const before = now;
    const oldDecision = await write({ type: 'decision.create', requestId: 'make-origin-decision', title: '旧版导出',
      source: { type: 'adr', ref: 'export-original' } });
    const nextDecision = await write({ type: 'decision.create', requestId: 'make-successor-decision', title: '新版导出',
      source: { type: 'adr', ref: 'export-successor' } });
    const pending = await report(await bind(await create('moved-after-deadline', oldDecision.id)));
    moveBy(before, 8);
    await write({ type: 'debt.branch', requestId: 'move-before-sweep', debtId: pending.id, expectedVersion: pending.version,
      decisionId: nextDecision.id, reason: '将导出问题交给新实现的决策' });
    moveBy(before, 9);
    await write({ type: 'debt.sweep', requestId: 'close-in-current-branch', branch: nextDecision.id });
    const period = 'from=2026-11-27&to=2026-11-30';
    const prior = (await request(`/stats?${period}&branch=${oldDecision.id}`)).body;
    const current = (await request(`/stats?${period}&branch=${nextDecision.id}`)).body;
    expect(prior).toMatchObject({ backlogStart: 1, transferredOut: 1, extinct: 0, backlogEnd: 0 });
    expect(current).toMatchObject({ backlogStart: 0, transferredIn: 1, extinct: 1, backlogEnd: 0 });
    expect(current.buckets.map((row: { backlog: number }) => row.backlog)).toEqual([0, 0, 1, 0]);
  });
});
