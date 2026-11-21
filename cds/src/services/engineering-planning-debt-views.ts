import {
  planningDebtViews, planningVerificationState, type PlanningDebt, type PlanningDebtBranch, type PlanningDebtList,
  type PlanningDebtView, type PlanningRelatedDebt,
} from '../shared/engineering-planning.js';
import { planningToday, unpaid, type PlanningState } from './engineering-planning-domain.js';
import { checkupDuplicatePairs } from './engineering-planning-checkup.js';

export function matchesDebtView(view: PlanningDebtView, debt: PlanningDebt, today: string, duplicates: Set<string>) {
  switch (view) {
    case 'all': return true;
    case 'unpaid': return unpaid(debt);
    case 'review_due': return debt.status === 'deferred' && !!debt.reviewAt && debt.reviewAt <= today;
    case 'overdue': return unpaid(debt) && !!debt.dueAt && debt.dueAt < today;
    case 'reopened': return debt.reopenCount > 0;
    case 'dup': return duplicates.has(debt.id);
    case 'pending_extinct': return unpaid(debt) && debt.anchor?.status === 'missing';
    case 'direct_repaid': return debt.status === 'repaid' && debt.repayment?.mode !== 'collateral' && (!debt.legacy || !!debt.repayment);
    case 'collateral': return debt.status === 'repaid' && debt.repayment?.mode === 'collateral';
    case 'extinct': return debt.outcome?.kind === 'extinct';
    case 'merged': return debt.outcome?.kind === 'merged';
    case 'void': return debt.status === 'dropped' && debt.outcome?.kind !== 'extinct' && debt.outcome?.kind !== 'merged';
    default: return debt.status === view;
  }
}

const duplicateSnapshots = new WeakMap<PlanningState, Set<string>>();
export function duplicateDebtIds(state: PlanningState): Set<string> {
  const existing = duplicateSnapshots.get(state);
  if (existing) return existing;
  const duplicates = new Set<string>();
  for (const [left, right] of checkupDuplicatePairs(state.debts.values())) {
    duplicates.add(left.id);
    duplicates.add(right.id);
  }
  duplicateSnapshots.set(state, duplicates);
  return duplicates;
}

export function debtListSummary(scoped: PlanningDebt[], matching: PlanningDebt[], today: string, duplicates: Set<string>, now: number):
  Pick<PlanningDebtList, 'counts' | 'ledger' | 'filterOptions'> {
  const counts = Object.fromEntries(planningDebtViews.map(view => [view, 0])) as Record<PlanningDebtView, number>;
  for (const row of matching) {
    for (const view of planningDebtViews) if (matchesDebtView(view, row, today, duplicates)) counts[view]++;
  }
  const ledger = { unpaid: 0, repaid: 0, extinct: 0, verified: 0 };
  const owners = new Set<string>();
  const tags = new Set<string>();
  for (const row of scoped) {
    if (unpaid(row)) {
      ledger.unpaid++;
      if (planningVerificationState(row.verify, now) === 'verified') ledger.verified++;
    }
    else if (row.status === 'repaid') ledger.repaid++;
    else if (row.outcome?.kind === 'extinct') ledger.extinct++;
    if (row.owner) owners.add(row.owner);
    for (const tag of row.tags ?? []) tags.add(tag);
  }
  return { counts, ledger, filterOptions: { owners: [...owners].sort(), tags: [...tags].sort() } };
}

export function projectDebtNavigation(state: PlanningState, today: string) {
  const cutoff = new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10);
  const debtBranches: Record<string, PlanningDebtBranch> = Object.create(null);
  const relatedDebts: Record<string, PlanningRelatedDebt> = Object.create(null);
  const branch = (id?: string) => debtBranches[id ?? 'none'] ??= {
    unpaid: 0, repaid: 0, extinct: 0, other: 0, planned: 0, highInterest: 0, created: 0, closed: 0,
  };
  const planned = new Set<string>();
  for (const plan of state.plans.values()) {
    for (const step of plan.steps) if (step.kind === 'debt' && step.relatedId) planned.add(step.relatedId);
  }
  const related = new Set(planned);
  for (const decision of state.decisions.values()) for (const id of decision.resolves ?? []) related.add(id);
  for (const proposal of state.proposals.values()) {
    if (proposal.kind === 'plan' && proposal.status === 'pending') for (const id of proposal.draft.debtIds ?? []) related.add(id);
  }
  const recentHits = new Map<string, number>();
  for (const event of state.events) {
    if (event.entity !== 'debt' || !['created', 'repaid', 'dropped', 'extinct', 'merged_into', 'hit'].includes(event.type)) continue;
    const day = planningToday(new Date(event.at));
    if (day < cutoff || day > today) continue;
    if (event.type === 'hit') recentHits.set(event.entityId, (recentHits.get(event.entityId) ?? 0) + 1);
    else if (event.type === 'created') branch(event.toDecisionId).created++;
    else branch(event.fromDecisionId).closed++;
  }
  for (const row of state.debts.values()) {
    const summary = branch(row.decisionId);
    const hits = recentHits.get(row.id) ?? 0;
    if (unpaid(row)) {
      summary.unpaid++;
      if (hits >= 3) summary.highInterest++;
    } else if (row.status === 'repaid') summary.repaid++;
    else if (row.outcome?.kind === 'extinct') summary.extinct++;
    else summary.other++;
    if (planned.has(row.id)) summary.planned++;
    if (related.has(row.id)) relatedDebts[row.id] = {
      id: row.id, title: row.title, status: row.status, outcome: row.outcome, decisionId: row.decisionId,
      recentHits: hits, repaidAt: row.repayment?.at,
    };
  }
  return { debtBranches, relatedDebts };
}
