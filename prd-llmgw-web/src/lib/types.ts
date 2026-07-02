// 自包含类型定义（从 prd-admin/src/types/admin.ts 的 LLM 日志相关子集移植，独立维护）。
// 本 mini-app 不依赖 prd-admin/prd-api 的任何源码。

// ── 通用 API 响应（与后端约定的 { success, data, error } 形状）──
export type ApiError = {
  code: string;
  message: string;
  traceId?: string | null;
};

export type ApiResponse<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: ApiError };

// ── 登录 ──
export type LoginRequest = { username: string; password: string };
export type LoginResult = {
  token: string;
  username?: string | null;
  displayName?: string | null;
  expiresAt?: string | null;
  /** 首登强制改密：true 时前端须跳「设置新口令」页，改密成功前不放行日志页。 */
  mustChangePassword?: boolean | null;
};

// ── 改密 ──
export type ChangePasswordRequest = { oldPassword: string; newPassword: string };
export type ChangePasswordResult = {
  /** 改密后重新签发的 token（不再带 mcp 标记）。 */
  token: string;
  username?: string | null;
  displayName?: string | null;
  expiresAt?: string | null;
};

// ── 日志列表项 ──
export type LlmLogListItem = {
  id: string;
  requestId: string;
  provider: string;
  model: string;
  platformId?: string | null;
  platformName?: string | null;
  groupId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  username?: string | null;
  displayName?: string | null;
  requestType?: string | null;
  appCallerCode?: string | null;
  appCallerCodeDisplayName?: string | null;
  status: string;
  startedAt: string;
  firstByteAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  error?: string | null;
  isFallback?: boolean | null;
  expectedModel?: string | null;
  protocol?: string | null;
  resolutionReason?: string | null;
  toolCallCount?: number | null;
  finishReason?: string | null;
  isStreaming?: boolean | null;
};

// ── 日志详情 ──
export type LlmLogDetail = {
  id: string;
  requestId: string;
  groupId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  requestType?: string | null;
  appCallerCode?: string | null;
  appCallerCodeDisplayName?: string | null;
  provider: string;
  model: string;
  requestBodyRedacted?: string | null;
  systemPromptText?: string | null;
  questionText?: string | null;
  answerText?: string | null;
  thinkingText?: string | null;
  responseToolCalls?: string | null;
  toolCallCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  startedAt: string;
  firstByteAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  status: string;
  statusCode?: number | null;
  isFallback?: boolean | null;
  fallbackReason?: string | null;
  expectedModel?: string | null;
  protocol?: string | null;
  resolutionReason?: string | null;
  finishReason?: string | null;
  isStreaming?: boolean | null;
  error?: string | null;
};

// ── 元信息（筛选下拉）──
export type LogsMeta = {
  models: string[];
  statuses: string[];
};

// ── 列表查询参数 ──
export type LogsListParams = {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  model?: string;
  status?: string;
};

export type LogsListData = {
  items: LlmLogListItem[];
  total: number;
  page: number;
  pageSize: number;
};

// ── 时间序列（柱状图）──
export type TimeseriesPoint = { date: string; count: number };
export type TimeseriesData = { items: TimeseriesPoint[] };

// ── 会话聚合（Sessions tab）──
export type SessionItem = {
  sessionId: string | null;
  requestCount: number;
  start?: string | null;
  end?: string | null;
  appCallerCode?: string | null;
  primaryModel?: string | null;
  primaryProvider?: string | null;
  supportingModels: string[];
};

export type SessionsData = {
  items: SessionItem[];
  total: number;
  page: number;
  pageSize: number;
};
