import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { ApiLogsListData, ApiLogsListParams, ApiLogsMetaData, ApiRequestLog } from '@/services/contracts/apiLogs';

function toQuery(params?: ApiLogsListParams) {
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

export async function getApiLogsReal(params?: ApiLogsListParams): Promise<ApiResponse<ApiLogsListData>> {
  return await apiRequest<ApiLogsListData>(`${api.logs.api.list()}${toQuery(params)}`, { method: 'GET' });
}

export async function getApiLogDetailReal(id: string): Promise<ApiResponse<ApiRequestLog>> {
  return await apiRequest<ApiRequestLog>(api.logs.api.byId(encodeURIComponent(id)), { method: 'GET' });
}

export async function getApiLogsMetaReal(): Promise<ApiResponse<ApiLogsMetaData>> {
  return await apiRequest<ApiLogsMetaData>(api.logs.api.meta(), { method: 'GET' });
}


