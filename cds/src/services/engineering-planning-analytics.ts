import {
  planningVerificationState, type DebtStatus, type PlanningAnalyticsActivity, type PlanningCounts, type PlanningDebt, type PlanningEvent,
  type PlanningEventKind, type PlanningGraphChange, type PlanningGraphDebt, type PlanningGraphOutcome, type PlanningStats,
} from '../shared/engineering-planning.js';
import { planningToday, unpaid, type PlanningState } from './engineering-planning-domain.js';

export type PlanningAnalyticsMode = 'evolution' | 'projection' | 'graph';
const DAY = 86_400_000;
const RECENT_LIMIT = 12;
const OUTLOOK_DAYS = 30;
const MAX_COMPARISON_DAYS = 90;
const recentTypes = new Set<PlanningEventKind>([
  'created', 'imported', 'deferred', 'started', 'repaid', 'reopened', 'dropped', 'extinct', 'merged_into', 'branch_moved',
  'verified', 'extinct_pending',
]);

export const matchesBranch = (id: string | undefined, branch: string | undefined) => !branch || (branch === 'none' ? !id : id === branch);
const active = (status: DebtStatus | undefined) => Boolean(status && unpaid({ status }));

export function eventDelta(event: PlanningEvent, branch?: string): { kind: keyof PlanningCounts; delta: number } | undefined {
  if (event.entity !== 'debt') return;
  const before = active(event.fromStatus) && matchesBranch(event.fromDecisionId, branch);
  const after = active(event.toStatus) && matchesBranch(event.toDecisionId, branch);
  if (before === after) return;
  if (event.type === 'branch_moved') return after ? { kind: 'transferredIn', delta: 1 } : { kind: 'transferredOut', delta: -1 };
  switch (event.type) {
    case 'created':
    case 'imported':
    case 'reopened': return { kind: event.type, delta: 1 };
    case 'repaid':
    case 'dropped':
    case 'extinct': return { kind: event.type, delta: -1 };
    case 'merged_into': return { kind: 'merged', delta: -1 };
  }
}

function matchesEventBranch(event: PlanningEvent, branch: string | undefined) {
  return !branch || (event.fromStatus !== undefined && matchesBranch(event.fromDecisionId, branch))
    || (event.toStatus !== undefined && matchesBranch(event.toDecisionId, branch));
}

function activity(event: PlanningEvent, debt: PlanningDebt, mode: PlanningAnalyticsMode): PlanningAnalyticsActivity {
  return { id: event.id, debtId: debt.id, at: event.at, type: event.type, ...(mode !== 'projection' ? { title: debt.title } : {}),
    ...(event.repayment?.mode === 'collateral' ? { collateral: true } : {}) };
}

function outcome(debt: PlanningDebt): PlanningGraphOutcome {
  if (unpaid(debt)) return 'unpaid';
  if (debt.status === 'repaid') return debt.repayment?.mode === 'collateral' ? 'collateral' : 'repaid';
  if (debt.outcome?.kind === 'extinct' || debt.outcome?.kind === 'merged') return debt.outcome.kind;
  return 'cancelled';
}

export function buildPlanningAnalytics(
  state: PlanningState,
  mode: PlanningAnalyticsMode,
  now: Date,
  from: string,
  to: string,
  branch?: string,
): Pick<PlanningStats, 'snapshot' | 'recent' | 'outlook' | 'breakdown' | 'graph'> {
  const today = planningToday(now);
  const asOf = now.toISOString();
  const outlook: NonNullable<PlanningStats['outlook']> = {
    through: planningToday(new Date(now.getTime() + OUTLOOK_DAYS * DAY)), repayments: 0, reviews: 0, items: [],
  };
  const snapshot = { today, unpaid: 0, inProgress: 0, reviewDue: 0, overdue: 0, pendingVerification: 0, pendingExtinct: 0 };
  const breakdown: NonNullable<PlanningStats['breakdown']> = {
    ages: [0, 0, 0, 0, 0], priorities: { high: 0, mid: 0, low: 0 }, sources: {}, hits: 0, topHits: [],
  };
  const recent: PlanningAnalyticsActivity[] = [];
  const changes: PlanningGraphChange[] = [];
  const debts: PlanningGraphDebt[] = [];
  const hits = new Map<string, number>();
  const fromComparison = new Date(now.getTime() - MAX_COMPARISON_DAYS * DAY).toISOString();
  const from30 = new Date(now.getTime() - 30 * DAY);
  const from30Time = from30.toISOString();
  const from30Day = planningToday(from30);

  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index];
    if (event.entity !== 'debt' || event.at > asOf || !matchesEventBranch(event, branch)) continue;
    const debt = state.debts.get(event.entityId);
    if (!debt) continue;
    if (event.type === 'hit' && event.at >= from30Time) hits.set(debt.id, (hits.get(debt.id) ?? 0) + 1);
    if (mode === 'graph') {
      if (event.at < fromComparison) continue;
      const movement = eventDelta(event, branch);
      if (movement) changes.push({ ...activity(event, debt, mode), movement: movement.kind, delta: movement.delta,
        tags: debt.tags ?? [] });
    } else {
      if (!recentTypes.has(event.type)) continue;
      if (recent.length >= RECENT_LIMIT && event.type !== 'created') continue;
      const day = planningToday(new Date(event.at));
      if (day < from || day > to) continue;
      if (recent.length < RECENT_LIMIT) recent.push(activity(event, debt, mode));
      if (event.type === 'created') {
        const source = debt.source.type;
        breakdown.sources[source] = (breakdown.sources[source] ?? 0) + 1;
      }
    }
  }

  for (const debt of state.debts.values()) {
    if (!matchesBranch(debt.decisionId, branch)) continue;
    const isUnpaid = unpaid(debt);
    const reviewDue = debt.status === 'deferred' && !!debt.reviewAt && debt.reviewAt <= today;
    const overdue = isUnpaid && !!debt.dueAt && debt.dueAt < today;
    const discovered = debt.discoveredAt ?? planningToday(new Date(debt.createdAt));
    if (isUnpaid) {
      snapshot.unpaid++;
      if (planningVerificationState(debt.verify, now.getTime()) !== 'verified') snapshot.pendingVerification++;
      if (debt.anchor?.status === 'missing') snapshot.pendingExtinct++;
    }
    if (debt.status === 'in_progress') snapshot.inProgress++;
    if (reviewDue) snapshot.reviewDue++;
    if (overdue) snapshot.overdue++;

    if (mode === 'graph') {
      debts.push({ id: debt.id, title: debt.title, status: debt.status, outcome: outcome(debt), priority: debt.priority,
        owner: debt.owner, module: debt.module, source: debt.source.type, tags: debt.tags ?? [], reopened: debt.reopenCount > 0,
        reviewDue, overdue, recentHits: hits.get(debt.id) ?? 0,
        recentlyCreated: discovered >= from30Day });
      continue;
    }

    if (!isUnpaid) continue;
    const future = { debtId: debt.id, ...(mode !== 'projection' ? { title: debt.title } : {}) };
    const age = (Date.parse(today) - Date.parse(discovered)) / DAY;
    const ageBucket = [30, 90, 180, 365, Infinity].findIndex(lastDay => age <= lastDay);
    breakdown.ages[ageBucket]++;
    breakdown.priorities[debt.priority]++;
    const recentHits = hits.get(debt.id) ?? 0;
    if (recentHits) {
      breakdown.hits += recentHits;
      breakdown.topHits.push({ ...future, recent: recentHits, total: debt.hitCount });
    }
    if (debt.dueAt && debt.dueAt > today && debt.dueAt <= outlook.through) {
      outlook.repayments++;
      outlook.items.push({ ...future, date: debt.dueAt, kind: 'repayment' });
    }
    if (debt.status === 'deferred' && debt.reviewAt && debt.reviewAt > today && debt.reviewAt <= outlook.through) {
      outlook.reviews++;
      outlook.items.push({ ...future, date: debt.reviewAt, kind: 'review' });
    }
  }

  if (mode === 'graph') return { snapshot, graph: { asOf, branch, debts, changes } };
  outlook.items.sort((a, b) => a.date.localeCompare(b.date) || a.debtId.localeCompare(b.debtId) || a.kind.localeCompare(b.kind));
  outlook.items = outlook.items.slice(0, RECENT_LIMIT);
  breakdown.topHits.sort((a, b) => b.recent - a.recent || b.total - a.total || a.debtId.localeCompare(b.debtId));
  breakdown.topHits = breakdown.topHits.slice(0, 5);
  return { snapshot, recent, outlook, breakdown };
}
