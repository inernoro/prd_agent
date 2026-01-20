import { apiRequest } from '@/services/real/apiClient';
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
  return await apiRequest<ApiLogsListData>(`/api/logs/api${toQuery(params)}`, { method: 'GET' });
}

export async function getApiLogDetailReal(id: string): Promise<ApiResponse<ApiRequestLog>> {
  return await apiRequest<ApiRequestLog>(`/api/logs/api/${encodeURIComponent(id)}`, { method: 'GET' });
}

export async function getApiLogsMetaReal(): Promise<ApiResponse<ApiLogsMetaData>> {
  return await apiRequest<ApiLogsMetaData>('/api/logs/api/meta', { method: 'GET' });
}


