import { describe, expect, it } from 'vitest';
import type { PlanningBoard, PlanningDecision, PlanningPlan, PlanningPullRequest } from '../../src/shared/engineering-planning.js';
import { timelineCauses, timelineItems, timelineRelations } from '../../web/src/pages/engineering-planning/planning-timeline-model.js';

const createdAt = '2026-11-01T09:00:00+08:00';
const projectId = 'timeline-fixture';
const source = { type: 'manual', ref: 'fixture' } as const;
const record = { projectId, version: 1, createdAt, updatedAt: createdAt, source };
const today = '2026-11-24';

function causes(partial: Pick<PlanningBoard, 'decisions' | 'plans'>) {
  const board: PlanningBoard = { projectId, today, protocolVersion: 1, permissions: ['read'],
    pendingReviewCount: 0, proposals: [], events: [], ...partial };
  const items = timelineItems(board);
  return timelineCauses(board, items, timelineRelations(board, items));
}

describe('planning timeline causes', () => {
  it('uses the actual ordinal of a late step before the plan deadline', () => {
    const plan: PlanningPlan = { ...record, id: 'PLN-fixture', title: 'Release fixture', dueAt: '2026-11-30', steps: [
      { id: 'first', kind: 'task', title: 'Prepare', status: 'done' },
      { id: 'second', kind: 'task', title: 'Check rollout', status: 'doing', dueAt: '2026-11-22' },
    ] };
    expect(causes({ decisions: [], plans: [plan] })[0]).toMatchObject({ key: 'plan:PLN-fixture', tone: 'bad',
      text: expect.stringContaining('1 个落地步骤逾期，卡在第 2 步') });
  });

  it('checks proposal activity and disregards old pull requests for replaced decisions', () => {
    const recent: PlanningDecision = { ...record, id: 'ADR-active', title: 'Active draft', status: 'proposed', updatedAt: `${today}T09:00:00+08:00` };
    const pull: PlanningPullRequest = { number: 8, projectId, repository: 'fixture/project', url: 'https://example.invalid/pulls/8',
      title: 'Fixture', author: 'fixture', openedAt: createdAt, updatedAt: createdAt, decisionIds: ['ADR-replaced'], debtIds: [], state: 'open', checks: 'fail' };
    const replaced: PlanningDecision = { ...record, id: 'ADR-replaced', title: 'Replaced', status: 'superseded', pullRequests: [pull] };
    const results = causes({ decisions: [recent, replaced], plans: [] });
    expect(results).toMatchObject([{ key: 'decision:ADR-active', tone: 'info' }]);
  });
});
