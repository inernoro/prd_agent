import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type {
  ExecutiveOverview,
  ExecutiveTrendItem,
  ExecutiveTeamMember,
  ExecutiveAgentStat,
  ExecutiveModelStat,
  ExecutiveLeaderboard,
  GetExecutiveOverviewContract,
  GetExecutiveTrendsContract,
  GetExecutiveTeamContract,
  GetExecutiveAgentsContract,
  GetExecutiveModelsContract,
  GetExecutiveLeaderboardContract,
} from '@/services/contracts/executive';

export const getExecutiveOverviewReal: GetExecutiveOverviewContract = async (days = 0): Promise<ApiResponse<ExecutiveOverview>> => {
  const d = Math.max(0, Math.floor(days));
  return await apiRequest<ExecutiveOverview>(`${api.executive.overview()}?days=${d}`);
};

export const getExecutiveTrendsReal: GetExecutiveTrendsContract = async (days = 90): Promise<ApiResponse<ExecutiveTrendItem[]>> => {
  const d = Math.max(0, Math.floor(days));
  return await apiRequest<ExecutiveTrendItem[]>(`${api.executive.trends()}?days=${d}`);
};

export const getExecutiveTeamReal: GetExecutiveTeamContract = async (days = 0): Promise<ApiResponse<ExecutiveTeamMember[]>> => {
  const d = Math.max(0, Math.floor(days));
  return await apiRequest<ExecutiveTeamMember[]>(`${api.executive.team()}?days=${d}`);
};

export const getExecutiveAgentsReal: GetExecutiveAgentsContract = async (days = 0): Promise<ApiResponse<ExecutiveAgentStat[]>> => {
  const d = Math.max(0, Math.floor(days));
  return await apiRequest<ExecutiveAgentStat[]>(`${api.executive.agents()}?days=${d}`);
};

export const getExecutiveModelsReal: GetExecutiveModelsContract = async (days = 0): Promise<ApiResponse<ExecutiveModelStat[]>> => {
  const d = Math.max(0, Math.floor(days));
  return await apiRequest<ExecutiveModelStat[]>(`${api.executive.models()}?days=${d}`);
};

export const getExecutiveLeaderboardReal: GetExecutiveLeaderboardContract = async (days = 0): Promise<ApiResponse<ExecutiveLeaderboard>> => {
  const d = Math.max(0, Math.floor(days));
  return await apiRequest<ExecutiveLeaderboard>(`${api.executive.leaderboard()}?days=${d}`);
};
