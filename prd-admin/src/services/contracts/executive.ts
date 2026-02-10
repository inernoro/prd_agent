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
};

export type ExecutiveModelStat = {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgDurationMs: number;
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
  category: 'agent' | 'activity';
  values: Record<string, number>;
};

export type ExecutiveLeaderboard = {
  users: LeaderboardUser[];
  dimensions: LeaderboardDimension[];
};

export type GetExecutiveOverviewContract = (days?: number) => Promise<ApiResponse<ExecutiveOverview>>;
export type GetExecutiveTrendsContract = (days?: number) => Promise<ApiResponse<ExecutiveTrendItem[]>>;
export type GetExecutiveTeamContract = (days?: number) => Promise<ApiResponse<ExecutiveTeamMember[]>>;
export type GetExecutiveAgentsContract = (days?: number) => Promise<ApiResponse<ExecutiveAgentStat[]>>;
export type GetExecutiveModelsContract = (days?: number) => Promise<ApiResponse<ExecutiveModelStat[]>>;
export type GetExecutiveLeaderboardContract = (days?: number) => Promise<ApiResponse<ExecutiveLeaderboard>>;
