import type { ApiResponse } from '@/types/api';

// ── 数据类型 ──

export type PmProjectType = 'strategic' | 'innovation' | 'operation';
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
  role: PmStakeholderRole;
  power: PmStakeholderAxis;
  interest: PmStakeholderAxis;
  score?: number | null;
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
  stakeholders: PmStakeholder[];
  evaluation?: PmEvaluation | null;
  createdAt: string;
  updatedAt: string;
};

export type PmRewardConfig = {
  id: string;
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
  memberIds: string[];
}>;

export type UpdateRewardConfigInput = Partial<{
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
export type ListPmProjectsContract = (page?: number, pageSize?: number, type?: PmProjectType) => Promise<ApiResponse<{ items: PmProject[]; total: number; page: number; pageSize: number }>>;
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
    name: string;
    userId?: string;
    role: PmStakeholderRole;
    power: PmStakeholderAxis;
    interest: PmStakeholderAxis;
  }>;
};
export type SetPmStakeholdersContract = (projectId: string, input: SetStakeholdersInput) => Promise<ApiResponse<{ stakeholders: PmStakeholder[] }>>;
export type EvaluatePmProjectContract = (projectId: string, scores: Record<string, number>) => Promise<ApiResponse<{ evaluation: PmEvaluation }>>;
export type GetPmDashboardContract = (fiscalYear?: number) => Promise<ApiResponse<PmDashboard>>;
export type GetPmRewardConfigContract = () => Promise<ApiResponse<PmRewardConfig>>;
export type UpdatePmRewardConfigContract = (input: UpdateRewardConfigInput) => Promise<ApiResponse<PmRewardConfig>>;
export type TogglePmExcellenceContract = (projectId: string, isExcellent: boolean) => Promise<ApiResponse<{ id: string; isExcellent: boolean }>>;
