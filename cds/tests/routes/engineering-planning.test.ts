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
  let designVersion: { id: string; title: string; version: number; decisionIds: string[]; frozen?: number;
    signed?: { runId: string; pullRequest: number; commit: string } } | undefined;
  let service: EngineeringPlanningService;

  async function start() {
    const app = express();
    app.use(express.json());
    const store = new FileEngineeringPlanningStore(directory);
    service = new EngineeringPlanningService(store, () => now, { repositoryFor: () => 'fixture/planning' },
      async projectId => projectId === projectA && designVersion ? [designVersion] : []);
    app.use('/api', createEngineeringPlanningRouter({
      service,
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

  it('finds decisions by everyday language and applicable objects within the authorized project', async () => {
    const historical = {
      title: '隔离子实例的登录凭据',
      aliases: ['预览密码', '预览登录'],
      appliesTo: [{ kind: 'config', ref: 'CDS_PREVIEW_PASSWORD' }],
      provenance: { level: 'backfilled', url: 'https://example.test/adr/preview', occurredOn: '2026-01-18' },
    };
    const created = await write({
      type: 'decision.create', requestId: 'trace-search-original', source: { type: 'adr', ref: 'fixture-origin' }, ...historical,
    });
    expect((await call('/commands', {
      type: 'proposal.submit', requestId: 'trace-search-pending', kind: 'decision', source: { type: 'adr', ref: 'fixture-pending' },
      draft: { ...historical, title: '待确认的同类提案' },
    }, { actor: 'agent' })).status).toBe(201);
    expect((await call('/commands', {
      type: 'decision.create', requestId: 'trace-search-other', source: { type: 'adr', ref: 'fixture-other' },
      ...historical, title: '另一个项目的同类决定',
    }, { project: projectB })).status).toBe(201);
    now = new Date(now.getTime() + 1000);
    const mention = await write({ type: 'decision.create', requestId: 'trace-search-mention',
      source: { type: 'adr', ref: 'fixture-mention' }, title: '业务日志脱敏', summary: '备注里提到预览密码的相关背景' });

    const byAlias = await call(`/decisions?q=${encodeURIComponent('预览密码')}`, undefined, { actor: 'reader' });
    expect(byAlias.status).toBe(200);
    expect(byAlias.body.projectId).toBe(projectA);
    expect(byAlias.body.items.map((row: { id: string }) => row.id)).toEqual([created.id, mention.id]);
    expect(byAlias.body.items[0].provenance).toEqual(historical.provenance);
    const byObject = await call('/decisions?subjectKind=config&subjectRef=cds_preview_password');
    expect(byObject.body.items.map((row: { id: string }) => row.id)).toEqual([created.id]);
    expect((await call('/decisions', undefined, { actor: 'anonymous' })).status).toBe(404);
    expect((await call('/decisions?subjectKind=config')).status).toBe(400);
  });

  it('requires a basis for inferred decisions and keeps old decisions searchable', async () => {
    const base = { type: 'decision.create', source: { type: 'manual', ref: 'fixture-legacy' } };
    const invalid = await call('/commands', {
      ...base, requestId: 'trace-inference-invalid', title: '未注明推断依据',
      provenance: { level: 'inferred', url: 'https://example.test/changes/1' },
    });
    expect(invalid.status).toBe(400);
    const previous = await write({ ...base, requestId: 'trace-legacy-written', title: '配置项采用服务端默认值' });
    const found = await call(`/decisions?q=${encodeURIComponent('默认值')}`);
    expect(found.status).toBe(200);
    expect(found.body.items).toMatchObject([{ id: previous.id, title: previous.title }]);
    expect(found.body.items[0].provenance).toBeUndefined();
  });

  beforeEach(async () => {
    now = new Date();
    designVersion = undefined;
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

  it('applies an ADR revision to its existing decision only when a human approves', async () => {
    const existingLink = { type: 'issue', title: '导出需求', url: 'https://example.com/issues/1' };
    const revisedLink = { type: 'adr', title: '导出 ADR 修订', url: 'https://example.com/repo/adr/export.md' };
    const created = await call('/commands', {
      type: 'decision.create', requestId: 'revision-fixture-create', title: '把导出同步执行', owner: '导出组', links: [existingLink],
      source: { type: 'manual', ref: 'revision-fixture-original' },
    });
    expect(created.status).toBe(201);
    const decisionId = created.body.result.id;
    const decisionChange = { decisionId, expectedVersion: 1, change: 'amended' };
    const proposed = await call('/commands', {
      type: 'proposal.submit', requestId: 'revision-fixture-propose', kind: 'decision', decisionChange, skill: 'cds-plan',
      draft: { title: '把导出迁移到异步队列', summary: '长任务已经会超过请求超时。', links: [revisedLink],
        pullRequest: { url: 'https://github.com/fixture/repo/pull/33' } },
      source: { type: 'adr', ref: 'docs/adr/export.md@fixture-b', url: revisedLink.url },
    }, { actor: 'agent' });
    expect(proposed.status).toBe(201);
    expect(proposed.body.result).toMatchObject({ decisionChange, status: 'pending' });
    const before = await call('');
    expect(before.body.decisions).toMatchObject([{ id: decisionId, title: '把导出同步执行', links: [existingLink], version: 1 }]);

    const approve = { type: 'proposal.accept', requestId: 'revision-fixture-confirm', proposalId: proposed.body.result.id };
    expect((await call('/commands', approve, { actor: 'agent-with-approve' })).status).toBe(403);
    const confirmed = await call('/commands', approve);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.result).toMatchObject({ status: 'accepted', result: { kind: 'decision', id: decisionId } });
    const after = await call('');
    expect(after.body.decisions).toMatchObject([{ id: decisionId, title: '把导出迁移到异步队列', owner: '导出组',
      status: 'proposed', version: 2, links: [revisedLink, existingLink], pullRequest: { url: 'https://github.com/fixture/repo/pull/33' } }]);
    expect(after.body.events).toEqual(expect.arrayContaining([expect.objectContaining({
      entity: 'decision', entityId: decisionId, type: 'amended', actor: expect.objectContaining({ id: 'test-owner' }),
      proposal: expect.objectContaining({ id: proposed.body.result.id, skill: 'cds-plan' }),
    })]));
  });

  it('keeps adoption pending, rejects foreign or stale decision versions, and applies a current proposal after review', async () => {
    const draft = { title: '使用异步导出' };
    const created = await call('/commands', { type: 'decision.create', requestId: 'adoption-fixture-create', ...draft,
      source: { type: 'manual', ref: 'adoption-fixture-original' } });
    const foreign = await call('/commands', { type: 'decision.create', requestId: 'adoption-fixture-foreign', ...draft,
      source: { type: 'manual', ref: 'adoption-fixture-foreign' } }, { project: projectB });
    const decisionId = created.body.result.id;
    const proposal = (requestId: string, target: string, expectedVersion: number) => call('/commands', {
      type: 'proposal.submit', requestId, kind: 'decision', draft,
      decisionChange: { decisionId: target, expectedVersion, change: 'accepted' },
      source: { type: 'adr', ref: `docs/adr/export.md@${requestId}` },
    }, { actor: 'agent' });
    expect((await proposal('adoption-fixture-foreign-target', foreign.body.result.id, 1)).status).toBe(404);
    expect((await proposal('adoption-fixture-wrong-version', decisionId, 8)).status).toBe(409);
    const first = await proposal('adoption-fixture-propose', decisionId, 1);
    expect(first.status).toBe(201);
    expect((await call('')).body.decisions).toMatchObject([{ id: decisionId, status: 'proposed', version: 1 }]);

    const updated = await call('/commands', { type: 'decision.change', requestId: 'adoption-fixture-amend', decisionId,
      expectedVersion: 1, change: 'amended', reason: '补了新的材料' });
    expect(updated.status).toBe(201);
    const approval = (requestId: string, proposalId: string) => call('/commands', { type: 'proposal.accept', requestId, proposalId });
    expect((await approval('adoption-fixture-stale', first.body.result.id)).status).toBe(409);
    expect((await call('')).body.decisions).toMatchObject([{ id: decisionId, status: 'proposed', version: 2 }]);

    const current = await proposal('adoption-fixture-current', decisionId, 2);
    expect(current.status).toBe(201);
    expect((await approval('adoption-fixture-adopt', current.body.result.id)).status).toBe(201);
    expect((await call('')).body.decisions).toMatchObject([{ id: decisionId, status: 'accepted', version: 3 }]);
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

  it('only accepts a due debt review and preserves the repayment plan when work starts', async () => {
    now = new Date('2026-11-21T01:00:00Z');
    const debt = await write({ ...createCommand('test-due-review-debt-0001'), dueAt: '2026-12-29' });
    const deferred = await write({ type: 'debt.defer', requestId: 'test-due-review-defer-0001', debtId: debt.id,
      expectedVersion: debt.version, reviewAt: '2026-11-22', reason: '等合成窗口' });
    const review = { type: 'debt.review', debtId: debt.id, expectedVersion: deferred.version,
      next: 'start', reason: '今天开始执行合成修复', requestId: 'test-run-review-0001' };
    expect((await call('/commands', review)).status).toBe(409);
    now = new Date('2026-11-21T16:00:00Z');
    expect(await write(review)).toMatchObject({ status: 'in_progress', dueAt: '2026-12-29' });
    expect((await call(`/debts/${debt.id}`)).body.events[0]).toMatchObject({ type: 'reviewed', note: review.reason,
      dates: { reviewAt: ['2026-11-22', null] } });
  });

  it('checks similar debts within one project and records an explicit distinction atomically', async () => {
    const first = await createDebt();
    const path = `/duplicates?title=${encodeURIComponent(first.title)}`;
    expect((await call(path)).body.items).toMatchObject([{ id: first.id, similarity: 1 }]);
    expect((await call(path, undefined, { project: projectB })).body.items).toEqual([]);
    const command = { ...createCommand('test-duplicate-confirm-0001', 'fixture-a-separate-finding'), module: '导出',
      title: `${first.title}!` };
    expect(await call('/commands', command)).toMatchObject({ status: 409, body: { error: 'possible_duplicate', candidates: [{ id: first.id }] } });
    expect((await call('/debts?view=all')).body.total).toBe(1);
    const created = await write({ ...command, distinction: { debtIds: [first.id], reason: '合成环境中是另一个接口，单独记录。' } });
    expect((await call(`/debts/${created.id}`)).body.events[0].note).toContain('另一个接口');
    expect((await call('/debts?view=dup')).body.total).toBe(0);
    expect((await call(`/debts?module=${encodeURIComponent('导出')}`)).body.items).toMatchObject([{ id: created.id }]);
  });

  it('previews a batch without writes and resolves the resulting batch within its project', async () => {
    const row = { title: '回读独立合成入口', source: { type: 'import', ref: 'test-import-row' }, module: '导入' };
    const preview = await call('/import-preview', { items: [row, row, { title: '没有来源的记录' }] });
    expect(preview).toMatchObject({ status: 200, body: { items: [{ index: 0, status: 'ready' }, { index: 1, status: 'repeated' }, { index: 2, status: 'invalid' }] } });
    expect((await call('/debts?view=all')).body.total).toBe(0);
    const result = await write({ type: 'debt.import', requestId: 'test-specific-batch-0001', items: [row] });
    expect(result.batchId).toMatch(/^BATCH-/);
    expect((await call(`/debts?view=all&batch=${result.batchId}`)).body.items).toMatchObject([{ id: result.items[0].id, importBatchId: result.batchId }]);
    expect((await call(`/debts?view=all&batch=${result.batchId}`, undefined, { project: projectB })).body.total).toBe(0);
    expect((await call('/import-preview', { items: [row] })).body.items).toMatchObject([{ index: 0, status: 'existing', debtId: result.items[0].id }]);
  });

  it('creates initial plan steps atomically and records the earlier repayment target', async () => {
    const debt = await write({ ...createCommand('test-initial-plan-debt-0001'), dueAt: '2026-12-20' });
    const plan = { type: 'plan.create', requestId: 'test-initial-steps-0001', title: '完成合成债务', startAt: '2026-12-01', dueAt: '2026-12-19',
      source: { type: 'manual', ref: 'fixture-initial-plan' }, initialSteps: [
        { kind: 'task', title: '取样', owner: '合成负责人' },
        { kind: 'debt', title: '归还示例债', relatedId: debt.id, dueAt: '2026-12-10' },
      ] };
    expect((await call('/commands', { ...plan, initialSteps: [...plan.initialSteps, { kind: 'debt', title: '不存在', relatedId: 'missing' }] })).status).toBe(404);
    expect((await call('')).body.plans).toEqual([]);
    expect((await call(`/debts/${debt.id}`)).body.debt.dueAt).toBe('2026-12-20');
    const saved = await write(plan);
    expect(saved.steps).toMatchObject([{ kind: 'task', owner: '合成负责人' }, { kind: 'debt', relatedId: debt.id }]);
    expect((await call(`/debts/${debt.id}`)).body).toMatchObject({ debt: { dueAt: '2026-12-10' }, events: [
      { type: 'planned', dates: { dueAt: ['2026-12-20', '2026-12-10'] }, relatedPlanId: saved.id },
      { type: 'created' },
    ] });
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

  it('filters and sorts the complete debt list before pagination and reads the scoped ledger', async () => {
    now = new Date('2026-11-19T02:00:00Z');
    const branch = await write({
      type: 'decision.create', requestId: 'test-list-decision-0001',
      title: '合成规划筛选', source: { type: 'adr', ref: 'fixture-list-decision' },
    });
    const later = await write({
      ...createCommand('test-list-debt-0001', 'fixture-list-newer-date'), decisionId: branch.id,
      title: '合成筛选同一查询问题甲', owner: '合成负责人', priority: 'high', dueAt: '2026-12-20', tags: ['性能/查询'],
    });
    const earlier = await write({
      ...createCommand('test-list-debt-0002', 'fixture-list-earlier-date'), decisionId: branch.id,
      title: '合成筛选同一查询问题乙', owner: '合成负责人', priority: 'high', dueAt: '2026-11-06', tags: ['性能/查询'],
    });
    await write({
      ...createCommand('test-list-debt-0003', 'fixture-list-other-tag'), decisionId: branch.id,
      title: '合成另一种筛选', owner: '其他合成人', priority: 'low', tags: ['性能/缓存'],
    });
    await write({ ...createCommand('test-list-debt-0004', 'fixture-list-unassigned'), title: '未归属' });
    const query = `?branch=${branch.id}&tag=${encodeURIComponent('性能/查询')}&priority=high&sort=deadline&view=dup&limit=1`;
    const first = await call('/debts' + query);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      total: 2, items: [{ id: earlier.id }], counts: { unpaid: 2, overdue: 1, dup: 2, all: 2 },
      ledger: { unpaid: 3, repaid: 0, extinct: 0 },
      filterOptions: { owners: ['其他合成人', '合成负责人'], tags: expect.arrayContaining(['性能/查询', '性能/缓存']) },
    });
    const second = await call('/debts' + query + '&cursor=' + first.body.nextCursor);
    expect(second.body.items.map((row: { id: string }) => row.id)).toEqual([later.id]);
    expect((await call('/debts' + query.replace('priority=high', 'priority=low') + '&cursor=' + first.body.nextCursor)).status).toBe(400);
    expect((await call('/debts?priority=invalid')).status).toBe(400);
    expect((await call('', undefined, { actor: 'reader' })).body.debtBranches).toMatchObject({
      [branch.id]: { unpaid: 3, created: 3 }, none: { unpaid: 1, created: 1 },
    });
  });

  it('keeps decision alternatives and actual plan dates and reads linked progress evidence', async () => {
    const decision = {
      type: 'decision.create', requestId: 'test-structure-decision-0001', title: '保留合成回退窗口',
      decisionKind: 'debt', options: [
        { title: '先加缓存', benefits: '保护待发布页面', drawbacks: '需记偿还计划' },
        { title: '先建索引', drawbacks: '下一发布窗口执行' },
      ], chosenOption: '先加缓存', consequences: '先保留现有兼容路径', source: { type: 'adr', ref: 'fixture-structure-adr' },
    };
    expect((await call('/commands', { ...decision, options: [{ title: '可选项' }], chosenOption: '无此选项' })).status).toBe(400);
    const saved = await write(decision);
    const plan = { type: 'plan.create', requestId: 'test-structure-plan-0001', title: '回退准备',
      decisionId: saved.id, source: { type: 'manual', ref: 'fixture-structure-plan' }, startAt: '2026-12-01', dueAt: '2026-12-12' };
    expect((await call('/commands', { ...plan, startAt: '2026-12-13' })).status).toBe(400);
    await write(plan);
    const debt = await createDebt();
    const notes = [{ type: 'test', label: '合成验收回执', url: 'https://example.test/check' }];
    await write({ type: 'debt.progress', requestId: 'test-structure-progress-0001', debtId: debt.id,
      expectedVersion: debt.version, note: '合成检查完成', evidence: notes });
    const board = (await call('')).body;
    expect(board.decisions).toContainEqual(expect.objectContaining({ id: saved.id,
      decisionKind: 'debt', chosenOption: '先加缓存', consequences: decision.consequences, options: expect.arrayContaining([decision.options[0]]) }));
    expect(board.plans).toContainEqual(expect.objectContaining({ startAt: plan.startAt, dueAt: plan.dueAt }));
    expect((await call(`/debts/${debt.id}`)).body.events[0].evidence).toEqual(notes);
  });

  it('validates outstanding criteria and keeps evidence against its exact criterion', async () => {
    const debt = await createDebt();
    const result = { criterionId: debt.criteria[0].id, verdict: 'met', note: '一条请求',
      evidence: [{ type: 'test', label: '合成运行', url: 'https://example.test/results/only-one' }] };
    const request = { type: 'debt.repay', requestId: 'test-criterion-evidence-0001', debtId: debt.id,
      expectedVersion: debt.version, summary: '移除重复请求', evidence: [] };
    expect((await call('/commands', { ...request, results: [{ ...result, verdict: 'unmet' }] })).status).toBe(400);
    expect((await call('/commands', { ...request, results: [{ ...result,
      evidence: [{ ...result.evidence[0], url: 'javascript:alert(1)' }],
    }] })).status).toBe(400);
    const repaid = await write({ ...request, results: [result] });
    expect(repaid.repayment.results).toEqual([result]);
    const detail = await call(`/debts/${debt.id}`);
    expect(detail.body.events[0].repayment.results).toEqual([result]);
    expect(detail.body.brief.readiness.items.at(-1).ok).toBe(true);
  });

  it('writes marked proof and compatible collateral debts together and serves images only to project readers', async () => {
    const main = await createDebt();
    const secondary = await write({ ...createCommand('test-proof-related-0001', 'fixture-proof-related'), title: '另一笔相同验收标准' });
    const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRVEAAAAASUVORK5CYII=';
    const after = { stage: 'after', dataUrl: `data:image/png;base64,${onePixelPng}`, label: '合成请求截图',
      mark: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 } };
    const request = { type: 'debt.repay', requestId: 'test-proof-with-related-0001', debtId: main.id,
      expectedVersion: main.version, summary: '合成请求已经修复', results: [{ criterionId: main.criteria[0].id, verdict: 'met' }] };
    expect((await call('/commands', { ...request, repaymentProofs: [{ ...after, mark: undefined }] })).status).toBe(400);
    expect((await call('/commands', { ...request, repaymentProofs: [] })).status).toBe(400);
    expect((await call('/commands', { ...request, repaymentProofs: [after],
      collateral: [{ debtId: secondary.id, expectedVersion: secondary.version + 1 }],
    })).status).toBe(409);
    expect((await call(`/debts/${main.id}`)).body.debt.status).toBe('open');
    const saved = await write({ ...request, repaymentProofs: [after], collateral: [{ debtId: secondary.id, expectedVersion: secondary.version }] });
    expect(saved.repayment.evidence[0]).toMatchObject({ type: 'screenshot', label: after.label,
      image: { stage: 'after', mark: after.mark } });
    expect(JSON.stringify(saved)).not.toContain(onePixelPng);
    const attached = await call(`/debts/${secondary.id}`);
    expect(attached.body.debt.repayment).toMatchObject({ mode: 'collateral', collateralOf: main.id,
      results: [{ criterionId: secondary.criteria[0].id, verdict: 'met' }] });
    expect((await call('/debts?view=collateral')).body.items).toHaveLength(1);
    const image = saved.repayment.evidence[0].image.id;
    await stop();
    await start();
    const protectedPath = (project: string) => `${endpoint}/api/projects/${project}/planning/evidence/${image}`;
    const bytes = await fetch(protectedPath(projectA), { headers: { 'x-fixture-actor': 'reader' } });
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('content-type')).toBe('image/png');
    expect(bytes.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await bytes.arrayBuffer()).toString('base64')).toBe(onePixelPng);
    expect((await fetch(protectedPath(projectA))).status).toBe(404);
    expect((await fetch(protectedPath(projectB), { headers: { 'x-fixture-actor': 'owner' } })).status).toBe(404);
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

  it('links a design within the project and completes its step only for a signed current commit', async () => {
    const decision = await write({ type: 'decision.create', requestId: 'add-design-decision', title: 'Review the fixture design',
      source: { type: 'manual', ref: 'test-design-decision' } });
    designVersion = { id: 'DSN-fixture', title: 'Fixture design', version: 2, decisionIds: [decision.id] };
    const create = { type: 'plan.create', requestId: 'add-design-to-plan', title: 'Ship the fixture design',
      source: { type: 'manual', ref: 'test-design-in-plan' },
      initialSteps: [{ kind: 'design', relatedId: designVersion.id, title: 'Finish design acceptance' }] };
    expect((await call('/commands', create, { project: projectB })).status).toBe(404);
    const plan = await write(create);
    const board = async () => (await call('')).body;
    expect((await board()).designs).toEqual([designVersion]);
    expect((await board()).plans[0].steps[0].status).toBe('todo');
    expect((await call('/commands', { type: 'plan.step', requestId: 'manual-design-completion', planId: plan.id,
      expectedVersion: plan.version, stepId: plan.steps[0].id, status: 'done', note: 'Fixture bypass attempt' })).status).toBe(409);

    const prNumber = 43;
    const observed = async (commit: string, updatedAt: string) => service.recordGithubObservation(projectA, { type: 'pull_request', pullRequest: {
      number: prNumber, repository: 'fixture/planning', url: 'https://github.com/fixture/planning/pull/43', title: 'Fixture PR',
      author: 'fixture', openedAt: '2026-01-01T00:00:00Z', updatedAt, state: 'open', headBranch: 'feat/fixture', headSha: commit,
      decisionRefs: [], debtRefs: [], observation: { action: 'synchronize' }, checks: {},
    } });
    const commit = '1'.repeat(40);
    await observed(commit, '2026-01-01T00:00:00Z');
    designVersion.frozen = 2;
    expect((await board()).plans[0].steps[0].status).toBe('doing');
    designVersion.signed = { commit, pullRequest: prNumber, runId: 'RUN-fixture' };
    expect((await board()).plans[0].steps[0].status).toBe('done');
    await observed('2'.repeat(40), '2026-01-02T00:00:00Z');
    expect((await board()).plans[0].steps[0].status).toBe('doing');
    expect((await board()).designs[0].signed).toEqual(designVersion.signed);
  });

  it('cancels an extinct debt step and only completes a debt step with verified repayment', async () => {
    now = new Date('2026-03-02T01:00:00Z');
    const expiredDebt = await write(createCommand('test-planned-extinct-0001', 'synthetic-expired-source'));
    const resolvedDebt = await write({ ...createCommand('test-planned-repay-0001', 'synthetic-repaid-source'), title: 'Keep traceability for the remaining route' });
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
