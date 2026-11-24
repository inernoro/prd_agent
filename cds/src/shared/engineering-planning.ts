export const planningPermissions = ['read', 'propose', 'write', 'approve'] as const;
export const PLANNING_MCP_TOOLS = ['cds_planning_read', 'cds_planning_propose', 'cds_planning_record_debt'] as const;
export type PlanningPermission = typeof planningPermissions[number];
export type PlanningActor = { kind: 'human' | 'agent'; id: string; label: string; permissions: readonly PlanningPermission[] };
export type PlanningIdentity = Pick<PlanningActor, 'id' | 'label'> & { kind: PlanningActor['kind'] | 'system' };

export const planningSourceTypes = ['manual', 'review', 'test', 'incident', 'code', 'adr', 'import'] as const;
export type PlanningSource = { type: typeof planningSourceTypes[number]; ref: string; url?: string };
export const planningEvidenceTypes = ['test', 'change', 'acceptance', 'metric', 'log', 'doc', 'screenshot'] as const;
export type PlanningProofMark = { x: number; y: number; width: number; height: number };
export type PlanningRepaymentProof = { stage: 'before' | 'after'; label: string; dataUrl: string; mark: PlanningProofMark };
export type PlanningEvidence = {
  type: typeof planningEvidenceTypes[number]; label: string; url?: string;
  image?: { id: string; stage: 'before' | 'after'; mark: PlanningProofMark };
};

export const planningVerificationMethods = ['reproduce', 'test', 'monitor', 'review'] as const;
export const planningVerificationPeriods = [14, 30, 60] as const;
export type PlanningVerification = {
  method: typeof planningVerificationMethods[number];
  note: string;
  evidence: PlanningEvidence[];
  at: string;
  by: PlanningIdentity;
  validDays: typeof planningVerificationPeriods[number];
  expiresAt: string;
};
export function planningVerificationState(verify: PlanningVerification | undefined, at: number) {
  if (!verify) return 'unverified';
  return Date.parse(verify.expiresAt) > at ? 'verified' : 'expired';
}

export const planningAnchorTypes = ['feature', 'route', 'file', 'flag', 'dep', 'api'] as const;
export type PlanningAnchorTarget = { type: typeof planningAnchorTypes[number]; ref: string };
export type PlanningGithubFileRemovalProof = {
  repository: string; pullRequestNumber: number; pullRequestUrl: string; mergeCommitSha: string; parentCommitSha: string;
  observedHeadSha: string; defaultBranch: string; path: string; deliveryId: string;
};
export type PlanningRemovalSource = { kind: 'human' } | { kind: 'github-file'; proof: PlanningGithubFileRemovalProof };
type PlanningRemoval = {
  note: string;
  evidence: PlanningEvidence[];
  missingAt: string;
  closeAt: string;
  reportedBy: PlanningIdentity;
  source?: PlanningRemovalSource;
};
export type PlanningDebtAnchor = PlanningAnchorTarget & { boundAt: string; by: PlanningIdentity } & (
  { status: 'alive' }
  | (PlanningRemoval & { status: 'missing' })
  | (PlanningRemoval & { status: 'gone'; closedAt: string })
);
export function planningClosureDays(closeAt: string, at: number) {
  return Math.max(0, Math.ceil((Date.parse(closeAt) - at) / 86_400_000));
}

export const debtPriorities = ['high', 'mid', 'low'] as const;
export type DebtPriority = typeof debtPriorities[number];
export type DebtStatus = 'open' | 'deferred' | 'in_progress' | 'repaid' | 'dropped';
export const legacyDebtStatuses = ['open', 'in_progress', 'repaid', 'pending_verification'] as const;
export type LegacyDebtStatus = typeof legacyDebtStatuses[number];
export type LegacyDebtOrigin = {
  status: LegacyDebtStatus; originalStatus: string; path: string; commit: string; line: number;
};
export const legacyDebtStatusLabels: Record<LegacyDebtStatus, string> = {
  open: '未还', in_progress: '处理中', repaid: '已还', pending_verification: '已落地待验证',
};
export type DebtOutcome = 'cancelled' | 'superseded' | 'extinct' | 'merged';
export type RootCause = { state: 'pending' | 'suspected' | 'confirmed'; text?: string; basis?: string };
export type Criterion = { id: string; text: string };
export type CriterionResult = { criterionId: string; verdict: 'met' | 'na'; note?: string; evidence?: PlanningEvidence[] };
export type Repayment = {
  at: string; by: PlanningIdentity; summary: string; results: CriterionResult[]; evidence: PlanningEvidence[];
  criteria?: Criterion[];
  mode?: 'collateral'; collateralOf?: string;
};
export const debtApproachStates = ['candidate', 'tried', 'rejected'] as const;
export type DebtDirection = {
  target?: string;
  approaches?: { title: string; status: typeof debtApproachStates[number]; note?: string }[];
};
export type DebtDraft = {
  title: string;
  summary?: string;
  whyDebt?: string;
  decisionId?: string;
  priority?: DebtPriority;
  criteria?: string[];
  rootCause?: RootCause;
  impact?: string;
  owner?: string;
  module?: string;
  dueAt?: string;
  trigger?: string;
  tags?: string[];
  direction?: DebtDirection;
};
export const clearableDebtFields = ['summary', 'whyDebt', 'impact', 'trigger', 'owner', 'module', 'dueAt', 'direction'] as const;
type ClearableDebtField = typeof clearableDebtFields[number];
export type DebtPatch = Partial<Omit<DebtDraft, 'decisionId' | ClearableDebtField>> & {
  [Field in ClearableDebtField]?: DebtDraft[Field] | null;
};
export const planningDecisionLinkTypes = ['doc', 'adr', 'issue'] as const;
export type PlanningDecisionLink = { type: typeof planningDecisionLinkTypes[number]; title: string; url: string };
export type PlanningPreviewTarget = { label: string; path: string };
export type PlanningPullRequestReference = { url: string; target?: PlanningPreviewTarget };
export type PlanningPullRequestPreview = {
  status: 'ready' | 'building' | 'failed' | 'expired'; url?: string; path?: string; builtAt?: string; commit?: string; branchId?: string;
};
export type PlanningPullRequest = {
  number: number; projectId: string; repository: string; url: string; decisionIds: string[]; debtIds: string[];
  title: string; author: string; openedAt: string; updatedAt: string; mergedAt?: string;
  state: 'draft' | 'open' | 'merged' | 'closed'; checks?: 'pass' | 'fail' | 'running';
  preview?: PlanningPullRequestPreview; target?: PlanningPreviewTarget;
};
export const decisionSubjectKinds = ['feature', 'config', 'preview', 'module'] as const;
export const decisionProvenanceLevels = ['original', 'backfilled', 'inferred'] as const;
export type DecisionSubject = { kind: typeof decisionSubjectKinds[number]; ref: string };
export type DecisionProvenance = {
  level: typeof decisionProvenanceLevels[number];
  url: string;
  occurredOn?: string;
  decidedBy?: string;
  basis?: string;
};

export type DecisionStructure = {
  decisionKind?: 'forward' | 'debt';
  options?: { title: string; benefits?: string; drawbacks?: string }[];
  chosenOption?: string;
  consequences?: string;
  aliases?: string[];
  appliesTo?: DecisionSubject[];
  provenance?: DecisionProvenance;
};
export type DecisionDraft = DecisionStructure & {
  title: string; summary?: string; rationale?: string; owner?: string; reviewAt?: string; resolves?: string[];
  links?: PlanningDecisionLink[]; pullRequest?: PlanningPullRequestReference;
};
export type PlanDraft = { title: string; summary?: string; decisionId?: string; owner?: string; startAt?: string; dueAt?: string };

type RecordBase = { id: string; projectId: string; version: number; createdAt: string; updatedAt: string };
export type PlanningDebt = RecordBase & Omit<DebtDraft, 'criteria'> & {
  source: PlanningSource;
  status: DebtStatus;
  priority: DebtPriority;
  criteria: Criterion[];
  ownerAccountId?: string;
  originDecisionId?: string;
  reviewAt?: string;
  deferReason?: string;
  repayment?: Repayment;
  outcome?: { kind: DebtOutcome; reason: string; targetId?: string; evidence?: PlanningEvidence[]; closedAt?: string };
  verify?: PlanningVerification;
  anchor?: PlanningDebtAnchor;
  notDuplicateWith?: string[];
  reopenCount: number;
  hitCount: number;
  discoveredAt?: string;
  importBatchId?: string;
  legacy?: LegacyDebtOrigin;
};
export type PlanningDecision = RecordBase & DecisionDraft & {
  source: PlanningSource;
  status: 'proposed' | 'accepted' | 'superseded' | 'deprecated';
  supersededBy?: string;
  reviewedAt?: string;
  pullRequests?: PlanningPullRequest[];
};
export type PlanningDecisionSearch = { projectId: string; total: number; items: PlanningDecision[] };

export type PlanningDesignLink = {
  id: string; title: string; version: number; decisionIds: string[]; frozen?: number;
  signed?: { runId: string; pullRequest?: number; commit: string; target?: 'installed' };
};

export const planningStepKinds = ['task', 'decision', 'debt', 'review', 'design'] as const;
export type PlanningStep = {
  id: string;
  kind: typeof planningStepKinds[number];
  title: string;
  relatedId?: string;
  dueAt?: string;
  owner?: string;
  status: 'todo' | 'doing' | 'done' | 'cancelled';
};
export type PlanningStepDraft = Pick<PlanningStep, 'kind' | 'title' | 'relatedId' | 'dueAt' | 'owner'>;
export type PlanningPlan = RecordBase & PlanDraft & { source: PlanningSource; steps: PlanningStep[] };
export type ProposalDecisionChange = { decisionId: string; expectedVersion: number; change: 'amended' | 'accepted' };
export type ProposalDraft = { kind: 'debt'; draft: DebtDraft }
  | { kind: 'decision'; draft: DecisionDraft; decisionChange?: ProposalDecisionChange }
  | { kind: 'plan'; draft: PlanDraft & { debtIds?: string[] } };
export type PlanningProposalSource = PlanningSource & { excerpt?: string };
type ProposalMetadata = { skill?: string; confidence?: number };
export type PlanningRecordKind = ProposalDraft['kind'];
export type PlanningProposal = RecordBase & ProposalDraft & ProposalMetadata & {
  source: PlanningProposalSource;
  author: PlanningIdentity;
  status: 'pending' | 'accepted' | 'rejected';
  suggest?: { dupOf: string; dupTitle: string };
  handledBy?: PlanningIdentity;
  reason?: string;
  result?: { kind: PlanningRecordKind; id: string; mode?: 'hit' };
};

export type PlanningEventKind =
  | 'created' | 'imported' | 'updated' | 'deferred' | 'started' | 'progress' | 'repaid' | 'reopened'
  | 'dropped' | 'extinct' | 'merged' | 'merged_into' | 'hit' | 'branch_moved'
  | 'verified' | 'anchor_bound' | 'anchor_kept' | 'extinct_pending' | 'not_duplicate' | 'dup_flagged' | 'planned'
  | 'proposed' | 'accepted' | 'rejected' | 'amended' | 'reviewed' | 'superseded' | 'deprecated' | 'step_added' | 'step_changed';
export type PlanningEvent = {
  id: string;
  projectId: string;
  entity: PlanningRecordKind | 'proposal';
  entityId: string;
  type: PlanningEventKind;
  at: string;
  actor: PlanningIdentity;
  note?: string;
  evidence?: PlanningEvidence[];
  repayment?: Repayment;
  verification?: PlanningVerification;
  anchorChange?: { before: PlanningAnchorTarget | null; after: PlanningAnchorTarget | null };
  effectiveAt?: string;
  via?: 'system';
  triggeredBy?: PlanningIdentity;
  dates?: { dueAt?: [string | null, string | null]; reviewAt?: [string | null, string | null] };
  triggerChange?: [string | null, string | null];
  proposedBy?: PlanningIdentity;
  proposal?: { id: string; source: PlanningProposalSource; skill?: string };
  relatedDebtId?: string;
  relatedPlanId?: string;
  stepChange?: { stepId: string; from?: PlanningStep['status']; to: PlanningStep['status'] };
  fromStatus?: DebtStatus;
  toStatus?: DebtStatus;
  fromDecisionId?: string;
  toDecisionId?: string;
};

export type PlanningCapabilities = { projectId: string; protocolVersion: 1; permissions: PlanningPermission[] };
export type PlanningDebtBranch = {
  unpaid: number; repaid: number; extinct: number; other: number; planned: number; highInterest: number; created: number; closed: number;
};
export type PlanningRelatedDebt = Pick<PlanningDebt, 'id' | 'title' | 'status' | 'outcome' | 'decisionId'> & {
  recentHits?: number; repaidAt?: string;
};
export type PlanningBoard = PlanningCapabilities & {
  today: string;
  proposals: PlanningProposal[];
  decisions: PlanningDecision[];
  plans: PlanningPlan[];
  events: PlanningEvent[];
  pendingReviewCount: number;
  designs?: PlanningDesignLink[];
  pullRequests?: PlanningPullRequest[];
  debtBranches?: Record<string, PlanningDebtBranch>;
  relatedDebts?: Record<string, PlanningRelatedDebt>;
};
export const planningDebtViews = [
  'all', 'unpaid', 'review_due', 'overdue', 'open', 'deferred', 'in_progress', 'reopened', 'dup', 'pending_extinct',
  'repaid', 'direct_repaid', 'collateral', 'dropped', 'extinct', 'merged', 'void',
] as const;
export type PlanningDebtView = typeof planningDebtViews[number];
export const planningDebtSorts = ['updated', 'deadline', 'oldest', 'interest', 'priority'] as const;
export type PlanningDebtList = {
  projectId: string; today: string; items: PlanningDebt[]; nextCursor: string | null;
  asOf?: string;
  total?: number; counts?: Record<PlanningDebtView, number>;
  ledger?: { unpaid: number; repaid: number; extinct: number; verified?: number };
  filterOptions?: { owners: string[]; tags: string[] };
};
export type PlanningDuplicateCandidate = Pick<PlanningDebt, 'id' | 'title' | 'status' | 'summary' | 'owner' | 'version'> & { similarity: number };
export type PlanningDebtDistinction = { debtIds: string[]; reason: string };
export type PlanningImportRow = DebtDraft & { source: PlanningSource; discoveredAt?: string; legacy?: LegacyDebtOrigin };
export type PlanningImportPreview = { projectId: string; items: {
  index: number; title?: string; sourceRef?: string; status: 'ready' | 'similar' | 'existing' | 'repeated' | 'invalid';
  debtId?: string; debtStatus?: DebtStatus; legacyStatus?: LegacyDebtStatus; message?: string; candidates?: PlanningDuplicateCandidate[];
}[] };
export type PlanningBriefTarget = 'header' | 'context' | 'criteria' | 'outcome';
export type PlanningBriefCitation =
  | { kind: 'record'; id: string; label: string; target: PlanningBriefTarget }
  | { kind: 'event' | 'decision' | 'plan'; id: string; label: string };
export type PlanningDebtBrief = {
  readiness: { score: number; max: number; items: { label: string; ok: boolean }[] };
  sections: {
    id: 'problem' | 'attempts' | 'why' | 'direction'; title: string;
    lines: { kind: 'fact' | 'inference' | 'gap'; text: string; cites: PlanningBriefCitation[] }[];
  }[];
  next: string[];
  gaps: string[];
  markdown: string;
};
export type PlanningDebtDetail = {
  projectId: string; debt: PlanningDebt; events: PlanningEvent[]; brief?: PlanningDebtBrief;
  pullRequests?: PlanningPullRequest[];
  collateralCandidates?: Pick<PlanningDebt, 'id' | 'title' | 'version'>[];
  duplicateCandidates?: PlanningDuplicateCandidate[];
  health?: { verification: ReturnType<typeof planningVerificationState>; daysUntilClosure?: number };
};
export type PlanningCounts = {
  created: number;
  imported: number;
  repaid: number;
  reopened: number;
  dropped: number;
  extinct: number;
  merged: number;
  transferredIn: number;
  transferredOut: number;
};
export type PlanningAnalyticsActivity = {
  id: string;
  debtId: string;
  at: string;
  type: PlanningEventKind;
  title?: string;
  collateral?: boolean;
};
export type PlanningGraphOutcome = 'unpaid' | 'repaid' | 'collateral' | 'extinct' | 'merged' | 'cancelled';
export type PlanningGraphDebt = {
  id: string;
  title: string;
  status: DebtStatus;
  outcome: PlanningGraphOutcome;
  priority: DebtPriority;
  owner?: string;
  module?: string;
  source: PlanningSource['type'];
  tags: string[];
  reopened: boolean;
  reviewDue: boolean;
  overdue: boolean;
  recentHits: number;
  recentlyCreated: boolean;
};
export type PlanningGraphChange = PlanningAnalyticsActivity & {
  movement: keyof PlanningCounts;
  tags: string[];
  delta: number;
};
export type PlanningStats = PlanningCounts & {
  projectId: string;
  from: string;
  to: string;
  backlogStart: number;
  backlogEnd: number;
  buckets: (PlanningCounts & { day: string; backlog: number })[];
  categories: { name: string; unpaid: number; repaid: number; dropped: number }[];
  snapshot?: { today: string; unpaid: number; inProgress: number; reviewDue: number; overdue: number;
    pendingVerification?: number; pendingExtinct?: number };
  recent?: PlanningAnalyticsActivity[];
  outlook?: {
    through: string;
    repayments: number;
    reviews: number;
    items: { debtId: string; title?: string; date: string; kind: 'repayment' | 'review' }[];
  };
  breakdown?: {
    ages: [number, number, number, number, number];
    priorities: Record<DebtPriority, number>;
    sources: Partial<Record<PlanningSource['type'], number>>;
    hits: number;
    topHits: { debtId: string; title?: string; recent: number; total: number }[];
  };
  graph?: { asOf: string; branch?: string; debts: PlanningGraphDebt[]; changes: PlanningGraphChange[] };
};

export type PlanningSweepResult = { projectId: string; at: string; pending: string[]; closed: string[] };
export type PlanningCheckupNotice = {
  id: string;
  kind: 'extinct_pending' | 'extinct' | 'dup';
  at: string;
  debtIds: string[];
  title: string;
  detail: string;
  readAt?: string;
};
export type PlanningCheckup = {
  projectId: string;
  unread: number;
  notices: PlanningCheckupNotice[];
  summary?: { at: string; duplicates: number; pending: number; closed: number };
};
export type PlanningCheckupRead = { id: string } | { all: true };
export type PlanningCheckupReadResult = { projectId: string; changed: number; unread: number };
export type PlanningCommitResult = PlanningDebt | PlanningDecision | PlanningPlan | PlanningProposal | PlanningSweepResult
  | { projectId: string; batchId?: string; items: { id: string; status: 'created' | 'existing'; sourceRef: string }[] };
export type PlanningReceipt = { projectId: string; result: PlanningCommitResult; reused: boolean };

type VersionedDebt = { debtId: string; expectedVersion: number };
type VersionedDecision = { decisionId: string; expectedVersion: number };
type VersionedPlan = { planId: string; expectedVersion: number };
type PlanningCommandFields =
  | ({ type: 'proposal.submit'; source: PlanningProposalSource } & ProposalDraft & ProposalMetadata)
  | { type: 'proposal.accept'; proposalId: string; as?: 'hit' | 'new'; debtId?: string }
  | { type: 'proposal.reject'; proposalId: string; reason: string }
  | ({ type: 'debt.create'; source: PlanningSource; distinction?: PlanningDebtDistinction; assignToSelf?: boolean } & DebtDraft)
  | { type: 'debt.import'; items: PlanningImportRow[] }
  | ({ type: 'debt.update'; patch: DebtPatch } & VersionedDebt)
  | ({ type: 'debt.branch'; decisionId: string | null; reason: string } & VersionedDebt)
  | ({ type: 'debt.defer'; reason: string; reviewAt: string; dueAt?: string | null; trigger?: string | null } & VersionedDebt)
  | ({ type: 'debt.review'; next: 'start' | 'defer' | 'drop'; reason: string; reviewAt?: string } & VersionedDebt)
  | ({ type: 'debt.start' | 'debt.progress'; note: string; evidence?: PlanningEvidence[] } & VersionedDebt)
  | ({ type: 'debt.repay'; summary: string; results: CriterionResult[]; evidence: PlanningEvidence[];
      repaymentProofs?: PlanningRepaymentProof[]; collateral?: VersionedDebt[] } & VersionedDebt)
  | ({ type: 'debt.reopen'; reason: string; evidence?: PlanningEvidence[] } & VersionedDebt)
  | ({ type: 'debt.drop'; kind: Exclude<DebtOutcome, 'merged'>; reason: string; targetId?: string; evidence?: PlanningEvidence[] } & VersionedDebt)
  | ({ type: 'debt.merge'; fromId: string; fromVersion: number; reason: string; takeFrom?: ('title' | 'summary' | 'owner')[] } & VersionedDebt)
  | ({ type: 'debt.not-duplicate'; fromId: string; fromVersion: number; reason: string } & VersionedDebt)
  | ({ type: 'debt.hit'; note: string } & VersionedDebt)
  | ({ type: 'debt.verify' } & Pick<PlanningVerification, 'method' | 'note' | 'validDays' | 'evidence'> & VersionedDebt)
  | ({ type: 'debt.anchor'; anchor: PlanningAnchorTarget | null; reason: string } & VersionedDebt)
  | ({ type: 'debt.anchor-missing'; note: string; evidence: PlanningEvidence[] } & VersionedDebt)
  | ({ type: 'debt.anchor-confirm'; note?: string } & VersionedDebt)
  | { type: 'debt.sweep'; branch?: string }
  | ({ type: 'decision.create'; source: PlanningSource } & DecisionDraft)
  | ({ type: 'decision.change'; change: 'accepted' | 'amended' | 'reviewed' | 'superseded' | 'deprecated'; reason: string;
      successorId?: string; transfer?: boolean; links?: PlanningDecisionLink[]; pullRequest?: PlanningPullRequestReference | null; structure?: DecisionStructure } & VersionedDecision)
  | ({ type: 'plan.create'; source: PlanningSource; initialSteps?: PlanningStepDraft[] } & PlanDraft)
  | ({ type: 'plan.add-step' } & PlanningStepDraft & VersionedPlan)
  | ({ type: 'plan.step'; stepId: string; status: 'todo' | 'doing' | 'done'; note: string } & VersionedPlan);
export type PlanningCommand = PlanningCommandFields & { requestId: string };

export interface EnvAuditFact {
  eventId: string;
  projectId: string;
  scope?: 'global' | 'project' | 'branch' | 'profile';
  profileId?: string;
  branchId?: string;
  branchReason?: string;
  ts: string;
  key: string;
  disposition: 'added' | 'changed' | 'deleted' | 'unchanged' | 'rotated' | 'unknown';
  dispositionReason?: string;
  actor?: string;
  actorReason?: string;
  signer?: string;
  signerReason?: string;
  sessionId?: string;
  sessionReason?: string;
  threadId?: string;
  turnId?: string;
  requestId?: string;
  operationId?: string;
  skillName?: string;
  skillVersion?: string;
  note?: string;
  effect: { state: 'pending' | 'effective' | 'inferred' | 'unknown' | 'not-applicable'; runId?: string; at?: string; reason?: string };
}
