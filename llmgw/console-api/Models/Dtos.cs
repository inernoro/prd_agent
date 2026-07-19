namespace PrdAgent.LlmGw.Models;

// 统一响应信封：{ success, data, error }。JSON 输出走 camelCase（见 Program.cs 配置）。
public sealed class ApiEnvelope<T>
{
    public bool Success { get; init; }
    public T? Data { get; init; }
    public ApiErrorBody? Error { get; init; }

    public static ApiEnvelope<T> Ok(T data) => new() { Success = true, Data = data, Error = null };

    public static ApiEnvelope<T> Fail(string code, string message) =>
        new() { Success = false, Data = default, Error = new ApiErrorBody { Code = code, Message = message } };
}

public sealed class ApiErrorBody
{
    public string Code { get; init; } = string.Empty;
    public string Message { get; init; } = string.Empty;
}

// ── 登录 ──
public sealed class LoginRequestDto
{
    public string? Username { get; set; }
    public string? Password { get; set; }
}

public sealed class MapSsoRequestDto
{
    public string? Code { get; set; }
}

public sealed class LoginResultDto
{
    public string Token { get; init; } = string.Empty;
    public string? Username { get; init; }
    public string? DisplayName { get; init; }
    public string? ExpiresAt { get; init; }
    public string? IdentityProvider { get; init; }

    /// <summary>首登强制改密：为 true 时前端须跳「设置新口令」页，改密成功前不放行日志页。</summary>
    public bool MustChangePassword { get; init; }
    public TenantSessionDto? Tenant { get; init; }
}

public sealed class TenantSessionDto
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public bool IsInternal { get; init; }
    public string Role { get; init; } = string.Empty;
    public List<string> TeamIds { get; init; } = new();
}

public sealed class SwitchTenantRequestDto
{
    public string? TenantId { get; set; }
}

// ── 改密 ──
public sealed class ChangePasswordRequestDto
{
    public string? OldPassword { get; set; }
    public string? NewPassword { get; set; }
}

public sealed class ChangePasswordResultDto
{
    /// <summary>改密后重新签发的 token（不再带 mcp 标记），前端替换 session 后即可读日志。</summary>
    public string Token { get; init; } = string.Empty;
    public string? Username { get; init; }
    public string? DisplayName { get; init; }
    public string? ExpiresAt { get; init; }
    public string? IdentityProvider { get; init; }
    public TenantSessionDto? Tenant { get; init; }
}

// ── 日志列表 ──
public sealed class LlmLogListItem
{
    public string Id { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public string? ReleaseCommit { get; set; }
    public string Provider { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? RunId { get; set; }
    public string? UserId { get; set; }
    public string? TeamId { get; set; }
    public string? ServiceKeyId { get; set; }
    public string? ClientCode { get; set; }
    public string? Environment { get; set; }
    public string? ServiceKeyPrefix { get; set; }
    public string? Username { get; set; }
    public string? DisplayName { get; set; }
    public string? RequestType { get; set; }
    public string? AppCallerCode { get; set; }
    public string? AppCallerCodeDisplayName { get; set; }
    public string? AppCallerTitle { get; set; }
    public string? SourceSystem { get; set; }
    public string? IngressProtocol { get; set; }
    public string Status { get; set; } = string.Empty;
    public string? StartedAt { get; set; }
    public string? FirstByteAt { get; set; }
    public string? EndedAt { get; set; }
    public long? DurationMs { get; set; }
    public int? StatusCode { get; set; }
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public decimal? EstimatedCost { get; set; }
    public string? EstimatedCostCurrency { get; set; }
    public decimal? EstimatedCostUsd { get; set; }
    public string? PriceSnapshotHash { get; set; }
    public string? ProviderRequestId { get; set; }
    public decimal? ProviderReportedCost { get; set; }
    public string? ProviderCostCurrency { get; set; }
    public string? FxSnapshotId { get; set; }
    public string? ReconciliationStatus { get; set; }
    public decimal? ReconciliationDelta { get; set; }
    public string? Error { get; set; }
    public bool? IsFallback { get; set; }
    public string? ExpectedModel { get; set; }
    public string? Protocol { get; set; }
    public string? ResolutionReason { get; set; }
    public string? Transport { get; set; }
    public string? ModelPolicy { get; set; }
    public string? ModelPoolId { get; set; }
    public int? ToolCallCount { get; set; }
    public string? FinishReason { get; set; }
    public bool? IsStreaming { get; set; }
}

public sealed class LogsListData
{
    public List<LlmLogListItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

// ── 详情 ──
public sealed class LlmLogDetail
{
    public string Id { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public string? ReleaseCommit { get; set; }
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? RunId { get; set; }
    public string? UserId { get; set; }
    public string? TeamId { get; set; }
    public string? ServiceKeyId { get; set; }
    public string? ClientCode { get; set; }
    public string? Environment { get; set; }
    public string? ServiceKeyPrefix { get; set; }
    public string? RequestType { get; set; }
    public string? AppCallerCode { get; set; }
    public string? AppCallerCodeDisplayName { get; set; }
    public string? AppCallerTitle { get; set; }
    public string? SourceSystem { get; set; }
    public string? IngressProtocol { get; set; }
    public string Provider { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? RequestBodyRedacted { get; set; }
    public string? SystemPromptText { get; set; }
    public string? PromptPolicyId { get; set; }
    public int? PromptPolicyVersion { get; set; }
    public string? PromptPolicyHash { get; set; }
    public string? QuestionText { get; set; }
    public string? AnswerText { get; set; }
    public string? ThinkingText { get; set; }
    public string? ResponseToolCalls { get; set; }
    public int? ToolCallCount { get; set; }
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    public decimal? EstimatedInputCost { get; set; }
    public decimal? EstimatedOutputCost { get; set; }
    public decimal? EstimatedCallCost { get; set; }
    public decimal? EstimatedCost { get; set; }
    public string? EstimatedCostCurrency { get; set; }
    public decimal? EstimatedCostUsd { get; set; }
    public string? PriceSnapshotHash { get; set; }
    public string? ProviderRequestId { get; set; }
    public decimal? ProviderReportedCost { get; set; }
    public string? ProviderCostCurrency { get; set; }
    public string? FxSnapshotId { get; set; }
    public string? ReconciliationStatus { get; set; }
    public decimal? ReconciliationDelta { get; set; }
    public string? StartedAt { get; set; }
    public string? FirstByteAt { get; set; }
    public string? EndedAt { get; set; }
    public long? DurationMs { get; set; }
    public string Status { get; set; } = string.Empty;
    public int? StatusCode { get; set; }
    public bool? IsFallback { get; set; }
    public string? FallbackReason { get; set; }
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }
    public string? ModelResolutionType { get; set; }
    public string? ModelGroupId { get; set; }
    public string? ModelGroupName { get; set; }
    public string? ExpectedModel { get; set; }
    public string? Protocol { get; set; }
    public string? ResolutionReason { get; set; }
    public string? Transport { get; set; }
    public string? ModelPolicy { get; set; }
    public string? ModelPoolId { get; set; }
    public string? ParameterPolicy { get; set; }
    public List<string> DroppedParameters { get; set; } = new();
    public List<ProviderAttemptDto> ProviderAttempts { get; set; } = new();
    public RouterTraceDto RouterTrace { get; set; } = new();
    public string? FinishReason { get; set; }
    public bool? IsStreaming { get; set; }
    public string? Error { get; set; }
}

public sealed class RouterTraceDto
{
    public string? Mode { get; set; }
    public string? RequestedModel { get; set; }
    public string? ActualModel { get; set; }
    public string? ModelGroupId { get; set; }
    public string? ModelGroupName { get; set; }
    public string? Provider { get; set; }
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }
    public string? Protocol { get; set; }
    public string? Transport { get; set; }
    public string? SourceSystem { get; set; }
    public string? IngressProtocol { get; set; }
    public string? RunId { get; set; }
    public string? ModelPolicy { get; set; }
    public string? ModelPoolId { get; set; }
    public bool IsFallback { get; set; }
    public string? FallbackReason { get; set; }
    public string? ResolutionReason { get; set; }
    public string? ParameterPolicy { get; set; }
    public List<string> DroppedParameters { get; set; } = new();
    public List<RouterTraceStepDto> Steps { get; set; } = new();
}

public sealed class ProviderAttemptDto
{
    public int Order { get; set; }
    public string Stage { get; set; } = "send";
    public string? Provider { get; set; }
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }
    public string? Model { get; set; }
    public string? ModelGroupId { get; set; }
    public string? ModelGroupName { get; set; }
    public string? Protocol { get; set; }
    public string? Transport { get; set; }
    public string Status { get; set; } = "selected";
    public string? Reason { get; set; }
    public int? StatusCode { get; set; }
    public long? DurationMs { get; set; }
    public string? Error { get; set; }
    public string? EndedAt { get; set; }
}

public sealed class RouterTraceStepDto
{
    public int Order { get; set; }
    public string Stage { get; set; } = "";
    public string Label { get; set; } = "";
    public string? Value { get; set; }
    public string Status { get; set; } = "info";
}

// ── 元信息 ──
public sealed class LogsMeta
{
    public List<string> Models { get; set; } = new();
    public List<string> Statuses { get; set; } = new();
    public List<string> Providers { get; set; } = new();
    public List<string> AppCallers { get; set; } = new();
    public List<string> Transports { get; set; } = new();
    public List<string> RequestTypes { get; set; } = new();
    public List<string> SourceSystems { get; set; } = new();
    public List<string> IngressProtocols { get; set; } = new();
    public List<string> ModelPolicies { get; set; } = new();
    public List<string> ServiceKeyIds { get; set; } = new();
    public List<string> ClientCodes { get; set; } = new();
    public List<string> Environments { get; set; } = new();
}

// ── 日志汇总 ──
public sealed class LogsSummaryData
{
    public long Total { get; set; }
    public long Succeeded { get; set; }
    public long Failed { get; set; }
    public long Running { get; set; }
    public long Cancelled { get; set; }
    public long Fallbacks { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public long TotalTokens { get; set; }
    public decimal? EstimatedCostUsd { get; set; }
    public long PricedRequests { get; set; }
    public long UnknownCostRequests { get; set; }
    public decimal PriceCoveragePercent { get; set; }
    public List<EstimatedCostBucket> EstimatedCosts { get; set; } = new();
    public long? AverageDurationMs { get; set; }
    public List<LogsBucketItem> TransportDistribution { get; set; } = new();
    public List<LogsBucketItem> StatusDistribution { get; set; } = new();
    public List<LogsBucketItem> SourceSystemDistribution { get; set; } = new();
    public List<LogsBucketItem> IngressProtocolDistribution { get; set; } = new();
    public List<LogsBucketItem> ModelPolicyDistribution { get; set; } = new();
}

public sealed class EstimatedCostBucket
{
    public string Currency { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public long Requests { get; set; }
}

public sealed class CostReconciliationImportRequest
{
    public string? Provider { get; set; }
    public string? ExternalRecordId { get; set; }
    public string? ProviderRequestId { get; set; }
    public string? ServiceKeyId { get; set; }
    public DateTime? WindowFrom { get; set; }
    public DateTime? WindowTo { get; set; }
    public decimal? ProviderReportedCost { get; set; }
    public string? ProviderCostCurrency { get; set; }
    public DateTime? BilledAt { get; set; }
    public string? FxSnapshotId { get; set; }
    public decimal? ProviderToEstimatedFxRate { get; set; }
}

public sealed class CostReconciliationItem
{
    public string Id { get; set; } = string.Empty;
    public string? TeamId { get; set; }
    public string Provider { get; set; } = string.Empty;
    public string ExternalRecordId { get; set; } = string.Empty;
    public string Granularity { get; set; } = string.Empty;
    public string? RequestId { get; set; }
    public string? ProviderRequestId { get; set; }
    public string? ServiceKeyId { get; set; }
    public string? Model { get; set; }
    public decimal? EstimatedCost { get; set; }
    public string? EstimatedCostCurrency { get; set; }
    public decimal? ProviderReportedCost { get; set; }
    public string ProviderCostCurrency { get; set; } = string.Empty;
    public string? FxSnapshotId { get; set; }
    public decimal? ProviderToEstimatedFxRate { get; set; }
    public decimal? ReconciliationDelta { get; set; }
    public string? DeltaCurrency { get; set; }
    public string ReconciliationStatus { get; set; } = string.Empty;
    public string? WindowFrom { get; set; }
    public string? WindowTo { get; set; }
    public string? BilledAt { get; set; }
    public string? CreatedAt { get; set; }
}

public sealed class CostReconciliationSummary
{
    public long TotalRecords { get; set; }
    public long RequestRecords { get; set; }
    public long WindowRecords { get; set; }
    public long ActualUnavailableRequests { get; set; }
    public List<EstimatedCostBucket> ProviderActualCosts { get; set; } = new();
    public List<LogsBucketItem> StatusDistribution { get; set; } = new();
    public List<CostReconciliationItem> Items { get; set; } = new();
}

public sealed class LegacyKeyCutoverUpdateRequest
{
    public string? Status { get; set; }
    public DateTime? DeadlineAt { get; set; }
    public List<string>? AllowedAppCallerCodes { get; set; }
    public List<string>? SuccessorServiceKeyIds { get; set; }
    public long RequiredSuccessorObservations { get; set; } = 1;
}

public sealed class LogsBucketItem
{
    public string Key { get; set; } = "";
    public long Count { get; set; }
}

// ── 租户首页聚合 ──
public sealed class TenantOverviewData
{
    public string From { get; set; } = string.Empty;
    public string To { get; set; } = string.Empty;
    public string GeneratedAt { get; set; } = string.Empty;
    public long TotalRequests { get; set; }
    public decimal? SuccessRatePercent { get; set; }
    public long? P95DurationMs { get; set; }
    public decimal RequestRatePerMinute { get; set; }
    public int RateWindowMinutes { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public long TotalTokens { get; set; }
    public int ActiveUsers { get; set; }
    public long PricedRequests { get; set; }
    public long UnknownCostRequests { get; set; }
    public decimal PriceCoveragePercent { get; set; }
    public List<EstimatedCostBucket> EstimatedCosts { get; set; } = new();
    public List<OverviewRankItem> TopUsers { get; set; } = new();
    public List<OverviewRankItem> TopAppCallers { get; set; } = new();
    public List<OverviewRankItem> TopModels { get; set; } = new();
    public ServiceKeyOverview ServiceKeys { get; set; } = new();
    public bool CanReadRecentRequests { get; set; }
    public List<LlmLogListItem> RecentRequests { get; set; } = new();
}

public sealed class OverviewRankItem
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public long Count { get; set; }
}

public sealed class ServiceKeyOverview
{
    public long Total { get; set; }
    public long Active { get; set; }
    public long Disabled { get; set; }
    public long Expired { get; set; }
    public long ExpiringSoon { get; set; }
    public long NeverUsed { get; set; }
    public string? LastUsedAt { get; set; }
}

// ── 协议入口运行覆盖 ──
public sealed class ProtocolCoverageData
{
    public string? ReleaseCommit { get; set; }
    public int SinceHours { get; set; }
    public string GeneratedAt { get; set; } = "";
    public long TotalLogRequests { get; set; }
    public int TotalRegisteredAppCallers { get; set; }
    public int TotalActiveAppCallers { get; set; }
    public int CoveredProtocols { get; set; }
    public int MissingRuntimeProtocols { get; set; }
    public List<ProtocolCoverageItem> Items { get; set; } = new();
}

public sealed class ProtocolCoverageItem
{
    public string IngressProtocol { get; set; } = "";
    public string Label { get; set; } = "";
    public string Status { get; set; } = "";
    public int RegisteredAppCallers { get; set; }
    public int ActiveAppCallers { get; set; }
    public int CoveredActiveAppCallers { get; set; }
    public int MissingActiveAppCallers { get; set; }
    public long LogRequests { get; set; }
    public long HttpRequests { get; set; }
    public long FailedRequests { get; set; }
    public long DroppedParameterRequests { get; set; }
    public List<string> RequestTypes { get; set; } = new();
    public List<string> MissingActiveAppCallerCodes { get; set; } = new();
    public string? LastSeenAt { get; set; }
    public string LogsLink { get; set; } = "";
    public string AppCallersLink { get; set; } = "";
}

// ── 时间序列 ──
public sealed class TimeseriesPoint
{
    public string Date { get; set; } = string.Empty;
    public int Count { get; set; }
}

public sealed class TimeseriesData
{
    public List<TimeseriesPoint> Items { get; set; } = new();
}

// ── 会话聚合 ──
public sealed class SessionItem
{
    public string? SessionId { get; set; }
    public int RequestCount { get; set; }
    public string? Start { get; set; }
    public string? End { get; set; }
    public string? AppCallerCode { get; set; }
    public string? PrimaryModel { get; set; }
    public string? PrimaryProvider { get; set; }
    public List<string> SupportingModels { get; set; } = new();
}

public sealed class SessionsData
{
    public List<SessionItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

// ── 配置写请求（网关配置面第二刀，可写）──
// 字段用 nullable：缺字段/空 body 时为 null，处理器拒绝（避免默认 false 误关平台/模型/默认池）。
public sealed class ToggleEnabledRequest { public bool? Enabled { get; set; } }
public sealed class ToggleDefaultRequest { public bool? IsDefault { get; set; } }
public sealed class RotateApiKeyRequest { public string? ApiKey { get; set; } }
public sealed class BulkRotateApiKeysRequest
{
    public string? ObjectType { get; set; }
    public string? ApiKey { get; set; }
    public List<string>? Ids { get; set; }
    public string? PlatformId { get; set; }
    public bool? EnabledOnly { get; set; }
    public bool? OnlyMissing { get; set; }
    public bool? AllGwOwned { get; set; }
}
public sealed class BulkRotateApiKeysResult
{
    public string ObjectType { get; set; } = "";
    public long MatchedCount { get; set; }
    public long ModifiedCount { get; set; }
    public long SkippedCount { get; set; }
    public string FilterSummary { get; set; } = "";
}
public sealed class CreatePoolRequest
{
    public string? Name { get; set; }
    public string? Code { get; set; }
    public string? ModelType { get; set; }
    public int? Priority { get; set; }
    public bool? IsDefaultForType { get; set; }
    public int? StrategyType { get; set; }
    public string? Description { get; set; }
}
public sealed class UpdatePoolRequest
{
    public string? Name { get; set; }
    public string? Code { get; set; }
    public string? ModelType { get; set; }
    public int? Priority { get; set; }
    public bool? IsDefaultForType { get; set; }
    public int? StrategyType { get; set; }
    public string? Description { get; set; }
}
public sealed class BulkClaimPoolsRequest
{
    public string? ModelType { get; set; }
    public bool? Overwrite { get; set; }
}
public sealed class BulkClaimPoolsResult
{
    public int Claimed { get; set; }
    public int Skipped { get; set; }
    public List<PoolItem> Items { get; set; } = new();
}
public sealed class PoolTypesData
{
    public List<PoolTypeItem> Items { get; set; } = new();
    public int Total { get; set; }
    public int Ready { get; set; }
    public int Waiting { get; set; }
}
public sealed class PoolTypeItem
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public string Purpose { get; set; } = "";
    public int SortOrder { get; set; }
    public string DefaultPoolId { get; set; } = "";
    public int ModelCount { get; set; }
    public bool Ready { get; set; }
    public long Version { get; set; }
}
public sealed class EnsurePoolTypesResult
{
    public int TypesCreated { get; set; }
    public int PoolsCreated { get; set; }
    public int ModelsAppended { get; set; }
    public PoolTypesData Types { get; set; } = new();
}
public sealed class BulkCalibratePoolPriceCurrencyRequest
{
    public string? ModelType { get; set; }
    public string? TargetCurrency { get; set; }
    public bool? OnlyMissing { get; set; }
    public bool? IncludeMembersWithoutPrice { get; set; }
}
public sealed class BulkCalibratePoolPriceCurrencyResult
{
    public int ScannedPools { get; set; }
    public int TouchedPools { get; set; }
    public int MatchedMembers { get; set; }
    public int UpdatedMembers { get; set; }
    public string TargetCurrency { get; set; } = "";
}
public sealed class BulkImportPoolModelsRequest
{
    public string? PlatformId { get; set; }
    public bool? EnabledOnly { get; set; }
    public string? CapabilityFilter { get; set; }
    public bool? OverwriteExisting { get; set; }
    public int? MaxCount { get; set; }
    public int? StartPriority { get; set; }
    public int? PriorityStep { get; set; }
}
public sealed class BulkImportPoolModelsResult
{
    public int ScannedModels { get; set; }
    public int MatchedModels { get; set; }
    public int Imported { get; set; }
    public int Updated { get; set; }
    public int SkippedExisting { get; set; }
    public int SkippedInvalid { get; set; }
    public string CapabilityFilter { get; set; } = "";
    public PoolItem? Pool { get; set; }
}
public sealed class BulkUpdateModelCapabilitiesRequest
{
    public string? PlatformId { get; set; }
    public bool? EnabledOnly { get; set; }
    public bool? OnlyMissing { get; set; }
    public bool? AllGwOwned { get; set; }
    public List<ModelCapabilityItem>? Capabilities { get; set; }
}
public sealed class BulkUpdateModelCapabilitiesResult
{
    public long MatchedCount { get; set; }
    public int ModifiedCount { get; set; }
    public int SkippedCount { get; set; }
    public int CapabilityCount { get; set; }
    public string FilterSummary { get; set; } = "";
}
public sealed class BulkClaimConfigAuthorityRequest
{
    public bool? Overwrite { get; set; }
}
public sealed class BulkClaimConfigAuthorityResult
{
    public int ClaimedPools { get; set; }
    public int SkippedPools { get; set; }
    public int ClaimedPlatforms { get; set; }
    public int SkippedPlatforms { get; set; }
    public int ClaimedModels { get; set; }
    public int SkippedModels { get; set; }
    public int ClaimedExchanges { get; set; }
    public int SkippedExchanges { get; set; }
    public int ClaimedTotal { get; set; }
    public int SkippedTotal { get; set; }
}
public sealed class BindActiveAppCallerPoolsResult
{
    public int Bound { get; set; }
    public int Skipped { get; set; }
    public int MissingDefaultPool { get; set; }
    public List<ConfigAuthorityGapItem> Items { get; set; } = new();
}
public sealed class UpsertPoolModelRequest
{
    public string? ModelId { get; set; }
    public string? PlatformId { get; set; }
    public int? Priority { get; set; }
    public string? Protocol { get; set; }
    public bool? EnablePromptCache { get; set; }
    public int? MaxTokens { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    public List<ModelCapabilityItem>? Capabilities { get; set; }
}
public sealed class UpdateGatewayAppCallerRequest
{
    public string? Status { get; set; }
    public string? ModelPoolId { get; set; }
    public string? ModelPolicy { get; set; }
    public string? ParameterPolicy { get; set; }
    public string? Owner { get; set; }
    public decimal? MonthlyBudgetUsd { get; set; }
    public decimal? BudgetReservationUsd { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }
}
public sealed class CreateGatewayAppCallerRequest
{
    public string? TeamId { get; set; }
    public string? AppCallerCode { get; set; }
    public string? RequestType { get; set; }
    public string? Title { get; set; }
    public string? IngressProtocol { get; set; }
}

public sealed class BulkUpdateGatewayAppCallersRequest
{
    public string? FilterStatus { get; set; }
    public string? SourceSystem { get; set; }
    public string? IngressProtocol { get; set; }
    public string? RequestType { get; set; }
    public string? Drift { get; set; }
    public string? Search { get; set; }
    public string? ModelPoolId { get; set; }
    public string? TargetStatus { get; set; }
    public string? ModelPolicy { get; set; }
    public string? ParameterPolicy { get; set; }
    public string? Owner { get; set; }
    public decimal? MonthlyBudgetUsd { get; set; }
    public decimal? BudgetReservationUsd { get; set; }
    public int? RateLimitPerMinute { get; set; }
}

public sealed class BulkUpdateGatewayAppCallersResult
{
    public long MatchedCount { get; set; }
    public long ModifiedCount { get; set; }
    public string FilterSummary { get; set; } = "";
}

public sealed class PromptPolicyVersionItem
{
    public string Id { get; set; } = "";
    public string? TeamId { get; set; }
    public string AppCallerCode { get; set; } = "";
    public string RequestType { get; set; } = "";
    public string SystemPromptPrefix { get; set; } = "";
    public string SystemPromptSuffix { get; set; } = "";
    public bool Enabled { get; set; }
    public int Version { get; set; }
    public List<string> AllowedVariables { get; set; } = new();
    public int MaxChars { get; set; }
    public string PolicyHash { get; set; } = "";
    public int PolicyChars { get; set; }
    public string? CreatedBy { get; set; }
    public string? UpdatedBy { get; set; }
    public string? UpdatedAt { get; set; }
}

public sealed class PromptPolicyData
{
    public string AppCallerId { get; set; } = "";
    public string AppCallerCode { get; set; } = "";
    public string RequestType { get; set; } = "";
    public PromptPolicyVersionItem? Current { get; set; }
    public List<PromptPolicyVersionItem> Versions { get; set; } = new();
}

public class SavePromptPolicyRequest
{
    public int ExpectedVersion { get; set; }
    public string? SystemPromptPrefix { get; set; }
    public string? SystemPromptSuffix { get; set; }
    public bool Enabled { get; set; } = true;
    public List<string>? AllowedVariables { get; set; }
    public int MaxChars { get; set; } = 8000;
}

public sealed class PreviewPromptPolicyRequest : SavePromptPolicyRequest
{
    public string? SampleSystemPrompt { get; set; }
}

public sealed class RollbackPromptPolicyRequest
{
    public int ExpectedVersion { get; set; }
    public int TargetVersion { get; set; }
}

public sealed class PromptPolicyPreview
{
    public string MergedSystemPrompt { get; set; } = "";
    public int PolicyChars { get; set; }
    public int MergedChars { get; set; }
    public string PolicyHash { get; set; } = "";
    public List<string> AppliedVariables { get; set; } = new();
}

// ── GW 操作审计（llm_gateway.llmgw_operation_audits，只读）──
public sealed class OperationAuditsData
{
    public List<OperationAuditItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
    public List<string> Actions { get; set; } = new();
    public List<string> TargetTypes { get; set; } = new();
    public List<string> Actors { get; set; } = new();
}

public sealed class OperationAuditItem
{
    public string Id { get; set; } = "";
    public string Action { get; set; } = "";
    public string TargetType { get; set; } = "";
    public string? TargetId { get; set; }
    public string? TargetName { get; set; }
    public string? ActorUserId { get; set; }
    public string? ActorUsername { get; set; }
    public bool Success { get; set; }
    public string? Reason { get; set; }
    public string ChangesJson { get; set; } = "{}";
    public string? RemoteIp { get; set; }
    public string? UserAgent { get; set; }
    public string? CreatedAt { get; set; }
}

// ── 模型池（只读，网关配置面第一刀）──
public sealed class PoolsData { public List<PoolItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class PoolItem
{
    public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string Code { get; set; } = "";
    public int Priority { get; set; } public string ModelType { get; set; } = ""; public bool IsDefaultForType { get; set; }
    public int StrategyType { get; set; } public string? Description { get; set; }
    public string SourceCollection { get; set; } = "model_groups"; public string Authority { get; set; } = "map";
    public string? ClaimedAt { get; set; }
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
    public List<PoolModelItem> Models { get; set; } = new();
    public long BoundAppCallerCount { get; set; }
    public List<PoolAppCallerItem> BoundAppCallers { get; set; } = new();
    public long RecentRequests { get; set; }
    public long RecentSucceeded { get; set; }
    public long RecentFailed { get; set; }
    public decimal? RecentSuccessRatePercent { get; set; }
    public string? LastRequestAt { get; set; }
    public int TrafficWindowHours { get; set; } = 168;
    public string Health { get; set; } = "empty";
    public int HealthyMembers { get; set; }
    public int DegradedMembers { get; set; }
    public int UnavailableMembers { get; set; }
    public bool ManagedByRegistry { get; set; }
    public bool AppendOnly { get; set; }
    public string? PoolRole { get; set; }
}
public sealed class PoolAppCallerItem
{
    public string Id { get; set; } = "";
    public string AppCallerCode { get; set; } = "";
    public string? Title { get; set; }
    public string Status { get; set; } = "";
}
public sealed class PoolModelItem
{
    public string ModelId { get; set; } = ""; public string PlatformId { get; set; } = ""; public int Priority { get; set; }
    public string? Protocol { get; set; } public int HealthStatus { get; set; } public string HealthStatusLabel { get; set; } = "";
    public string? LastFailedAt { get; set; } public string? LastSuccessAt { get; set; }
    public int ConsecutiveFailures { get; set; } public int ConsecutiveSuccesses { get; set; }
    public bool? EnablePromptCache { get; set; } public int? MaxTokens { get; set; }
    public bool IsMain { get; set; } public bool IsIntent { get; set; } public bool IsVision { get; set; } public bool IsImageGen { get; set; }
    public List<ModelCapabilityItem> Capabilities { get; set; } = new();
    public decimal? InputPricePerMillion { get; set; } public decimal? OutputPricePerMillion { get; set; } public decimal? PricePerCall { get; set; } public string? PriceCurrency { get; set; }
}

// ── 平台（无任何密钥字段，仅 hasKey）──
public sealed class PlatformsData { public List<PlatformItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class PlatformItem
{
    public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string PlatformType { get; set; } = "";
    public string? ProviderId { get; set; } public string? ApiUrl { get; set; } public bool Enabled { get; set; }
    public int MaxConcurrency { get; set; } public string? Remark { get; set; } public bool HasKey { get; set; }
    public string SourceCollection { get; set; } = "llmplatforms"; public string Authority { get; set; } = "map";
    public string? ClaimedAt { get; set; }
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
}
public sealed class CreatePlatformRequest
{
    public string? Name { get; set; }
    public string? PlatformType { get; set; }
    public string? ProviderId { get; set; }
    public string? ApiUrl { get; set; }
    public string? ApiKey { get; set; }
    public int? MaxConcurrency { get; set; }
    public string? Remark { get; set; }
}

// ── 模型（密钥只允许写入，读取仅返回 hasKey）──
public sealed class ModelsData { public List<ModelItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class ModelItem
{
    public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string ModelName { get; set; } = "";
    public string? ApiUrl { get; set; } public string? Protocol { get; set; } public string? PlatformId { get; set; } public string? Group { get; set; }
    public int Timeout { get; set; } public int MaxRetries { get; set; } public int MaxConcurrency { get; set; } public int? MaxTokens { get; set; }
    public bool Enabled { get; set; } public int Priority { get; set; }
    public bool IsMain { get; set; } public bool IsIntent { get; set; } public bool IsVision { get; set; } public bool IsImageGen { get; set; }
    public bool? EnablePromptCache { get; set; } public string? Remark { get; set; } public bool HasKey { get; set; }
    public string SourceCollection { get; set; } = "llmmodels"; public string Authority { get; set; } = "map";
    public string? ClaimedAt { get; set; }
    public long CallCount { get; set; } public long SuccessCount { get; set; } public long FailCount { get; set; } public long TotalDuration { get; set; }
    public List<ModelCapabilityItem> Capabilities { get; set; } = new();
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
}
public sealed class CreateModelRequest
{
    public string? PlatformId { get; set; }
    public string? Name { get; set; }
    public string? ModelName { get; set; }
    public string? Protocol { get; set; }
    public List<string> Capabilities { get; set; } = new();
    public string? ApiKey { get; set; }
    public int? Timeout { get; set; }
    public int? MaxRetries { get; set; }
    public int? MaxConcurrency { get; set; }
    public int? MaxTokens { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    public string? Remark { get; set; }
}
public sealed class CreateModelResult
{
    public ModelItem Item { get; set; } = new();
    public int PoolTypesCreated { get; set; }
    public int PoolsCreated { get; set; }
    public int ModelsAppended { get; set; }
}
public sealed class ModelCapabilityItem { public string Type { get; set; } = ""; public string Source { get; set; } = ""; public bool Value { get; set; } }
public sealed class ParameterCapabilitiesMetaData
{
    public List<ParameterCapabilityMetaItem> Items { get; set; } = new();
    public List<ParameterCapabilityTemplateItem> Templates { get; set; } = new();
}
public sealed class ParameterCapabilityMetaItem
{
    public string Name { get; set; } = "";
    public string Label { get; set; } = "";
    public string CapabilityType { get; set; } = "";
    public string Category { get; set; } = "";
}
public sealed class ParameterCapabilityTemplateItem
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Provider { get; set; } = "";
    public string Description { get; set; } = "";
    public List<string> Capabilities { get; set; } = new();
}

// ── Exchange（无密钥，仅 hasKey）──
public sealed class ExchangesData { public List<ExchangeItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class ExchangeItem
{
    public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string ModelAlias { get; set; } = "";
    public List<string> ModelAliases { get; set; } = new(); public List<ExchangeModelItem> Models { get; set; } = new();
    public string TargetUrl { get; set; } = ""; public string TargetAuthScheme { get; set; } = ""; public string TransformerType { get; set; } = "";
    public bool Enabled { get; set; } public string? Description { get; set; } public bool HasKey { get; set; }
    public string SourceCollection { get; set; } = "model_exchanges"; public string Authority { get; set; } = "map";
    public string? ClaimedAt { get; set; }
    public long Version { get; set; }
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
}
public sealed class ExchangeModelItem
{
    public string ModelId { get; set; } = ""; public string? DisplayName { get; set; } public string ModelType { get; set; } = "";
    public string? Description { get; set; } public bool Enabled { get; set; }
}
public sealed class ExchangeOptionItem
{
    public string Value { get; set; } = "";
    public string Label { get; set; } = "";
    public string? Description { get; set; }
}
public sealed class ExchangeMetaData
{
    public List<ExchangeOptionItem> TransformerTypes { get; set; } = new();
    public List<ExchangeOptionItem> AuthSchemes { get; set; } = new();
    public List<ExchangeOptionItem> ModelTypes { get; set; } = new();
}
public sealed class ExchangeModelWriteRequest
{
    public string? ModelId { get; set; }
    public string? DisplayName { get; set; }
    public string? ModelType { get; set; }
    public string? Description { get; set; }
    public bool? Enabled { get; set; }
}
public sealed class CreateExchangeRequest
{
    public string? Name { get; set; }
    public List<ExchangeModelWriteRequest> Models { get; set; } = new();
    public string? TargetUrl { get; set; }
    public string? ApiKey { get; set; }
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public bool? Enabled { get; set; }
    public string? Description { get; set; }
}
public sealed class UpdateExchangeRequest
{
    public string? Name { get; set; }
    public List<ExchangeModelWriteRequest> Models { get; set; } = new();
    public string? TargetUrl { get; set; }
    public string? TargetAuthScheme { get; set; }
    public string? TransformerType { get; set; }
    public bool? Enabled { get; set; }
    public string? Description { get; set; }
    public long? Version { get; set; }
}

// ── GW-owned API key 健康自检（不返回明文/密文/脱敏 key）──
public sealed class KeyHealthData
{
    public KeyHealthSummary Summary { get; set; } = new();
    public List<KeyHealthItem> Items { get; set; } = new();
}
public sealed class KeyHealthSummary
{
    public bool PrimaryConfigured { get; set; }
    public int LegacySecretCount { get; set; }
    public int Total { get; set; }
    public int Ok { get; set; }
    public int Missing { get; set; }
    public int Unreadable { get; set; }
    public int LegacyReadable { get; set; }
    public int StubUnreadable { get; set; }
    public string Status { get; set; } = "unknown";
}
public sealed class KeyHealthItem
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string ObjectType { get; set; } = "";
    public string Authority { get; set; } = "llm_gateway";
    public bool Enabled { get; set; }
    public bool HasKey { get; set; }
    public string Status { get; set; } = "";
    public bool UsedLegacySecret { get; set; }
}

// ── 配置权威迁移报告：量化 MAP fallback 退场前还剩哪些缺口 ──
public sealed class ConfigAuthorityReportData
{
    public ConfigAuthoritySummary Summary { get; set; } = new();
    public List<ConfigAuthorityGapItem> Gaps { get; set; } = new();
}
public sealed class ConfigAuthoritySummary
{
    public int MapPools { get; set; }
    public int GatewayPools { get; set; }
    public int MapOnlyPools { get; set; }
    public int MapPlatforms { get; set; }
    public int GatewayPlatforms { get; set; }
    public int MapOnlyPlatforms { get; set; }
    public int MapModels { get; set; }
    public int GatewayModels { get; set; }
    public int MapOnlyModels { get; set; }
    public int MapExchanges { get; set; }
    public int GatewayExchanges { get; set; }
    public int MapOnlyExchanges { get; set; }
    public long AppCallersTotal { get; set; }
    public int ActiveAppCallers { get; set; }
    public int ActiveWithGatewayPool { get; set; }
    public int ActiveWithUsableGatewayPool { get; set; }
    public int ActiveMissingGatewayPool { get; set; }
    public int ActiveBoundPoolWithoutUsableMember { get; set; }
    public int DiscoveredAppCallers { get; set; }
    public int ConfiguredAppCallers { get; set; }
    public int DisabledAppCallers { get; set; }
    public int MapFallbackObjectsRemaining { get; set; }
    public bool ActiveAppCallerMapFallbackReady { get; set; }
    public string ActiveAppCallerMapFallbackPolicy { get; set; } = "configurable";
    public int ReadinessPercent { get; set; }
    public string Status { get; set; } = "unknown";
}
public sealed class ConfigAuthorityGapItem
{
    public string ObjectType { get; set; } = "";
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Status { get; set; } = "";
    public string Detail { get; set; } = "";
}

// ── 运行态发布 gate 聚合：只读回答“是否可以切 full-http” ──
public sealed class RuntimeGatesData
{
    public string Status { get; set; } = "waiting";
    public string? ReleaseCommit { get; set; }
    public bool ReadyForHttpFull { get; set; }
    public int Passed { get; set; }
    public int Blocked { get; set; }
    public int Waiting { get; set; }
    public int Retained { get; set; }
    public string GeneratedAt { get; set; } = string.Empty;
    public List<RuntimeGateItem> Items { get; set; } = new();
}

public sealed class RuntimeGateItem
{
    public string Id { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Status { get; set; } = "waiting";
    public bool Blocking { get; set; }
    public string Detail { get; set; } = string.Empty;
    public string Evidence { get; set; } = string.Empty;
    public string NextAction { get; set; } = string.Empty;
    public Dictionary<string, string> Facts { get; set; } = new();
    public List<RuntimeGateLink> Links { get; set; } = new();
}

public sealed class RuntimeGateLink
{
    public string Label { get; set; } = string.Empty;
    public string To { get; set; } = string.Empty;
}

// ── GW appCaller 注册表（llm_gateway.llmgw_app_callers，只读）──
public sealed class GatewayAppCallersData
{
    public List<GatewayAppCallerItem> Items { get; set; } = new();
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
    public List<string> Statuses { get; set; } = new();
    public List<string> SourceSystems { get; set; } = new();
    public List<string> IngressProtocols { get; set; } = new();
    public List<string> RequestTypes { get; set; } = new();
}

public sealed class GatewayAppCallerItem
{
    public string Id { get; set; } = "";
    public string? TeamId { get; set; }
    public string AppCallerCode { get; set; } = "";
    public string RequestType { get; set; } = "";
    public string SourceSystem { get; set; } = "";
    public string IngressProtocol { get; set; } = "";
    public List<string> ObservedIngressProtocols { get; set; } = new();
    public string? Title { get; set; }
    public string Status { get; set; } = "";
    public string? ModelPoolId { get; set; }
    public string? ModelPolicy { get; set; }
    public string? ParameterPolicy { get; set; }
    public string? LastObservedModelPoolId { get; set; }
    public string? LastObservedModelPolicy { get; set; }
    public string? LastObservedParameterPolicy { get; set; }
    public List<string> ObservedModelPoolIds { get; set; } = new();
    public List<string> ObservedModelPolicies { get; set; } = new();
    public List<string> ObservedParameterPolicies { get; set; } = new();
    public string? LastObservedRequestId { get; set; }
    public string? LastObservedSessionId { get; set; }
    public string? LastObservedRunId { get; set; }
    public string? Owner { get; set; }
    public decimal? MonthlyBudgetUsd { get; set; }
    public decimal? BudgetReservationUsd { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }
    public long TotalSeen { get; set; }
    public string? FirstSeenAt { get; set; }
    public string? LastSeenAt { get; set; }
    public string? CreatedAt { get; set; }
    public string? UpdatedAt { get; set; }
}

// ── 影子比对（只读）──
public sealed class ShadowData { public ShadowSummary Summary { get; set; } = new(); public List<ShadowItem> Recent { get; set; } = new(); }
public sealed class ShadowSummary
{
    public long Total { get; set; }
    public long AllMatch { get; set; }
    public long Critical { get; set; }
    public long HttpFail { get; set; }
    public double? SinceHours { get; set; }
    public string? Since { get; set; }
    public string? ReleaseCommit { get; set; }
    public string? FirstComparedAt { get; set; }
    public string? LastComparedAt { get; set; }
    public double CoverageHours { get; set; }
}
public sealed class ShadowItem
{
    public string Id { get; set; } = ""; public string Kind { get; set; } = ""; public string? RequestId { get; set; }
    public string? ReleaseCommit { get; set; }
    public string AppCallerCode { get; set; } = ""; public string ModelType { get; set; } = ""; public string? ComparedAt { get; set; }
    public long ShadowDurationMs { get; set; } public bool HttpOk { get; set; } public string? HttpError { get; set; }
    public bool AllMatch { get; set; } public bool HasCritical { get; set; }
    public ShadowSnapshotItem Inproc { get; set; } = new(); public ShadowSnapshotItem Http { get; set; } = new();
    public List<ShadowMismatchItem> Mismatches { get; set; } = new(); public bool? TextMatches { get; set; }
}
public sealed class ShadowSnapshotItem
{
    public bool Success { get; set; } public string? ActualModel { get; set; } public string? Protocol { get; set; }
    public string? PlatformType { get; set; } public string? ResolutionType { get; set; } public string? ModelGroupId { get; set; } public bool IsFallback { get; set; }
}
public sealed class ShadowMismatchItem { public string Field { get; set; } = ""; public string? Inproc { get; set; } public string? Http { get; set; } public string Severity { get; set; } = ""; }

public sealed class ServiceKeyCreateRequest
{
    public string? Name { get; set; }
    public string? SourceSystem { get; set; }
    public string? ClientCode { get; set; }
    public string? Environment { get; set; }
    public string? Purpose { get; set; }
    public List<string>? AppCallerCodes { get; set; }
    public List<string>? IngressProtocols { get; set; }
    public List<string>? Scopes { get; set; }
    public string? TeamId { get; set; }
    public List<string>? AllowedCidrs { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? RotatesKeyId { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public bool ConfirmWildcardRisk { get; set; }
}

public sealed class ServiceKeyItem
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string KeyPrefix { get; set; } = "gwk_";
    public bool Enabled { get; set; }
    public string? TeamId { get; set; }
    public string? CreatedByUsername { get; set; }
    public string SourceSystem { get; set; } = "";
    public string ClientCode { get; set; } = "";
    public string Environment { get; set; } = "";
    public string Purpose { get; set; } = "runtime";
    public List<string> AppCallerCodes { get; set; } = new();
    public List<string> IngressProtocols { get; set; } = new();
    public List<string> Scopes { get; set; } = new();
    public List<string> AllowedCidrs { get; set; } = new();
    public int? RateLimitPerMinute { get; set; }
    public string? ExpiresAt { get; set; }
    public string? LastUsedAt { get; set; }
    public string? CreatedAt { get; set; }
    public string? RotatesKeyId { get; set; }
    public string? RotatedByKeyId { get; set; }
    public string RotationState { get; set; } = "active";
}

public sealed class CreateTenantRequest
{
    public string? Name { get; set; }
    public string? Slug { get; set; }
}

public sealed class TenantGovernanceData
{
    public string TenantId { get; set; } = string.Empty;
    public decimal? MonthlyBudgetUsd { get; set; }
    public decimal? BudgetReservationUsd { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public DateTime MonthStart { get; set; }
    public decimal ReservedUsd { get; set; }
    public decimal SpentUsd { get; set; }
    public decimal? RemainingBudgetUsd { get; set; }
    public long CurrentMinuteCount { get; set; }
    public DateTime CurrentMinuteStart { get; set; }
}

public sealed class UpdateTenantGovernanceRequest
{
    public decimal? MonthlyBudgetUsd { get; set; }
    public decimal? BudgetReservationUsd { get; set; }
    public int? RateLimitPerMinute { get; set; }
}

public sealed class CreateTeamRequest
{
    public string? Name { get; set; }
}

public sealed class UpdateTeamRequest
{
    public string? Name { get; set; }
    public string? Status { get; set; }
}

public sealed class CreateMemberRequest
{
    public string? Username { get; set; }
    public string? DisplayName { get; set; }
    public string? InitialPassword { get; set; }
    public string? Role { get; set; }
    public List<string>? TeamIds { get; set; }
}

public sealed class UpdateMemberRequest
{
    public int ExpectedVersion { get; set; }
    public string? Role { get; set; }
    public string? Status { get; set; }
    public List<string>? TeamIds { get; set; }
}
