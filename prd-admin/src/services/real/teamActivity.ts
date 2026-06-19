import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type {
  GetTeamActivityExperienceMapContract,
  GetTeamActivityExperienceMapParams,
  GetTeamActivityInsightsContract,
  GetTeamActivityInsightsParams,
  GetTeamActivityLogsContract,
  GetTeamActivityModulesContract,
  GetTeamActivityParams,
  GetTeamActivityStatsContract,
  GetTeamActivityStatsParams,
  SetInsightStateParams,
  SetTeamActivityInsightStateContract,
  TeamActivityExperienceMapData,
  TeamActivityInsightsData,
  TeamActivityListData,
  TeamActivityModulesData,
  TeamActivityStatsData,
} from '@/services/contracts/teamActivity';

function toQuery(
  params?:
    | GetTeamActivityParams
    | GetTeamActivityStatsParams
    | GetTeamActivityInsightsParams
    | GetTeamActivityExperienceMapParams
) {
  const sp = new URLSearchParams();
  if (!params) return '';
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim();
    if (!s) return;
    sp.set(k, s);
  });
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

export const getTeamActivityLogsReal: GetTeamActivityLogsContract = async (
  params?: GetTeamActivityParams
): Promise<ApiResponse<TeamActivityListData>> => {
  return await apiRequest<TeamActivityListData>(`${api.teamActivity.logs()}${toQuery(params)}`, { method: 'GET' });
};

export const getTeamActivityModulesReal: GetTeamActivityModulesContract = async (): Promise<
  ApiResponse<TeamActivityModulesData>
> => {
  return await apiRequest<TeamActivityModulesData>(api.teamActivity.modules(), { method: 'GET' });
};

export const getTeamActivityStatsReal: GetTeamActivityStatsContract = async (
  params?: GetTeamActivityStatsParams
): Promise<ApiResponse<TeamActivityStatsData>> => {
  return await apiRequest<TeamActivityStatsData>(`${api.teamActivity.stats()}${toQuery(params)}`, { method: 'GET' });
};

export const getTeamActivityInsightsReal: GetTeamActivityInsightsContract = async (
  params?: GetTeamActivityInsightsParams
): Promise<ApiResponse<TeamActivityInsightsData>> => {
  return await apiRequest<TeamActivityInsightsData>(`${api.teamActivity.insights()}${toQuery(params)}`, {
    method: 'GET',
  });
};

export const setTeamActivityInsightStateReal: SetTeamActivityInsightStateContract = async (
  params: SetInsightStateParams
) => {
  return await apiRequest<{ fingerprint: string; status: string | null }>(api.teamActivity.insightState(), {
    method: 'POST',
    body: params,
  });
};

export const getTeamActivityExperienceMapReal: GetTeamActivityExperienceMapContract = async (
  params?: GetTeamActivityExperienceMapParams
): Promise<ApiResponse<TeamActivityExperienceMapData>> => {
  return await apiRequest<TeamActivityExperienceMapData>(
    `${api.teamActivity.experienceMap()}${toQuery(params)}`,
    { method: 'GET' }
  );
};
