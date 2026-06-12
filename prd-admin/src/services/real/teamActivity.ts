import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type {
  GetTeamActivityLogsContract,
  GetTeamActivityModulesContract,
  GetTeamActivityParams,
  TeamActivityListData,
  TeamActivityModulesData,
} from '@/services/contracts/teamActivity';

function toQuery(params?: GetTeamActivityParams) {
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
