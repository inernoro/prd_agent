export const planningPermissions = ['read', 'propose', 'write', 'approve'] as const;
export const PLANNING_MCP_TOOLS = ['cds_planning_read', 'cds_planning_propose', 'cds_planning_record_debt'] as const;
export type PlanningPermission = typeof planningPermissions[number];
export type PlanningActor = { kind: 'human' | 'agent'; id: string; label: string; permissions: readonly PlanningPermission[] };
export type PlanningIdentity = Pick<PlanningActor, 'kind' | 'id' | 'label'>;

export const planningSourceTypes = ['manual', 'review', 'test', 'incident', 'code', 'adr', 'import'] as const;
export type PlanningSource = { type: typeof planningSourceTypes[number]; ref: string; url?: string };
export const planningEvidenceTypes = ['test', 'change', 'acceptance', 'metric', 'log', 'doc', 'screenshot'] as const;
export type PlanningEvidence = { type: typeof planningEvidenceTypes[number]; label: string; url?: string };

export const debtPriorities = ['high', 'mid', 'low'] as const;
export type DebtPriority = typeof debtPriorities[number];
export type DebtStatus = 'open' | 'deferred' | 'in_progress' | 'repaid' | 'dropped';
export type DebtOutcome = 'cancelled' | 'superseded' | 'extinct' | 'merged';
export type RootCause = { state: 'pending' | 'suspected' | 'confirmed'; text?: string; basis?: string };
export type Criterion = { id: string; text: string };
export type CriterionResult = { criterionId: string; verdict: 'met' | 'na'; note?: string };
export type Repayment = { at: string; by: PlanningIdentity; summary: string; results: CriterionResult[]; evidence: PlanningEvidence[] };
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
  dueAt?: string;
  trigger?: string;
  tags?: string[];
  direction?: DebtDirection;
};
export const clearableDebtFields = ['summary', 'whyDebt', 'impact', 'trigger', 'owner', 'dueAt', 'direction'] as const;
type ClearableDebtField = typeof clearableDebtFields[number];
export type DebtPatch = Partial<Omit<DebtDraft, 'decisionId' | ClearableDebtField>> & {
  [Field in ClearableDebtField]?: DebtDraft[Field] | null;
};
export type DecisionDraft = { title: string; summary?: string; rationale?: string; owner?: string; reviewAt?: string; resolves?: string[] };
export type PlanDraft = { title: string; summary?: string; decisionId?: string; owner?: string; dueAt?: string };

type RecordBase = { id: string; projectId: string; version: number; createdAt: string; updatedAt: string };
export type PlanningDebt = RecordBase & Omit<DebtDraft, 'criteria'> & {
  source: PlanningSource;
  status: DebtStatus;
  priority: DebtPriority;
  criteria: Criterion[];
  originDecisionId?: string;
  reviewAt?: string;
  deferReason?: string;
  repayment?: Repayment;
  outcome?: { kind: DebtOutcome; reason: string; targetId?: string; evidence?: PlanningEvidence[] };
  reopenCount: number;
  hitCount: number;
  discoveredAt?: string;
};
export type PlanningDecision = RecordBase & DecisionDraft & {
  source: PlanningSource;
  status: 'proposed' | 'accepted' | 'superseded' | 'deprecated';
  supersededBy?: string;
  reviewedAt?: string;
};

export const planningStepKinds = ['task', 'decision', 'debt', 'review'] as const;
export type PlanningStep = {
  id: string;
  kind: typeof planningStepKinds[number];
  title: string;
  relatedId?: string;
  dueAt?: string;
  status: 'todo' | 'doing' | 'done' | 'cancelled';
};
export type PlanningPlan = RecordBase & PlanDraft & { source: PlanningSource; steps: PlanningStep[] };
export type ProposalDraft = { kind: 'debt'; draft: DebtDraft } | { kind: 'decision'; draft: DecisionDraft } | { kind: 'plan'; draft: PlanDraft };
export type PlanningRecordKind = ProposalDraft['kind'];
export type PlanningProposal = RecordBase & ProposalDraft & {
  source: PlanningSource;
  author: PlanningIdentity;
  status: 'pending' | 'accepted' | 'rejected';
  handledBy?: PlanningIdentity;
  reason?: string;
  result?: { kind: PlanningRecordKind; id: string };
};

export type PlanningEventKind =
  | 'created' | 'imported' | 'updated' | 'deferred' | 'started' | 'progress' | 'repaid' | 'reopened'
  | 'dropped' | 'extinct' | 'merged' | 'merged_into' | 'hit' | 'branch_moved'
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
  dates?: { dueAt?: [string | null, string | null]; reviewAt?: [string | null, string | null] };
  proposedBy?: PlanningIdentity;
  fromStatus?: DebtStatus;
  toStatus?: DebtStatus;
  fromDecisionId?: string;
  toDecisionId?: string;
};

export type PlanningCapabilities = { projectId: string; protocolVersion: 1; permissions: PlanningPermission[] };
export type PlanningBoard = PlanningCapabilities & {
  today: string;
  proposals: PlanningProposal[];
  decisions: PlanningDecision[];
  plans: PlanningPlan[];
  events: PlanningEvent[];
  pendingReviewCount: number;
};
export type PlanningDebtList = { projectId: string; today: string; items: PlanningDebt[]; nextCursor: string | null };
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
export type PlanningDebtDetail = { projectId: string; debt: PlanningDebt; events: PlanningEvent[]; brief?: PlanningDebtBrief };
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
export type PlanningStats = PlanningCounts & {
  projectId: string;
  from: string;
  to: string;
  backlogStart: number;
  backlogEnd: number;
  buckets: (PlanningCounts & { day: string; backlog: number })[];
  categories: { name: string; unpaid: number; repaid: number; dropped: number }[];
};

export type PlanningCommitResult = PlanningDebt | PlanningDecision | PlanningPlan | PlanningProposal
  | { projectId: string; items: { id: string; status: 'created' | 'existing'; sourceRef: string }[] };
export type PlanningReceipt = { projectId: string; result: PlanningCommitResult; reused: boolean };

type VersionedDebt = { debtId: string; expectedVersion: number };
type VersionedDecision = { decisionId: string; expectedVersion: number };
type VersionedPlan = { planId: string; expectedVersion: number };
type PlanningCommandFields =
  | ({ type: 'proposal.submit'; source: PlanningSource } & ProposalDraft)
  | { type: 'proposal.accept'; proposalId: string }
  | { type: 'proposal.reject'; proposalId: string; reason: string }
  | ({ type: 'debt.create'; source: PlanningSource } & DebtDraft)
  | { type: 'debt.import'; items: (DebtDraft & { source: PlanningSource; discoveredAt?: string })[] }
  | ({ type: 'debt.update'; patch: DebtPatch } & VersionedDebt)
  | ({ type: 'debt.branch'; decisionId: string | null; reason: string } & VersionedDebt)
  | ({ type: 'debt.defer'; reason: string; reviewAt: string } & VersionedDebt)
  | ({ type: 'debt.start' | 'debt.progress'; note: string } & VersionedDebt)
  | ({ type: 'debt.repay'; summary: string; results: CriterionResult[]; evidence: PlanningEvidence[] } & VersionedDebt)
  | ({ type: 'debt.reopen'; reason: string } & VersionedDebt)
  | ({ type: 'debt.drop'; kind: Exclude<DebtOutcome, 'merged'>; reason: string; targetId?: string; evidence?: PlanningEvidence[] } & VersionedDebt)
  | ({ type: 'debt.merge'; fromId: string; fromVersion: number; reason: string } & VersionedDebt)
  | ({ type: 'debt.hit'; note: string } & VersionedDebt)
  | ({ type: 'decision.create'; source: PlanningSource } & DecisionDraft)
  | ({ type: 'decision.change'; change: 'accepted' | 'amended' | 'reviewed' | 'superseded' | 'deprecated'; reason: string; successorId?: string; transfer?: boolean } & VersionedDecision)
  | ({ type: 'plan.create'; source: PlanningSource } & PlanDraft)
  | ({ type: 'plan.add-step'; kind: PlanningStep['kind']; title: string; relatedId?: string; dueAt?: string } & VersionedPlan)
  | ({ type: 'plan.step'; stepId: string; status: 'todo' | 'doing' | 'done'; note: string } & VersionedPlan);
export type PlanningCommand = PlanningCommandFields & { requestId: string };
