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
  requestPurpose?: string;
};

export type LlmLogsListData = {
  items: LlmRequestLogListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type LlmLogsMetaRequestPurpose = {
  value: string;
  displayName: string;
};

export type LlmLogsMetaData = {
  providers: string[];
  models: string[];
  requestPurposes: LlmLogsMetaRequestPurpose[];
  statuses: string[];
  users?: LlmLogsMetaUser[];
};

export type LlmLogsMetaUser = {
  userId: string;
  username?: string | null;
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
  platformId?: string;
  requestPurpose?: string;
};

export type LlmModelStatsItem = {
  provider: string;
  model: string;
  platformId?: string;
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

// 批量统计请求项
export type BatchModelStatsItem = {
  appCallerCode?: string;
  platformId: string;
  modelId: string;
};

// 批量统计请求参数
export type BatchModelStatsParams = {
  days?: number;
  items: BatchModelStatsItem[];
};

// 批量统计响应数据（key 格式：appCallerCode:platformId:modelId）
export type BatchModelStatsData = {
  days: number;
  items: Record<string, LlmModelStatsItem | null>;
};

export type GetBatchModelStatsContract = (params: BatchModelStatsParams) => Promise<ApiResponse<BatchModelStatsData>>;



