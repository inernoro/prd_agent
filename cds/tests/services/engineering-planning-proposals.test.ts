import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanningActor } from '../../src/shared/engineering-planning.js';
import { EngineeringPlanningService, FileEngineeringPlanningStore } from '../../src/services/engineering-planning.js';

const project = 'proposal-fixture';
const otherProject = 'other-proposal-fixture';
const author: PlanningActor = { kind: 'agent', id: 'runner', label: '审查助手', permissions: ['read', 'propose'] };
const reviewer: PlanningActor = { kind: 'human', id: 'reviewer', label: '项目负责人', permissions: ['read', 'propose', 'write', 'approve'] };
const title = '黑白主题报表导出操作触发重复网络请求';
const similarTitle = '黑白主题报表导出操作触发重复的网络请求';
const source = { type: 'review', ref: 'review:fixture:1', url: 'https://example.com/reviews/1' };

function recordId(receipt: Awaited<ReturnType<EngineeringPlanningService['command']>>) {
  if (!('id' in receipt.result)) throw new Error('Expected an engineering planning record');
  return receipt.result.id;
}

describe('engineering planning proposal review', () => {
  let directory: string;
  let planning: EngineeringPlanningService;

  function open() {
    return new EngineeringPlanningService(new FileEngineeringPlanningStore(directory), () => new Date('2026-11-20T09:00:00Z'));
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'cds-planning-proposals-'));
    planning = open();
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  function create(requestId: string, projectId = project, draftTitle = title) {
    return planning.command(projectId, reviewer, { type: 'debt.create', requestId, title: draftTitle, source });
  }

  function propose(requestId: string, draftTitle = similarTitle, metadata = {}) {
    return planning.command(project, author, {
      type: 'proposal.submit', requestId, kind: 'debt', draft: { title: draftTitle }, source, ...metadata,
    });
  }

  it('attributes the actual source and increases the original debt interest once after human approval', async () => {
    const original = await create('original-debt');
    const debtId = recordId(original);
    const submitted = await propose('review-finding', similarTitle, {
      skill: 'cds-review', confidence: 0.88, source: { ...source, excerpt: '已放行这次改动，下一个 PR 补齐。' },
    });
    expect(submitted.result).toMatchObject({
      status: 'pending', author: { id: author.id, label: author.label }, skill: 'cds-review', confidence: 0.88,
      source: { ...source, excerpt: '已放行这次改动，下一个 PR 补齐。' }, suggest: { dupOf: debtId, dupTitle: title },
    });
    expect((await planning.debt(project, debtId)).debt.hitCount).toBe(0);
    expect((await planning.debts(project)).items).toHaveLength(1);

    const approval = { type: 'proposal.accept', requestId: 'review-confirmation', proposalId: recordId(submitted), as: 'hit', debtId };
    await expect(planning.command(project, { ...author, permissions: reviewer.permissions }, approval)).rejects.toMatchObject({ status: 403 });
    const results = await Promise.all([planning.command(project, reviewer, approval), open().command(project, reviewer, approval)]);
    expect(results.map(item => item.reused).sort()).toEqual([false, true]);
    expect(results[0].result).toMatchObject({ status: 'accepted', result: { kind: 'debt', id: debtId, mode: 'hit' } });

    planning = open();
    expect((await planning.debts(project)).items).toHaveLength(1);
    const detail = await planning.debt(project, debtId);
    expect(detail.debt).toMatchObject({ hitCount: 1, status: 'open', source });
    expect(detail.events.filter(event => event.type === 'hit')).toMatchObject([{
      actor: { id: reviewer.id }, proposedBy: { id: author.id },
      proposal: { id: recordId(submitted), skill: 'cds-review', source },
    }]);
  });

  it('keeps one proposal for the same source and title even after rejection, while allowing another finding from that source', async () => {
    const first = await propose('fixture-first', '导出操作触发重复网络请求');
    expect(first.result).not.toHaveProperty('confidence');
    const proposalId = recordId(first);
    await planning.command(project, reviewer, { type: 'proposal.reject', requestId: 'fixture-dismiss', proposalId, reason: '暂时不采纳' });
    const retried = await propose('fixture-retried', '导出操作触发重复网络请求');
    expect(retried).toMatchObject({ reused: true, result: { id: proposalId, status: 'rejected' } });
    const second = await propose('fixture-second', '导出文件名缺少时区');
    expect(recordId(second)).not.toEqual(proposalId);
    expect((await planning.board(project, author)).proposals).toHaveLength(2);
    expect((await planning.debts(project)).items).toEqual([]);
  });

  it('matches only current project debts and rechecks the displayed target before recording a hit', async () => {
    const foreign = await create('fixture-foreign', otherProject, similarTitle);
    const submitted = await propose('fixture-wrong-project');
    expect(submitted.result).not.toHaveProperty('suggest');
    const target = await create('fixture-local');
    const debtId = recordId(target);
    const proposalId = recordId(submitted);
    expect((await planning.board(project, author)).proposals[0].suggest).toMatchObject({ dupOf: debtId });
    const acceptHit = { type: 'proposal.accept', requestId: 'fixture-stale-target', as: 'hit', proposalId };
    await expect(planning.command(project, reviewer, { ...acceptHit, debtId: recordId(foreign) })).rejects.toMatchObject({ status: 409 });
    await planning.command(project, reviewer, {
      type: 'debt.drop', requestId: 'fixture-drop', debtId, expectedVersion: 1, kind: 'cancelled', reason: '误记',
    });
    expect((await planning.board(project, author)).proposals[0]).not.toHaveProperty('suggest');
    await expect(planning.command(project, reviewer, { ...acceptHit, debtId })).rejects.toMatchObject({ status: 409 });
    expect((await planning.debt(otherProject, recordId(foreign))).debt.hitCount).toBe(0);
    expect((await planning.board(project, reviewer)).proposals[0].status).toBe('pending');
  });

  it('honors the explicit new-debt action and carries skill attribution into the creation history', async () => {
    const original = await create('fixture-original');
    const submitted = await propose('fixture-different', similarTitle, { skill: 'cds-qa', confidence: 0 });
    expect(submitted.result).toMatchObject({ confidence: 0, suggest: { dupOf: recordId(original) } });
    const accepted = await planning.command(project, reviewer, {
      type: 'proposal.accept', requestId: 'fixture-new', as: 'new', proposalId: recordId(submitted),
    });
    const debt = (await planning.debts(project)).items.find(item => item.id !== recordId(original));
    expect(debt).toMatchObject({ title: similarTitle, source, hitCount: 0 });
    expect(accepted.result).toMatchObject({ status: 'accepted', result: { kind: 'debt', id: debt?.id } });
    const detail = await planning.debt(project, debt!.id);
    expect(detail.events).toMatchObject([{
      type: 'created', actor: { id: reviewer.id }, proposedBy: { id: author.id },
      proposal: { id: recordId(submitted), skill: 'cds-qa', source }, note: expect.stringContaining('cds-qa'),
    }]);
  });

  it('validates optional metadata and prevents a requester from supplying the duplicate recommendation', async () => {
    for (const metadata of [{ confidence: -0.1 }, { confidence: 1.1 }, { confidence: '0.9' }, { skill: ' ' },
      { source: { ...source, url: 'javascript:alert(1)' } }, { suggest: { dupOf: 'other-debt' } }]) {
      await expect(propose('fixture-invalid', similarTitle, metadata)).rejects.toMatchObject({ status: 400 });
    }
    expect((await planning.board(project, author)).proposals).toEqual([]);
  });
});
