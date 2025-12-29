export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';

export type UserStatus = 'Active' | 'Disabled';

export type AdminUser = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt?: string;
};

export type PagedResult<T> = {
  items: T[];
  total: number;
};

export type Platform = {
  id: string;
  name: string;
  platformType: string;
  /** 可选：用于 Cherry 分组/能力规则等 provider 级差异化逻辑（如 silicon/dashscope） */
  providerId?: string;
  apiUrl: string;
  apiKeyMasked: string;
  enabled: boolean;
};

export type Model = {
  id: string;
  name: string;
  modelName: string;
  platformId: string;
  enabled: boolean;
  isMain: boolean;
  isIntent?: boolean;
  isVision?: boolean;
  isImageGen?: boolean;
  group?: string;
  enablePromptCache: boolean;
  /** 优先级：越小越靠前（用于拖拽排序） */
  priority?: number;
  // 后端模型统计（真实数据；用于模型管理页显示“请求次数/平均耗时”等）
  callCount?: number;
  totalDuration?: number;
  successCount?: number;
  failCount?: number;
  averageDuration?: number;
  successRate?: number;
};

export type LLMConfig = {
  id: string;
  provider: string;
  model: string;
  apiEndpoint?: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  rateLimitPerMinute: number;
  isActive: boolean;
  enablePromptCache: boolean;
  apiKeyMasked: string;
};

export type LlmRequestLogListItem = {
  id: string;
  requestId: string;
  provider: string;
  model: string;
  /** 便于在列表中展示"外部请求 URL"（如更新模型/models.list 等） */
  apiBase?: string | null;
  /** 便于在列表中展示"外部请求 URL"（如更新模型/models.list 等） */
  path?: string | null;
  /** 外部请求 HTTP Method（GET/POST/...） */
  httpMethod?: string | null;
  /** 平台 ID（来自 LLMPlatform） */
  platformId?: string | null;
  /** 平台名称（来自 LLMPlatform.Name，如"硅基流动"、"薇薇安"） */
  platformName?: string | null;
  groupId?: string | null;
  sessionId?: string | null;
  viewRole?: string | null;
  /** 这次调用的类型：reasoning/intent/vision/imageGen/unknown/... */
  requestType?: string | null;
  /** 这次调用的用途：如 chat.sendMessage / previewAsk.section / imageGen.generate */
  requestPurpose?: string | null;
  status: string;
  startedAt: string;
  firstByteAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  error?: string | null;
  /** 列表预览：用户问题（短文本） */
  questionPreview?: string | null;
  /** 列表预览：模型回答（短文本，可用于 UI 滚动） */
  answerPreview?: string | null;
};

export type LlmRequestLog = {
  id: string;
  requestId: string;
  groupId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  viewRole?: string | null;
  requestType?: string | null;
  requestPurpose?: string | null;
  provider: string;
  model: string;
  apiBase?: string | null;
  path?: string | null;
  /** 外部请求 HTTP Method（GET/POST/...） */
  httpMethod?: string | null;
  requestHeadersRedacted?: Record<string, string> | null;
  requestBodyRedacted: string;
  requestBodyHash?: string | null;
  /** requestBodyRedacted 原始字符数（后端落库前，未截断） */
  requestBodyChars?: number | null;
  /** requestBodyRedacted 是否发生过截断（后端落库时为控制体积） */
  requestBodyTruncated?: boolean | null;
  systemPromptChars?: number | null;
  systemPromptHash?: string | null;
  systemPromptText?: string | null;
  messageCount?: number | null;
  documentChars?: number | null;
  documentHash?: string | null;
  /** 本次请求 messages 中所有 user 内容长度总和 */
  userPromptChars?: number | null;
  /** Token统计来源：reported/estimated/missing */
  tokenUsageSource?: string | null;
  /** 生图成功张数（文本请求为 null） */
  imageSuccessCount?: number | null;
  statusCode?: number | null;
  responseHeaders?: Record<string, string> | null;
  questionText?: string | null;
  answerText?: string | null;
  answerTextChars?: number | null;
  answerTextHash?: string | null;
  assembledTextChars?: number | null;
  assembledTextHash?: string | null;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  startedAt: string;
  firstByteAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  status: string;
};

export type UploadArtifact = {
  id: string;
  requestId: string;
  kind: 'input_image' | 'output_image' | string;
  createdByAdminId: string;
  prompt?: string | null;
  relatedInputIds?: string[] | null;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  cosUrl: string;
  createdAt: string;
};
