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
};

export type PmTask = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  parentTaskId?: string | null;
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
export type GetPmMembersContract = (projectId: string) => Promise<ApiResponse<{ members: PmMember[]; leaderId: string; ownerId: string }>>;
export type SetPmMembersContract = (projectId: string, memberIds: string[]) => Promise<ApiResponse<{ members: PmMember[]; memberIds: string[] }>>;
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
export type AddPmTaskCommentContract = (taskId: string, content: string) => Promise<ApiResponse<PmTaskActivity>>;
export type BulkPmTasksContract = (projectId: string, input: BulkTasksInput) => Promise<ApiResponse<{ matched?: number; modified?: number; deletedCount?: number }>>;
