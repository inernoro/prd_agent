import { ok, fail, type ApiResponse } from '@/types/api';
import type { GetLlmLogDetailContract, GetLlmLogsContract, GetLlmLogsMetaContract, LlmLogsListData, LlmLogsMetaData } from '@/services/contracts/llmLogs';
import type { LlmRequestLog } from '@/types/admin';

export const getLlmLogsMock: GetLlmLogsContract = async (): Promise<ApiResponse<LlmLogsListData>> => {
  return ok({ items: [], total: 0, page: 1, pageSize: 30 });
};

export const getLlmLogDetailMock: GetLlmLogDetailContract = async (): Promise<ApiResponse<LlmRequestLog>> => {
  return fail('NOT_FOUND', 'mock：暂无日志') as unknown as ApiResponse<LlmRequestLog>;
};

export const getLlmLogsMetaMock: GetLlmLogsMetaContract = async (): Promise<ApiResponse<LlmLogsMetaData>> => {
  return ok({ providers: [], models: [], statuses: ['running', 'succeeded', 'failed', 'cancelled'] });
};

