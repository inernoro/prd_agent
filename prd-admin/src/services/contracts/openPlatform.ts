// 开放平台服务契约

export interface OpenPlatformApp {
  id: string;
  appName: string;
  description?: string;
  boundUserId: string;
  boundUserName: string;
  boundGroupId?: string;
  boundGroupName?: string;
  ignoreUserSystemPrompt?: boolean;
  /** 是否禁用群上下文，禁用后仅使用用户传递的上下文（默认 true） */
  disableGroupContext?: boolean;
  /** 对话系统提示词（可选）。非空时使用该值作为系统提示词覆盖默认提示词。 */
  conversationSystemPrompt?: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt?: string;
  totalRequests: number;
  apiKeyMasked: string;
  // Webhook 配置摘要
  webhookEnabled: boolean;
  webhookUrl?: string;
  tokenQuotaLimit: number;
  tokensUsed: number;
  quotaWarningThreshold: number;
  notifyTarget: string;
}

export interface OpenPlatformRequestLog {
  id: string;
  appId: string;
  appName: string;
  requestId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  method: string;
  path: string;
  statusCode: number;
  errorCode?: string;
  groupId?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CreateAppRequest {
  appName: string;
  description?: string;
  boundUserId: string;
  boundGroupId?: string;
  ignoreUserSystemPrompt?: boolean;
  /** 是否禁用群上下文，禁用后仅使用用户传递的上下文（默认 true） */
  disableGroupContext?: boolean;
  /** 对话系统提示词（可选）。非空时使用该值作为系统提示词覆盖默认提示词。 */
  conversationSystemPrompt?: string;
}

export interface UpdateAppRequest {
  appName?: string;
  description?: string;
  boundUserId?: string;
  boundGroupId?: string;
  ignoreUserSystemPrompt?: boolean;
  disableGroupContext?: boolean;
  /** 对话系统提示词（可选）。非空时使用该值作为系统提示词覆盖默认提示词。 */
  conversationSystemPrompt?: string;
}

export interface CreateAppResponse {
  id: string;
  appName: string;
  description?: string;
  boundUserId: string;
  boundGroupId?: string;
  isActive: boolean;
  createdAt: string;
  apiKey: string; // 仅创建时返回
}

export interface PagedAppsResponse {
  items: OpenPlatformApp[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PagedLogsResponse {
  items: OpenPlatformRequestLog[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RegenerateKeyResponse {
  apiKey: string;
}

// ============ Webhook 配置 ============

export interface WebhookConfigResponse {
  webhookUrl?: string;
  webhookSecretMasked?: string;
  webhookEnabled: boolean;
  tokenQuotaLimit: number;
  tokensUsed: number;
  quotaWarningThreshold: number;
  lastQuotaWarningAt?: string;
  notifyTarget: string;
}

export interface UpdateWebhookConfigRequest {
  webhookUrl?: string;
  webhookSecret?: string;
  webhookEnabled: boolean;
  tokenQuotaLimit: number;
  quotaWarningThreshold: number;
  notifyTarget: string;
}

export interface WebhookTestResponse {
  success: boolean;
  statusCode?: number;
  durationMs?: number;
  errorMessage?: string;
  responseBody?: string;
}

export interface WebhookLogItem {
  id: string;
  type: string;
  title: string;
  statusCode?: number;
  success: boolean;
  errorMessage?: string;
  durationMs?: number;
  retryCount: number;
  createdAt: string;
}

export interface PagedWebhookLogsResponse {
  items: WebhookLogItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface IOpenPlatformService {
  // 应用管理
  getApps(page: number, pageSize: number, search?: string): Promise<PagedAppsResponse>;
  createApp(request: CreateAppRequest): Promise<CreateAppResponse>;
  updateApp(id: string, request: UpdateAppRequest): Promise<void>;
  deleteApp(id: string): Promise<void>;
  regenerateKey(id: string): Promise<RegenerateKeyResponse>;
  toggleAppStatus(id: string): Promise<void>;

  // 日志查询
  getLogs(
    page: number,
    pageSize: number,
    appId?: string,
    startTime?: string,
    endTime?: string,
    statusCode?: number
  ): Promise<PagedLogsResponse>;

  // Webhook 配置
  getWebhookConfig(appId: string): Promise<WebhookConfigResponse>;
  updateWebhookConfig(appId: string, request: UpdateWebhookConfigRequest): Promise<void>;
  testWebhook(appId: string): Promise<WebhookTestResponse>;
  getWebhookLogs(appId: string, page: number, pageSize: number): Promise<PagedWebhookLogsResponse>;
}
