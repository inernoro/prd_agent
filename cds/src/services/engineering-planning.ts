import { createHash } from 'node:crypto';
import {
  decisionSubjectKinds, debtPriorities, planningClosureDays, planningDebtSorts, planningDebtViews, planningPermissions, planningSourceTypes, planningVerificationState,
  type PlanningActor, type PlanningBoard, type PlanningCapabilities, type PlanningDebtView,
  type PlanningCheckup, type PlanningCheckupRead, type PlanningCheckupReadResult,
  type PlanningCounts, type PlanningDebt, type PlanningDebtDetail, type PlanningDebtList, type PlanningDecisionSearch,
  type PlanningDesignLink, type PlanningPlan, type PlanningReceipt, type PlanningStats,
} from '../shared/engineering-planning.js';
import { PlanningMutation, planningSweepActor, planningToday, sharesRepaymentCriteria, unpaid, type GithubRemovalCheck, type PlanningState } from './engineering-planning-domain.js';
import { buildPlanningAnalytics, eventDelta, matchesBranch } from './engineering-planning-analytics.js';
import { checkupDuplicatePairs, duplicatePresentAtBaseline, planningDuplicateKey } from './engineering-planning-checkup.js';
import { buildDebtBrief } from './engineering-planning-brief.js';
import { debtListSummary, duplicateDebtIds, matchesDebtView, projectDebtNavigation } from './engineering-planning-debt-views.js';
import { parsePlanningCommand, planningDay, planningId, planningImportInputs, planningText, rejectPlanning } from './engineering-planning-input.js';
import { findSimilarDebts, duplicateDebtMatcher, projectProposalSuggestion } from './engineering-planning-proposal-matching.js';
import type { EngineeringPlanningCommit, EngineeringPlanningStore } from './engineering-planning-store.js';
import { applyPullRequestObservation, planningPullRequestKey, projectPlanningPullRequests, type PlanningGitHubObservation,
  type PlanningPreviewResolver } from './engineering-planning-pull-requests.js';
import { fileAnchorPath, type PlanningFileAnchorProbe } from './engineering-planning-file-anchors.js';
export { FileEngineeringPlanningStore, MongoEngineeringPlanningStore } from './engineering-planning-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DAY = 86_400_000;

function empty(): PlanningState {
  return { revision: 0, debts: new Map(), decisions: new Map(), plans: new Map(), proposals: new Map(), events: [], receipts: new Map(), pullRequests: new Map() };
}

function apply(base: PlanningState, commits: EngineeringPlanningCommit[], projectId: string, retainEvidenceBytes: boolean): PlanningState {
  if (commits.length === 0) return base;
  const state = {
    revision: base.revision, debts: new Map(base.debts), decisions: new Map(base.decisions),
    plans: new Map(base.plans), proposals: new Map(base.proposals), events: [...base.events], receipts: new Map(base.receipts),
    assets: new Map(base.assets), pullRequests: new Map(base.pullRequests),
    notices: new Map(base.notices), duplicateBaselineRevision: base.duplicateBaselineRevision,
    reportedDuplicatePairs: new Set(base.reportedDuplicatePairs),
  };
  for (const commit of commits) {
    if (commit.projectId !== projectId || commit.revision !== state.revision + 1) throw new Error('Planning history is incomplete');
    for (const row of commit.debts) state.debts.set(row.id, row);
    for (const row of commit.decisions) state.decisions.set(row.id, row);
    for (const row of commit.plans) state.plans.set(row.id, row);
    for (const row of commit.proposals) state.proposals.set(row.id, row);
    for (const { id, mime, base64 } of commit.assets ?? []) state.assets.set(id, {
      id, mime, revision: commit.revision, ...(retainEvidenceBytes ? { base64 } : {}),
    });
    for (const pullRequest of commit.pullRequests ?? []) state.pullRequests.set(planningPullRequestKey(pullRequest.repository, pullRequest.number), pullRequest);
    for (const notice of commit.notices ?? []) state.notices.set(notice.id, notice);
    if (commit.duplicateBaselineRevision !== undefined) state.duplicateBaselineRevision = commit.duplicateBaselineRevision;
    for (const pair of commit.reportedDuplicatePairs ?? []) state.reportedDuplicatePairs.add(pair);
    state.events.push(...commit.events);
    if (commit.request && 'receipt' in commit.request) state.receipts.set(commit.request.key, commit.request);
    state.revision = commit.revision;
  }
  return state;
}

type DebtQuery = {
  q?: unknown; cursor?: unknown; branch?: unknown; tag?: unknown; view?: unknown; limit?: unknown;
  priority?: unknown; owner?: unknown; source?: unknown; module?: unknown; batch?: unknown; sort?: unknown; tagMatch?: unknown;
};
type StatsQuery = { from?: unknown; to?: unknown; branch?: unknown; analytics?: unknown };
type DecisionQuery = { q?: unknown; subjectKind?: unknown; subjectRef?: unknown };
const decisionText = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' ');
type Cursor = { revision: number; offset: number; filter: string };

function pageCursor(value: unknown, fingerprint: string, revision: number): Cursor {
  if (value === undefined) return { revision, offset: 0, filter: fingerprint };
  const encoded = planningText(value, 'cursor', 300);
  let record: Partial<Cursor> | undefined;
  try { record = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { /* invalid cursor */ }
  if (!record || record.filter !== fingerprint || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)
    || record.revision < 0 || record.revision > revision || typeof record.offset !== 'number' || !Number.isSafeInteger(record.offset) || record.offset < 0) {
    rejectPlanning(400, 'invalid_cursor', '分页条件已变化，请从第一页重新查询');
  }
  return record as Cursor;
}

const order = <T extends { updatedAt: string; id: string }>(a: T, b: T) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
function planProjection(plan: PlanningPlan, debts: PlanningState['debts'], designs: Map<string, PlanningDesignLink>,
  hasCurrentSignature: (signature: NonNullable<PlanningDesignLink['signed']>) => boolean): PlanningPlan {
  return { ...plan, steps: plan.steps.map(step => {
    if (step.kind === 'design' && step.relatedId) {
      const design = designs.get(step.relatedId);
      if (!design?.frozen) return step;
      return { ...step, status: design.signed && hasCurrentSignature(design.signed) ? 'done' : 'doing' };
    }
    const debt = step.kind === 'debt' && step.relatedId ? debts.get(step.relatedId) : undefined;
    if (!debt) return step;
    const status = { open: 'todo', deferred: 'todo', in_progress: 'doing', repaid: 'done', dropped: 'cancelled' } as const;
    return { ...step, status: status[debt.status] };
  }) };
}

const counts = (): PlanningCounts => ({
  created: 0, imported: 0, repaid: 0, reopened: 0, dropped: 0, extinct: 0, merged: 0, transferredIn: 0, transferredOut: 0,
});
const dayStamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export class EngineeringPlanningService {
  private readonly latest = new Map<string, PlanningState>();

  constructor(private readonly store: EngineeringPlanningStore, private readonly now = () => new Date(), private readonly github?: {
    repositoryFor: (projectId: string) => string | undefined; previewFor?: PlanningPreviewResolver;
    defaultBranchFor?: (projectId: string) => string | null | undefined; fileAnchorProbe?: PlanningFileAnchorProbe;
  }, private readonly designLinksFor?: (projectId: string) => Promise<PlanningDesignLink[]>) {}

  private async load(projectId: string, revision?: number): Promise<PlanningState> {
    const base = this.latest.get(projectId) ?? empty();
    if (base.revision === revision) return base;
    if (revision !== undefined) {
      const commits = await this.store.read(projectId, 0);
      return apply(empty(), commits.filter(commit => commit.revision <= revision), projectId, !this.store.readAsset);
    }
    const commits = await this.store.read(projectId, base.revision);
    const state = apply(base, commits, projectId, !this.store.readAsset);
    const cached = this.latest.get(projectId);
    if (cached && cached.revision > state.revision) return cached;
    this.latest.set(projectId, state);
    return state;
  }

  capabilities(projectId: string, actor: PlanningActor): PlanningCapabilities {
    return { projectId, protocolVersion: 1,
      permissions: planningPermissions.filter(permission => actor.permissions.includes(permission) && (permission !== 'approve' || actor.kind === 'human')) };
  }

  private async publish(state: PlanningState, commit: EngineeringPlanningCommit): Promise<boolean> {
    // Earlier releases expect a request key on every revision. Internal keys never collide with
    // client request hashes and carry no user receipt.
    const stored: EngineeringPlanningCommit = commit.request ? commit : { ...commit, request: { key: `internal:${commit.revision}`, internal: true } };
    if (!await this.store.append(stored)) return false;
    if ((this.latest.get(commit.projectId)?.revision ?? 0) <= state.revision) {
      this.latest.set(commit.projectId, apply(state, [commit], commit.projectId, !this.store.readAsset));
    }
    return true;
  }

  async sweepRecordedRemovals(projectId: string, through: Date): Promise<void> {
    if (through.getTime() > this.now().getTime()) return;
    for (let attempts = 0; attempts < 10; attempts++) {
      const state = await this.load(projectId);
      const at = this.now();
      if (through.getTime() > at.getTime()) return;
      const githubFiles = await this.recheckGithubRemovals(projectId, state);
      const mutation = new PlanningMutation(state, projectId, planningSweepActor, at.toISOString());
      mutation.sweepRecordedRemovals({ through: through.toISOString(), githubFiles });
      if (!mutation.changes.debts.length || await this.publish(state, { projectId, revision: state.revision + 1, ...mutation.changes })) return;
    }
    throw new Error('Planning sweep could not acquire a project revision');
  }

  /** Only the verified repository webhook invokes this method. */
  async recordGithubObservation(projectId: string, observation: PlanningGitHubObservation): Promise<void> {
    const repository = observation.type === 'pull_request' ? observation.pullRequest.repository : observation.repository;
    if (this.github?.repositoryFor(projectId)?.toLowerCase() !== repository.toLowerCase()) return;
    for (let attempts = 0; attempts < 10; attempts++) {
      const state = await this.load(projectId);
      const pullRequests = applyPullRequestObservation(state.pullRequests, observation);
      if (!pullRequests.length || await this.publish(state, { projectId, revision: state.revision + 1,
        pullRequests, debts: [], decisions: [], plans: [], proposals: [], events: [] })) return;
    }
    throw new Error('PR observation could not acquire a project revision');
  }

  private projectPullRequests(projectId: string, state: PlanningState, now: Date) {
    const repository = this.github?.repositoryFor(projectId);
    return repository && state.pullRequests.size ? projectPlanningPullRequests(projectId, repository, state, now, this.github?.previewFor) : [];
  }

  async pullRequestPreview(projectId: string, number: number) {
    const repository = this.github?.repositoryFor(projectId);
    if (!repository || !this.github?.previewFor) return undefined;
    const row = (await this.load(projectId)).pullRequests.get(planningPullRequestKey(repository, number));
    return row ? this.github.previewFor(projectId, row, this.now()) : undefined;
  }

  async designAcceptanceDebt(projectId: string, id: string, sourceRef: string) {
    const state = await this.load(projectId);
    const proposal = state.proposals.get(id);
    const debt = state.debts.get(proposal?.result?.kind === 'debt' ? proposal.result.id : id);
    return debt?.source.type === 'test' && debt.source.ref === sourceRef && debt.status !== 'dropped' ? debt.id : undefined;
  }

  async approvedDesignRequirement(projectId: string, planId: string) {
    const state = await this.load(projectId);
    const plan = state.plans.get(planId);
    if (!plan) return undefined;
    const proposal = [...state.proposals.values()].find(row => row.kind === 'plan' && row.status === 'accepted'
      && row.result?.kind === 'plan' && row.result.id === plan.id);
    if (!proposal?.draft.summary) return undefined;
    return { planVersion: plan.version, proposalId: proposal.id, title: proposal.draft.title,
      requirements: proposal.draft.summary };
  }

  private async recheckGithubRemovals(projectId: string, state: PlanningState, decisionBranch?: string) {
    const checks = new Map<string, GithubRemovalCheck>();
    const repository = this.github?.repositoryFor(projectId);
    const branch = this.github?.defaultBranchFor?.(projectId);
    const probe = this.github?.fileAnchorProbe;
    if (!repository || !branch || !probe) return checks;
    const candidates = [...state.debts.values()].flatMap(debt => {
      if (!unpaid(debt) || (decisionBranch && (debt.decisionId ?? 'none') !== decisionBranch)) return [];
      const anchor = debt.anchor;
      if (anchor?.type !== 'file' || anchor.status !== 'missing' || anchor.source?.kind !== 'github-file') return [];
      const file = fileAnchorPath(anchor.ref);
      const proof = anchor.source.proof;
      if (!file || proof?.repository?.toLowerCase() !== repository.toLowerCase() || proof.defaultBranch !== branch || proof.path !== file) return [];
      return [{ id: debt.id, file, proof }];
    });
    if (!candidates.length) return checks;
    const files = [...new Set(candidates.map(row => row.file))];
    const commits = new Set(candidates.map(row => row.proof.mergeCommitSha));
    const observation = await probe(projectId, repository, branch, files, commits);
    if (this.github?.repositoryFor(projectId) !== repository || this.github.defaultBranchFor?.(projectId) !== branch) return checks;
    for (const { id, file, proof } of candidates) {
      const current = observation.removals.get(file);
      if (observation.present.has(file)) checks.set(id, 'restored');
      else if (current?.mergeCommitSha === proof.mergeCommitSha && current.parentCommitSha === proof.parentCommitSha) checks.set(id, 'missing');
    }
    return checks;
  }

  async scanGithubFileAnchors(projectId: string): Promise<number> {
    const repository = this.github?.repositoryFor(projectId);
    const branch = this.github?.defaultBranchFor?.(projectId);
    const readProofs = this.github?.fileAnchorProbe;
    if (!repository || !branch || !readProofs) return 0;
    const state = await this.load(projectId);
    const anchors = [...state.debts.values()].flatMap(debt => {
      const anchor = debt.anchor;
      if (anchor?.type !== 'file' || anchor.status !== 'alive' || !unpaid(debt)) return [];
      const file = fileAnchorPath(anchor.ref);
      return file ? [{ debtId: debt.id, file, boundAt: anchor.boundAt }] : [];
    });
    if (!anchors.length) return 0;
    const earliestBinding = anchors.map(anchor => anchor.boundAt).sort()[0];
    const merges = [...state.pullRequests.values()].flatMap(pr => {
      if (pr.state !== 'merged' || pr.repository.toLowerCase() !== repository.toLowerCase() || pr.baseRef !== branch
        || !pr.mergedAt || pr.mergedAt < earliestBinding || !pr.mergeCommitSha || !pr.mergeDeliveryId) return [];
      return [{ number: pr.number, url: pr.url, mergedAt: pr.mergedAt, commit: pr.mergeCommitSha, deliveryId: pr.mergeDeliveryId }];
    });
    if (!merges.length) return 0;
    const files = [...new Set(anchors.map(anchor => anchor.file))];
    const { removals } = await readProofs(projectId, repository, branch, files, new Set(merges.map(merge => merge.commit)));
    if (!removals.size) return 0;

    for (let attempts = 0; attempts < 10; attempts++) {
      const current = await this.load(projectId);
      if (this.github?.repositoryFor(projectId) !== repository || this.github.defaultBranchFor?.(projectId) !== branch) return 0;
      const mutation = new PlanningMutation(current, projectId, planningSweepActor, this.now().toISOString());
      for (const anchor of anchors) {
        const local = removals.get(anchor.file);
        const debt = current.debts.get(anchor.debtId);
        if (!local || !debt?.anchor || debt.anchor.boundAt !== anchor.boundAt || fileAnchorPath(debt.anchor.ref) !== anchor.file) continue;
        const candidates = merges.filter(merge => merge.commit === local.mergeCommitSha && merge.mergedAt >= anchor.boundAt);
        if (candidates.length !== 1) continue;
        const [merge] = candidates;
        const signed = current.pullRequests.get(planningPullRequestKey(repository, merge.number));
        if (signed?.baseRef !== branch || signed.mergeCommitSha !== merge.commit || signed.mergeDeliveryId !== merge.deliveryId) continue;
        mutation.recordGithubFileRemoval(debt, { ...local, repository, pullRequestNumber: merge.number, pullRequestUrl: merge.url,
          defaultBranch: branch, path: anchor.file, deliveryId: merge.deliveryId });
      }
      const changed = mutation.changes.debts.length;
      if (!changed || await this.publish(current, { projectId, revision: current.revision + 1, ...mutation.changes })) return changed;
    }
    throw new Error('文件锚点巡检遇到并发更新，下次巡检将重试');
  }

  async sweepDuplicatePairs(projectId: string, through = this.now()): Promise<void> {
    let baseline: PlanningState | undefined;
    let retries = 0;
    while (retries < 10) {
      const state = await this.load(projectId);
      if (state.debts.size === 0) return;
      if (state.duplicateBaselineRevision === undefined) {
        if (await this.publish(state, { projectId, revision: state.revision + 1, duplicateBaselineRevision: state.revision,
          debts: [], decisions: [], plans: [], proposals: [], events: [] })) return;
        retries++;
        continue;
      }
      baseline ??= await this.load(projectId, state.duplicateBaselineRevision);
      const at = this.now();
      const until = through.getTime() < at.getTime() ? through.toISOString() : at.toISOString();
      const mutation = new PlanningMutation(state, projectId, planningSweepActor, at.toISOString());
      const live = [...state.debts.values()].filter(debt => debt.updatedAt <= until);
      for (const [left, right] of checkupDuplicatePairs(live)) {
        const pair = planningDuplicateKey(left.id, right.id);
        if (state.reportedDuplicatePairs?.has(pair) || duplicatePresentAtBaseline(baseline.debts.get(left.id), baseline.debts.get(right.id))) continue;
        mutation.recordDuplicatePair(left, right);
        // Keep each atomic revision within the storage document budget.
        if ((mutation.changes.reportedDuplicatePairs?.length ?? 0) === 100) break;
      }
      if (!mutation.changes.events.length) return;
      if (await this.publish(state, { projectId, revision: state.revision + 1, ...mutation.changes })) retries = 0;
      else retries++;
    }
    throw new Error('Duplicate sweep could not acquire a project revision');
  }

  async checkup(projectId: string, actor: PlanningActor): Promise<PlanningCheckup> {
    if (!actor.permissions.includes('read')) rejectPlanning(404, 'not_found', '没有可访问的工程规划项目');
    const state = await this.load(projectId);
    const notices = actor.kind === 'human' ? [...(state.notices?.values() ?? [])]
      .filter(row => row.recipientId === actor.id).sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
      .map(({ recipientId: _, ...row }) => row) : [];
    const today = planningToday(this.now());
    const pairs = new Set<string>();
    let pending = 0;
    let closed = 0;
    let lastAt = '';
    for (const event of state.events) {
      if (event.type !== 'extinct_pending' && !(event.type === 'extinct' && event.via === 'system') && event.type !== 'dup_flagged') continue;
      if (planningToday(new Date(event.at)) !== today) continue;
      if (event.type === 'extinct_pending') pending++;
      else if (event.type === 'extinct') closed++;
      else if (event.relatedDebtId) pairs.add(planningDuplicateKey(event.entityId, event.relatedDebtId));
      if (event.at > lastAt) lastAt = event.at;
    }
    return { projectId, notices, unread: notices.filter(row => !row.readAt).length,
      ...(lastAt ? { summary: { at: lastAt, duplicates: pairs.size, pending, closed } } : {}) };
  }

  async markCheckupRead(projectId: string, actor: PlanningActor, request: PlanningCheckupRead): Promise<PlanningCheckupReadResult> {
    if (!actor.permissions.includes('read') || actor.kind !== 'human') rejectPlanning(404, 'not_found', '没有可访问的巡检通知');
    for (let attempts = 0; attempts < 10; attempts++) {
      const state = await this.load(projectId);
      const owned = [...(state.notices?.values() ?? [])].filter(row => row.recipientId === actor.id);
      if ('id' in request && !owned.some(row => row.id === request.id)) rejectPlanning(404, 'not_found', '没有可访问的巡检通知');
      const unread = owned.filter(row => !row.readAt);
      const readAt = this.now().toISOString();
      const notices = unread.filter(row => 'all' in request || request.id === row.id).map(row => ({ ...row, readAt }));
      const changed = notices.length;
      if (!changed || await this.publish(state, { projectId, revision: state.revision + 1, notices,
        debts: [], decisions: [], plans: [], proposals: [], events: [] })) {
        return { projectId, changed, unread: unread.length - changed };
      }
    }
    return rejectPlanning(409, 'write_contention', '通知正在更新，请稍后重试');
  }

  async command(projectId: string, actor: PlanningActor, input: unknown, context?: { designSourceRef: string }): Promise<PlanningReceipt> {
    const command = parsePlanningCommand(input);
    if (command.type === 'debt.create' && command.assignToSelf && actor.kind !== 'human') {
      rejectPlanning(403, 'write_forbidden', '请由已认证的项目成员选择由自己负责');
    }
    const approval = command.type === 'proposal.accept' || command.type === 'proposal.reject';
    const need = approval ? 'approve' : command.type === 'proposal.submit' ? 'propose' : 'write';
    if (!actor.permissions.includes(need) || (actor.kind === 'agent' && command.type !== 'proposal.submit' && command.type !== 'debt.create')) {
      rejectPlanning(403, 'write_forbidden', approval ? '请由该项目有确认权限的成员处理提案' : '当前授权不允许此操作，请检查项目权限');
    }
    const key = hash([actor.kind, actor.id, command.requestId]);
    const fingerprint = hash(command);
    let designIds: Set<string> | undefined;
    for (let attempts = 0; attempts < 10; attempts++) {
      const state = await this.load(projectId);
      const previous = state.receipts.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) rejectPlanning(409, 'idempotency_conflict', '该请求编号已用于其他内容，请检查原提交');
        return { ...previous.receipt, reused: true };
      }

      if (context) {
        const source = (row: { source: { type: string; ref: string } }) => row.source.type === 'test' && row.source.ref === context.designSourceRef;
        const established = [...state.debts.values()].find(row => row.status !== 'dropped' && source(row))
          ?? [...state.proposals.values()].find(row => row.kind === 'debt' && row.status === 'pending' && source(row));
        if (established) return { projectId, result: established, reused: true };
      }
      if (!designIds && ((command.type === 'plan.add-step' && command.kind === 'design')
        || (command.type === 'plan.create' && command.initialSteps?.some(step => step.kind === 'design')))) {
        designIds = new Set((await this.designLinksFor?.(projectId))?.map(design => design.id));
      }
      const githubFiles = command.type === 'debt.sweep' ? await this.recheckGithubRemovals(projectId, state, command.branch) : undefined;
      const mutation = new PlanningMutation(state, projectId, actor, this.now().toISOString(), designIds);
      const result = mutation.run(command, { ...context, githubFiles });
      const receipt = { projectId, result, reused: mutation.reused };
      const commit: EngineeringPlanningCommit = { projectId, revision: state.revision + 1,
        request: { key, fingerprint, receipt }, ...mutation.changes };
      if (await this.publish(state, commit)) return receipt;
    }
    return rejectPlanning(409, 'write_contention', '项目正在接收其他更新，请用相同请求编号重试');
  }

  async board(projectId: string, actor: PlanningActor): Promise<PlanningBoard> {
    const [state, designs] = await Promise.all([this.load(projectId), this.designLinksFor?.(projectId)]);
    const now = this.now();
    const today = planningToday(now);
    const pullRequests = this.projectPullRequests(projectId, state, now);
    const designById = new Map(designs?.map(design => [design.id, design]));
    const repository = this.github?.repositoryFor(projectId);
    const hasCurrentSignature = (signature: NonNullable<PlanningDesignLink['signed']>) => Boolean(repository
      && state.pullRequests.get(planningPullRequestKey(repository, signature.pullRequest))?.headSha === signature.commit);
    const proposals = [...state.proposals.values()].sort(order);
    const match = proposals.some(row => row.kind === 'debt' && row.status === 'pending')
      ? duplicateDebtMatcher(state.debts.values()) : undefined;
    return {
      ...this.capabilities(projectId, actor),
      ...projectDebtNavigation(state, today),
      today,
      proposals: match ? proposals.map(row => projectProposalSuggestion(row, match)) : proposals,
      decisions: [...state.decisions.values()].sort(order).map(decision => {
        const linked = pullRequests.filter(row => row.decisionIds.includes(decision.id));
        return linked.length ? { ...decision, pullRequests: linked } : decision;
      }),
      ...(pullRequests.length ? { pullRequests } : {}),
      ...(designs?.length ? { designs } : {}),
      plans: [...state.plans.values()].sort(order).map(plan => planProjection(plan, state.debts, designById, hasCurrentSignature)),
      events: state.events.filter(event => event.entity !== 'debt').slice(-250).reverse(),
      pendingReviewCount: [...state.decisions.values()].filter(row => row.status === 'accepted' && row.reviewAt && row.reviewAt <= today
        && (!row.reviewedAt || planningToday(new Date(row.reviewedAt)) < row.reviewAt)).length,
    };
  }

  async decisions(projectId: string, query: DecisionQuery): Promise<PlanningDecisionSearch> {
    const terms = query.q === undefined || query.q === '' ? [] : decisionText(planningText(query.q, 'q', 200)).split(/\s+/u);
    const kind = query.subjectKind;
    const subject = query.subjectRef === undefined ? undefined : decisionText(planningText(query.subjectRef, 'subjectRef', 200));
    if ((kind === undefined) !== (subject === undefined) || (kind !== undefined && !decisionSubjectKinds.some(item => item === kind))) {
      rejectPlanning(400, 'invalid', '请同时填写有效的适用对象类型和名称');
    }
    const state = await this.load(projectId);
    const phrase = terms.join(' ');
    const matches = [...state.decisions.values()].flatMap(row => {
      if (subject && !row.appliesTo?.some(value => value.kind === kind && decisionText(value.ref) === subject)) return [];
      const names = [row.id, row.title, ...(row.aliases ?? []), ...(row.appliesTo ?? []).map(value => value.ref)].map(decisionText);
      const searchable = [...names, ...[row.summary, row.rationale, row.chosenOption].filter((value): value is string => Boolean(value)).map(decisionText)];
      if (!terms.every(term => searchable.some(value => value.includes(term)))) return [];
      const rank = !phrase ? 0 : names.includes(phrase) ? 2 : names.some(value => value.startsWith(phrase)) ? 1 : 0;
      return [{ row, rank }];
    }).sort((a, b) => b.rank - a.rank || order(a.row, b.row));
    return { projectId, total: matches.length, items: matches.slice(0, 50).map(item => item.row) };
  }

  async debts(projectId: string, query: DebtQuery = {}): Promise<PlanningDebtList> {
    const live = await this.load(projectId);
    const q = query.q === undefined || query.q === '' ? '' : planningText(query.q, 'q', 200).toLocaleLowerCase();
    const branch = query.branch === undefined ? undefined : planningId(query.branch, 'branch');
    const tag = query.tag === undefined ? undefined : planningText(query.tag, 'tag', 80);
    const exactTag = query.tagMatch === 'exact';
    const view = (query.view === undefined ? 'unpaid' : planningText(query.view, 'view', 32).replaceAll('-', '_')) as PlanningDebtView;
    const sort = (query.sort === undefined ? 'updated' : planningText(query.sort, 'sort', 20)) as typeof planningDebtSorts[number];
    const selectedPriorities = query.priority === undefined ? [] : planningText(query.priority, 'priority', 24).split(',');
    const priorities = debtPriorities.filter(value => selectedPriorities.includes(value));
    const owner = query.owner === undefined ? undefined : planningText(query.owner, 'owner', 120);
    const module = query.module === undefined ? undefined : planningText(query.module, 'module', 80);
    const batch = query.batch === undefined ? undefined : planningId(query.batch, 'batch');
    const source = query.source === undefined ? undefined : planningText(query.source, 'source', 16) as typeof planningSourceTypes[number];
    const limitValue = query.limit ?? '50';
    if ((query.tagMatch !== undefined && (!tag || !exactTag))
      || !planningDebtViews.includes(view) || !planningDebtSorts.includes(sort) || priorities.length !== selectedPriorities.length
      || (source !== undefined && !planningSourceTypes.includes(source))
      || typeof limitValue !== 'string' || !/^[1-9]\d{0,2}$/.test(limitValue) || Number(limitValue) > 100) {
      rejectPlanning(400, 'invalid', '请检查债务筛选、排序和分页范围');
    }
    const now = this.now();
    const today = planningToday(now);
    const limit = Number(limitValue);
    const baseFilters = [projectId, view, q, branch, tag, limit, today];
    const viewFilters = priorities.length || owner || source || sort !== 'updated' || exactTag
      ? [...baseFilters, priorities, owner, source, sort, exactTag] : baseFilters;
    const filters = module || batch ? [...viewFilters, { module, batch }] : viewFilters;
    const cursor = pageCursor(query.cursor, hash(filters), live.revision);
    const state = cursor.revision === live.revision ? live : await this.load(projectId, cursor.revision);
    if (branch && branch !== 'none' && !state.decisions.has(branch)) rejectPlanning(404, 'not_found', '此项目没有这条决策');
    const terms = q ? q.split(/\s+/u) : [];
    const scoped = [...state.debts.values()].filter(debt => matchesBranch(debt.decisionId, branch));
    const duplicates = duplicateDebtIds(state);
    const matching = scoped.filter(debt => {
      if (tag && !(debt.tags?.length
        ? debt.tags.some(value => value === tag || (!exactTag && value.startsWith(`${tag}/`))) : tag === '未分类')) return false;
      if (priorities.length && !priorities.includes(debt.priority)) return false;
      if (owner && debt.owner !== owner) return false;
      if (module && debt.module !== module) return false;
      if (batch && debt.importBatchId !== batch) return false;
      if (source && debt.source.type !== source) return false;
      if (!terms.length) return true;
      const text = [debt.id, debt.title, debt.summary, debt.whyDebt, debt.owner, debt.module, debt.tags?.join(' '), debt.source.ref, debt.rootCause?.text].join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
    const deadline = (debt: PlanningDebt) => {
      if (!unpaid(debt)) return '9999-12-31';
      if (debt.anchor?.status === 'missing') return planningToday(new Date(debt.anchor.closeAt));
      return (debt.status === 'deferred' ? debt.reviewAt : debt.dueAt) ?? '9999-12-31';
    };
    const items = matching.filter(debt => matchesDebtView(view, debt, today, duplicates)).sort((a, b) => {
      const exact = Number(b.id.toLocaleLowerCase() === q) - Number(a.id.toLocaleLowerCase() === q);
      if (exact) return exact;
      let compare = 0;
      switch (sort) {
        case 'deadline': compare = deadline(a).localeCompare(deadline(b)); break;
        case 'oldest': compare = a.createdAt.localeCompare(b.createdAt); break;
        case 'interest': compare = b.hitCount - a.hitCount; break;
        case 'priority': compare = debtPriorities.indexOf(a.priority) - debtPriorities.indexOf(b.priority); break;
      }
      return compare || order(a, b);
    });
    const next = cursor.offset + limit;
    return { projectId, today, asOf: now.toISOString(), items: items.slice(cursor.offset, next), total: items.length,
      ...debtListSummary(scoped, matching, today, duplicates, now.getTime()),
      nextCursor: next < items.length ? Buffer.from(JSON.stringify({ ...cursor, offset: next })).toString('base64url') : null };
  }

  async debt(projectId: string, id: string): Promise<PlanningDebtDetail> {
    const state = await this.load(projectId);
    const debt = state.debts.get(id);
    if (!debt) rejectPlanning(404, 'not_found', '此项目没有这条债务');
    const now = this.now();
    const health: PlanningDebtDetail['health'] = { verification: planningVerificationState(debt.verify, now.getTime()) };
    if (unpaid(debt) && debt.anchor?.status === 'missing') {
      health.daysUntilClosure = planningClosureDays(debt.anchor.closeAt, now.getTime());
    }
    const originIds = new Set([id]);
    const mergedByTarget = new Map<string, string[]>();
    for (const row of state.debts.values()) {
      if (row.outcome?.kind !== 'merged' || !row.outcome.targetId) continue;
      const merged = mergedByTarget.get(row.outcome.targetId) ?? [];
      merged.push(row.id);
      mergedByTarget.set(row.outcome.targetId, merged);
    }
    for (const key of originIds) for (const merged of mergedByTarget.get(key) ?? []) originIds.add(merged);
    const events = state.events.filter(item => item.entity === 'debt' && item.entityId === id).reverse();
    const history = originIds.size === 1 ? events : state.events.filter(item => item.entity === 'debt' && originIds.has(item.entityId)).reverse();
    const plans = [...state.plans.values()].filter(plan => plan.steps.some(step => step.kind === 'debt' && step.relatedId === id));
    const brief = buildDebtBrief(debt, events, {
      origin: debt.originDecisionId ? state.decisions.get(debt.originDecisionId) : undefined,
      current: debt.decisionId ? state.decisions.get(debt.decisionId) : undefined,
      plans,
    }, now);
    const collateralCandidates = unpaid(debt) && debt.criteria.length ? [...state.debts.values()]
      .filter(row => row.id !== debt.id && unpaid(row) && sharesRepaymentCriteria(debt, row)).sort(order).slice(0, 6)
      .map(({ id, title, version }) => ({ id, title, version })) : [];
    const duplicateCandidates = unpaid(debt) ? findSimilarDebts(state.debts.values(), debt.title, { base: debt }).slice(0, 6) : [];
    const pullRequests = this.projectPullRequests(projectId, state, now).filter(row => row.debtIds.includes(debt.id)
      || (debt.decisionId && row.decisionIds.includes(debt.decisionId)));
    return { projectId, debt, events: history, brief, collateralCandidates, duplicateCandidates, health, ...(pullRequests.length ? { pullRequests } : {}) };
  }

  async duplicates(projectId: string, rawTitle: unknown) {
    const title = planningText(rawTitle, 'title', 120);
    const state = await this.load(projectId);
    return { projectId, items: findSimilarDebts(state.debts.values(), title, { includeRepaid: true }).slice(0, 6) };
  }

  async previewImport(projectId: string, actor: PlanningActor, input: unknown) {
    if (actor.kind !== 'human' || !actor.permissions.includes('write')) rejectPlanning(403, 'write_forbidden', '请由有写权限的成员预览导入');
    const rows = planningImportInputs(input);
    return new PlanningMutation(await this.load(projectId), projectId, actor, this.now().toISOString()).previewImport(rows);
  }

  async evidenceAsset(projectId: string, id: string) {
    const metadata = (await this.load(projectId)).assets?.get(id);
    const asset = metadata && (this.store.readAsset ? await this.store.readAsset(projectId, metadata.revision, id) : metadata);
    if (!asset?.base64) rejectPlanning(404, 'not_found', '此项目没有这张证据截图');
    return { mime: asset.mime, bytes: Buffer.from(asset.base64, 'base64') };
  }

  async stats(projectId: string, query: StatsQuery = {}): Promise<PlanningStats> {
    const state = await this.load(projectId);
    const now = this.now();
    const to = query.to === undefined ? planningToday(now) : planningDay(query.to, 'to');
    const from = query.from === undefined ? isoDay(dayStamp(to) - 29 * DAY) : planningDay(query.from, 'from');
    const branch = query.branch === undefined ? undefined : planningId(query.branch, 'branch');
    const mode = query.analytics;
    if (mode !== undefined && mode !== 'evolution' && mode !== 'projection' && mode !== 'graph') {
      rejectPlanning(400, 'invalid', '请选择有效的统计视图');
    }
    if (branch && branch !== 'none' && !state.decisions.has(branch)) rejectPlanning(404, 'not_found', '此项目没有这条决策');
    const length = (dayStamp(to) - dayStamp(from)) / DAY + 1;
    if (length < 1 || length > 366) rejectPlanning(400, 'invalid', '请选择最长 366 天的统计区间');
    const totals = counts();
    let backlogStart = 0;
    const days = new Map<string, { counts: PlanningCounts; delta: number }>();
    for (const event of state.events) {
      const change = eventDelta(event, branch);
      if (!change) continue;
      const discoveredAt = event.type === 'imported' ? state.debts.get(event.entityId)?.discoveredAt : undefined;
      const date = discoveredAt ?? planningToday(new Date(event.at));
      if (date < from) { backlogStart += change.delta; continue; }
      if (date > to) continue;
      const day = days.get(date) ?? { counts: counts(), delta: 0 };
      day.delta += change.delta;
      day.counts[change.kind]++;
      totals[change.kind]++;
      days.set(date, day);
    }
    let backlogEnd = backlogStart;
    const buckets = Array.from({ length }, (_, offset) => {
      const day = isoDay(dayStamp(from) + offset * DAY);
      const entry = days.get(day);
      backlogEnd += entry?.delta ?? 0;
      return { day, backlog: backlogEnd, ...(entry?.counts ?? counts()) };
    });
    const categories = new Map<string, PlanningStats['categories'][number]>();
    for (const debt of state.debts.values()) {
      if (mode === 'projection' || !matchesBranch(debt.decisionId, branch)) continue;
      const labels = new Set(debt.tags?.length ? debt.tags.map(tag => tag.split('/')[0]) : ['未分类']);
      for (const name of labels) {
        const entry = categories.get(name) ?? { name, unpaid: 0, repaid: 0, dropped: 0 };
        if (unpaid(debt)) entry.unpaid++;
        else if (debt.status === 'repaid') entry.repaid++;
        else entry.dropped++;
        categories.set(name, entry);
      }
    }
    return { projectId, from, to, backlogStart, backlogEnd, ...totals, buckets,
      categories: [...categories.values()].sort((a, b) => b.unpaid - a.unpaid || a.name.localeCompare(b.name)),
      ...(mode ? buildPlanningAnalytics(state, mode, now, from, to, branch) : {}) };
  }
}
