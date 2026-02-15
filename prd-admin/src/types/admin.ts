export type UserRole = 'PM' | 'DEV' | 'QA' | 'ADMIN';

export type UserStatus = 'Active' | 'Disabled';

export type AdminUser = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  /** 用户类型：Human/Bot（后端枚举字符串） */
  userType?: 'Human' | 'Bot' | string;
  /** 机器人类型：PM/DEV/QA（仅 Bot 有） */
  botKind?: 'PM' | 'DEV' | 'QA' | string;
  /** 头像文件名（仅文件名，不含路径/域名） */
  avatarFileName?: string | null;
  createdAt: string;
  lastLoginAt?: string;
  /** 最后操作时间（用户写操作 / 机器人发消息） */
  lastActiveAt?: string;
  /** 是否处于登录锁定期（后端动态计算） */
  isLocked?: boolean;
  /** 剩余锁定秒数（0/undefined 表示未锁定） */
  lockoutRemainingSeconds?: number;
  /** 系统角色 key（用于权限管理） */
  systemRoleKey?: string | null;
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
  /** 透传到大模型请求的 max_tokens；null/undefined 表示使用后端默认（当前 4096） */
  maxTokens?: number | null;
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
  /** 模型解析类型：0=直连单模型, 1=默认模型池, 2=专属模型池 */
  modelResolutionType?: number | null;
  /** 模型池 ID */
  modelGroupId?: string | null;
  /** 模型池名称 */
  modelGroupName?: string | null;
  groupId?: string | null;
  sessionId?: string | null;
  /** 发起请求的用户 ID */
  userId?: string | null;
  viewRole?: string | null;
  /** 这次调用的类型：reasoning/intent/vision/imageGen/unknown/... */
  requestType?: string | null;
  /** 这次调用的用途：如 chat.sendMessage / previewAsk.section / imageGen.generate */
  requestPurpose?: string | null;
  /** RequestPurpose 的中文显示名（日志写入时一次性保存，确保日志自包含） */
  requestPurposeDisplayName?: string | null;
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
  /** 是否发生了模型降级 */
  isFallback?: boolean | null;
  /** 期望使用的模型 */
  expectedModel?: string | null;
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
  /** RequestPurpose 的中文显示名（日志写入时一次性保存，确保日志自包含） */
  requestPurposeDisplayName?: string | null;
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
  /** AI 思考过程文本（DeepSeek reasoning_content） */
  thinkingText?: string | null;
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
  /** 图片引用列表（参考图 COS URL 等元数据，用于日志页展示） */
  imageReferences?: LlmImageReference[] | null;
  /** 输入参考图（COS URL，来自前端上传） */
  inputImages?: LlmLogImage[] | null;
  /** 输出生成图（COS URL，来自生图结果） */
  outputImages?: LlmLogImage[] | null;
  /** 是否发生了模型降级 */
  isFallback?: boolean | null;
  /** 降级原因 */
  fallbackReason?: string | null;
  /** 期望使用的模型 */
  expectedModel?: string | null;
};

export type LlmImageReference = {
  sha256?: string | null;
  cosUrl?: string | null;
  label?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
};

export type LlmLogImage = {
  url: string;
  originalUrl?: string | null;
  label?: string | null;
  sha256?: string | null;
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

export type MermaidRenderSet = {
  svgLight?: string | null;
  svgDark?: string | null;
};

export type DocumentContentInfo = {
  id: string;
  title: string;
  content: string;
  mermaidRenderCacheVersion?: number | null;
  mermaidRenders?: Record<string, MermaidRenderSet> | null;
};
