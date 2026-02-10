import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { LlmRequestLog } from '@/types/admin';
import type {
  GetLlmLogDetailContract,
  GetLlmLogsContract,
  GetLlmLogsMetaContract,
  GetLlmLogsParams,
  GetLlmModelStatsContract,
  GetLlmModelStatsParams,
  GetBatchModelStatsContract,
  BatchModelStatsParams,
  LlmLogsListData,
  LlmLogsMetaData,
  LlmModelStatsData,
  BatchModelStatsData,
  GetReplayCurlContract,
  ReplayCurlData,
} from '@/services/contracts/llmLogs';

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
  return await apiRequest<LlmLogsListData>(`${api.logs.llm.list()}${toQuery(params)}`, { method: 'GET' });
};

export const getLlmLogDetailReal: GetLlmLogDetailContract = async (id: string): Promise<ApiResponse<LlmRequestLog>> => {
  return await apiRequest<LlmRequestLog>(api.logs.llm.byId(encodeURIComponent(id)), { method: 'GET' });
};

export const getLlmLogsMetaReal: GetLlmLogsMetaContract = async (): Promise<ApiResponse<LlmLogsMetaData>> => {
  return await apiRequest<LlmLogsMetaData>(api.logs.llm.meta(), { method: 'GET' });
};

export const getLlmModelStatsReal: GetLlmModelStatsContract = async (params?: GetLlmModelStatsParams): Promise<ApiResponse<LlmModelStatsData>> => {
  return await apiRequest<LlmModelStatsData>(`${api.logs.llm.modelStats()}${toQuery(params)}`, { method: 'GET' });
};

export const getBatchModelStatsReal: GetBatchModelStatsContract = async (params: BatchModelStatsParams): Promise<ApiResponse<BatchModelStatsData>> => {
  return await apiRequest<BatchModelStatsData>(api.logs.llm.batchModelStats(), {
    method: 'POST',
    body: JSON.stringify(params),
  });
};

export const getReplayCurlReal: GetReplayCurlContract = async (id: string): Promise<ApiResponse<ReplayCurlData>> => {
  return await apiRequest<ReplayCurlData>(api.logs.llm.replayCurl(encodeURIComponent(id)), { method: 'GET' });
};

