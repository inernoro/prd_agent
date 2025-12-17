import { apiRequest } from '@/services/real/apiClient';
import type { ApiResponse } from '@/types/api';
import type { LlmRequestLog } from '@/types/admin';
import type { GetLlmLogDetailContract, GetLlmLogsContract, GetLlmLogsMetaContract, GetLlmLogsParams, LlmLogsListData, LlmLogsMetaData } from '@/services/contracts/llmLogs';

function toQuery(params?: GetLlmLogsParams) {
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

export const getLlmLogsReal: GetLlmLogsContract = async (params?: GetLlmLogsParams): Promise<ApiResponse<LlmLogsListData>> => {
  return await apiRequest<LlmLogsListData>(`/api/v1/admin/llm-logs${toQuery(params)}`, { method: 'GET' });
};

export const getLlmLogDetailReal: GetLlmLogDetailContract = async (id: string): Promise<ApiResponse<LlmRequestLog>> => {
  return await apiRequest<LlmRequestLog>(`/api/v1/admin/llm-logs/${encodeURIComponent(id)}`, { method: 'GET' });
};

export const getLlmLogsMetaReal: GetLlmLogsMetaContract = async (): Promise<ApiResponse<LlmLogsMetaData>> => {
  return await apiRequest<LlmLogsMetaData>('/api/v1/admin/llm-logs/meta', { method: 'GET' });
};

