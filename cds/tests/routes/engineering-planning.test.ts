import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineeringPlanningRouter } from '../../src/routes/engineering-planning.js';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';
import type { PlanningDebtBrief } from '../../src/shared/engineering-planning.js';

type Permission = 'read' | 'propose' | 'write' | 'approve';
type RequestOptions = {
  project?: string;
  actor?: 'anonymous' | 'owner' | 'agent' | 'agent-with-approve' | 'reader';
};
type BriefSection = PlanningDebtBrief['sections'][number];

const projectA = 'test-planning-a';
const projectB = 'test-planning-b';
const source = { type: 'review', ref: 'synthetic-review-comment-09' };
const approvePermissions: Permission[] = ['read', 'propose', 'write', 'approve'];
const reviewAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

describe('engineering planning HTTP contracts', () => {
  let directory: string;
  let server: Server | undefined;
  let endpoint: string;
  let now: Date;

  async function start() {
    const app = express();
    app.use(express.json());
    const store = new FileEngineeringPlanningStore(directory);
    app.use('/api', createEngineeringPlanningRouter({
      service: new EngineeringPlanningService(store, () => now),
      resolveAccess(req, projectId) {
        if (projectId !== projectA && projectId !== projectB) return null;
        const actor = req.get('x-fixture-actor');
        if (actor === 'owner') return { kind: 'human', id: 'test-owner', label: 'Fixture owner', permissions: approvePermissions };
        if (projectId !== projectA) return null;
        if (actor === 'reader') return { kind: 'human', id: 'test-reader', label: 'Fixture reader', permissions: ['read'] };
        if (actor === 'agent-with-approve') return { kind: 'agent', id: 'test-agent-legacy', label: 'Fixture legacy key', permissions: approvePermissions };
        if (actor === 'agent') return { kind: 'agent', id: 'test-agent', label: 'Fixture agent', permissions: ['read', 'propose'] };
        return null;
      },
    }));
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected an HTTP listen address');
    endpoint = `http://127.0.0.1:${address.port}`;
  }

  async function stop() {
    const running = server;
    server = undefined;
    if (!running) return;
    await new Promise<void>((resolve, reject) => running.close(error => error ? reject(error) : resolve()));
  }

  async function call(resource: string, command?: object, options: RequestOptions = {}) {
    const { actor = 'owner', project = projectA } = options;
    const headers: Record<string, string> = { 'x-fixture-actor': actor };
    if (command) headers['content-type'] = 'application/json';
    const response = await fetch(`${endpoint}/api/projects/${project}/planning${resource}`, {
      method: command ? 'POST' : 'GET',
      headers,
      body: command && JSON.stringify(command),
    });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }

  function createCommand(requestId: string, sourceRef = source.ref) {
    return {
      type: 'debt.create',
      requestId,
      title: 'Remove redundant export request',
      summary: 'The fixture export currently requests the same record twice.',
      source: { ...source, ref: sourceRef },
      whyDebt: 'The existing release accepts this with a temporary cache.',
      criteria: ['Exactly one request for a fixture export'],
    };
  }

  function submitCommand(requestId: string, sourceRef = source.ref) {
    const { title, summary, whyDebt, criteria } = createCommand(requestId);
    return {
      type: 'proposal.submit',
      requestId,
      kind: 'debt',
      source: { ...source, ref: sourceRef },
      draft: { title, summary, whyDebt, criteria },
    };
  }

  async function createDebt(options?: RequestOptions) {
    const created = await call('/commands', createCommand('test-create-0001'), options);
    expect([200, 201]).toContain(created.status);
    return created.body.result;
  }

  async function write(command: object) {
    const response = await call('/commands', command);
    expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
    return response.body.result;
  }

  beforeEach(async () => {
    now = new Date();
    directory = await mkdtemp(path.join(tmpdir(), 'cds-engineering-planning-test-'));
    await start();
  });

  afterEach(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('validates the command and rejects client-controlled project, actor, and lifecycle fields without writing', async () => {
    const command = createCommand('test-validation-0001');
    const invalidCommands = [
      { ...command, title: '    ' },
      { ...command, title: 'x'.repeat(121) },
      { ...command, status: 'repaid' },
      { ...command, actor: { kind: 'human', id: 'test-owner' } },
      { ...command, projectId: projectB },
      { ...command, source: { type: 'unrecognized', ref: 'xyz' } },
      { ...command, source: { ...source, url: 'file:///fixture.txt' } },
      { ...submitCommand('test-validation-0002'), draft: { title: 'Draft with admin input', status: 'accepted' } },
    ];
    for (const invalid of invalidCommands) {
      expect((await call('/commands', invalid)).status).toBe(400);
    }
    const board = await call('');
    expect(board.body).toMatchObject({ projectId: projectA, proposals: [] });
    expect((await call('/debts')).body.items).toEqual([]);
  });

  it('never exposes private project data in direct project or resource reads', async () => {
    const hidden = await createDebt({ project: projectB });
    for (const resource of ['', '/debts', '/stats', `/debts/${hidden.id}`]) {
      const response = await call(resource, undefined, { project: projectB, actor: 'agent' });
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty('brief');
      expect(JSON.stringify(response.body)).not.toContain(hidden.title);
    }
    expect((await call(`/debts/${hidden.id}`, undefined, { actor: 'agent' })).status).toBe(404);
    expect((await call('', undefined, { actor: 'anonymous' })).status).toBe(404);
    expect((await call('/debts', undefined, { actor: 'reader' })).body.items).toEqual([]);
  });

  it('separates proposal-only agents and human approval; pending proposals leave the debt count unchanged', async () => {
    const initial = await call('/stats');
    expect(initial.status).toBe(200);
    expect((await call('/commands', createCommand('test-forbidden-0001'), { actor: 'agent' })).status).toBe(403);
    expect((await call('/commands', submitCommand('test-forbidden-0002'), { actor: 'reader' })).status).toBe(403);
    const submitted = await call('/commands', submitCommand('test-submission-0001'), { actor: 'agent' });
    expect([200, 201]).toContain(submitted.status);
    const proposalId = submitted.body.result.id;
    const approve = { type: 'proposal.accept', requestId: 'test-approval-0001', proposalId };
    expect((await call('/commands', approve, { actor: 'agent' })).status).toBe(403);
    expect((await call('/commands', approve, { actor: 'agent-with-approve' })).status).toBe(403);
    expect((await call('/stats')).body).toEqual(initial.body);
    expect((await call('/debts')).body.items).toEqual([]);
    const boardBeforeApproval = await call('');
    expect(boardBeforeApproval.body.proposals).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposalId, status: 'pending' })]));

    const accepted = await call('/commands', approve);
    expect([200, 201]).toContain(accepted.status);
    expect(accepted.body.result).toMatchObject({ id: proposalId, status: 'accepted', result: expect.any(Object) });
    const replay = await call('/commands', approve);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ reused: true, result: accepted.body.result });
    expect((await call('/debts')).body.items).toMatchObject([{
      projectId: projectA, title: submitted.body.result.draft.title, status: 'open',
    }]);
    expect((await call('/stats')).body).not.toEqual(initial.body);
  });

  it('rejects a proposal without creating a formal debt and records the decision', async () => {
    const submitted = await call('/commands', submitCommand('test-reject-proposal-0001'), { actor: 'agent' });
    const proposal = submitted.body.result;
    const rejected = await call('/commands', {
      type: 'proposal.reject', requestId: 'test-reject-proposal-0002', proposalId: proposal.id, reason: 'The fixture task is already covered',
    });
    expect([200, 201]).toContain(rejected.status);
    expect(rejected.body.result).toMatchObject({ id: proposal.id, status: 'rejected' });
    expect(JSON.stringify(rejected.body.result)).toContain('The fixture task is already covered');
    expect((await call('/debts')).body.items).toEqual([]);
  });

  it('only lets a debt reference a decision in its own project', async () => {
    const submitted = await call('/commands', {
      type: 'proposal.submit', requestId: 'test-decision-0001', kind: 'decision',
      source: { type: 'adr', ref: 'synthetic-decision-0001' },
      draft: { title: 'Adopt the fixture export protocol' },
    }, { project: projectB });
    expect([200, 201]).toContain(submitted.status);
    const accepted = await call('/commands', {
      type: 'proposal.accept', requestId: 'test-decision-0002', proposalId: submitted.body.result.id,
    }, { project: projectB });
    expect([200, 201]).toContain(accepted.status);
    const board = await call('', undefined, { project: projectB });
    expect(board.body.decisions).toMatchObject([{ title: 'Adopt the fixture export protocol' }]);
    const [{ id: decisionId }] = board.body.decisions;

    const attempted = await call('/commands', { ...createCommand('test-decision-0003'), decisionId });
    expect([400, 404]).toContain(attempted.status);
    expect(JSON.stringify(attempted.body)).not.toContain('Adopt the fixture export protocol');
    expect((await call('/debts')).body.items).toEqual([]);

    const linked = await call('/commands', { ...createCommand('test-decision-0004'), decisionId }, { project: projectB });
    expect([200, 201]).toContain(linked.status);
    expect(linked.body.result).toMatchObject({ projectId: projectB, decisionId });
  });

  it('records the authenticated agent identity on a directly authorized debt write', async () => {
    const debt = await createDebt({ actor: 'agent-with-approve' });
    const detail = await call(`/debts/${debt.id}`);
    expect(detail.body.events).toHaveLength(1);
    expect(detail.body.events[0].actor).toMatchObject({ kind: 'agent', id: 'test-agent-legacy' });
  });

  it('deduplicates concurrent retries and source keys within the originating project', async () => {
    const command = createCommand('test-idempotency-0001');
    const results = await Promise.all([
      call('/commands', command),
      call('/commands', command),
    ]);
    results.forEach(response => expect([200, 201]).toContain(response.status));
    const record = results[0].body.result;
    expect(results[1].body.result.id).toBe(record.id);
    expect(results.map(response => response.body.reused).sort()).toEqual([false, true]);

    const conflicting = await call('/commands', { ...command, title: 'Different request using the same idempotency key' });
    expect(conflicting.status).toBe(409);
    const duplicate = await call('/commands', { ...command, requestId: 'test-idempotency-0002' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ reused: true, result: { id: record.id } });
    expect((await call('/debts')).body.items).toMatchObject([{ id: record.id }]);
    expect((await call(`/debts/${record.id}`)).body.events).toHaveLength(1);
    const otherProject = await call('/commands', command, { project: projectB });
    expect([200, 201]).toContain(otherProject.status);
    expect(otherProject.body).toMatchObject({ reused: false, result: { projectId: projectB } });
  });

  it('publishes only one new event when concurrent writers use the same record version', async () => {
    const debt = await createDebt();
    const results = await Promise.all([
      call('/commands', {
        type: 'debt.defer', requestId: 'test-version-0001', debtId: debt.id, expectedVersion: debt.version,
        reason: 'Wait for the fixture window', reviewAt,
      }),
      call('/commands', {
        type: 'debt.progress', requestId: 'test-version-0002', debtId: debt.id, expectedVersion: debt.version,
        note: 'Started fixture measurements',
      }),
    ]);
    expect(results.filter(response => [200, 201].includes(response.status))).toHaveLength(1);
    expect(results.filter(response => response.status === 409)).toHaveLength(1);
    const detail = await call(`/debts/${debt.id}`);
    expect(detail.body.debt.version).toBe(debt.version + 1);
    expect(detail.body.events).toHaveLength(2);
  });

  it('reads a grounded handoff from the current debt and its own history', async () => {
    now = new Date('2026-03-02T01:00:00Z');
    const origin = await write({
      type: 'decision.create', requestId: 'test-handoff-origin-0001',
      title: '保留合成导出兼容路径', source: { type: 'adr', ref: 'fixture-handoff-origin' },
    });
    const debt = await write({
      ...createCommand('test-handoff-debt-0001'), decisionId: origin.id,
      impact: '合成导出的重复请求延迟交付',
      rootCause: { state: 'suspected', text: '可能是合成缓存失效' },
    });
    const path = `/debts/${debt.id}`;
    const initial = await call(path, undefined, { actor: 'reader' });
    expect(initial.status).toBe(200);
    expect(initial.body.brief).toMatchObject({
      readiness: { score: expect.any(Number), max: 7, items: expect.any(Array) },
      next: expect.any(Array), gaps: expect.any(Array), markdown: expect.any(String),
    });
    expect(initial.body.brief.readiness.items).toHaveLength(7);
    expect(initial.body.brief.readiness.score).toBeLessThan(7);
    expect(initial.body.brief.gaps.length).toBeGreaterThan(0);
    expect(initial.body.brief.next.length).toBeGreaterThan(0);
    const initialSections: BriefSection[] = initial.body.brief.sections;
    expect(initialSections.map(section => section.id)).toEqual(['problem', 'attempts', 'why', 'direction']);
    expect(initialSections.flatMap(section => section.lines)).toContainEqual(expect.objectContaining({
      kind: 'inference', text: expect.stringContaining('可能是合成缓存失效'),
    }));
    expect(initialSections.flatMap(section => section.lines).some(line => line.kind === 'gap')).toBe(true);

    const deferred = await write({
      type: 'debt.defer', requestId: 'test-handoff-debt-0002', debtId: debt.id, expectedVersion: debt.version,
      reason: '待合成回归环境开放', reviewAt: '2026-03-04',
    });
    const inProgress = await write({
      type: 'debt.progress', requestId: 'test-handoff-debt-0003', debtId: debt.id, expectedVersion: deferred.version,
      note: '合成回归已定位两次调用',
    });
    await write({
      type: 'debt.update', requestId: 'test-handoff-debt-0004', debtId: debt.id, expectedVersion: inProgress.version,
      patch: { rootCause: { state: 'confirmed', text: '合成重试入口重复调用', basis: '合成请求记录可回读' } },
    });
    const current = await call(path, undefined, { actor: 'reader' });
    expect(current.status).toBe(200);
    expect(current.body.brief.readiness.score).toBe(initial.body.brief.readiness.score + 1);
    const sections: BriefSection[] = current.body.brief.sections;
    const lines = sections.flatMap(section => section.lines);
    const attempts = sections.find(section => section.id === 'attempts')?.lines;
    const events: { id: string; type: string; projectId: string; entityId: string }[] = current.body.events;
    expect(events.every(event => event.projectId === projectA && event.entityId === debt.id)).toBe(true);
    const allowedReferences = {
      record: new Set([debt.id]), event: new Set(events.map(event => event.id)),
      decision: new Set([origin.id]), plan: new Set<string>(),
    };
    for (const line of lines) {
      if (line.kind === 'fact') expect(line.cites.length).toBeGreaterThan(0);
      for (const cite of line.cites) {
        expect(allowedReferences[cite.kind].has(cite.id)).toBe(true);
        expect(cite.label.trim()).not.toBe('');
      }
    }
    expect(lines.find(line => line.text.includes('合成重试入口重复调用'))).toMatchObject({
      kind: 'fact', cites: expect.arrayContaining([expect.objectContaining({ kind: 'record', id: debt.id })]),
    });
    expect(lines.some(line => line.text.includes('可能是合成缓存失效'))).toBe(false);
    for (const [type, note] of [['deferred', '待合成回归环境开放'], ['progress', '合成回归已定位两次调用']] as const) {
      expect(attempts?.find(line => line.text.includes(note))).toMatchObject({
        kind: 'fact', cites: expect.arrayContaining([expect.objectContaining({
          kind: 'event', id: events.find(event => event.type === type)?.id,
        })]),
      });
    }
    expect(current.body.brief.markdown).toContain('合成回归已定位两次调用');
    expect(current.body.brief.markdown).toContain('合成重试入口重复调用');
  });

  it('requires evidence to repay a debt and preserves that evidence after a reopen', async () => {
    const debt = await createDebt();
    const deferred = await call('/commands', {
      type: 'debt.defer', requestId: 'test-lifecycle-0001', debtId: debt.id, expectedVersion: debt.version,
      reason: 'Fixture window pending', reviewAt,
    });
    expect([200, 201]).toContain(deferred.status);
    expect(deferred.body.result.status).toBe('deferred');
    const progressed = await call('/commands', {
      type: 'debt.progress', requestId: 'test-lifecycle-0002', debtId: debt.id, expectedVersion: deferred.body.result.version,
      note: 'Measured one export request in the fixture.',
    });
    expect([200, 201]).toContain(progressed.status);
    expect(progressed.body.result.status).toBe('in_progress');
    const repay = {
      type: 'debt.repay', requestId: 'test-lifecycle-0003', debtId: debt.id, expectedVersion: progressed.body.result.version,
      summary: 'Removed the redundant request',
      results: [{ criterionId: debt.criteria[0].id, verdict: 'met', note: 'Exactly one request' }],
    };
    expect((await call('/commands', { ...repay, evidence: [] })).status).toBe(400);
    const evidence = { type: 'test', label: 'Synthetic export run 21 verified one request' };
    const repaid = await call('/commands', { ...repay, evidence: [evidence] });
    expect([200, 201]).toContain(repaid.status);
    expect(repaid.body.result.status).toBe('repaid');
    const paidDetail = await call(`/debts/${debt.id}`);
    expect(paidDetail.body.brief).toMatchObject({ markdown: expect.stringContaining(repay.summary) });
    const reopened = await call('/commands', {
      type: 'debt.reopen', requestId: 'test-lifecycle-0004', debtId: debt.id, expectedVersion: repaid.body.result.version,
      reason: 'Fixture run 22 reproduced the duplicate request',
    });
    expect([200, 201]).toContain(reopened.status);
    expect(reopened.body.result.status).toBe('open');
    const detail = await call(`/debts/${debt.id}`);
    expect(detail.body.events).toHaveLength(5);
    expect(JSON.stringify(detail.body.events)).toContain(evidence.label);
    expect(detail.body.debt).not.toHaveProperty('repayment');
    const attempts: BriefSection | undefined = detail.body.brief.sections.find((section: BriefSection) => section.id === 'attempts');
    expect(attempts?.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'fact', text: expect.stringContaining(repay.summary) }),
      expect.objectContaining({ kind: 'fact', text: expect.stringContaining('Fixture run 22 reproduced the duplicate request') }),
    ]));
  });

  it('keeps explicit planning direction and approach states on the debt and in the handoff', async () => {
    const direction = {
      target: '合成导出仅请求一次',
      approaches: [
        { title: '合并合成重试入口', status: 'candidate' },
        { title: '延长合成缓存', status: 'tried', note: '合成回归仍复现' },
        { title: '移除合成重试', status: 'rejected', note: '合成兼容要求不允许' },
      ],
    };
    const debt = await write({ ...createCommand('test-handoff-direction-0001'), direction });
    const path = `/debts/${debt.id}`;
    expect((await call(path)).body.debt.direction).toEqual(direction);
    const revised = { ...direction, target: '合成导出复用同一请求' };
    await write({
      type: 'debt.update', requestId: 'test-handoff-direction-0002', debtId: debt.id, expectedVersion: debt.version,
      patch: { direction: revised },
    });
    const current = await call(path, undefined, { actor: 'reader' });
    expect(current.status).toBe(200);
    expect(current.body.debt.direction).toEqual(revised);
    expect(current.body.brief.markdown).toContain(revised.target);
    expect(current.body.brief.markdown).not.toContain(direction.target);
    expect(current.body.brief.markdown).toContain('合并合成重试入口');
    expect(current.body.brief.markdown).toContain('合成回归仍复现');
    expect(current.body.brief.markdown).toContain('合成兼容要求不允许');
  });

  it('clears debt ownership and repayment target only when explicitly requested', async () => {
    now = new Date('2026-03-02T01:00:00Z');
    const dueAt = '2026-03-20';
    const debt = await write({
      ...createCommand('test-handoff-clear-0001'), owner: '合成负责人', dueAt,
    });
    const retained = await write({
      type: 'debt.update', requestId: 'test-handoff-clear-0002', debtId: debt.id, expectedVersion: debt.version,
      patch: { summary: '合成更新没有传负责人和预计日期' },
    });
    expect(retained).toMatchObject({ owner: '合成负责人', dueAt });

    await write({
      type: 'debt.update', requestId: 'test-handoff-clear-0003', debtId: debt.id, expectedVersion: retained.version,
      patch: { owner: null, dueAt: null },
    });
    const current = await call(`/debts/${debt.id}`, undefined, { actor: 'reader' });
    expect(current.status).toBe(200);
    expect(current.body.debt).not.toHaveProperty('owner');
    expect(current.body.debt).not.toHaveProperty('dueAt');
    expect(current.body.events[0]).toMatchObject({ type: 'updated', dates: { dueAt: [dueAt, null] } });
  });

  it('recovers committed records, audit history, and request receipts after restart', async () => {
    const command = createCommand('test-durable-0001');
    const committed = await call('/commands', command);
    expect([200, 201]).toContain(committed.status);
    const { id } = committed.body.result;
    const expected = await call(`/debts/${id}`);
    expect(expected.status).toBe(200);
    await stop();
    await start();

    expect(await call(`/debts/${id}`)).toEqual(expected);
    const replayed = await call('/commands', command);
    expect(replayed.body).toMatchObject({ reused: true, result: { id } });
    expect((await call(`/debts/${id}`)).body.events).toHaveLength(1);
  });

  it('keeps historical branch balances after transfer and nets transfer activity across branches', async () => {
    now = new Date('2026-03-01T15:30:00Z');
    const proposedOrigin = await write({
      type: 'decision.create', requestId: 'test-origin-decision-0001',
      title: 'Original fixture protocol', source: { type: 'adr', ref: 'fixture-adr-origin' },
    });
    const origin = await write({
      type: 'decision.change', requestId: 'test-origin-decision-0002',
      decisionId: proposedOrigin.id, expectedVersion: proposedOrigin.version, change: 'accepted', reason: 'Fixture origin was approved',
    });
    const proposedSuccessor = await write({
      type: 'decision.create', requestId: 'test-successor-decision-0001',
      title: 'Successor fixture protocol', source: { type: 'adr', ref: 'fixture-adr-successor' },
    });
    const successor = await write({
      type: 'decision.change', requestId: 'test-successor-decision-0002',
      decisionId: proposedSuccessor.id, expectedVersion: proposedSuccessor.version, change: 'accepted', reason: 'Fixture successor was approved',
    });
    const debt = await write({ ...createCommand('test-transfer-debt-0001'), decisionId: origin.id });

    now = new Date('2026-03-01T16:20:00Z');
    await write({
      type: 'decision.change', requestId: 'test-transfer-debt-0002',
      decisionId: origin.id, expectedVersion: origin.version, change: 'superseded', successorId: successor.id,
      reason: 'The successor takes over the unresolved debt',
    });
    const current = await call(`/debts/${debt.id}`);
    expect(current.body.debt).toMatchObject({ originDecisionId: origin.id, decisionId: successor.id });
    expect(current.body.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'branch_moved', fromDecisionId: origin.id, toDecisionId: successor.id,
    })]));

    const historical = await call(`/stats?from=2026-03-01&to=2026-03-01&branch=${origin.id}`);
    expect(historical.status).toBe(200);
    expect(historical.body).toMatchObject({ projectId: projectA, created: 1, transferredOut: 0, backlogEnd: 1 });
    const originMovement = await call(`/stats?from=2026-03-02&to=2026-03-02&branch=${origin.id}`);
    expect(originMovement.body).toMatchObject({
      backlogStart: 1, backlogEnd: 0, transferredIn: 0, transferredOut: 1,
      buckets: [{ day: '2026-03-02', backlog: 0, transferredOut: 1 }],
    });
    const successorMovement = await call(`/stats?from=2026-03-02&to=2026-03-02&branch=${successor.id}`);
    expect(successorMovement.body).toMatchObject({
      backlogStart: 0, backlogEnd: 1, transferredIn: 1, transferredOut: 0,
      buckets: [{ day: '2026-03-02', backlog: 1, transferredIn: 1 }],
    });
    const wholeProject = await call('/stats?from=2026-03-02&to=2026-03-02');
    expect(wholeProject.body).toMatchObject({ backlogStart: 1, backlogEnd: 1, transferredIn: 0, transferredOut: 0, repaid: 0 });

    const otherProject = await call('/stats?from=2026-03-02&to=2026-03-02', undefined, { project: projectB });
    expect(otherProject.body).toMatchObject({ projectId: projectB, backlogEnd: 0, transferredIn: 0, transferredOut: 0 });
  });

  it('cancels an extinct debt step and only completes a debt step with verified repayment', async () => {
    now = new Date('2026-03-02T01:00:00Z');
    const expiredDebt = await write(createCommand('test-planned-extinct-0001', 'synthetic-expired-source'));
    const resolvedDebt = await write(createCommand('test-planned-repay-0001', 'synthetic-repaid-source'));
    const plan = await write({
      type: 'plan.create', requestId: 'test-plan-0001',
      title: 'Retire the two fixture flows', source: { type: 'manual', ref: 'synthetic-plan-source' },
    });
    const firstStep = await write({
      type: 'plan.add-step', requestId: 'test-plan-0002', planId: plan.id, expectedVersion: plan.version,
      kind: 'debt', relatedId: expiredDebt.id, title: 'Check the retired flow',
    });
    const bothSteps = await write({
      type: 'plan.add-step', requestId: 'test-plan-0003', planId: plan.id, expectedVersion: firstStep.version,
      kind: 'debt', relatedId: resolvedDebt.id, title: 'Verify the surviving flow',
    });
    const attemptManualCompletion = await call('/commands', {
      type: 'plan.step', requestId: 'test-plan-0004', planId: plan.id, expectedVersion: bothSteps.version,
      stepId: bothSteps.steps[0].id, status: 'done', note: 'Unverified completion attempt',
    });
    expect(attemptManualCompletion.status).toBe(409);

    await write({
      type: 'debt.drop', requestId: 'test-planned-extinct-0002', debtId: expiredDebt.id, expectedVersion: expiredDebt.version,
      kind: 'extinct', reason: 'The original fixture flow no longer exists',
      evidence: [{ type: 'change', label: 'Synthetic change removed the fixture flow' }],
    });
    await write({
      type: 'debt.repay', requestId: 'test-planned-repay-0002', debtId: resolvedDebt.id, expectedVersion: resolvedDebt.version,
      summary: 'Verified the fixture flow without redundant requests',
      results: [{ criterionId: resolvedDebt.criteria[0].id, verdict: 'met', note: 'Checked one request' }],
      evidence: [{ type: 'test', label: 'Synthetic export run confirmed one request' }],
    });
    const board = await call('');
    expect(board.body.plans).toMatchObject([{
      id: plan.id, steps: [{ relatedId: expiredDebt.id, status: 'cancelled' }, { relatedId: resolvedDebt.id, status: 'done' }],
    }]);
    const stats = await call('/stats?from=2026-03-02&to=2026-03-02');
    expect(stats.body).toMatchObject({ created: 2, extinct: 1, repaid: 1, backlogEnd: 0 });
  });

  it('keeps import sources stable across batches and tracks imported debt separately from new debt', async () => {
    now = new Date('2026-03-02T01:00:00Z');
    const items = [
      { title: 'Historic export debt', source: { type: 'import', ref: 'fixture-ledger:001' }, discoveredAt: '2026-02-11' },
      { title: 'Unspecified discovery date', source: { type: 'import', ref: 'fixture-ledger:002' } },
    ];
    const command = { type: 'debt.import', requestId: 'test-import-0001', items };
    const imported = await call('/commands', command);
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({
      projectId: projectA, reused: false,
      result: { items: items.map(item => ({ id: expect.any(String), status: 'created', sourceRef: item.source.ref })) },
    });
    const [{ id: historicalId }, { id: unknownId }] = imported.body.result.items;
    const historical = await call(`/debts/${historicalId}`);
    expect(historical.body.debt).toMatchObject({ discoveredAt: '2026-02-11', source: items[0].source });
    expect((await call(`/debts/${unknownId}`)).body.debt.discoveredAt).toBeUndefined();
    const edited = await write({
      type: 'debt.update', requestId: 'test-import-0002', debtId: historicalId, expectedVersion: historical.body.debt.version,
      patch: { title: 'Reviewed historic export debt' },
    });
    const repeated = await call('/commands', { ...command, requestId: 'test-import-0003' });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({
      reused: true,
      result: { items: [{ id: historicalId, status: 'existing' }, { id: unknownId, status: 'existing' }] },
    });
    const details = (await call(`/debts/${historicalId}`)).body;
    expect(details.debt).toEqual(edited);
    expect(details.events.map((event: { type: string }) => event.type)).toEqual(['updated', 'imported']);
    expect((await call('/debts')).body.items).toHaveLength(2);
    const originalDate = await call('/stats?from=2026-02-11&to=2026-02-11');
    expect(originalDate.body).toMatchObject({ backlogStart: 0, backlogEnd: 0, created: 0, imported: 0 });
    const importDate = await call('/stats?from=2026-03-02&to=2026-03-02');
    expect(importDate.body).toMatchObject({
      backlogStart: 0, backlogEnd: 2, created: 0, imported: 2,
      buckets: [{ day: '2026-03-02', backlog: 2, created: 0, imported: 2 }],
    });
  });

  it('rejects a batch with an invalid row before persisting any debt or receipt', async () => {
    now = new Date('2026-03-02T01:00:00Z');
    const valid = { title: 'Valid historic debt', source: { type: 'import', ref: 'fixture-atomic:001' } };
    const second = { title: 'Future discovery date', source: { type: 'import', ref: 'fixture-atomic:002' } };
    const command = { type: 'debt.import', requestId: 'test-import-atomic-0001' };
    const rejected = await call('/commands', { ...command, items: [valid, { ...second, discoveredAt: '2026-03-03' }] });
    expect(rejected.status).toBe(400);
    expect((await call('/debts')).body.items).toEqual([]);
    expect((await call('/stats?from=2026-03-02&to=2026-03-02')).body).toMatchObject({
      created: 0, imported: 0, backlogEnd: 0,
    });

    const corrected = await call('/commands', { ...command, items: [valid, { ...second, discoveredAt: '2026-03-02' }] });
    expect(corrected.status).toBe(201);
    expect(corrected.body.result.items.map((item: { status: string }) => item.status)).toEqual(['created', 'created']);
    expect((await call('/debts')).body.items).toHaveLength(2);
  });

  it('continues listing the original project snapshot after a newer debt is created', async () => {
    now = new Date('2026-03-02T01:00:00Z');
    const older = await write({ ...createCommand('test-cursor-0001', 'fixture-cursor:001'), title: 'Older fixture debt' });
    now = new Date('2026-03-02T02:00:00Z');
    const current = await write({ ...createCommand('test-cursor-0002', 'fixture-cursor:002'), title: 'Current fixture debt' });
    const query = '/debts?limit=1&q=fixture';
    const first = await call(query);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ projectId: projectA, items: [{ id: current.id }], nextCursor: expect.any(String) });
    const cursor = encodeURIComponent(first.body.nextCursor);

    now = new Date('2026-03-02T03:00:00Z');
    const newer = await write({ ...createCommand('test-cursor-0003', 'fixture-cursor:003'), title: 'New fixture debt' });
    const continuation = await call(`${query}&cursor=${cursor}`);
    expect(continuation.status).toBe(200);
    expect(continuation.body).toMatchObject({ items: [{ id: older.id }], nextCursor: null });
    expect((await call(query)).body.items).toMatchObject([{ id: newer.id }]);
  });
});
