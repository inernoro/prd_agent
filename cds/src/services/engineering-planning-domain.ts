import { randomUUID } from 'node:crypto';
import { fileAnchorPath } from './engineering-planning-file-anchors.js';
import { createCheckupNotices, planningDuplicateKey, type PlanningNoticeRecord } from './engineering-planning-checkup.js';
import type {
  Criterion, DebtDraft, DecisionDraft, PlanDraft, PlanningCommand, PlanningCommitResult,
  PlanningAnchorTarget, PlanningCheckupNotice, PlanningDebtAnchor, PlanningGithubFileRemovalProof, PlanningSweepResult, PlanningVerification,
  PlanningDebt, PlanningDebtDistinction, PlanningDecision, PlanningEvent, PlanningEvidence, PlanningIdentity, PlanningImportPreview,
  PlanningPlan, PlanningProposal, PlanningSource, PlanningStep, PlanningStepDraft, Repayment,
} from '../shared/engineering-planning.js';
import { PlanningError, planningImportRow, rejectPlanning } from './engineering-planning-input.js';
import { duplicateDebtMatcher, explicitlyDistinct, findSimilarDebts, projectProposalSuggestion, proposalTitleKey } from './engineering-planning-proposal-matching.js';
import type { EngineeringPlanningCommandRequest, EngineeringPlanningCommit, PlanningEvidenceAsset } from './engineering-planning-store.js';
import type { PlanningPullRequestSnapshot } from './engineering-planning-pull-requests.js';

export type PlanningState = {
  revision: number;
  debts: Map<string, PlanningDebt>;
  decisions: Map<string, PlanningDecision>;
  plans: Map<string, PlanningPlan>;
  proposals: Map<string, PlanningProposal>;
  events: PlanningEvent[];
  receipts: Map<string, EngineeringPlanningCommandRequest>;
  assets?: Map<string, PlanningEvidenceAsset & { revision: number }>;
  pullRequests: Map<string, PlanningPullRequestSnapshot>;
  notices?: Map<string, PlanningNoticeRecord>;
  duplicateBaselineRevision?: number;
  reportedDuplicatePairs?: Set<string>;
};

type Entity = PlanningDebt | PlanningDecision | PlanningPlan | PlanningProposal;
type Changes = Pick<EngineeringPlanningCommit, 'debts' | 'decisions' | 'plans' | 'proposals' | 'events' | 'assets' | 'notices' | 'reportedDuplicatePairs'>;
type DebtChange = Extract<PlanningCommand, { debtId: string }>;
type DecisionChange = Omit<Extract<PlanningCommand, { type: 'decision.change' }>, 'type' | 'requestId'>;
type EventDetail = Omit<PlanningEvent, 'id' | 'at' | 'actor' | 'projectId' | 'entity' | 'entityId' | 'type'>;
type MissingAnchor = Extract<PlanningDebtAnchor, { status: 'missing' }>;

export const planningSweepActor: PlanningIdentity = { kind: 'system', id: 'cds-planning-sweep', label: 'CDS 巡检' };
const DAY = 86_400_000;
const REMOVAL_GRACE = 7;
const addDays = (at: string, days: number) => new Date(Date.parse(at) + days * DAY).toISOString();
const anchorTarget = (anchor: PlanningAnchorTarget | undefined) => anchor ? { type: anchor.type, ref: anchor.ref } : null;
const gitCommit = /^[a-f0-9]{40}$/;

function hasRecordedRemoval(anchor: MissingAnchor) {
  if (Date.parse(anchor.closeAt) - Date.parse(anchor.missingAt) !== REMOVAL_GRACE * DAY) return false;
  const links = anchor.evidence?.filter(item => item.type === 'change' && item.url) ?? [];
  if (anchor.source?.kind === 'human') return anchor.reportedBy?.kind === 'human' && links.length > 0;
  if (anchor.source?.kind !== 'github-file' || anchor.type !== 'file' || anchor.reportedBy?.kind !== 'system') return false;
  const { proof } = anchor.source;
  return Boolean(proof?.deliveryId && proof.defaultBranch && proof.repository && proof.path && proof.path === fileAnchorPath(anchor.ref)
    && Number.isSafeInteger(proof.pullRequestNumber) && proof.pullRequestNumber > 0
    && [proof.mergeCommitSha, proof.parentCommitSha, proof.observedHeadSha].every(hash => gitCommit.test(hash))
    && links.some(item => item.url === proof.pullRequestUrl));
}

export const unpaid = (debt: Pick<PlanningDebt, 'status'>) => debt.status !== 'repaid' && debt.status !== 'dropped';
export const sharesRepaymentCriteria = (left: PlanningDebt, right: PlanningDebt) =>
  left.criteria.length > 0 && left.criteria.length === right.criteria.length
  && left.criteria.every(criterion => right.criteria.some(other => other.text === criterion.text));
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

  constructor(private readonly state: PlanningState, private readonly projectId: string, actor: PlanningIdentity,
    private readonly at: string, private readonly designIds?: ReadonlySet<string>) {
    this.actor = { kind: actor.kind, id: actor.id, label: actor.label };
  }

  private base(prefix: string) {
    return { id: id(prefix), projectId: this.projectId, version: 1, createdAt: this.at, updatedAt: this.at };
  }

  private next(row: Entity) {
    return { version: row.version + 1, updatedAt: this.at };
  }

  private event(entity: PlanningEvent['entity'], entityId: string, type: PlanningEvent['type'],
    detail: EventDetail = {}, actor = this.actor) {
    this.changes.events.push({ id: id('EV'), projectId: this.projectId, at: this.at, actor, entity, entityId, type, ...detail });
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

  private debtBySource(source: PlanningSource, title?: string): PlanningDebt | undefined {
    const matches = (row: PlanningDebt) => sourceMatches(row.source, source)
      && (title === undefined || proposalTitleKey(row.title) === proposalTitleKey(title));
    const found = this.changes.debts.find(matches) ?? [...this.state.debts.values()].find(matches);
    let current = found;
    while (current?.outcome?.kind === 'merged' && current.outcome.targetId) {
      current = this.state.debts.get(current.outcome.targetId);
    }
    return current ?? found;
  }

  private newDebt(draft: DebtDraft, source: PlanningSource, options: {
    attribution?: EventDetail; forceNew?: boolean; imported?: boolean; discoveredAt?: string; importBatchId?: string;
    checkDuplicates?: boolean; distinction?: PlanningDebtDistinction; explicitlyDifferent?: string; assignToSelf?: boolean;
  } = {}) {
    const found = options.forceNew ? undefined : this.debtBySource(source, options.attribution?.proposal ? draft.title : undefined);
    if (found) {
      this.reused = true;
      return found;
    }
    const acknowledged = options.distinction?.debtIds ?? [];
    if (options.checkDuplicates) {
      const candidates = findSimilarDebts(this.state.debts.values(), draft.title, { includeRepaid: true }).slice(0, 6);
      const valid = new Set(candidates.map(row => row.id));
      const blocked = candidates.some(row => row.similarity >= .9 && !acknowledged.includes(row.id));
      if (blocked || acknowledged.some(id => !valid.has(id))) {
        throw new PlanningError(409, 'possible_duplicate', '请核对疑似重复债务，仍需单独记录时请写明区别', candidates);
      }
    }
    this.related(draft);
    if (options.discoveredAt && options.discoveredAt > planningToday(new Date(this.at))) {
      rejectPlanning(400, 'invalid', '发现日期不能晚于今天');
    }
    const distinctFrom = options.explicitlyDifferent ? [options.explicitlyDifferent] : acknowledged;
    const row: PlanningDebt = {
      ...this.base('DEBT'), ...draft, source, originDecisionId: draft.decisionId, status: 'open',
      priority: draft.priority ?? 'mid', criteria: criteria(draft.criteria ?? []), reopenCount: 0, hitCount: 0,
      ...(options.assignToSelf && this.actor.kind === 'human' ? { owner: this.actor.label, ownerAccountId: this.actor.id } : {}),
      ...(distinctFrom.length ? { notDuplicateWith: distinctFrom } : {}),
      ...(options.discoveredAt ? { discoveredAt: options.discoveredAt } : {}),
      ...(options.importBatchId ? { importBatchId: options.importBatchId } : {}),
    };
    this.changes.debts.push(row);
    this.event('debt', row.id, options.imported ? 'imported' : 'created',
      { toStatus: row.status, toDecisionId: row.decisionId, ...options.attribution,
        ...(options.distinction ? { note: options.distinction.reason } : {}) });
    return row;
  }

  previewImport(inputs: unknown[]): PlanningImportPreview {
    const seen = new Set<string>();
    const items = inputs.map<PlanningImportPreview['items'][number]>((input, index) => {
      try {
        const row = planningImportRow(input);
        const base = { index, title: row.title, sourceRef: row.source.ref };
        const existing = this.debtBySource(row.source);
        if (existing) return { ...base, status: 'existing', debtId: existing.id };
        this.related(row);
        if (row.discoveredAt && row.discoveredAt > planningToday(new Date(this.at))) {
          rejectPlanning(400, 'invalid', '发现日期不能晚于今天');
        }
        if (seen.has(row.source.ref)) return { ...base, status: 'repeated' };
        seen.add(row.source.ref);
        const candidates = findSimilarDebts(this.state.debts.values(), row.title, { includeRepaid: true }).slice(0, 3);
        return candidates.length ? { ...base, status: 'similar', candidates } : { ...base, status: 'ready' };
      } catch (error) {
        if (error instanceof PlanningError) return { index, status: 'invalid', message: error.message };
        throw error;
      }
    });
    return { projectId: this.projectId, items };
  }

  private newDecision(draft: DecisionDraft, source: PlanningSource, attribution?: EventDetail) {
    const found = [...this.state.decisions.values()].find(row => sourceMatches(row.source, source)
      && (!attribution?.proposal || proposalTitleKey(row.title) === proposalTitleKey(draft.title)));
    if (found) { this.reused = true; return found; }
    this.related(draft);
    const row: PlanningDecision = { ...this.base('ADR'), ...draft, source, status: 'proposed' };
    this.changes.decisions.push(row);
    this.event('decision', row.id, 'proposed', attribution);
    return row;
  }

  private newPlan(draft: PlanDraft, source: PlanningSource, attribution?: EventDetail, initialSteps: PlanningStepDraft[] = []) {
    const found = [...this.state.plans.values()].find(row => sourceMatches(row.source, source)
      && (!attribution?.proposal || proposalTitleKey(row.title) === proposalTitleKey(draft.title)));
    if (found) { this.reused = true; return found; }
    this.related(draft);
    const row: PlanningPlan = { ...this.base('PLN'), ...draft, source, steps: [] };
    this.event('plan', row.id, 'created', attribution);
    for (const step of initialSteps) row.steps.push(this.addPlanStep(row, step));
    this.changes.plans.push(row);
    return row;
  }

  private saveDebt(previous: PlanningDebt, patch: Partial<PlanningDebt>, type: PlanningEvent['type'],
    detail: EventDetail = {}, actor = this.actor) {
    const row = { ...previous, ...patch, ...this.next(previous) };
    this.changes.debts.push(row);
    this.event('debt', row.id, type, {
      fromStatus: previous.status, toStatus: row.status, fromDecisionId: previous.decisionId, toDecisionId: row.decisionId, ...detail,
    }, actor);
    return row;
  }

  private move(previous: PlanningDebt, decisionId: string | undefined, reason: string) {
    return this.saveDebt(previous, { decisionId, originDecisionId: previous.originDecisionId ?? decisionId }, 'branch_moved', { note: reason });
  }

  private recordHit(previous: PlanningDebt, detail: EventDetail) {
    return this.saveDebt(previous, { hitCount: previous.hitCount + 1 }, 'hit', detail);
  }

  private withProposalSuggestion(proposal: PlanningProposal): PlanningProposal {
    return proposal.kind === 'debt' && proposal.status === 'pending'
      ? projectProposalSuggestion(proposal, duplicateDebtMatcher(this.state.debts.values()))
      : proposal;
  }

  private submit(command: Extract<PlanningCommand, { type: 'proposal.submit' }>) {
    const title = proposalTitleKey(command.draft.title);
    const found = [...this.state.proposals.values()].find(row => row.kind === command.kind && row.source.ref === command.source.ref
      && proposalTitleKey(row.draft.title) === title);
    if (found) { this.reused = true; return this.withProposalSuggestion(found); }
    this.related(command.draft);
    if (command.kind === 'decision' && command.decisionChange) this.decisionForChange(command.decisionChange);
    const { type: _, requestId: _request, ...payload } = command;
    const row = this.withProposalSuggestion({ ...this.base('PRO'), ...payload, author: this.actor, status: 'pending' });
    this.changes.proposals.push(row);
    this.event('proposal', row.id, 'proposed');
    return row;
  }

  private handleProposal(command: Extract<PlanningCommand, { type: 'proposal.accept' | 'proposal.reject' }>) {
    const original = this.state.proposals.get(command.proposalId);
    if (!original) missing();
    if (original.status !== 'pending') closed('提案已经处理，请查看处理结果');
    const pending = this.withProposalSuggestion(original);
    const base = { ...pending, ...this.next(original), handledBy: this.actor };
    const attribution = { proposedBy: original.author,
      proposal: { id: original.id, source: original.source, ...(original.skill === undefined ? {} : { skill: original.skill }) } };
    if (command.type === 'proposal.reject') {
      const row = { ...base, status: 'rejected' as const, reason: command.reason };
      this.changes.proposals.push(row);
      this.event('proposal', row.id, 'rejected', { ...attribution, note: command.reason });
      return row;
    }
    const proposer = original.skill ? `技能 ${original.skill}（${original.author.label}）` : original.author.label;
    const detail = { ...attribution, note: `${proposer}从 ${original.source.ref} 提出，${this.actor.label}确认` };
    let record: Entity;
    const hit = command.as === 'hit';
    if (hit) {
      const target = pending.suggest && this.state.debts.get(pending.suggest.dupOf);
      if (!target || (command.debtId !== undefined && command.debtId !== target.id)) {
        closed('疑似重复债务已变化，请刷新提案后再确认');
      }
      record = this.recordHit(target, detail);
    } else {
      switch (original.kind) {
        case 'debt': record = this.newDebt(original.draft, original.source, { attribution: detail, forceNew: command.as === 'new',
          explicitlyDifferent: command.as === 'new' ? pending.suggest?.dupOf : undefined }); break;
        case 'decision':
          record = original.decisionChange
            ? this.changeDecision({ ...original.decisionChange, reason: detail.note }, { revision: original.draft, attribution })
            : this.newDecision(original.draft, original.source, detail);
          break;
        case 'plan': record = this.newPlan(original.draft, original.source, detail); break;
      }
    }
    this.reused = false;
    const row = { ...base, status: 'accepted' as const,
      result: { kind: original.kind, id: record.id, ...(hit ? { mode: 'hit' as const } : {}) } };
    this.changes.proposals.push(row);
    this.event('proposal', row.id, 'accepted', attribution);
    return row;
  }

  recordGithubFileRemoval(debt: PlanningDebt, proof: PlanningGithubFileRemovalProof): void {
    if (!unpaid(debt) || debt.anchor?.type !== 'file' || debt.anchor.status !== 'alive') return;
    const note = `${proof.defaultBranch} 的合并变更删除了绑定文件 ${proof.path}。`;
    const evidence: PlanningEvidence[] = [{ type: 'change', label: `PR #${proof.pullRequestNumber} 删除 ${proof.path}`, url: proof.pullRequestUrl }];
    const anchor: MissingAnchor = { ...debt.anchor, status: 'missing', note, evidence, missingAt: this.at, closeAt: addDays(this.at, REMOVAL_GRACE),
      reportedBy: planningSweepActor, source: { kind: 'github-file', proof } };
    this.saveDebt(debt, { anchor, verify: undefined }, 'extinct_pending',
      { note, evidence, via: 'system', anchorChange: { before: anchorTarget(debt.anchor), after: anchorTarget(anchor) } }, planningSweepActor);
    this.notifyRemoval(debt, anchor, 'extinct_pending');
  }

  private addNotices(notice: Pick<PlanningCheckupNotice, 'kind' | 'title' | 'detail' | 'debtIds'>, recipients: Array<string | undefined>) {
    const entries = createCheckupNotices({ ...notice, at: this.at }, recipients);
    if (entries.length) (this.changes.notices ??= []).push(...entries);
  }

  private notifyRemoval(debt: PlanningDebt, anchor: MissingAnchor, kind: 'extinct_pending' | 'extinct') {
    const title = kind === 'extinct_pending' ? '疑似随功能消失' : '债务已随功能消失';
    this.addNotices({ kind, title, detail: debt.title, debtIds: [debt.id] },
      [debt.ownerAccountId, anchor.reportedBy?.kind === 'human' ? anchor.reportedBy.id : undefined]);
  }

  recordDuplicatePair(left: PlanningDebt, right: PlanningDebt) {
    const kind = 'dup_flagged';
    const detail = { note: '巡检发现标题相近的待偿还债务', via: 'system' as const };
    this.event('debt', left.id, kind, { ...detail, relatedDebtId: right.id, toDecisionId: left.decisionId }, planningSweepActor);
    this.event('debt', right.id, kind, { ...detail, relatedDebtId: left.id, toDecisionId: right.decisionId }, planningSweepActor);
    (this.changes.reportedDuplicatePairs ??= []).push(planningDuplicateKey(left.id, right.id));
    this.addNotices({ kind: 'dup', title: '巡检发现疑似重复债务', detail: `${left.title} · ${right.title}`, debtIds: [left.id, right.id] },
      [left.ownerAccountId, right.ownerAccountId]);
  }

  private settleRemoval(debt: PlanningDebt, missingAnchor: MissingAnchor, reason: string, automatic = false) {
    const closedAt = automatic ? missingAnchor.closeAt : this.at;
    const anchor = { ...missingAnchor, status: 'gone' as const, closedAt };
    const evidence = missingAnchor.evidence;
    const triggeredBy = automatic && this.actor.kind === 'human' ? this.actor : undefined;
    this.notifyRemoval(debt, missingAnchor, 'extinct');
    // Preserve journal order for branch transfers while recording the grace deadline as the effective close time.
    return this.saveDebt(debt, { status: 'dropped', anchor, reviewAt: undefined, deferReason: undefined,
      outcome: { kind: 'extinct', reason, evidence, closedAt } }, 'extinct',
      { note: reason, evidence, effectiveAt: closedAt, ...(automatic ? { via: 'system' } : {}),
        ...(triggeredBy ? { triggeredBy } : {}) },
      automatic ? planningSweepActor : this.actor);
  }

  sweepRecordedRemovals({ branch, through = this.at }: { branch?: string; through?: string } = {}): PlanningSweepResult {
    if (branch && branch !== 'none' && !this.state.decisions.has(branch)) missing();
    const result: PlanningSweepResult = { projectId: this.projectId, at: this.at, pending: [], closed: [] };
    for (const debt of this.state.debts.values()) {
      if (branch && (debt.decisionId ?? 'none') !== branch) continue;
      const anchor = debt.anchor;
      if (!unpaid(debt) || anchor?.status !== 'missing' || !hasRecordedRemoval(anchor)) continue;
      if (anchor.closeAt > through) {
        result.pending.push(debt.id);
        continue;
      }
      const reason = '已登记的功能消失满 7 天，巡检按变更证据结案。';
      this.settleRemoval(debt, anchor, reason, true);
      result.closed.push(debt.id);
    }
    return result;
  }

  private changeDebt(command: DebtChange) {
    const old = atVersion(this.state.debts.get(command.debtId), command.expectedVersion);
    if (command.type === 'debt.reopen') {
      if (unpaid(old) || old.outcome?.kind === 'merged') closed('仅可重开已偿还或已失效的债务，已合并请处理保留记录');
      return this.saveDebt(old, { status: 'open', repayment: undefined, outcome: undefined, verify: undefined, anchor: undefined,
        reopenCount: old.reopenCount + 1 }, 'reopened',
      { note: command.reason, evidence: command.evidence, ...(old.anchor ? { anchorChange: { before: anchorTarget(old.anchor), after: null } } : {}) });
    }
    if (!unpaid(old)) closed('债务已关闭，如问题复发请先重开');
    switch (command.type) {
      case 'debt.update': {
        const { criteria: values, ...patch } = command.patch;
        const updated = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? undefined]));
        if (patch.owner !== undefined && patch.owner !== old.owner) updated.ownerAccountId = undefined;
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
      case 'debt.review': {
        const today = planningToday(new Date(this.at));
        if (old.status !== 'deferred' || !old.reviewAt || old.reviewAt > today) closed('这笔债务尚未到回看日期');
        const reviewAt = command.next === 'defer' ? command.reviewAt : undefined;
        if (command.next === 'defer' && (!reviewAt || reviewAt <= today)) rejectPlanning(400, 'invalid', '下次回看请选今天之后的日期');
        const status = { start: 'in_progress', defer: 'deferred', drop: 'dropped' } as const;
        return this.saveDebt(old, { status: status[command.next], reviewAt, deferReason: reviewAt ? command.reason : undefined,
          ...(command.next === 'drop' ? { outcome: { kind: 'cancelled', reason: command.reason, closedAt: this.at } } : {}),
        }, command.next === 'drop' ? 'dropped' : 'reviewed', { note: command.reason, dates: { reviewAt: [old.reviewAt, reviewAt ?? null] } });
      }
      case 'debt.start':
      case 'debt.progress':
        return this.saveDebt(old, { status: 'in_progress', reviewAt: undefined, deferReason: undefined },
          command.type === 'debt.start' ? 'started' : 'progress', { note: command.note, evidence: command.evidence });
      case 'debt.verify': {
        if (old.anchor?.status === 'missing') closed('请先处理已登记的功能消失，再认证债务是否仍在');
        const { method, note, validDays, evidence } = command;
        const verify: PlanningVerification = { method, note, validDays, evidence,
          at: this.at, by: this.actor, expiresAt: addDays(this.at, validDays) };
        return this.saveDebt(old, { verify }, 'verified', { note, evidence, verification: verify });
      }
      case 'debt.anchor': {
        const before = anchorTarget(old.anchor);
        const after = command.anchor;
        if (old.anchor?.status !== 'missing' && before?.type === after?.type && before?.ref === after?.ref) {
          closed('绑定对象没有变化');
        }
        const anchor = after ? { ...after, status: 'alive' as const, by: this.actor, boundAt: this.at } : undefined;
        return this.saveDebt(old, { anchor }, old.anchor?.status === 'missing' || !after ? 'anchor_kept' : 'anchor_bound',
          { note: command.reason, anchorChange: { before, after } });
      }
      case 'debt.anchor-missing': {
        if (old.anchor?.status !== 'alive') closed('请先绑定有效的功能位置');
        const anchor: MissingAnchor = { ...old.anchor, status: 'missing', note: command.note, evidence: command.evidence,
          missingAt: this.at, closeAt: addDays(this.at, REMOVAL_GRACE), reportedBy: this.actor, source: { kind: 'human' } };
        this.notifyRemoval(old, anchor, 'extinct_pending');
        return this.saveDebt(old, { anchor, verify: undefined }, 'extinct_pending',
          { note: command.note, evidence: command.evidence, anchorChange: { before: anchorTarget(old.anchor), after: anchorTarget(anchor) } });
      }
      case 'debt.anchor-confirm':
        if (old.anchor?.status !== 'missing') closed('此债务没有待确认的功能消失记录');
        return this.settleRemoval(old, old.anchor, command.note ?? old.anchor.note);
      case 'debt.repay': {
        const verified = new Set(command.results.map(row => row.criterionId));
        if (!old.criteria.length || command.results.length !== old.criteria.length || !old.criteria.every(row => verified.has(row.id))) {
          rejectPlanning(400, 'criteria_unmet', '请逐项核对当前偿还标准，并附上验证证据');
        }
        if (!command.repaymentProofs?.length) {
          rejectPlanning(400, 'evidence_required', '请上传一张标注完毕的还后截图');
        }
        const seen = new Set([old.id]);
        const collateral = (command.collateral ?? []).map(item => {
          const related = atVersion(this.state.debts.get(item.debtId), item.expectedVersion);
          if (seen.has(related.id) || !unpaid(related) || !sharesRepaymentCriteria(old, related)) {
            rejectPlanning(400, 'criteria_unmet', '连带偿还仅适用于同项目、尚未结清且核对标准完全相同的债务');
          }
          seen.add(related.id);
          return related;
        });
        const proofEvidence = command.repaymentProofs.map((proof): PlanningEvidence => {
          const assetId = id('proof');
          const comma = proof.dataUrl.indexOf(',');
          (this.changes.assets ??= []).push({
            id: assetId, mime: proof.dataUrl.slice(5, proof.dataUrl.indexOf(';')), base64: proof.dataUrl.slice(comma + 1),
          });
          return { type: 'screenshot', label: proof.label, image: { id: assetId, stage: proof.stage, mark: proof.mark } };
        });
        const evidence = [...command.evidence, ...proofEvidence];
        const repayment: Repayment = { at: this.at, by: this.actor, summary: command.summary, results: command.results, criteria: old.criteria, evidence };
        for (const related of collateral) {
          const results = command.results.map(result => {
            const text = old.criteria.find(criterion => criterion.id === result.criterionId)!.text;
            return { ...result, criterionId: related.criteria.find(criterion => criterion.text === text)!.id };
          });
          const shared: Repayment = { ...repayment, results, criteria: related.criteria, mode: 'collateral', collateralOf: old.id };
          this.saveDebt(related, { status: 'repaid', repayment: shared, reviewAt: undefined, deferReason: undefined }, 'repaid',
            { note: command.summary, evidence, repayment: shared });
        }
        return this.saveDebt(old, { status: 'repaid', repayment, reviewAt: undefined, deferReason: undefined }, 'repaid',
          { note: command.summary, evidence, repayment });
      }
      case 'debt.drop': {
        if (command.kind === 'extinct') {
          if (old.anchor?.status !== 'missing') closed('请先登记功能位置已消失，再确认关闭');
          return this.settleRemoval(old, old.anchor, command.reason);
        }
        if (command.targetId) {
          const target = this.state.debts.get(command.targetId);
          if (!target) missing();
          if (target.id === old.id || target.outcome?.kind === 'merged') closed('请选择另一个有效的承接债务');
        }
        const outcome = { kind: command.kind, reason: command.reason, targetId: command.targetId, evidence: command.evidence };
        return this.saveDebt(old, { status: 'dropped', outcome, reviewAt: undefined, deferReason: undefined },
          'dropped', { note: command.reason, evidence: command.evidence });
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
        const chosen = command.takeFrom ?? [];
        const certainty = { confirmed: 2, suspected: 1, pending: 0 };
        const rootCause = from.rootCause && (!old.rootCause || certainty[from.rootCause.state] > certainty[old.rootCause.state]) ? from.rootCause : old.rootCause;
        const verify = from.verify && (!old.verify || from.verify.at > old.verify.at) ? from.verify : old.verify;
        const keep = this.saveDebt(old, { criteria: combined, tags, hitCount: old.hitCount + from.hitCount, priority, dueAt, rootCause, verify,
          ...(chosen.includes('title') ? { title: from.title } : {}),
          ...(chosen.includes('summary') ? { summary: from.summary } : {}),
          ...(chosen.includes('owner') ? { owner: from.owner, ownerAccountId: from.ownerAccountId } : {}),
        }, 'merged', { note: command.reason, relatedDebtId: from.id });
        this.saveDebt(from, { status: 'dropped', outcome: { kind: 'merged', reason: command.reason, targetId: old.id }, reviewAt: undefined, deferReason: undefined },
          'merged_into', { note: command.reason, relatedDebtId: old.id });
        return keep;
      }
      case 'debt.not-duplicate': {
        const from = atVersion(this.state.debts.get(command.fromId), command.fromVersion);
        if (from.id === old.id || !unpaid(from) || explicitlyDistinct(old, from)) closed('请选择尚未标记的其他待还债务');
        this.saveDebt(from, { notDuplicateWith: [...(from.notDuplicateWith ?? []), old.id] }, 'not_duplicate', { note: command.reason, relatedDebtId: old.id });
        return this.saveDebt(old, { notDuplicateWith: [...(old.notDuplicateWith ?? []), from.id] }, 'not_duplicate', { note: command.reason, relatedDebtId: from.id });
      }
      case 'debt.hit':
        return this.recordHit(old, { note: command.note });
    }
  }

  private decisionForChange(command: Pick<DecisionChange, 'decisionId' | 'expectedVersion' | 'change'>) {
    const original = atVersion(this.state.decisions.get(command.decisionId), command.expectedVersion);
    if (original.status === 'superseded' || original.status === 'deprecated') closed('已结束的决策仅保留历史');
    if (command.change === 'accepted' && original.status !== 'proposed') closed('只有提议中的决策可以采纳');
    return original;
  }

  private changeDecision(command: DecisionChange, proposal?: { revision: DecisionDraft; attribution: EventDetail }) {
    const original = this.decisionForChange(command);
    const row: PlanningDecision = { ...original, ...this.next(original) };
    if (command.change === 'amended') {
      if (proposal) {
        const { links, ...fields } = proposal.revision;
        this.related(proposal.revision);
        Object.assign(row, fields);
        if (fields.options && row.chosenOption && !fields.options.some(option => option.title === row.chosenOption)) delete row.chosenOption;
        if (links?.length) {
          row.links = [...links, ...(original.links ?? [])].filter((link, index, all) =>
            all.findIndex(item => item.type === link.type && item.url === link.url) === index);
          if (row.links.length > 16) rejectPlanning(400, 'invalid', '决策链接超出上限，请整理已有链接后重新提议');
        }
      }
      if (command.links !== undefined) row.links = command.links;
      if (command.pullRequest === null) delete row.pullRequest;
      else if (command.pullRequest !== undefined) row.pullRequest = command.pullRequest;
      if (command.structure) {
        const { decisionKind, options, chosenOption, consequences, aliases, appliesTo, provenance } = command.structure;
        Object.assign(row, { decisionKind, options, chosenOption, consequences,
          ...(aliases === undefined ? {} : { aliases }),
          ...(appliesTo === undefined ? {} : { appliesTo }),
          ...(provenance === undefined ? {} : { provenance }),
        });
      }
    }
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
    this.event('decision', row.id, command.change, { note: command.reason, ...proposal?.attribution });
    return row;
  }

  private addPlanStep(plan: PlanningPlan, draft: PlanningStepDraft): PlanningStep {
    if (plan.steps.length >= 100) rejectPlanning(400, 'invalid', '此计划最多可有 100 个步骤');
    const { kind, title, relatedId, dueAt, owner } = draft;
    if (relatedId) {
      if (plan.steps.some(step => step.kind === kind && step.relatedId === relatedId)) closed('这项记录已经排进该计划');
      if (kind === 'debt') {
        const debt = this.state.debts.get(relatedId);
        if (!debt) missing();
        if (!unpaid(debt)) closed('请把未还的债务排进计划');
        const earlier = dueAt && (!debt.dueAt || dueAt < debt.dueAt) ? dueAt : undefined;
        const detail = { note: `排入落地计划「${plan.title}」`, relatedPlanId: plan.id };
        if (earlier) this.saveDebt(debt, { dueAt: earlier }, 'planned', { ...detail, dates: { dueAt: [debt.dueAt ?? null, earlier] } });
        else this.event('debt', debt.id, 'planned', detail);
      } else if (kind === 'design') {
        if (!this.designIds?.has(relatedId)) missing();
      } else this.decision(relatedId);
    }
    const step: PlanningStep = { id: id('STEP'), kind, title, relatedId, dueAt, owner, status: 'todo' };
    this.event('plan', plan.id, 'step_added', { note: title, stepChange: { stepId: step.id, to: step.status } });
    return step;
  }

  private changePlan(command: Extract<PlanningCommand, { planId: string }>) {
    const original = atVersion(this.state.plans.get(command.planId), command.expectedVersion);
    if (command.type === 'plan.add-step') {
      const row: PlanningPlan = { ...original, ...this.next(original), steps: [...original.steps, this.addPlanStep(original, command)] };
      this.changes.plans.push(row);
      return row;
    }
    const step = original.steps.find(item => item.id === command.stepId);
    if (!step) missing();
    if (step.kind === 'debt') closed('偿还步骤随债务结局变化，请在债务详情操作');
    if (step.kind === 'design') closed('稿件验收签收后，步骤会自动完成');
    const row = { ...original, ...this.next(original), steps: original.steps.map(item =>
      item.id === step.id ? { ...item, status: command.status } : item) };
    this.changes.plans.push(row);
    this.event('plan', row.id, 'step_changed', { note: command.note, stepChange: { stepId: step.id, from: step.status, to: command.status } });
    return row;
  }

  run(command: PlanningCommand): PlanningCommitResult {
    switch (command.type) {
      case 'proposal.submit': return this.submit(command);
      case 'proposal.accept':
      case 'proposal.reject': return this.handleProposal(command);
      case 'debt.create': {
        const { source, distinction, assignToSelf, type: _, requestId: _request, ...draft } = command;
        return this.newDebt(draft, source, { checkDuplicates: true, distinction, assignToSelf });
      }
      case 'debt.import': {
        const batchId = id('BATCH');
        const items = command.items.map(({ source, discoveredAt, ...draft }) => {
          this.reused = false;
          const debt = this.newDebt(draft, source, { imported: true, discoveredAt, importBatchId: batchId });
          return { id: debt.id, status: this.reused ? 'existing' as const : 'created' as const, sourceRef: source.ref };
        });
        this.reused = items.every(row => row.status === 'existing');
        return { projectId: this.projectId, items, ...(this.reused ? {} : { batchId }) };
      }
      case 'debt.update':
      case 'debt.branch':
      case 'debt.defer':
      case 'debt.review':
      case 'debt.start':
      case 'debt.progress':
      case 'debt.repay':
      case 'debt.reopen':
      case 'debt.drop':
      case 'debt.merge':
      case 'debt.not-duplicate':
      case 'debt.hit':
      case 'debt.verify':
      case 'debt.anchor':
      case 'debt.anchor-missing':
      case 'debt.anchor-confirm': return this.changeDebt(command);
      case 'debt.sweep': return this.sweepRecordedRemovals({ branch: command.branch });
      case 'decision.create': {
        const { source, type: _, requestId: _request, ...draft } = command;
        return this.newDecision(draft, source);
      }
      case 'decision.change': return this.changeDecision(command);
      case 'plan.create': {
        const { source, initialSteps, type: _, requestId: _request, ...draft } = command;
        return this.newPlan(draft, source, undefined, initialSteps);
      }
      case 'plan.add-step':
      case 'plan.step': return this.changePlan(command);
    }
  }
}
