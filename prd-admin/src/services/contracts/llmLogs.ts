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
  userId?: string;
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

// 按模型聚合统计（用于模型管理页左下角统计标签）
export type GetLlmModelStatsParams = {
  days?: number;
  provider?: string;
  model?: string;
  status?: string;
};

export type LlmModelStatsItem = {
  provider: string;
  model: string;
  requestCount: number;
  avgDurationMs?: number | null;
  avgTtfbMs?: number | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  successCount?: number | null;
  failCount?: number | null;
};

export type LlmModelStatsData = {
  days: number;
  items: LlmModelStatsItem[];
};

export type GetLlmModelStatsContract = (params?: GetLlmModelStatsParams) => Promise<ApiResponse<LlmModelStatsData>>;



