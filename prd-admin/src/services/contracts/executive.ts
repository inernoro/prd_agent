import type { ApiResponse } from '@/types/api';

export type ExecutiveOverview = {
  totalUsers: number;
  activeUsers: number;
  prevActiveUsers: number;
  periodMessages: number;
  prevMessages: number;
  periodTokens: number;
  prevTokens: number;
  llmCalls: number;
  totalDefects: number;
  resolvedDefects: number;
  defectResolutionRate: number;
  periodImages: number;
  days: number;
};

export type ExecutiveTrendItem = {
  date: string;
  messages: number;
  tokens: number;
};

export type ExecutiveTeamMember = {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarFileName: string | null;
  lastActiveAt: string | null;
  isActive: boolean;
  messages: number;
  sessions: number;
  defectsCreated: number;
  defectsResolved: number;
  imageRuns: number;
};

export type ExecutiveAgentStat = {
  appKey: string;
  name: string;
  calls: number;
  users: number;
  tokens: number;
  avgDurationMs: number;
  llmCalls: number;
  apiCalls: number;
};

export type ExecutiveModelStat = {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  imageCount: number;
  tokenCost: number;
  callCost: number;
  totalCost: number;
  hasPricing: boolean;
};

export type LeaderboardUser = {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  avatarFileName: string | null;
  lastActiveAt: string | null;
  isActive: boolean;
};

export type LeaderboardDimension = {
  key: string;
  name: string;
  category: 'agent' | 'activity' | 'image';
  values: Record<string, number>;
  /** 口径说明（怎么算的）—— 后端单一来源，前端直接渲染 */
  description?: string;
  /** 怎么操作会让这一项 +1 */
  howToIncrease?: string;
  /** 排除了哪些异常/奇异数据 */
  anomalyNote?: string;
  /** 缺陷列专用：每个用户的提交/解决拆解 */
  subValues?: Record<string, { created: number; resolved: number }>;
};

export type ExecutiveLeaderboard = {
  users: LeaderboardUser[];
  dimensions: LeaderboardDimension[];
  totalDays: number;
};

export type GetExecutiveOverviewContract = (days?: number) => Promise<ApiResponse<ExecutiveOverview>>;
export type GetExecutiveTrendsContract = (days?: number) => Promise<ApiResponse<ExecutiveTrendItem[]>>;
export type GetExecutiveTeamContract = (days?: number) => Promise<ApiResponse<ExecutiveTeamMember[]>>;
export type GetExecutiveAgentsContract = (days?: number) => Promise<ApiResponse<ExecutiveAgentStat[]>>;
export type GetExecutiveModelsContract = (days?: number) => Promise<ApiResponse<ExecutiveModelStat[]>>;
export type GetExecutiveLeaderboardContract = (days?: number) => Promise<ApiResponse<ExecutiveLeaderboard>>;
