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
  requestHeadersRedacted?: Record<string, string> | null;
  requestBodyRedacted: string;
  requestBodyHash?: string | null;
  systemPromptChars?: number | null;
  systemPromptHash?: string | null;
  messageCount?: number | null;
  documentChars?: number | null;
  documentHash?: string | null;
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
