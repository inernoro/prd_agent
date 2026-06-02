import type { ApiResponse } from '@/types/api';

// ── 数据类型 ──

export type PmProjectType = 'general' | 'strategic' | 'innovation' | 'operation';
export type PmOperationSubType = 'routine' | 'rectification' | 'supervision';
export type PmProjectLifecycle = 'registered' | 'running' | 'closing' | 'evaluated' | 'archived';
export type PmTaskStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'cancelled';
export type PmTaskPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
export type PmStakeholderRole = 'beneficiary' | 'management' | 'team' | 'other';
export type PmStakeholderAxis = 'high' | 'low';
export type PmEvaluationGrade = 'success' | 'mediocre' | 'fail';

export type PmStakeholder = {
  id: string;
  name: string;
  userId?: string | null;
  isRepresentative: boolean;
  note?: string | null;
  role: PmStakeholderRole;
  power: PmStakeholderAxis;
  interest: PmStakeholderAxis;
};

export type PmEvaluationParticipant = {
  stakeholderId: string;
  userId?: string | null;
  name: string;
  isRepresentative?: boolean;
  note?: string | null;
  role: PmStakeholderRole;
  score?: number | null;
  scoredAt?: string | null;
  scoredBy?: string | null;
};

export type PmEvaluationRound = {
  status: 'collecting' | 'finalized';
  initiatedBy: string;
  initiatedByName?: string | null;
  initiatedAt: string;
  finalizedAt?: string | null;
  participants: PmEvaluationParticipant[];
  result?: PmEvaluation | null;
};

export type PmEvaluation = {
  satisfactionScore: number;
  grade: PmEvaluationGrade;
  roleAverages: Record<string, number>;
  evaluatedAt: string;
  evaluatedBy: string;
};

export type PmProject = {
  id: string;
  projectNo: string;
  title: string;
  description?: string;
  businessGoal: string;
  projectType: PmProjectType;
  operationSubType?: PmOperationSubType | null;
  lifecycle: PmProjectLifecycle;
  leaderId: string;
  leaderName?: string;
  memberIds: string[];
  observerIds: string[];
  strategyAlignment?: string;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  closedAt?: string | null;
  budget?: number | null;
  actualCost?: number | null;
  ownerId: string;
  taskCount: number;
  doneTaskCount: number;
  valueCoefficient: number;
  isExcellent: boolean;
  excellenceAwardedAt?: string | null;
  wipLimits?: Partial<Record<PmTaskStatus, number>> | null;
  stakeholders: PmStakeholder[];
  evaluation?: PmEvaluation | null;
  evaluationRound?: PmEvaluationRound | null;
  createdAt: string;
  updatedAt: string;
};

export type PmRewardConfig = {
  id: string;
  generalBase: number;
  strategicBase: number;
  innovationBase: number;
  operationRoutineBase: number;
  moreVision: number;
  moreOutcome: number;
  moreRapid: number;
  moreEmpowered: number;
  fiscalYearStartMonth: number;
  excellenceBonusBase: number;
  updatedAt: string;
};

export type PmProjectBonus = {
  id: string;
  projectNo: string;
  title: string;
  projectType: PmProjectType;
  operationSubType?: PmOperationSubType | null;
  grade: PmEvaluationGrade;
  satisfactionScore: number;
  valueCoefficient: number;
  isExcellent: boolean;
  bonus: number;
};

export type PmNpssStats = {
  totalEvaluated: number;
  successCount: number;
  mediocreCount: number;
  failCount: number;
  npss: number;
  totalBonus: number;
};

export type PmQuarterStats = { quarter: number; stats: PmNpssStats };

export type PmCostMetrics = {
  onTimeRate: number;       // -1 表示无数据
  onTimeBase: number;
  budgetControlRate: number; // -1 表示无数据
  budgetBase: number;
  totalBudget: number;
  totalActualCost: number;
};

export type PmTaskActivity = {
  id: string;
  taskId: string;
  projectId: string;
  type: 'comment' | 'change';
  userId: string;
  userName?: string | null;
  content?: string | null;
  field?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  createdAt: string;
};

export type BulkTasksInput = {
  taskIds: string[];
  delete?: boolean;
  status?: PmTaskStatus;
  priority?: PmTaskPriority;
  assigneeId?: string;
};

export type PmDashboard = {
  totalEvaluated: number;
  successCount: number;
  mediocreCount: number;
  failCount: number;
  npss: number;
  baseline: number;
  totalBonus: number;
  projects: PmProjectBonus[];
  rewardConfig: PmRewardConfig;
  fiscalYear?: number | null;
  availableFiscalYears: number[];
  quarters: PmQuarterStats[];
  excellentProjects: PmProjectBonus[];
  costMetrics: PmCostMetrics;
  portfolioHealth?: PmPortfolioHealth;
};

export type PmProjectHealthRow = {
  id: string;
  projectNo: string;
  title: string;
  projectType: PmProjectType;
  health: 'red' | 'yellow' | 'green';
  reason: string;
  progress: number;
  taskCount: number;
  doneTaskCount: number;
  overdueCount: number;
  highRiskCount: number;
  budgetUtil: number; // -1=未设预算
  leaderName?: string | null;
};
export type PmPortfolioHealth = {
  activeCount: number;
  redCount: number;
  yellowCount: number;
  greenCount: number;
  avgProgress: number;
  projects: PmProjectHealthRow[];
};

export type PmTask = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  parentTaskId?: string | null;
  milestoneId?: string | null;
  goalId?: string | null;
  status: PmTaskStatus;
  priority: PmTaskPriority;
  assigneeId?: string | null;
  assigneeName?: string | null;
  estimateDays?: number | null;
  startAt?: string | null;
  dueAt?: string | null;
  dependsOn: string[];
  labels: string[];
  orderKey: number;
  source: 'manual' | 'ai_decompose';
  sourceRef?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** AI 拆解出的任务草稿（SSE 流式返回，未落库） */
export type PmTaskDraft = {
  title: string;
  description?: string;
  priority: PmTaskPriority;
  estimateDays?: number | null;
  dependsOnTitles: string[];
  sourceRef?: string | null;
  labels: string[];
};

// ── 请求类型 ──

export type CreatePmProjectInput = {
  title: string;
  description?: string;
  businessGoal: string;
  projectType: PmProjectType;
  operationSubType?: PmOperationSubType;
  leaderId?: string;
  memberIds?: string[];
  strategyAlignment?: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
  budget?: number;
};

export type UpdatePmProjectInput = Partial<{
  title: string;
  description: string;
  businessGoal: string;
  strategyAlignment: string;
  lifecycle: PmProjectLifecycle;
  plannedStartAt: string;
  plannedEndAt: string;
  budget: number;
  actualCost: number;
  valueCoefficient: number;
  wipLimits: Record<string, number>;
  memberIds: string[];
}>;

export type UpdateRewardConfigInput = Partial<{
  generalBase: number;
  strategicBase: number;
  innovationBase: number;
  operationRoutineBase: number;
  moreVision: number;
  moreOutcome: number;
  moreRapid: number;
  moreEmpowered: number;
  fiscalYearStartMonth: number;
  excellenceBonusBase: number;
}>;

export type CreatePmTaskInput = Partial<Omit<PmTask, 'id' | 'projectId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'source' | 'dependsOn' | 'labels'>> & {
  title: string;
  dependsOn?: string[];
  labels?: string[];
};

export type UpdatePmTaskInput = Partial<{
  title: string;
  description: string;
  status: PmTaskStatus;
  priority: PmTaskPriority;
  assigneeId: string;
  estimateDays: number;
  startAt: string;
  dueAt: string;
  dependsOn: string[];
  labels: string[];
  orderKey: number;
  milestoneId: string;
  goalId: string;
}>;

export type BatchCreatePmTasksInput = {
  tasks: Array<{
    title: string;
    description?: string;
    priority?: PmTaskPriority;
    estimateDays?: number | null;
    dependsOnTitles?: string[];
    sourceRef?: string | null;
    labels?: string[];
  }>;
};

// ── Contract 签名 ──

export type CreatePmProjectContract = (input: CreatePmProjectInput) => Promise<ApiResponse<PmProject>>;
export type PmProjectScope = 'managed' | 'related' | 'all';

export type ListPmProjectsContract = (
  opts?: { page?: number; pageSize?: number; type?: PmProjectType; scope?: PmProjectScope }
) => Promise<ApiResponse<{ items: PmProject[]; total: number; page: number; pageSize: number }>>;

export type PmMember = { userId: string; displayName: string; avatarFileName?: string | null };
export type GetPmMembersContract = (projectId: string) => Promise<ApiResponse<{ members: PmMember[]; observers: PmMember[]; leaderId: string; ownerId: string }>>;
export type SetPmMembersContract = (projectId: string, memberIds: string[]) => Promise<ApiResponse<{ members: PmMember[]; memberIds: string[] }>>;
export type SetPmObserversContract = (projectId: string, observerIds: string[]) => Promise<ApiResponse<{ observers: PmMember[]; observerIds: string[] }>>;

// ── 知识库 ──
export type PmKnowledgeFile = {
  id: string;
  projectId: string;
  fileName: string;
  contentType: string;
  fileSize: number;
  url: string;
  category: string;
  uploaderId: string;
  uploaderName?: string | null;
  createdAt: string;
  updatedAt: string;
};
export type PmMemberSite = {
  userId: string;
  userName: string;
  siteId: string;
  title: string;
  url: string;
  /** public | private —— private 仅表示未在公开页列出，项目内仍可访问 */
  visibility?: string;
  coverImageUrl?: string | null;
  viewCount?: number;
  tags?: string[];
  updatedAt?: string;
};

export type ListPmKnowledgeFilesContract = (projectId: string, category?: string) => Promise<ApiResponse<{ files: PmKnowledgeFile[]; categories: string[] }>>;
export type UpdatePmKnowledgeFileContract = (fileId: string, input: { fileName?: string; category?: string }) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmKnowledgeFileContract = (fileId: string) => Promise<ApiResponse<{ deleted: boolean }>>;
export type GetPmMemberSitesContract = (projectId: string) => Promise<ApiResponse<{ sites: PmMemberSite[] }>>;
/** 解析项目知识库绑定的 DocumentStore（find-or-create），前端据此渲染 DocBrowser */
export type GetPmKnowledgeStoreContract = (projectId: string) => Promise<ApiResponse<{ storeId: string; canWrite: boolean }>>;

// ── 决策事项 ──
export type PmDecisionType = 'pending' | 'decided' | 'memo';
export type PmDecision = {
  id: string;
  projectId: string;
  title: string;
  content?: string | null;
  type: PmDecisionType;
  decidedBy?: string | null;
  decidedByName?: string | null;
  decidedAt?: string | null;
  /** 关联目标 ID 列表 */
  relatedGoalIds?: string[];
  /** 关联任务 ID 列表 */
  relatedTaskIds?: string[];
  createdBy: string;
  createdByName?: string | null;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
};
export type CreatePmDecisionInput = { title: string; content?: string; type?: PmDecisionType; relatedGoalIds?: string[]; relatedTaskIds?: string[] };
export type UpdatePmDecisionInput = Partial<{ title: string; content: string; type: PmDecisionType; orderKey: number; relatedGoalIds: string[]; relatedTaskIds: string[] }>;
export type ListPmDecisionsContract = (projectId: string) => Promise<ApiResponse<{ items: PmDecision[] }>>;
export type CreatePmDecisionContract = (projectId: string, input: CreatePmDecisionInput) => Promise<ApiResponse<PmDecision>>;
export type UpdatePmDecisionContract = (decisionId: string, input: UpdatePmDecisionInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmDecisionContract = (decisionId: string) => Promise<ApiResponse<{ deleted: boolean }>>;

// ── 项目周报 ──
export type PmWeeklyReport = {
  id: string;
  projectId: string;
  title: string;
  weekStart?: string | null;
  content: string;
  authorId: string;
  authorName?: string | null;
  relatedGoalIds?: string[];
  relatedTaskIds?: string[];
  sourceType?: string | null;
  sourceReportId?: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SavePmWeeklyReportInput = { title?: string; content?: string; weekStart?: string; relatedGoalIds?: string[]; relatedTaskIds?: string[] };
export type ListPmWeeklyReportsContract = (projectId: string) => Promise<ApiResponse<{ items: PmWeeklyReport[] }>>;
export type CreatePmWeeklyReportContract = (projectId: string, input: SavePmWeeklyReportInput) => Promise<ApiResponse<PmWeeklyReport>>;
export type UpdatePmWeeklyReportContract = (reportId: string, input: SavePmWeeklyReportInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmWeeklyReportContract = (reportId: string) => Promise<ApiResponse<{ deleted: boolean }>>;

/** 可导入的个人周报（report-agent，当前用户可见范围内） */
export type ImportableWeeklyReport = {
  id: string;
  userId: string;
  userName?: string | null;
  teamId: string;
  teamName?: string | null;
  weekYear: number;
  weekNumber: number;
  status: string;
  periodStart: string;
  periodEnd: string;
  isMine: boolean;
  sectionCount: number;
};
export type ListImportableWeeklyReportsContract = (params?: { weekYear?: number; weekNumber?: number }) => Promise<ApiResponse<{ items: ImportableWeeklyReport[] }>>;
export type ImportWeeklyReportContract = (projectId: string, input: { sourceReportId: string; relatedGoalIds?: string[]; relatedTaskIds?: string[] }) => Promise<ApiResponse<PmWeeklyReport>>;

// ── 会议纪要 ──
export type PmMeeting = {
  id: string;
  projectId: string;
  title: string;
  meetingAt?: string | null;
  location?: string | null;
  attendeeIds: string[];
  content: string;
  recordedBy: string;
  recordedByName?: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SavePmMeetingInput = { title?: string; meetingAt?: string; location?: string; attendeeIds?: string[]; content?: string };
export type ListPmMeetingsContract = (projectId: string) => Promise<ApiResponse<{ items: PmMeeting[]; attendees: PmMember[] }>>;
export type CreatePmMeetingContract = (projectId: string, input: SavePmMeetingInput) => Promise<ApiResponse<PmMeeting>>;
export type UpdatePmMeetingContract = (meetingId: string, input: SavePmMeetingInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmMeetingContract = (meetingId: string) => Promise<ApiResponse<{ deleted: boolean }>>;

// ── 目标 / 计划 ──
export type PmGoalScope = 'team' | 'personal';
export type PmGoalStatus = 'on_track' | 'at_risk' | 'done' | 'abandoned';
export type PmGoal = {
  id: string;
  projectId: string;
  scope: PmGoalScope;
  /** 父目标 id；null/缺省=顶层目标 */
  parentId?: string | null;
  /** 层级深度，顶层=0 */
  depth?: number;
  /** 直接子目标数量 */
  childCount?: number;
  ownerId: string;
  title: string;
  description?: string | null;
  metric?: string | null;
  period?: string | null;
  progress: number;
  progressMode: 'auto' | 'manual';
  linkedMilestoneCount?: number;
  status: PmGoalStatus;
  createdBy: string;
  createdByName?: string | null;
  orderKey: number;
  createdAt: string;
  updatedAt: string;
};
export type SavePmGoalInput = Partial<{ scope: PmGoalScope; parentId: string; title: string; description: string; metric: string; period: string; progress: number; progressMode: 'auto' | 'manual'; status: PmGoalStatus; orderKey: number }>;
/** AI 拆解出的目标草稿（SSE 返回，未落库） */
export type PmGoalDraft = { title: string; description?: string | null; metric?: string | null; period?: string | null };
export type ListPmGoalsContract = (projectId: string) => Promise<ApiResponse<{ items: PmGoal[] }>>;
export type CreatePmGoalContract = (projectId: string, input: SavePmGoalInput) => Promise<ApiResponse<PmGoal>>;
export type UpdatePmGoalContract = (goalId: string, input: SavePmGoalInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmGoalContract = (goalId: string) => Promise<ApiResponse<{ deleted: boolean }>>;

// ── 审计日志 ──
export type PmAuditLog = {
  id: string;
  projectId?: string | null;
  projectNo?: string | null;
  projectTitle?: string | null;
  actorId: string;
  actorName?: string | null;
  action: string;
  actionLabel: string;
  method: string;
  path: string;
  targetId?: string | null;
  createdAt: string;
};
export type ListPmAuditLogsContract = (opts?: { projectId?: string; page?: number; pageSize?: number }) => Promise<ApiResponse<{ items: PmAuditLog[]; total: number; page: number; pageSize: number }>>;

// ── 里程碑 ──
export type PmMilestoneStatus = 'planned' | 'reached' | 'cancelled';
export type PmMilestoneHealth = 'on_track' | 'at_risk' | 'overdue' | 'reached' | 'cancelled';
export type PmMilestoneCriterion = { id: string; text: string; done: boolean };
export type PmDeliverableType = 'weekly' | 'decision' | 'link';
export type PmDeliverableRef = { type: PmDeliverableType; refId?: string | null; title: string; url?: string | null };
export type PmMilestone = {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  dueAt?: string | null;
  reachedAt?: string | null;
  goalId?: string | null;
  ownerId?: string | null;
  ownerName?: string | null;
  acceptanceCriteria?: PmMilestoneCriterion[];
  criteriaTotal?: number;
  criteriaDone?: number;
  /** 前置里程碑 Id */
  dependsOn?: string[];
  deliverables?: PmDeliverableRef[];
  /** 前置未达成 → 受阻 */
  blocked?: boolean;
  blockedBy?: string[];
  status: PmMilestoneStatus;
  orderKey: number;
  taskTotal: number;
  taskDone: number;
  progress: number;
  /** 达成日 - 计划截止日（天）：正=延期，负=提前 */
  slippageDays?: number | null;
  health: PmMilestoneHealth;
  createdAt: string;
  updatedAt: string;
};
export type SavePmMilestoneInput = Partial<{
  title: string; description: string; dueAt: string; goalId: string; ownerId: string;
  acceptanceCriteria: { id?: string; text: string; done: boolean }[];
  dependsOn: string[];
  deliverables: { type: PmDeliverableType; refId?: string; title: string; url?: string }[];
  status: PmMilestoneStatus; orderKey: number;
}>;
export type ListPmMilestonesContract = (projectId: string) => Promise<ApiResponse<{ items: PmMilestone[] }>>;
export type CreatePmMilestoneContract = (projectId: string, input: SavePmMilestoneInput) => Promise<ApiResponse<PmMilestone>>;
export type UpdatePmMilestoneContract = (milestoneId: string, input: SavePmMilestoneInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmMilestoneContract = (milestoneId: string) => Promise<ApiResponse<{ deleted: boolean }>>;

// ── 风险登记册 ──
export type PmRiskLevel = 'high' | 'medium' | 'low';
export type PmRiskResponse = 'open' | 'avoid' | 'transfer' | 'mitigate' | 'accept';
export type PmRiskStatus = 'open' | 'mitigating' | 'closed';
export type PmRisk = {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  probability: PmRiskLevel;
  impact: PmRiskLevel;
  response: PmRiskResponse;
  status: PmRiskStatus;
  ownerId?: string | null;
  ownerName?: string | null;
  relatedGoalId?: string | null;
  relatedTaskId?: string | null;
  /** 来源决策 ID —— 本风险由哪条决策衍生 */
  relatedDecisionId?: string | null;
  /** 关联里程碑 ID —— 本风险威胁哪个阶段节点 */
  relatedMilestoneId?: string | null;
  orderKey: number;
  createdBy: string;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SavePmRiskInput = Partial<{ title: string; description: string; probability: PmRiskLevel; impact: PmRiskLevel; response: PmRiskResponse; status: PmRiskStatus; ownerId: string; relatedGoalId: string; relatedTaskId: string; relatedDecisionId: string; relatedMilestoneId: string; orderKey: number }>;
export type ListPmRisksContract = (projectId: string) => Promise<ApiResponse<{ items: PmRisk[] }>>;
export type CreatePmRiskContract = (projectId: string, input: SavePmRiskInput) => Promise<ApiResponse<PmRisk>>;
export type UpdatePmRiskContract = (riskId: string, input: SavePmRiskInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmRiskContract = (riskId: string) => Promise<ApiResponse<{ deleted: boolean }>>;

// ── 项目级燃尽 / 预算挣值报表 ──
export type PmBurndownPoint = {
  date: string;
  scope: number;
  done: number | null;
  remaining: number | null;
  ideal: number;
  pv: number | null;
  ev: number | null;
};
export type PmBurndown = {
  start: string;
  plannedEnd: string;
  today: string;
  totalScope: number;
  doneCount: number;
  remaining: number;
  completionRate: number;
  overdue: boolean;
  spi: number | null;
  budget: number | null;
  actualCost: number | null;
  earnedValue: number | null;
  plannedValue: number | null;
  points: PmBurndownPoint[];
};
export type GetPmBurndownContract = (projectId: string) => Promise<ApiResponse<PmBurndown>>;
export type GetPmProjectContract = (projectId: string) => Promise<ApiResponse<{ project: PmProject; tasks: PmTask[] }>>;
export type UpdatePmProjectContract = (projectId: string, input: UpdatePmProjectInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmProjectContract = (projectId: string) => Promise<ApiResponse<{ deleted: boolean }>>;
export type CreatePmTaskContract = (projectId: string, input: CreatePmTaskInput) => Promise<ApiResponse<PmTask>>;
export type BatchCreatePmTasksContract = (projectId: string, input: BatchCreatePmTasksInput) => Promise<ApiResponse<{ items: PmTask[]; count: number }>>;
export type UpdatePmTaskContract = (taskId: string, input: UpdatePmTaskInput) => Promise<ApiResponse<{ updated: boolean }>>;
export type DeletePmTaskContract = (taskId: string) => Promise<ApiResponse<{ deletedCount: number }>>;

export type SetStakeholdersInput = {
  stakeholders: Array<{
    id?: string;
    userId: string;
    isRepresentative?: boolean;
    note?: string;
    role: PmStakeholderRole;
    power: PmStakeholderAxis;
    interest: PmStakeholderAxis;
  }>;
};
export type SetPmStakeholdersContract = (projectId: string, input: SetStakeholdersInput) => Promise<ApiResponse<{ stakeholders: PmStakeholder[] }>>;
export type StartPmEvaluationContract = (projectId: string) => Promise<ApiResponse<{ round: PmEvaluationRound }>>;
export type SubmitPmScoreContract = (projectId: string, stakeholderId: string, score: number) => Promise<ApiResponse<{ scored: number; total: number }>>;
export type FinalizePmEvaluationContract = (projectId: string) => Promise<ApiResponse<{ round: PmEvaluationRound }>>;
export type GetPmDashboardContract = (fiscalYear?: number) => Promise<ApiResponse<PmDashboard>>;
export type GetPmRewardConfigContract = () => Promise<ApiResponse<PmRewardConfig>>;
export type UpdatePmRewardConfigContract = (input: UpdateRewardConfigInput) => Promise<ApiResponse<PmRewardConfig>>;
export type TogglePmExcellenceContract = (projectId: string, isExcellent: boolean) => Promise<ApiResponse<{ id: string; isExcellent: boolean }>>;
export type GetPmTaskActivitiesContract = (taskId: string) => Promise<ApiResponse<{ items: PmTaskActivity[] }>>;
export type AddPmTaskCommentContract = (taskId: string, content: string, mentionedUserIds?: string[]) => Promise<ApiResponse<PmTaskActivity>>;
export type BulkPmTasksContract = (projectId: string, input: BulkTasksInput) => Promise<ApiResponse<{ matched?: number; modified?: number; deletedCount?: number }>>;
