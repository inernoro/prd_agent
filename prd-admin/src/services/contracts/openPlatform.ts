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
  isActive: boolean;
  createdAt: string;
  lastUsedAt?: string;
  totalRequests: number;
  apiKeyMasked: string;
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
}

export interface UpdateAppRequest {
  appName?: string;
  description?: string;
  boundUserId?: string;
  boundGroupId?: string;
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
}
