import type { ApiResponse } from '@/types/api';

export type OverviewStats = {
  totalUsers: number;
  activeUsers: number;
  totalGroups: number;
  todayMessages: number;
};

export type TokenUsage = {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
};

export type GetOverviewStatsContract = () => Promise<ApiResponse<OverviewStats>>;
export type GetTokenUsageContract = (days?: number) => Promise<ApiResponse<TokenUsage>>;

export type TrendItem = { date: string; count: number };
export type GetMessageTrendContract = (days?: number) => Promise<ApiResponse<TrendItem[]>>;

export type ActiveGroup = {
  groupId: string;
  groupName: string;
  memberCount: number;
  messageCount: number;
  gapCount: number;
};
export type GetActiveGroupsContract = (limit?: number) => Promise<ApiResponse<ActiveGroup[]>>;

export type GapStats = {
  total: number;
  byStatus: { pending: number; resolved: number; ignored: number };
  byType: Record<string, number>;
};
export type GetGapStatsContract = () => Promise<ApiResponse<GapStats>>;
