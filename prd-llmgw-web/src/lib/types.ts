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
  tenant?: TenantSession | null;
};

export type TenantSession = { id: string; name: string; role: string; teamIds: string[] };

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
  releaseCommit?: string | null;
  provider: string;
  model: string;
  platformId?: string | null;
  platformName?: string | null;
  groupId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  userId?: string | null;
  username?: string | null;
  displayName?: string | null;
  requestType?: string | null;
  appCallerCode?: string | null;
  appCallerCodeDisplayName?: string | null;
  appCallerTitle?: string | null;
  sourceSystem?: string | null;
  ingressProtocol?: string | null;
  status: string;
  startedAt: string;
  firstByteAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCost?: number | null;
  estimatedCostCurrency?: string | null;
  estimatedCostUsd?: number | null;
  error?: string | null;
  isFallback?: boolean | null;
  expectedModel?: string | null;
  protocol?: string | null;
  resolutionReason?: string | null;
  transport?: string | null;
  modelPolicy?: string | null;
  modelPoolId?: string | null;
  toolCallCount?: number | null;
  finishReason?: string | null;
  isStreaming?: boolean | null;
};

// ── 日志详情 ──
export type LlmLogDetail = {
  id: string;
  requestId: string;
  releaseCommit?: string | null;
  groupId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  userId?: string | null;
  requestType?: string | null;
  appCallerCode?: string | null;
  appCallerCodeDisplayName?: string | null;
  appCallerTitle?: string | null;
  sourceSystem?: string | null;
  ingressProtocol?: string | null;
  provider: string;
  model: string;
  requestBodyRedacted?: string | null;
  systemPromptText?: string | null;
  promptPolicyId?: string | null;
  promptPolicyVersion?: number | null;
  promptPolicyHash?: string | null;
  promptPolicyChars?: number | null;
  questionText?: string | null;
  answerText?: string | null;
  thinkingText?: string | null;
  responseToolCalls?: string | null;
  toolCallCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputPricePerMillion?: number | null;
  outputPricePerMillion?: number | null;
  pricePerCall?: number | null;
  priceCurrency?: string | null;
  estimatedInputCost?: number | null;
  estimatedOutputCost?: number | null;
  estimatedCallCost?: number | null;
  estimatedCost?: number | null;
  estimatedCostCurrency?: string | null;
  estimatedCostUsd?: number | null;
  startedAt: string;
  firstByteAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
  status: string;
  statusCode?: number | null;
  isFallback?: boolean | null;
  fallbackReason?: string | null;
  platformId?: string | null;
  platformName?: string | null;
  modelResolutionType?: string | null;
  modelGroupId?: string | null;
  modelGroupName?: string | null;
  expectedModel?: string | null;
  protocol?: string | null;
  resolutionReason?: string | null;
  transport?: string | null;
  modelPolicy?: string | null;
  modelPoolId?: string | null;
  parameterPolicy?: string | null;
  droppedParameters?: string[];
  providerAttempts: ProviderAttempt[];
  routerTrace: RouterTrace;
  finishReason?: string | null;
  isStreaming?: boolean | null;
  error?: string | null;
};

export type RouterTrace = {
  mode?: string | null;
  requestedModel?: string | null;
  actualModel?: string | null;
  modelGroupId?: string | null;
  modelGroupName?: string | null;
  provider?: string | null;
  platformId?: string | null;
  platformName?: string | null;
  protocol?: string | null;
  transport?: string | null;
  sourceSystem?: string | null;
  ingressProtocol?: string | null;
  runId?: string | null;
  modelPolicy?: string | null;
  modelPoolId?: string | null;
  isFallback: boolean;
  fallbackReason?: string | null;
  resolutionReason?: string | null;
  parameterPolicy?: string | null;
  droppedParameters: string[];
  steps: RouterTraceStep[];
};

export type RouterTraceStep = {
  order: number;
  stage: string;
  label: string;
  value?: string | null;
  status: 'info' | 'warning' | 'error' | string;
};

export type ProviderAttempt = {
  order: number;
  stage: string;
  provider?: string | null;
  platformId?: string | null;
  platformName?: string | null;
  model?: string | null;
  modelGroupId?: string | null;
  modelGroupName?: string | null;
  protocol?: string | null;
  transport?: string | null;
  status: string;
  reason?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  error?: string | null;
  endedAt?: string | null;
};

// ── 元信息（筛选下拉）──
export type LogsMeta = {
  models: string[];
  statuses: string[];
  providers: string[];
  appCallers: string[];
  transports: string[];
  requestTypes: string[];
  sourceSystems: string[];
  ingressProtocols: string[];
  modelPolicies: string[];
};

export type LogsBucketItem = {
  key: string;
  count: number;
};

export type LogsSummaryData = {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  cancelled: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  averageDurationMs?: number | null;
  transportDistribution: LogsBucketItem[];
  statusDistribution: LogsBucketItem[];
  sourceSystemDistribution: LogsBucketItem[];
  ingressProtocolDistribution: LogsBucketItem[];
  modelPolicyDistribution: LogsBucketItem[];
};

export type ProtocolCoverageItem = {
  ingressProtocol: string;
  label: string;
  status: string;
  registeredAppCallers: number;
  activeAppCallers: number;
  coveredActiveAppCallers: number;
  missingActiveAppCallers: number;
  logRequests: number;
  httpRequests: number;
  failedRequests: number;
  droppedParameterRequests: number;
  requestTypes: string[];
  missingActiveAppCallerCodes: string[];
  lastSeenAt?: string | null;
  logsLink: string;
  appCallersLink: string;
};

export type ProtocolCoverageData = {
  releaseCommit?: string | null;
  sinceHours: number;
  generatedAt: string;
  totalLogRequests: number;
  totalRegisteredAppCallers: number;
  totalActiveAppCallers: number;
  coveredProtocols: number;
  missingRuntimeProtocols: number;
  items: ProtocolCoverageItem[];
};

// ── 列表查询参数 ──
export type LogsListParams = {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  model?: string;
  status?: string;
  provider?: string;
  appCallerCode?: string;
  transport?: string;
  requestType?: string;
  sourceSystem?: string;
  ingressProtocol?: string;
  modelPolicy?: string;
  releaseCommit?: string;
  runId?: string;
  requestId?: string;
  sessionId?: string;
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

// ── 模型池（只读配置面）──
export type PoolModelInfo = {
  modelId: string; platformId: string; priority: number; protocol?: string | null;
  healthStatus: number; healthStatusLabel: string;
  lastFailedAt?: string | null; lastSuccessAt?: string | null;
  consecutiveFailures: number; consecutiveSuccesses: number;
  enablePromptCache?: boolean | null; maxTokens?: number | null;
  isMain: boolean; isIntent: boolean; isVision: boolean; isImageGen: boolean;
  capabilities: ModelCapability[];
  inputPricePerMillion?: number | null; outputPricePerMillion?: number | null; pricePerCall?: number | null; priceCurrency?: string | null;
};
export type ModelPool = {
  id: string; name: string; code: string; priority: number; modelType: string;
  isDefaultForType: boolean; strategyType: number; description?: string | null;
  sourceCollection: string; authority: string; claimedAt?: string | null;
  createdAt?: string | null; updatedAt?: string | null; models: PoolModelInfo[];
};
export type PoolsData = { items: ModelPool[]; total: number };
export type CreatePoolRequest = {
  name: string;
  code?: string;
  modelType: string;
  priority?: number;
  isDefaultForType?: boolean;
  strategyType?: number;
  description?: string;
};
export type UpdatePoolRequest = {
  name?: string;
  code?: string;
  modelType?: string;
  priority?: number;
  isDefaultForType?: boolean;
  strategyType?: number;
  description?: string;
};
export type BulkClaimPoolsRequest = {
  modelType?: string;
  overwrite?: boolean;
};
export type BulkClaimPoolsResult = {
  claimed: number;
  skipped: number;
  items: ModelPool[];
};
export type BulkCalibratePoolPriceCurrencyRequest = {
  modelType?: string;
  targetCurrency?: string;
  onlyMissing?: boolean;
  includeMembersWithoutPrice?: boolean;
};
export type BulkCalibratePoolPriceCurrencyResult = {
  scannedPools: number;
  touchedPools: number;
  matchedMembers: number;
  updatedMembers: number;
  targetCurrency: string;
};
export type BulkImportPoolModelsRequest = {
  platformId?: string;
  enabledOnly?: boolean;
  capabilityFilter?: string;
  overwriteExisting?: boolean;
  maxCount?: number;
  startPriority?: number;
  priorityStep?: number;
};
export type BulkImportPoolModelsResult = {
  scannedModels: number;
  matchedModels: number;
  imported: number;
  updated: number;
  skippedExisting: number;
  skippedInvalid: number;
  capabilityFilter: string;
  pool?: ModelPool | null;
};
export type BulkRotateApiKeysRequest = {
  objectType: 'platform' | 'model' | 'exchange';
  apiKey: string;
  ids?: string[];
  platformId?: string;
  enabledOnly?: boolean;
  onlyMissing?: boolean;
  allGwOwned?: boolean;
};
export type BulkRotateApiKeysResult = {
  objectType: string;
  matchedCount: number;
  modifiedCount: number;
  skippedCount: number;
  filterSummary: string;
};
export type BulkUpdateModelCapabilitiesRequest = {
  platformId?: string;
  enabledOnly?: boolean;
  onlyMissing?: boolean;
  allGwOwned?: boolean;
  capabilities?: ModelCapability[];
};
export type BulkUpdateModelCapabilitiesResult = {
  matchedCount: number;
  modifiedCount: number;
  skippedCount: number;
  capabilityCount: number;
  filterSummary: string;
};
export type BulkClaimConfigAuthorityRequest = {
  overwrite?: boolean;
};
export type BulkClaimConfigAuthorityResult = {
  claimedPools: number;
  skippedPools: number;
  claimedPlatforms: number;
  skippedPlatforms: number;
  claimedModels: number;
  skippedModels: number;
  claimedExchanges: number;
  skippedExchanges: number;
  claimedTotal: number;
  skippedTotal: number;
};
export type BindActiveAppCallerPoolsResult = {
  bound: number;
  skipped: number;
  missingDefaultPool: number;
  items: ConfigAuthorityGapItem[];
};
export type UpsertPoolModelRequest = {
  modelId: string;
  platformId?: string;
  priority?: number;
  protocol?: string;
  enablePromptCache?: boolean;
  maxTokens?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  pricePerCall?: number;
  priceCurrency?: string;
  capabilities?: ModelCapability[];
};

// ── 平台（无密钥，仅 hasKey）──
export type PlatformItem = {
  id: string; name: string; platformType: string; providerId?: string | null; apiUrl?: string | null;
  enabled: boolean; maxConcurrency: number; remark?: string | null; hasKey: boolean;
  sourceCollection: string; authority: string; claimedAt?: string | null;
  createdAt?: string | null; updatedAt?: string | null;
};
export type PlatformsData = { items: PlatformItem[]; total: number };

// ── 模型（无密钥，仅 hasKey）──
export type ModelCapability = { type: string; source: string; value: boolean };
export type ParameterCapabilityMetaItem = {
  name: string;
  label: string;
  capabilityType: string;
  category: string;
};
export type ParameterCapabilityTemplateItem = {
  key: string;
  label: string;
  provider: string;
  description: string;
  capabilities: string[];
};
export type ParameterCapabilitiesMetaData = { items: ParameterCapabilityMetaItem[]; templates: ParameterCapabilityTemplateItem[] };
export type ModelItem = {
  id: string; name: string; modelName: string; apiUrl?: string | null; protocol?: string | null;
  platformId?: string | null; group?: string | null; timeout: number; maxRetries: number;
  maxConcurrency: number; maxTokens?: number | null; enabled: boolean; priority: number;
  isMain: boolean; isIntent: boolean; isVision: boolean; isImageGen: boolean;
  enablePromptCache?: boolean | null; remark?: string | null; hasKey: boolean;
  sourceCollection: string; authority: string; claimedAt?: string | null;
  callCount: number; successCount: number; failCount: number; totalDuration: number;
  capabilities: ModelCapability[]; createdAt?: string | null; updatedAt?: string | null;
};
export type ModelsData = { items: ModelItem[]; total: number };

// ── Exchange（无密钥，仅 hasKey）──
export type ExchangeModelItem = {
  modelId: string;
  displayName?: string | null;
  modelType: string;
  description?: string | null;
  enabled: boolean;
};
export type ExchangeItem = {
  id: string;
  name: string;
  modelAlias: string;
  modelAliases: string[];
  models: ExchangeModelItem[];
  targetUrl: string;
  targetAuthScheme: string;
  transformerType: string;
  enabled: boolean;
  description?: string | null;
  hasKey: boolean;
  sourceCollection: string;
  authority: string;
  claimedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};
export type ExchangesData = { items: ExchangeItem[]; total: number };

// ── GW-owned API key 健康自检 ──
export type KeyHealthSummary = {
  primaryConfigured: boolean;
  legacySecretCount: number;
  total: number;
  ok: number;
  missing: number;
  unreadable: number;
  legacyReadable: number;
  stubUnreadable: number;
  status: string;
};
export type KeyHealthItem = {
  id: string;
  name: string;
  objectType: string;
  authority: string;
  enabled: boolean;
  hasKey: boolean;
  status: string;
  usedLegacySecret: boolean;
};
export type KeyHealthData = { summary: KeyHealthSummary; items: KeyHealthItem[] };

// ── 配置权威迁移报告 ──
export type ConfigAuthoritySummary = {
  mapPools: number;
  gatewayPools: number;
  mapOnlyPools: number;
  mapPlatforms: number;
  gatewayPlatforms: number;
  mapOnlyPlatforms: number;
  mapModels: number;
  gatewayModels: number;
  mapOnlyModels: number;
  mapExchanges: number;
  gatewayExchanges: number;
  mapOnlyExchanges: number;
  appCallersTotal: number;
  activeAppCallers: number;
  activeWithGatewayPool: number;
  activeWithUsableGatewayPool: number;
  activeMissingGatewayPool: number;
  activeBoundPoolWithoutUsableMember: number;
  discoveredAppCallers: number;
  configuredAppCallers: number;
  disabledAppCallers: number;
  mapFallbackObjectsRemaining: number;
  activeAppCallerMapFallbackReady: boolean;
  activeAppCallerMapFallbackPolicy: string;
  readinessPercent: number;
  status: string;
};
export type ConfigAuthorityGapItem = {
  objectType: string;
  id: string;
  name: string;
  status: string;
  detail: string;
};
export type ConfigAuthorityReportData = {
  summary: ConfigAuthoritySummary;
  gaps: ConfigAuthorityGapItem[];
};

export type RuntimeGateItem = {
  id: string;
  label: string;
  status: string;
  blocking: boolean;
  detail: string;
  evidence: string;
  nextAction: string;
  facts?: Record<string, string>;
  links?: RuntimeGateLink[];
};
export type RuntimeGateLink = {
  label: string;
  to: string;
};
export type RuntimeGatesData = {
  status: string;
  releaseCommit?: string | null;
  readyForHttpFull: boolean;
  passed: number;
  blocked: number;
  waiting: number;
  retained: number;
  generatedAt: string;
  items: RuntimeGateItem[];
};

// ── GW appCaller 注册表（llm_gateway.llmgw_app_callers）──
export type GatewayAppCaller = {
  id: string;
  appCallerCode: string;
  requestType: string;
  sourceSystem: string;
  ingressProtocol: string;
  observedIngressProtocols?: string[];
  title?: string | null;
  status: string;
  modelPoolId?: string | null;
  modelPolicy?: string | null;
  parameterPolicy?: string | null;
  lastObservedModelPoolId?: string | null;
  lastObservedModelPolicy?: string | null;
  lastObservedParameterPolicy?: string | null;
  lastObservedRequestId?: string | null;
  lastObservedSessionId?: string | null;
  lastObservedRunId?: string | null;
  owner?: string | null;
  monthlyBudgetUsd?: number | null;
  budgetReservationUsd?: number | null;
  rateLimitPerMinute?: number | null;
  notes?: string | null;
  totalSeen: number;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type UpdateGatewayAppCallerRequest = {
  status?: string;
  modelPoolId?: string;
  modelPolicy?: string;
  parameterPolicy?: string;
  owner?: string;
  monthlyBudgetUsd?: number;
  budgetReservationUsd?: number;
  rateLimitPerMinute?: number;
  notes?: string;
};

export type BulkUpdateGatewayAppCallersRequest = {
  filterStatus?: string;
  sourceSystem?: string;
  ingressProtocol?: string;
  requestType?: string;
  drift?: string;
  search?: string;
  targetStatus?: string;
  modelPolicy?: string;
  parameterPolicy?: string;
  owner?: string;
  monthlyBudgetUsd?: number;
  budgetReservationUsd?: number;
  rateLimitPerMinute?: number;
};

export type BulkUpdateGatewayAppCallersResult = {
  matchedCount: number;
  modifiedCount: number;
  filterSummary: string;
};

export type PromptPolicyVersion = {
  id: string; teamId?: string | null; appCallerCode: string; requestType: string;
  systemPromptPrefix: string; systemPromptSuffix: string; enabled: boolean; version: number;
  allowedVariables: string[]; maxChars: number; policyHash: string; policyChars: number;
  createdBy?: string | null; updatedBy?: string | null; updatedAt?: string | null;
};
export type PromptPolicyData = {
  appCallerId: string; appCallerCode: string; requestType: string;
  current?: PromptPolicyVersion | null; versions: PromptPolicyVersion[];
};
export type PromptPolicyDraft = {
  expectedVersion: number; systemPromptPrefix: string; systemPromptSuffix: string;
  enabled: boolean; allowedVariables: string[]; maxChars: number;
};
export type PromptPolicyPreview = {
  mergedSystemPrompt: string; policyChars: number; mergedChars: number;
  policyHash: string; appliedVariables: string[];
};

export type OperationAuditItem = {
  id: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  targetName?: string | null;
  actorUserId?: string | null;
  actorUsername?: string | null;
  success: boolean;
  reason?: string | null;
  changesJson: string;
  remoteIp?: string | null;
  userAgent?: string | null;
  createdAt?: string | null;
};

export type OperationAuditsData = {
  items: OperationAuditItem[];
  total: number;
  page: number;
  pageSize: number;
  actions: string[];
  targetTypes: string[];
  actors: string[];
};

export type GatewayAppCallersData = {
  items: GatewayAppCaller[];
  total: number;
  page: number;
  pageSize: number;
  statuses: string[];
  sourceSystems: string[];
  ingressProtocols: string[];
  requestTypes: string[];
};

export type ServiceKeyItem = {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  teamId?: string | null;
  createdByUsername?: string | null;
  sourceSystem: string;
  appCallerCodes: string[];
  ingressProtocols: string[];
  scopes: string[];
  allowedCidrs: string[];
  rateLimitPerMinute?: number | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string | null;
};

export type CreateServiceKeyRequest = {
  name: string;
  sourceSystem: string;
  appCallerCodes: string[];
  ingressProtocols: string[];
  scopes: string[];
  teamId?: string;
  allowedCidrs: string[];
  rateLimitPerMinute?: number;
  rotatesKeyId?: string;
  expiresAt?: string;
};

export type CreatedServiceKey = CreateServiceKeyRequest & {
  id: string;
  key: string;
  warning: string;
  keyPrefix: string;
};

export type OrganizationData = {
  tenant: { id: string; name: string; slug: string; status: string; isInternal: boolean } | null;
  teams: { id: string; name: string; status: string; createdAt: string; updatedAt: string }[];
  members: { id: string; userId: string; username?: string | null; displayName?: string | null; role: string; teamIds: string[]; status: string; version: number }[];
};

export type CreatedTenant = { id: string; name: string; slug: string; defaultTeamId: string };
export type CreatedTeam = { id: string; name: string; status: string };

// ── 影子比对（只读）──
export type ShadowSnapshot = {
  success: boolean; actualModel?: string | null; protocol?: string | null; platformType?: string | null;
  resolutionType?: string | null; modelGroupId?: string | null; isFallback: boolean;
};
export type ShadowMismatch = { field: string; inproc?: string | null; http?: string | null; severity: string };
export type ShadowItem = {
  id: string; kind: string; requestId?: string | null; releaseCommit?: string | null; appCallerCode: string; modelType: string;
  comparedAt?: string | null; shadowDurationMs: number; httpOk: boolean; httpError?: string | null;
  allMatch: boolean; hasCritical: boolean; inproc: ShadowSnapshot; http: ShadowSnapshot;
  mismatches: ShadowMismatch[]; textMatches?: boolean | null;
};
export type ShadowSummary = {
  total: number;
  allMatch: number;
  critical: number;
  httpFail: number;
  sinceHours?: number | null;
  since?: string | null;
  releaseCommit?: string | null;
  firstComparedAt?: string | null;
  lastComparedAt?: string | null;
  coverageHours?: number;
};
export type ShadowData = { summary: ShadowSummary; recent: ShadowItem[] };
