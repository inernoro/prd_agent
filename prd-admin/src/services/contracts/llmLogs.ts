import type { ApiResponse } from '@/types/api';
import type { LlmRequestLog, LlmRequestLogListItem } from '@/types/admin';

export type GetLlmLogsParams = {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  requestId?: string;
  groupId?: string;
  sessionId?: string;
  status?: string;
};

export type LlmLogsListData = {
  items: LlmRequestLogListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type LlmLogsMetaData = {
  providers: string[];
  models: string[];
  statuses: string[];
};

export type GetLlmLogsContract = (params?: GetLlmLogsParams) => Promise<ApiResponse<LlmLogsListData>>;

export type GetLlmLogDetailContract = (id: string) => Promise<ApiResponse<LlmRequestLog>>;

export type GetLlmLogsMetaContract = () => Promise<ApiResponse<LlmLogsMetaData>>;

