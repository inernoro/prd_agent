// 多通道适配器服务契约

// ============ 白名单 ============
export interface ChannelWhitelist {
  id: string;
  channelType: string;
  identifierPattern: string;
  displayName?: string;
  description?: string;
  boundUserId?: string;
  boundUserName?: string;
  allowedAgents: string[];
  dailyQuota: number;
  todayUsedCount: number;
  quotaResetAt?: string;
  isActive: boolean;
  priority: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWhitelistRequest {
  channelType: string;
  identifierPattern: string;
  displayName?: string;
  description?: string;
  boundUserId?: string;
  allowedAgents?: string[];
  dailyQuota?: number;
  priority?: number;
}

export interface UpdateWhitelistRequest {
  identifierPattern?: string;
  displayName?: string;
  description?: string;
  boundUserId?: string;
  allowedAgents?: string[];
  dailyQuota?: number;
  priority?: number;
}

// ============ 身份映射 ============
export interface ChannelIdentityMapping {
  id: string;
  channelType: string;
  channelIdentifier: string;
  userId: string;
  userName?: string;
  isVerified: boolean;
  verifiedAt?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIdentityMappingRequest {
  channelType: string;
  channelIdentifier: string;
  userId: string;
  isVerified?: boolean;
}

export interface UpdateIdentityMappingRequest {
  userId?: string;
  isVerified?: boolean;
}

// ============ 任务 ============
export interface ChannelTaskAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url?: string;
  uploadedAt: string;
}

export interface ChannelTaskStatusChange {
  status: string;
  at: string;
  note?: string;
}

export interface ChannelTaskResult {
  type: string;
  textContent?: string;
  imageUrl?: string;
  imageUrls?: string[];
  data?: Record<string, unknown>;
}

export interface ChannelTaskResponse {
  type: string;
  sentAt: string;
  messageId?: string;
  status: string;
  error?: string;
}

export interface ChannelTask {
  id: string;
  channelType: string;
  channelMessageId?: string;
  senderIdentifier: string;
  senderDisplayName?: string;
  mappedUserId?: string;
  mappedUserName?: string;
  whitelistId?: string;
  intent?: string;
  targetAgent?: string;
  originalContent: string;
  originalSubject?: string;
  parsedParameters: Record<string, unknown>;
  attachments: ChannelTaskAttachment[];
  status: string;
  statusHistory: ChannelTaskStatusChange[];
  result?: ChannelTaskResult;
  error?: string;
  errorCode?: string;
  responsesSent: ChannelTaskResponse[];
  retryCount: number;
  maxRetries: number;
  parentTaskId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

// ============ 统计 ============
export interface ChannelTaskStats {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  todayTotal: number;
  avgDurationMs?: number;
}

export interface ChannelStatusInfo {
  channelType: string;
  displayName: string;
  isEnabled: boolean;
  todayRequestCount: number;
  todaySuccessCount: number;
  todayFailCount: number;
}

export interface ChannelStats {
  channelType: string;
  displayName: string;
  isEnabled: boolean;
  whitelistCount: number;
  taskStats: ChannelTaskStats;
}

export interface ChannelStatsResponse {
  channels: ChannelStatusInfo[];
  todayTaskCount: number;
  processingCount: number;
  successRate: number;
  avgDurationSeconds: number;
  whitelistCount: number;
  identityMappingCount: number;
}

// ============ 分页响应 ============
export interface PagedWhitelistResponse {
  items: ChannelWhitelist[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PagedIdentityMappingResponse {
  items: ChannelIdentityMapping[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PagedTaskResponse {
  items: ChannelTask[];
  total: number;
  page: number;
  pageSize: number;
}

// ============ 邮件工作流 ============
export interface EmailWorkflow {
  id: string;
  addressPrefix: string;
  displayName: string;
  description?: string;
  icon?: string;
  intentType: string;
  targetAgent?: string;
  customPrompt?: string;
  replyTemplate?: string;
  isActive: boolean;
  priority: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowRequest {
  addressPrefix: string;
  displayName: string;
  description?: string;
  icon?: string;
  intentType: string;
  targetAgent?: string;
  customPrompt?: string;
  replyTemplate?: string;
  priority?: number;
}

export interface UpdateWorkflowRequest {
  addressPrefix?: string;
  displayName?: string;
  description?: string;
  icon?: string;
  intentType?: string;
  targetAgent?: string;
  customPrompt?: string;
  replyTemplate?: string;
  priority?: number;
}

export interface PagedWorkflowResponse {
  items: EmailWorkflow[];
  total: number;
  page: number;
  pageSize: number;
}

// ============ 服务接口 ============
export interface IChannelService {
  // 邮箱配置
  getSettings(): Promise<ChannelSettings>;
  updateSettings(request: UpdateSettingsRequest): Promise<ChannelSettings>;
  testConnection(request: TestConnectionRequest): Promise<TestConnectionResult>;
  triggerPoll(): Promise<{ success: boolean; message: string; emailCount?: number }>;

  // 邮件工作流管理
  getWorkflows(page: number, pageSize: number): Promise<PagedWorkflowResponse>;
  getWorkflow(id: string): Promise<EmailWorkflow>;
  createWorkflow(request: CreateWorkflowRequest): Promise<EmailWorkflow>;
  updateWorkflow(id: string, request: UpdateWorkflowRequest): Promise<EmailWorkflow>;
  deleteWorkflow(id: string): Promise<void>;
  toggleWorkflow(id: string): Promise<EmailWorkflow>;

  // 白名单管理
  getWhitelists(
    page: number,
    pageSize: number,
    channelType?: string,
    search?: string
  ): Promise<PagedWhitelistResponse>;
  getWhitelist(id: string): Promise<ChannelWhitelist>;
  createWhitelist(request: CreateWhitelistRequest): Promise<ChannelWhitelist>;
  updateWhitelist(id: string, request: UpdateWhitelistRequest): Promise<ChannelWhitelist>;
  deleteWhitelist(id: string): Promise<void>;
  toggleWhitelist(id: string): Promise<ChannelWhitelist>;

  // 身份映射管理
  getIdentityMappings(
    page: number,
    pageSize: number,
    channelType?: string,
    search?: string
  ): Promise<PagedIdentityMappingResponse>;
  getIdentityMapping(id: string): Promise<ChannelIdentityMapping>;
  createIdentityMapping(request: CreateIdentityMappingRequest): Promise<ChannelIdentityMapping>;
  updateIdentityMapping(id: string, request: UpdateIdentityMappingRequest): Promise<ChannelIdentityMapping>;
  deleteIdentityMapping(id: string): Promise<void>;

  // 任务管理
  getTasks(
    page: number,
    pageSize: number,
    channelType?: string,
    status?: string,
    search?: string
  ): Promise<PagedTaskResponse>;
  getTask(id: string): Promise<ChannelTask>;
  retryTask(id: string): Promise<ChannelTask>;
  cancelTask(id: string): Promise<ChannelTask>;

  // 统计
  getStats(): Promise<ChannelStatsResponse>;
  getTaskStats(channelType?: string): Promise<ChannelTaskStats>;

}

// ============ 邮箱配置 ============
export interface ChannelSettings {
  id?: string;
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  imapPassword?: string;
  imapUseSsl?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpUseSsl?: boolean;
  pollIntervalMinutes?: number;
  isEnabled?: boolean;
  lastPollAt?: string;
  lastPollResult?: string;
}

export interface UpdateSettingsRequest {
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  imapPassword?: string;
  imapUseSsl?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpUseSsl?: boolean;
  pollIntervalMinutes?: number;
  isEnabled?: boolean;
}

export interface TestConnectionRequest {
  imapHost: string;
  imapPort: number;
  imapUsername: string;
  imapPassword: string;
  imapUseSsl: boolean;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
}

// ============ 常量 ============
export const ChannelTypes = {
  Email: 'email',
  Sms: 'sms',
  Siri: 'siri',
  Webhook: 'webhook',
} as const;

export const ChannelTypeDisplayNames: Record<string, string> = {
  email: '邮件',
  sms: '短信',
  siri: 'Siri',
  webhook: 'Webhook',
};

export const TaskStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export const TaskStatusDisplayNames: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const TaskIntents: Record<string, string> = {
  'image-gen': '图片生成',
  'defect-create': '创建缺陷',
  'defect-query': '查询缺陷',
  'prd-query': 'PRD 问答',
  'help': '帮助',
  'cancel': '取消',
  'unknown': '未知',
};

// ============ 邮件意图类型 ============
export const EmailIntentTypes = {
  Unknown: 'unknown',
  Classify: 'classify',
  CreateTodo: 'createtodo',
  Summarize: 'summarize',
  FollowUp: 'followup',
  FYI: 'fyi',
} as const;

export const EmailIntentTypeDisplayNames: Record<string, string> = {
  unknown: '未知',
  classify: '邮件分类',
  createtodo: '创建待办',
  summarize: '内容摘要',
  followup: '跟进回复',
  fyi: '仅供参考',
};
