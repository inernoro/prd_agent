import { randomUUID } from 'node:crypto';
import type {
  Criterion, DebtDraft, DecisionDraft, PlanDraft, PlanningActor, PlanningCommand, PlanningCommitResult,
  PlanningDebt, PlanningDecision, PlanningEvent, PlanningIdentity, PlanningPlan, PlanningProposal, PlanningSource,
} from '../shared/engineering-planning.js';
import { rejectPlanning } from './engineering-planning-input.js';
import type { EngineeringPlanningCommit } from './engineering-planning-store.js';

export type PlanningState = {
  revision: number;
  debts: Map<string, PlanningDebt>;
  decisions: Map<string, PlanningDecision>;
  plans: Map<string, PlanningPlan>;
  proposals: Map<string, PlanningProposal>;
  events: PlanningEvent[];
  receipts: Map<string, EngineeringPlanningCommit['request']>;
};

type Entity = PlanningDebt | PlanningDecision | PlanningPlan | PlanningProposal;
type Changes = Pick<EngineeringPlanningCommit, 'debts' | 'decisions' | 'plans' | 'proposals' | 'events'>;
type DebtChange = Extract<PlanningCommand, { debtId: string }>;
type EventDetail = Omit<PlanningEvent, 'id' | 'at' | 'actor' | 'projectId' | 'entity' | 'entityId' | 'type'>;

export const unpaid = (debt: Pick<PlanningDebt, 'status'>) => debt.status !== 'repaid' && debt.status !== 'dropped';
const planningCalendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
export const planningToday = (at = new Date()) => planningCalendar.format(at);
const sourceMatches = (a: PlanningSource, b: PlanningSource) => a.type === b.type && a.ref === b.ref;
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
function missing(): never { return rejectPlanning(404, 'not_found', '此项目没有这条工程规划记录'); }
function closed(message: string): never { return rejectPlanning(409, 'invalid_state', message); }

function atVersion<T extends Entity>(row: T | undefined, version: number): T {
  if (!row) missing();
  if (row.version !== version) rejectPlanning(409, 'version_conflict', '记录已被更新，请重新读取后再提交');
  return row;
}

function criteria(values: string[], current: Criterion[] = []): Criterion[] {
  return values.map(text => current.find(item => item.text === text) ?? { id: id('criterion'), text });
}

export class PlanningMutation {
  readonly changes: Changes = { debts: [], decisions: [], plans: [], proposals: [], events: [] };
  reused = false;
  private readonly actor: PlanningIdentity;

  constructor(private readonly state: PlanningState, private readonly projectId: string, actor: PlanningActor, private readonly at: string) {
    this.actor = { kind: actor.kind, id: actor.id, label: actor.label };
  }

  private base(prefix: string) {
    return { id: id(prefix), projectId: this.projectId, version: 1, createdAt: this.at, updatedAt: this.at };
  }

  private next(row: Entity) {
    return { version: row.version + 1, updatedAt: this.at };
  }

  private event(entity: PlanningEvent['entity'], entityId: string, type: PlanningEvent['type'], detail: EventDetail = {}) {
    this.changes.events.push({ id: id('EV'), projectId: this.projectId, at: this.at, actor: this.actor, entity, entityId, type, ...detail });
  }

  private decision(id: string | undefined) {
    if (!id) return undefined;
    const decision = this.state.decisions.get(id);
    if (!decision) missing();
    if (decision.status === 'superseded' || decision.status === 'deprecated') closed('请选择仍在推进的同项目决策');
    return decision;
  }

  private related(draft: DebtDraft | DecisionDraft | PlanDraft) {
    if ('decisionId' in draft) this.decision(draft.decisionId);
    if ('resolves' in draft && draft.resolves?.some(debtId => !this.state.debts.has(debtId))) missing();
  }

  private debtBySource(source: PlanningSource): PlanningDebt | undefined {
    const found = this.changes.debts.find(row => sourceMatches(row.source, source))
      ?? [...this.state.debts.values()].find(row => sourceMatches(row.source, source));
    let current = found;
    while (current?.outcome?.kind === 'merged' && current.outcome.targetId) {
      current = this.state.debts.get(current.outcome.targetId);
    }
    return current ?? found;
  }

  private newDebt(draft: DebtDraft, source: PlanningSource, options: { proposedBy?: PlanningIdentity; imported?: boolean; discoveredAt?: string } = {}) {
    const found = this.debtBySource(source);
    if (found) {
      this.reused = true;
      return found;
    }
    this.related(draft);
    if (options.discoveredAt && options.discoveredAt > planningToday(new Date(this.at))) {
      rejectPlanning(400, 'invalid', '发现日期不能晚于今天');
    }
    const row: PlanningDebt = {
      ...this.base('DEBT'), ...draft, source, originDecisionId: draft.decisionId, status: 'open',
      priority: draft.priority ?? 'mid', criteria: criteria(draft.criteria ?? []), reopenCount: 0, hitCount: 0,
      ...(options.discoveredAt ? { discoveredAt: options.discoveredAt } : {}),
    };
    this.changes.debts.push(row);
    this.event('debt', row.id, options.imported ? 'imported' : 'created',
      { toStatus: row.status, toDecisionId: row.decisionId, proposedBy: options.proposedBy });
    return row;
  }

  private newDecision(draft: DecisionDraft, source: PlanningSource, proposedBy?: PlanningIdentity) {
    const found = [...this.state.decisions.values()].find(row => sourceMatches(row.source, source));
    if (found) { this.reused = true; return found; }
    this.related(draft);
    const row: PlanningDecision = { ...this.base('ADR'), ...draft, source, status: 'proposed' };
    this.changes.decisions.push(row);
    this.event('decision', row.id, 'proposed', { proposedBy });
    return row;
  }

  private newPlan(draft: PlanDraft, source: PlanningSource, proposedBy?: PlanningIdentity) {
    const found = [...this.state.plans.values()].find(row => sourceMatches(row.source, source));
    if (found) { this.reused = true; return found; }
    this.related(draft);
    const row: PlanningPlan = { ...this.base('PLN'), ...draft, source, steps: [] };
    this.changes.plans.push(row);
    this.event('plan', row.id, 'created', { proposedBy });
    return row;
  }

  private saveDebt(previous: PlanningDebt, patch: Partial<PlanningDebt>, type: PlanningEvent['type'], detail: EventDetail = {}) {
    const row = { ...previous, ...patch, ...this.next(previous) };
    this.changes.debts.push(row);
    this.event('debt', row.id, type, {
      fromStatus: previous.status, toStatus: row.status, fromDecisionId: previous.decisionId, toDecisionId: row.decisionId, ...detail,
    });
    return row;
  }

  private move(previous: PlanningDebt, decisionId: string | undefined, reason: string) {
    return this.saveDebt(previous, { decisionId, originDecisionId: previous.originDecisionId ?? decisionId }, 'branch_moved', { note: reason });
  }

  private submit(command: Extract<PlanningCommand, { type: 'proposal.submit' }>) {
    const found = [...this.state.proposals.values()].find(row => row.kind === command.kind && sourceMatches(row.source, command.source));
    if (found) { this.reused = true; return found; }
    this.related(command.draft);
    const base = { ...this.base('PRO'), source: command.source, author: this.actor, status: 'pending' as const };
    let row: PlanningProposal;
    switch (command.kind) {
      case 'debt': row = { ...base, kind: command.kind, draft: command.draft }; break;
      case 'decision': row = { ...base, kind: command.kind, draft: command.draft }; break;
      case 'plan': row = { ...base, kind: command.kind, draft: command.draft }; break;
    }
    this.changes.proposals.push(row);
    this.event('proposal', row.id, 'proposed');
    return row;
  }

  private handleProposal(command: Extract<PlanningCommand, { type: 'proposal.accept' | 'proposal.reject' }>) {
    const original = this.state.proposals.get(command.proposalId);
    if (!original) missing();
    if (original.status !== 'pending') closed('提案已经处理，请查看处理结果');
    const base = { ...original, ...this.next(original), handledBy: this.actor };
    if (command.type === 'proposal.reject') {
      const row = { ...base, status: 'rejected' as const, reason: command.reason };
      this.changes.proposals.push(row);
      this.event('proposal', row.id, 'rejected', { note: command.reason, proposedBy: original.author });
      return row;
    }
    let record: Entity;
    switch (original.kind) {
      case 'debt': record = this.newDebt(original.draft, original.source, { proposedBy: original.author }); break;
      case 'decision': record = this.newDecision(original.draft, original.source, original.author); break;
      case 'plan': record = this.newPlan(original.draft, original.source, original.author); break;
    }
    this.reused = false;
    const row = { ...base, status: 'accepted' as const, result: { kind: original.kind, id: record.id } };
    this.changes.proposals.push(row);
    this.event('proposal', row.id, 'accepted', { proposedBy: original.author });
    return row;
  }

  private changeDebt(command: DebtChange) {
    const old = atVersion(this.state.debts.get(command.debtId), command.expectedVersion);
    if (command.type === 'debt.reopen') {
      if (unpaid(old) || old.outcome?.kind === 'merged') closed('仅可重开已偿还或已失效的债务，已合并请处理保留记录');
      return this.saveDebt(old, { status: 'open', repayment: undefined, outcome: undefined, reopenCount: old.reopenCount + 1 },
        'reopened', { note: command.reason });
    }
    if (!unpaid(old)) closed('债务已关闭，如问题复发请先重开');
    switch (command.type) {
      case 'debt.update': {
        const { criteria: values, ...patch } = command.patch;
        const updated = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? undefined]));
        const oldDueAt = old.dueAt ?? null;
        return this.saveDebt(old, { ...updated, ...(values ? { criteria: criteria(values, old.criteria) } : {}) }, 'updated',
          patch.dueAt !== undefined && patch.dueAt !== oldDueAt ? { dates: { dueAt: [oldDueAt, patch.dueAt] } } : {});
      }
      case 'debt.branch':
        this.decision(command.decisionId ?? undefined);
        if ((command.decisionId ?? undefined) === old.decisionId) closed('当前承接决策没有变化');
        return this.move(old, command.decisionId ?? undefined, command.reason);
      case 'debt.defer':
        if (command.reviewAt <= planningToday(new Date(this.at))) rejectPlanning(400, 'invalid', '下次回看请选今天之后的日期');
        return this.saveDebt(old, { status: 'deferred', reviewAt: command.reviewAt, deferReason: command.reason }, 'deferred',
          { note: command.reason, dates: { reviewAt: [old.reviewAt ?? null, command.reviewAt] } });
      case 'debt.start':
      case 'debt.progress':
        return this.saveDebt(old, { status: 'in_progress', reviewAt: undefined, deferReason: undefined },
          command.type === 'debt.start' ? 'started' : 'progress', { note: command.note });
      case 'debt.repay': {
        const verified = new Set(command.results.map(row => row.criterionId));
        if (!old.criteria.length || command.results.length !== old.criteria.length || !old.criteria.every(row => verified.has(row.id))) {
          rejectPlanning(400, 'criteria_unmet', '请逐项核对当前偿还标准，并附上验证证据');
        }
        const repayment = { at: this.at, by: this.actor, summary: command.summary, results: command.results, evidence: command.evidence };
        return this.saveDebt(old, { status: 'repaid', repayment, reviewAt: undefined, deferReason: undefined }, 'repaid',
          { note: command.summary, evidence: command.evidence, repayment });
      }
      case 'debt.drop': {
        if (command.targetId) {
          const target = this.state.debts.get(command.targetId);
          if (!target) missing();
          if (target.id === old.id || target.outcome?.kind === 'merged') closed('请选择另一个有效的承接债务');
        }
        const outcome = { kind: command.kind, reason: command.reason, targetId: command.targetId, evidence: command.evidence };
        return this.saveDebt(old, { status: 'dropped', outcome, reviewAt: undefined, deferReason: undefined },
          command.kind === 'extinct' ? 'extinct' : 'dropped', { note: command.reason, evidence: command.evidence });
      }
      case 'debt.merge': {
        const from = atVersion(this.state.debts.get(command.fromId), command.fromVersion);
        if (from.id === old.id || !unpaid(from)) closed('只能合并两笔同项目且尚未关闭的债务');
        const combined = [...new Map([...from.criteria, ...old.criteria].map(row => [row.text, row])).values()];
        const tags = [...new Set([...(old.tags ?? []), ...(from.tags ?? [])])];
        if (combined.length > 32 || tags.length > 20) rejectPlanning(400, 'invalid', '合并后的偿还标准或标签超出上限，请先整理');
        const priorityOrder = ['high', 'mid', 'low'];
        const priority = priorityOrder.indexOf(old.priority) <= priorityOrder.indexOf(from.priority) ? old.priority : from.priority;
        const dueAt = [old.dueAt, from.dueAt].filter(Boolean).sort()[0];
        const keep = this.saveDebt(old, { criteria: combined, tags, hitCount: old.hitCount + from.hitCount, priority, dueAt }, 'merged', { note: command.reason });
        this.saveDebt(from, { status: 'dropped', outcome: { kind: 'merged', reason: command.reason, targetId: old.id }, reviewAt: undefined, deferReason: undefined },
          'merged_into', { note: command.reason });
        return keep;
      }
      case 'debt.hit':
        return this.saveDebt(old, { hitCount: old.hitCount + 1 }, 'hit', { note: command.note });
    }
  }

  private changeDecision(command: Extract<PlanningCommand, { type: 'decision.change' }>) {
    const original = atVersion(this.state.decisions.get(command.decisionId), command.expectedVersion);
    if (original.status === 'superseded' || original.status === 'deprecated') closed('已结束的决策仅保留历史');
    if (command.change === 'accepted' && original.status !== 'proposed') closed('只有提议中的决策可以采纳');
    const row: PlanningDecision = { ...original, ...this.next(original) };
    if (command.change === 'accepted') row.status = 'accepted';
    if (command.change === 'deprecated') row.status = 'deprecated';
    if (command.change === 'reviewed') row.reviewedAt = this.at;
    if (command.change === 'superseded') {
      const successor = this.decision(command.successorId);
      if (!successor || successor.id === row.id || successor.status !== 'accepted') closed('接替决策必须是同项目已采纳的另一条决策');
      row.status = 'superseded';
      row.supersededBy = successor.id;
      if (command.transfer) {
        for (const debt of this.state.debts.values()) {
          if (debt.decisionId === row.id && unpaid(debt) && !successor.resolves?.includes(debt.id)) {
            this.move(debt, successor.id, command.reason);
          }
        }
      }
    }
    this.changes.decisions.push(row);
    this.event('decision', row.id, command.change, { note: command.reason });
    return row;
  }

  private changePlan(command: Extract<PlanningCommand, { planId: string }>) {
    const original = atVersion(this.state.plans.get(command.planId), command.expectedVersion);
    if (command.type === 'plan.add-step') {
      if (original.steps.length >= 100) rejectPlanning(400, 'invalid', '此计划最多可有 100 个步骤');
      if (command.relatedId) {
        if (command.kind === 'debt') {
          const debt = this.state.debts.get(command.relatedId);
          if (!debt) missing();
          if (!unpaid(debt)) closed('请把未还的债务排进计划');
        } else this.decision(command.relatedId);
        if (original.steps.some(step => step.kind === command.kind && step.relatedId === command.relatedId)) {
          closed('这项记录已经排进该计划');
        }
      }
      const row: PlanningPlan = { ...original, ...this.next(original), steps: [...original.steps,
        { id: id('STEP'), title: command.title, kind: command.kind, relatedId: command.relatedId, dueAt: command.dueAt, status: 'todo' }] };
      this.changes.plans.push(row);
      this.event('plan', row.id, 'step_added', { note: command.title });
      return row;
    }
    const step = original.steps.find(item => item.id === command.stepId);
    if (!step) missing();
    if (step.kind === 'debt') closed('偿还步骤随债务结局变化，请在债务详情操作');
    const row = { ...original, ...this.next(original), steps: original.steps.map(item =>
      item.id === step.id ? { ...item, status: command.status } : item) };
    this.changes.plans.push(row);
    this.event('plan', row.id, 'step_changed', { note: command.note });
    return row;
  }

  run(command: PlanningCommand): PlanningCommitResult {
    switch (command.type) {
      case 'proposal.submit': return this.submit(command);
      case 'proposal.accept':
      case 'proposal.reject': return this.handleProposal(command);
      case 'debt.create': {
        const { source, type: _, requestId: _request, ...draft } = command;
        return this.newDebt(draft, source);
      }
      case 'debt.import': {
        const items = command.items.map(({ source, discoveredAt, ...draft }) => {
          this.reused = false;
          const debt = this.newDebt(draft, source, { imported: true, discoveredAt });
          return { id: debt.id, status: this.reused ? 'existing' as const : 'created' as const, sourceRef: source.ref };
        });
        this.reused = items.every(row => row.status === 'existing');
        return { projectId: this.projectId, items };
      }
      case 'debt.update':
      case 'debt.branch':
      case 'debt.defer':
      case 'debt.start':
      case 'debt.progress':
      case 'debt.repay':
      case 'debt.reopen':
      case 'debt.drop':
      case 'debt.merge':
      case 'debt.hit': return this.changeDebt(command);
      case 'decision.create': {
        const { source, type: _, requestId: _request, ...draft } = command;
        return this.newDecision(draft, source);
      }
      case 'decision.change': return this.changeDecision(command);
      case 'plan.create': {
        const { source, type: _, requestId: _request, ...draft } = command;
        return this.newPlan(draft, source);
      }
      case 'plan.add-step':
      case 'plan.step': return this.changePlan(command);
    }
  }
}
