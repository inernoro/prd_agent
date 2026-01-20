import { apiRequest } from '@/services/real/apiClient';
import { ok, type ApiResponse } from '@/types/api';
import type { GetActiveGroupsContract, GetGapStatsContract, GetMessageTrendContract, GetOverviewStatsContract, GetTokenUsageContract, OverviewStats, TokenUsage, TrendItem, ActiveGroup, GapStats } from '@/services/contracts/adminStats';

type BackendOverview = OverviewStats & Record<string, unknown>;

type BackendTokenUsage = {
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  dailyUsage?: unknown;
};

export const getOverviewStatsReal: GetOverviewStatsContract = async (): Promise<ApiResponse<OverviewStats>> => {
  const res = await apiRequest<BackendOverview>(`/api/logs/stats/overview`);
  if (!res.success) return res;
  return ok({
    totalUsers: res.data.totalUsers ?? 0,
    activeUsers: res.data.activeUsers ?? 0,
    totalGroups: res.data.totalGroups ?? 0,
    todayMessages: res.data.todayMessages ?? 0,
  });
};

export const getTokenUsageReal: GetTokenUsageContract = async (days = 7): Promise<ApiResponse<TokenUsage>> => {
  const d = Math.max(1, Math.min(30, Math.floor(days || 7)));
  const res = await apiRequest<BackendTokenUsage>(`/api/logs/stats/token-usage?days=${d}`);
  if (!res.success) return res as unknown as ApiResponse<TokenUsage>;
  return ok({
    totalInput: res.data.totalInput ?? 0,
    totalOutput: res.data.totalOutput ?? 0,
    totalTokens: res.data.totalTokens ?? (res.data.totalInput ?? 0) + (res.data.totalOutput ?? 0),
  });
};

export const getMessageTrendReal: GetMessageTrendContract = async (days = 14): Promise<ApiResponse<TrendItem[]>> => {
  const d = Math.max(1, Math.min(90, Math.floor(days || 14)));
  return await apiRequest<TrendItem[]>(`/api/logs/stats/message-trend?days=${d}`);
};

export const getActiveGroupsReal: GetActiveGroupsContract = async (limit = 10): Promise<ApiResponse<ActiveGroup[]>> => {
  const n = Math.max(1, Math.min(50, Math.floor(limit || 10)));
  return await apiRequest<ActiveGroup[]>(`/api/logs/stats/active-groups?limit=${n}`);
};

export const getGapStatsReal: GetGapStatsContract = async (): Promise<ApiResponse<GapStats>> => {
  const res = await apiRequest<GapStats>(`/api/logs/stats/gap-stats`);
  if (!res.success) return res;
  // 后端 byType 可能是固定字段对象，这里保持为 Record<string, number> 视角
  return ok({
    total: res.data.total ?? 0,
    byStatus: res.data.byStatus ?? { pending: 0, resolved: 0, ignored: 0 },
    byType: (res.data.byType ?? {}) as Record<string, number>,
  });
};





