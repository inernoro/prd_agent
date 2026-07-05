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
  appCallerCode?: string;
};

export type LlmLogsListData = {
  items: LlmRequestLogListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type LlmLogsMetaAppCallerCode = {
  value: string;
  displayName: string;
};

export type LlmLogsMetaData = {
  providers: string[];
  models: string[];
  appCallerCodes: LlmLogsMetaAppCallerCode[];
  statuses: string[];
  users?: LlmLogsMetaUser[];
};

export type LlmLogsMetaUser = {
  userId: string;
  username?: string | null;
  displayName?: string | null;
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
  appCallerCode?: string;
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

// replay-curl 响应数据
export type ReplayCurlData = {
  curl: string;
  endpoint?: string;
  model?: string;
  imageCount?: number;
  textCount?: number;
  restoreErrors?: string[] | null;
  requestBodyLength?: number;
  warning?: string | null;
};

export type GetReplayCurlContract = (id: string) => Promise<ApiResponse<ReplayCurlData>>;

// ── 按天请求量时间序列（OpenRouter 风格柱状图）──
export type GetLlmLogsTimeseriesParams = {
  days?: number;
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  status?: string;
  appCallerCode?: string;
  userId?: string;
};

export type LlmLogsTimeseriesPoint = {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
  successCount: number;
  failCount: number;
};

export type LlmLogsTimeseriesData = {
  from: string;
  to: string;
  items: LlmLogsTimeseriesPoint[];
};

export type GetLlmLogsTimeseriesContract = (params?: GetLlmLogsTimeseriesParams) => Promise<ApiResponse<LlmLogsTimeseriesData>>;

// ── 按会话聚合（OpenRouter Sessions tab）──
export type GetLlmLogsSessionsParams = {
  page?: number;
  pageSize?: number;
  days?: number;
  from?: string;
  to?: string;
  appCallerCode?: string;
  userId?: string;
};

export type LlmLogsSessionItem = {
  sessionId: string | null;
  requestCount: number;
  start?: string | null;
  end?: string | null;
  appCallerCode?: string | null;
  primaryModel?: string | null;
  primaryProvider?: string | null;
  supportingModels: string[];
};

export type LlmLogsSessionsData = {
  items: LlmLogsSessionItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type GetLlmLogsSessionsContract = (params?: GetLlmLogsSessionsParams) => Promise<ApiResponse<LlmLogsSessionsData>>;

// ── 按应用前缀 + 类型聚合（应用视图矩阵）──
export type GetLlmLogsAppSummaryParams = {
  from?: string;
  to?: string;
  days?: number;
};

export type LlmLogsAppSummaryItem = {
  appPrefix: string;
  requestType: string;
  requestCount: number;
  successCount: number;
  failCount: number;
  /** 0-1 之间的成功率；总数为 0 时为 null */
  successRate: number | null;
  medianDurationMs: number | null;
};

export type LlmLogsAppSummaryData = {
  from: string;
  to: string;
  items: LlmLogsAppSummaryItem[];
};

export type GetLlmLogsAppSummaryContract = (
  params?: GetLlmLogsAppSummaryParams,
) => Promise<ApiResponse<LlmLogsAppSummaryData>>;

// ── 日志正文 COS 占位符还原 ──
export type RestoreLlmLogTextData = {
  id: string;
  answerText?: string | null;
  systemPromptText?: string | null;
  questionText?: string | null;
  thinkingText?: string | null;
  restoredCount: number;
  restoreErrors: string[] | null;
};

export type RestoreLlmLogTextContract = (id: string) => Promise<ApiResponse<RestoreLlmLogTextData>>;



