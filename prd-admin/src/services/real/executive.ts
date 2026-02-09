import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type {
  ExecutiveOverview,
  ExecutiveTrendItem,
  ExecutiveTeamMember,
  ExecutiveAgentStat,
  ExecutiveModelStat,
  GetExecutiveOverviewContract,
  GetExecutiveTrendsContract,
  GetExecutiveTeamContract,
  GetExecutiveAgentsContract,
  GetExecutiveModelsContract,
} from '@/services/contracts/executive';

export const getExecutiveOverviewReal: GetExecutiveOverviewContract = async (days = 7): Promise<ApiResponse<ExecutiveOverview>> => {
  const d = Math.max(1, Math.min(30, Math.floor(days || 7)));
  return await apiRequest<ExecutiveOverview>(`${api.executive.overview()}?days=${d}`);
};

export const getExecutiveTrendsReal: GetExecutiveTrendsContract = async (days = 30): Promise<ApiResponse<ExecutiveTrendItem[]>> => {
  const d = Math.max(7, Math.min(90, Math.floor(days || 30)));
  return await apiRequest<ExecutiveTrendItem[]>(`${api.executive.trends()}?days=${d}`);
};

export const getExecutiveTeamReal: GetExecutiveTeamContract = async (days = 7): Promise<ApiResponse<ExecutiveTeamMember[]>> => {
  const d = Math.max(1, Math.min(30, Math.floor(days || 7)));
  return await apiRequest<ExecutiveTeamMember[]>(`${api.executive.team()}?days=${d}`);
};

export const getExecutiveAgentsReal: GetExecutiveAgentsContract = async (days = 7): Promise<ApiResponse<ExecutiveAgentStat[]>> => {
  const d = Math.max(1, Math.min(30, Math.floor(days || 7)));
  return await apiRequest<ExecutiveAgentStat[]>(`${api.executive.agents()}?days=${d}`);
};

export const getExecutiveModelsReal: GetExecutiveModelsContract = async (days = 7): Promise<ApiResponse<ExecutiveModelStat[]>> => {
  const d = Math.max(1, Math.min(30, Math.floor(days || 7)));
  return await apiRequest<ExecutiveModelStat[]>(`${api.executive.models()}?days=${d}`);
};
