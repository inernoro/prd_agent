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

    /// <summary>
    /// 带数据的失败。用于「拒绝了，但要告诉调用方拒绝的依据」——
    /// 例如删除被引用挡下时，把占用清单一起回去，前端才能把「先摘哪几个」列出来，
    /// 而不是只甩一句「删不了」让人自己猜。
    /// </summary>
    public static ApiEnvelope<T> Fail(string code, string message, T data) =>
        new() { Success = false, Data = data, Error = new ApiErrorBody { Code = code, Message = message } };
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
    /// <summary>
    /// 旧口令。联邦账号首次设置本地口令时可以为空——它的旧口令是建号时随机生成的，
    /// 判定见 <see cref="Auth.LocalPasswordPolicy.RequiresOldPassword"/>。
    /// </summary>
    public string? OldPassword { get; set; }
    public string? NewPassword { get; set; }

    /// <summary>
    /// 可选的新登录名。联邦账号的自动用户名（map-{hash}）没人记得住，
    /// 不让改名的话即使设了口令也登不进来。留空表示保持现有用户名。
    /// </summary>
    public string? Username { get; set; }
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

    /// <summary>
    /// 口令确实改成功了，但会话在这中间到期了，签不出新 token——前端应提示重新登录。
    /// 这种情形不能报失败：报失败会让用户拿着**已经作废的旧口令**反复重试。
    /// </summary>
    public bool RequiresRelogin { get; init; }
}

/// <summary>
/// 「账号与安全」页要渲染的自身账号事实。它回答三个此前无处可查的问题：
/// 我的登录名是什么、我有没有可用的本地口令、设置口令要不要填旧口令。
/// </summary>
public sealed class AccountProfileDto
{
    public string Username { get; init; } = string.Empty;
    public string? DisplayName { get; init; }

    /// <summary>身份来源：map 表示由 MAP 一键登录自动建号，空表示独立口令账号。</summary>
    public string? IdentityProvider { get; init; }

    /// <summary>当前是否存在有人知道的本地口令。false 表示这个账号还从未被真人认领。</summary>
    public bool HasLocalPassword { get; init; }

    /// <summary>设置新口令时是否必须填写旧口令。</summary>
    public bool RequiresOldPassword { get; init; }

    /// <summary>当前用户名是否为自动生成（据此提示用户改成记得住的名字）。</summary>
    public bool UsernameIsGenerated { get; init; }

    /// <summary>
    /// 建议的登录名，即外部身份那边的登录名（MAP 用户名）。
    /// 前端拿它预填输入框——SSO 进来的人不该被迫记住第二个名字。为空表示没有可用建议。
    /// </summary>
    public string? SuggestedUsername { get; init; }

    /// <summary>
    /// 建议登录名已被别人占用。为 true 时前端必须明说「你的 MAP 登录名已被占用，请另取一个」，
    /// 否则用户会照着填、撞一次冲突、再自己猜原因。
    /// </summary>
    public bool SuggestedUsernameTaken { get; init; }

    public int MinPasswordLength { get; init; }
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
    public string? LogicalModelId { get; set; }
    public string? LogicalModelPublicId { get; set; }
    public string? OfferingId { get; set; }
    public string? OfferingTargetKind { get; set; }
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? RunId { get; set; }
    public string? LogicalRequestId { get; set; }
    public string? ProviderTaskId { get; set; }
    public string? UserId { get; set; }
    public string? TeamId { get; set; }
    public string? ServiceKeyId { get; set; }
    public string? ClientCode { get; set; }
    public string? Environment { get; set; }
    public string? ServiceKeyPrefix { get; set; }
    public string? Username { get; set; }
    public string? DisplayName { get; set; }
    public string? RequestType { get; set; }
    public string? Operation { get; set; }
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
    public string? TokenUsageSource { get; set; }
    public int? ImageSuccessCount { get; set; }
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
    public string? LogicalRequestId { get; set; }
    public string? ProviderTaskId { get; set; }
    public long UpstreamCallCount { get; set; }
    public long StatusQueryCount { get; set; }
    public string? UserId { get; set; }
    public string? TeamId { get; set; }
    public string? ServiceKeyId { get; set; }
    public string? ClientCode { get; set; }
    public string? Environment { get; set; }
    public string? ServiceKeyPrefix { get; set; }
    public string? RequestType { get; set; }
    public string? Operation { get; set; }
    public string? AppCallerCode { get; set; }
    public string? AppCallerCodeDisplayName { get; set; }
    public string? AppCallerTitle { get; set; }
    public string? SourceSystem { get; set; }
    public string? IngressProtocol { get; set; }
    public string Provider { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? LogicalModelId { get; set; }
    public string? LogicalModelPublicId { get; set; }
    public string? OfferingId { get; set; }
    public string? OfferingTargetKind { get; set; }
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
    public int? ImageSuccessCount { get; set; }
    public List<LogImageDto> OutputImages { get; set; } = new();
    public string? OutputImageCaptureStatus { get; set; }
    public string? OutputImageCaptureError { get; set; }
    public string? OutputImageCapturedAt { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    public decimal? EstimatedInputCost { get; set; }
    public decimal? EstimatedOutputCost { get; set; }
    public decimal? EstimatedCallCost { get; set; }
    public decimal? EstimatedCost { get; set; }
    public string? EstimatedCostCurrency { get; set; }
    /// <summary>缓存命中输入部分的成本。</summary>
    public decimal? EstimatedCacheReadCost { get; set; }
    /// <summary>写入缓存部分的成本（Anthropic 一类协议）。</summary>
    public decimal? EstimatedCacheWriteCost { get; set; }
    /// <summary>缓存命中输入单价快照。</summary>
    public decimal? CachedInputPricePerMillion { get; set; }
    /// <summary>写入缓存输入单价快照。</summary>
    public decimal? CacheWritePricePerMillion { get; set; }
    /// <summary>价格来源：upstream / admin / migrated。</summary>
    public string? PriceSource { get; set; }
    /// <summary>价格观测时间（ISO）。</summary>
    public string? PriceObservedAt { get; set; }
    /// <summary>这次到底算没算出钱：priced / unpriced / stale_currency / no_usage。</summary>
    public string? CostStatus { get; set; }
    /// <summary>算不出钱时的人话原因，直接给用户看。</summary>
    public string? CostUnpricedReason { get; set; }
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

public sealed class LogImageDto
{
    public string Url { get; set; } = string.Empty;
    public string? OriginalUrl { get; set; }
    public string? Label { get; set; }
    public string? Sha256 { get; set; }
    public string? MimeType { get; set; }
    public long? SizeBytes { get; set; }
}

public sealed class RouterTraceDto
{
    public string? LogicalModelId { get; set; }
    public string? LogicalModelPublicId { get; set; }
    public string? OfferingId { get; set; }
    public string? OfferingTargetKind { get; set; }
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
    public bool? ReachedProvider { get; set; }
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
    public List<string> Operations { get; set; } = new();
}

// ── 日志汇总 ──
public sealed class LogsSummaryData
{
    public long Total { get; set; }
    public long UpstreamCalls { get; set; }
    public long ControlCalls { get; set; }
    public long StatusQueries { get; set; }
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
    /// <summary>缓存命中省下的钱（按输入全价与缓存价的差额算）。没有缓存命中时为 null。</summary>
    public decimal? CacheSavingsUsd { get; set; }
    /// <summary>有用量但模型没配价，这次调用没计上钱。</summary>
    public long UnpricedRequests { get; set; }
    /// <summary>模型价格不是美金口径，不敢记账。</summary>
    public long StaleCurrencyRequests { get; set; }
    /// <summary>上游没返回 token 用量，无从计价。</summary>
    public long NoUsageRequests { get; set; }
    /// <summary>按「漏掉的调用次数」排的缺价模型清单，直接告诉用户该去给谁补价。</summary>
    public List<UnpricedModelBucket> TopUnpricedModels { get; set; } = new();
    public List<EstimatedCostBucket> EstimatedCosts { get; set; } = new();
    public long? AverageDurationMs { get; set; }
    public List<LogsBucketItem> TransportDistribution { get; set; } = new();
    public List<LogsBucketItem> StatusDistribution { get; set; } = new();
    public List<LogsBucketItem> SourceSystemDistribution { get; set; } = new();
    public List<LogsBucketItem> IngressProtocolDistribution { get; set; } = new();
    public List<LogsBucketItem> ModelPolicyDistribution { get; set; } = new();
}

/// <summary>一条缺价模型漏掉了多少次调用，以及为什么算不出钱。</summary>
public sealed class UnpricedModelBucket
{
    public string Model { get; set; } = string.Empty;
    public string? Provider { get; set; }
    public long Requests { get; set; }
    /// <summary>unpriced / stale_currency，决定该去补价还是去换算币种。</summary>
    public string Status { get; set; } = string.Empty;
    /// <summary>直接给人看的一句原因。</summary>
    public string? Reason { get; set; }
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
    /// <summary>「对这些调用方而言我是默认」；不传表示不改。</summary>
    public List<string>? DefaultForAppCallerCodes { get; set; }
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
public sealed class BulkUpdateModelCapabilitiesRequest
{
    public string? PlatformId { get; set; }
    /// <summary>按 _id / ModelName / Name 精确圈定要维护的模型；与 PlatformId 同时给则取交集。</summary>
    public List<string>? ModelIds { get; set; }
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
public sealed class UpdateGatewayAppCallerRequest
{
    public string? Status { get; set; }
    public string? ModelPoolId { get; set; }
    public List<string>? AllowedModelPoolIds { get; set; }
    public string? DefaultModelPoolId { get; set; }
    public bool? AllowCrossPoolFallback { get; set; }
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

/// <summary>用户那句「我想做什么」。调用用途码由它推导，除此之外不接收任何字段。</summary>
public sealed class DraftAppCallerRequest
{
    public string? Intent { get; set; }
}

/// <summary>
/// 服务网关设置的唯一可写面：系统级功能用哪个模型。
/// 地址、appCaller、密钥都由系统自管，不在这里接收——它们不是用户该知道的值。
/// </summary>
public sealed class UpdateSystemSettingsRequest
{
    /// <summary>auto（网关自己挑）/ pool（钉一个模型池）/ model（钉一个模型）。</summary>
    public string? ModelSource { get; set; }
    public string? ModelGroupId { get; set; }
    public string? ModelName { get; set; }
    // 刻意不接受归属团队字段：系统消耗恒记在「系统内部」团队，单独计费，不由请求体改写。
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
    public long? AverageDurationMs { get; set; }
    public int RecentTenRequests { get; set; }
    public decimal? RecentTenSuccessRatePercent { get; set; }
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
/// <summary>
/// 池成员可解析性索引：一次请求里建一次，给所有池复用。
/// 前三张是「存在**且启用**」，用来判成员还能不能承接调用；
/// 后三张是「只要存在就算」（不看启用），用来把「被停用」和「压根没了」分开——
/// 停用是临时状态，启用即恢复；不存在才是死成员，才该给摘除入口。
/// </summary>
public sealed record PoolResolutionIndex(
    HashSet<string> PlatformIds,
    List<MongoDB.Bson.BsonDocument> Models,
    List<MongoDB.Bson.BsonDocument> Exchanges,
    HashSet<string> ExistingPlatformIds,
    List<MongoDB.Bson.BsonDocument> ExistingModels,
    List<MongoDB.Bson.BsonDocument> ExistingExchanges);

public sealed class PoolModelItem
{
    public string ModelId { get; set; } = ""; public string PlatformId { get; set; } = ""; public int Priority { get; set; }
    public string? Protocol { get; set; } public int HealthStatus { get; set; } public string HealthStatusLabel { get; set; } = "";
    /// <summary>
    /// 不可用的原因，只有「不是因为调用失败」时才有值：
    /// <c>upstream-missing</c> 挂的上游已经不存在；<c>model-missing</c> 上游还在但这个模型没了；
    /// <c>upstream-disabled</c> 上游还在、只是被停用；<c>model-disabled</c> 模型还在、只是被停用。
    /// 两个 <c>-missing</c> 是死成员（不可逆，该摘除），两个 <c>-disabled</c> 是临时状态（启用即恢复）。
    /// 为空表示走的是常规健康判定（真的调用失败过），由 ConsecutiveFailures 一路解释。
    /// 有它才能避免界面写出「不可用（连续失败 0 次）」这种自相矛盾的归因。
    /// </summary>
    public string? UnavailableReason { get; set; }

    /// <summary>
    /// 这个成员能不能被摘除（指向的上游或模型已经不存在了）。
    /// 由后端与成员删除端点**同一个判据**算出，前端直接用，不要自己拼条件去猜——
    /// 猜的那一版连续三轮 review 各漏一处，每处都表现为「按钮亮着、点下去 409」。
    /// </summary>
    public bool Removable { get; set; }
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

    /// <summary>
    /// 密钥指纹：只保留头尾各几位，中间打码（如 sk-or-v1…9c2a）。
    /// 存在的理由是两条上游可以同名同 URL、只有 key 不同——只回 hasKey 时运维分不出谁是谁，
    /// 也就没法判断该换哪一把。仅在调用方具备 ConfigWrite 时下发，其余一律 null。
    /// 明文永不外泄，这里也永远不是完整密钥。
    /// </summary>
    public string? KeyFingerprint { get; set; }

    /// <summary>密钥可读性：missing（没配）/ ok（能解开）/ unreadable（密文在但当前密钥解不开，多半是换过 ApiKeyCrypto:Secret）。</summary>
    public string KeyStatus { get; set; } = "missing";
}

/// <summary>
/// 删除上游前的占用清单：谁还在引用它。空 = 可安全删除。
/// 交换所（exchanges）自带上游地址与密钥、不绑平台，所以不在这张表里。
/// </summary>
public sealed class PlatformDeleteBlockers
{
    public List<string> Models { get; set; } = new();
    public List<string> Pools { get; set; } = new();
    public int TotalCount => Models.Count + Pools.Count;
}

/// <summary>
/// 删除模型前的占用清单：哪些模型池还把它当成员，哪些逻辑模型还把它当上游 offering。
/// 两类引用的定位方式不同（池成员按 (modelId, platformId) 复合，offering 按 _id 单键），
/// 只查一类就会漏掉另一类，留下一条指向已删模型、解析不到又不报错的 offering。
/// </summary>
public sealed class ModelDeleteBlockers
{
    public List<string> Pools { get; set; } = new();
    public List<string> LogicalModels { get; set; } = new();
    public int TotalCount => Pools.Count + LogicalModels.Count;
}

/// <summary>
/// 删除模型池前的占用清单。
/// 「是某个类型的当前默认池」单列一条：它不是别人引用了你，而是删掉之后那个类型没有默认可用，
/// 属于同样必须先解决、但解决方式完全不同的一类阻挡。
/// </summary>
public sealed class PoolDeleteBlockers
{
    public bool IsCurrentDefault { get; set; }
    public List<string> AppCallers { get; set; } = new();
    public int TotalCount => AppCallers.Count + (IsCurrentDefault ? 1 : 0);
}

/// <summary>删除交换所前的占用清单：哪些模型池成员还指着它，哪些逻辑模型还把它当 offering 上游。</summary>
public sealed class ExchangeDeleteBlockers
{
    public List<string> Pools { get; set; } = new();
    public List<string> LogicalModels { get; set; } = new();
    public int TotalCount => Pools.Count + LogicalModels.Count;
}

/// <summary>删除团队前的占用清单：成员、接入密钥、appCaller 三类引用。</summary>
public sealed class TeamDeleteBlockers
{
    public List<string> Members { get; set; } = new();
    public int ServiceKeys { get; set; }
    public int AppCallers { get; set; }
    public int TotalCount => Members.Count + ServiceKeys + AppCallers;
}

/// <summary>
/// 删除租户前的剩余内容清单。租户删除刻意不做级联，所以这张清单同时就是
/// 「还要自己清掉什么」的待办：每一项非零都会挡下删除。
/// </summary>
public sealed class TenantDeleteBlockers
{
    public int OtherMembers { get; set; }
    public int Platforms { get; set; }
    public int Models { get; set; }
    public int Pools { get; set; }
    public int Exchanges { get; set; }
    public int LogicalModels { get; set; }
    public int ServiceKeys { get; set; }
    public int AppCallers { get; set; }
    public int TotalCount => OtherMembers + Platforms + Models + Pools + Exchanges + LogicalModels + ServiceKeys + AppCallers;
}

/// <summary>删除逻辑模型的结果：它名下的 offering 是从属子项，跟着一起删。</summary>
public sealed class LogicalModelDeleteResult
{
    public int OfferingsDeleted { get; set; }
}

/// <summary>
/// 删除 appCaller 的结果：它名下的提示词策略版本是从属子项，跟着一起删。
/// 报条数而不是静默删——删的是会改写系统提示词的治理配置，事后必须能核对删掉了什么。
/// </summary>
public sealed class AppCallerDeleteResult
{
    public int PromptPolicyVersionsDeleted { get; set; }
}

/// <summary>编辑上游：只改这几项；密钥走独立的轮换端点，不混在这里。</summary>
public sealed class UpdatePlatformRequest
{
    public string? Name { get; set; }
    public string? PlatformType { get; set; }
    public string? ApiUrl { get; set; }
    public int? MaxConcurrency { get; set; }
    public string? Remark { get; set; }
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
    public string ImageSizeControlMode { get; set; } = "inherit";
    public string? ImageSizeFieldFormat { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    /// <summary>缓存命中输入单价。null 表示没配，计价时按输入全价算，不当免费。</summary>
    public decimal? CachedInputPricePerMillion { get; set; }
    /// <summary>写入缓存输入单价，Anthropic 一类按溢价收费的协议才用得上。</summary>
    public decimal? CacheWritePricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    /// <summary>价格来源：upstream / admin / migrated；null 表示这份价格没有来源可考。</summary>
    public string? PriceSource { get; set; }
    /// <summary>价格观测时间（ISO）。</summary>
    public string? PriceObservedAt { get; set; }
    /// <summary>最后一次改价的人。</summary>
    public string? PriceUpdatedBy { get; set; }
    /// <summary>价格是否已到复核期（超过 30 天，或压根没有观测时间）。</summary>
    public bool PriceStale { get; set; }
    /// <summary>距上次观测过了多少天；没有观测时间为 null。</summary>
    public int? PriceAgeDays { get; set; }
    /// <summary>这份价格能不能用来记账：有价且币种是美金。</summary>
    public bool PriceBillable { get; set; }
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
}
public sealed class CreateModelRequest
{
    public string? PlatformId { get; set; }
    public string? Name { get; set; }
    public string? ModelName { get; set; }
    public string? Protocol { get; set; }
    public List<string> Capabilities { get; set; } = new();
    public string? ImageSizeControlMode { get; set; }
    public string? ImageSizeFieldFormat { get; set; }
    public string? ApiKey { get; set; }
    public int? Timeout { get; set; }
    public int? MaxRetries { get; set; }
    public int? MaxConcurrency { get; set; }
    public int? MaxTokens { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? CachedInputPricePerMillion { get; set; }
    public decimal? CacheWritePricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    public string? Remark { get; set; }
}

/// <summary>
/// 改一条已有模型。价格四档 + 币种一起提交，服务端据此重算来源与观测时间。
///
/// <see cref="SyncPoolIds"/> 是这次改动要一并更新的模型池：真正参与计费的是池成员里的那份价格，
/// 只改模型档案而不同步，线上会继续按旧价跑——而两处单独看都没错，这正是最难发现的一种漂移。
/// </summary>
public sealed class UpdateModelRequest
{
    public string? Name { get; set; }
    public string? Protocol { get; set; }
    public int? MaxTokens { get; set; }
    public string? Remark { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? CachedInputPricePerMillion { get; set; }
    public decimal? CacheWritePricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    /// <summary>true 表示清空这条模型的全部价格字段。</summary>
    public bool? ClearPricing { get; set; }
    /// <summary>
    /// true 表示清掉这条模型的最大输出 token 限制（改回「不限制」）。
    ///
    /// 为什么不能靠传 null：MaxTokens 本身就是可空的，而 JSON 序列化会把 undefined/null
    /// 整个省掉，服务端只在收到整数时才更新——于是「清空」与「这次没动它」在线上完全
    /// 分不开，旧限制永远留着，而界面写着「留空表示不限制」。同 ClearPricing 的处境。
    /// </summary>
    public bool? ClearMaxTokens { get; set; }
    /// <summary>保存后要把新价格同步过去的模型池 ID；不在表里的池保留它自己的覆盖价。</summary>
    public List<string>? SyncPoolIds { get; set; }
}

/// <summary>一条模型被某个模型池引用的情况：继承档案价，还是用了自己的覆盖价。</summary>
public sealed class ModelPoolUsageItem
{
    public string PoolId { get; set; } = "";
    public string PoolName { get; set; } = "";
    public string? ModelType { get; set; }
    /// <summary>true 表示这个池成员的价格与模型档案一致（继承）。</summary>
    public bool Inherits { get; set; }
    /// <summary>池成员上实际生效的价格，覆盖时与档案价不同。</summary>
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? CachedInputPricePerMillion { get; set; }
    public decimal? CacheWritePricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    public string? PriceSource { get; set; }
    public string? PriceObservedAt { get; set; }
    public string? PriceUpdatedBy { get; set; }
    /// <summary>这个池是不是只读的托管池（托管池不接受从这里改价）。</summary>
    public bool Managed { get; set; }
}

public sealed class ModelPoolUsageData
{
    public List<ModelPoolUsageItem> Pools { get; set; } = new();
    public int InheritingCount { get; set; }
    public int OverridingCount { get; set; }
}

public sealed class UpdateModelImageSizeControlRequest
{
    public string? Mode { get; set; }
    public string? FieldFormat { get; set; }
}
public sealed class CreateModelResult
{
    public ModelItem Item { get; set; } = new();
    public int PoolTypesCreated { get; set; }
    public int PoolsCreated { get; set; }
    public int ModelsAppended { get; set; }
}

// ── 逻辑模型与上游 Offering ──
// 能力契约审计结果。发布门禁只看 clean 一个布尔；不干净时按 unknownObjects 逐个点名整改。
public sealed class CapabilityAuditData
{
    public int SchemaVersion { get; set; }
    public int Scanned { get; set; }
    public int ResidualLegacyAliases { get; set; }
    public int StillUnversioned { get; set; }
    public bool Clean { get; set; }
    public List<CapabilityAuditFinding> UnknownObjects { get; set; } = new();
}

public sealed class CapabilityAuditFinding
{
    public string PublicId { get; set; } = "";
    public string ModelType { get; set; } = "";
    public List<string> UnknownCapabilities { get; set; } = new();
}

/// <summary>逻辑模型近 N 天用量，供白名单列表里那条趋势线与花费列使用。</summary>
/// <summary>把存量模型池搬成模型（公开名 + 上游线路）的结果。</summary>
public sealed class PoolMigrationResult
{
    /// <summary>试运行：只算不写。默认就是试运行——搬迁只该在人看过计划之后才真发生。</summary>
    public bool DryRun { get; set; }

    public int PoolsScanned { get; set; }
    public int ModelsCreated { get; set; }
    public int RoutesCreated { get; set; }

    /// <summary>已经有同名公开模型、这次只给它补线路的池。</summary>
    public int LinkedToExisting { get; set; }

    public List<PoolMigrationEntry> Entries { get; set; } = new();

    /// <summary>没搬的池与原因。静默跳过等于让人以为都搬完了。</summary>
    public List<PoolMigrationSkip> Skipped { get; set; } = new();
}

public sealed class PoolMigrationEntry
{
    public string PoolId { get; set; } = "";
    public string PoolName { get; set; } = "";
    public string PublicId { get; set; } = "";
    public string ModelType { get; set; } = "";
    public string RoutingStrategy { get; set; } = "priority";
    public bool IsDefaultForType { get; set; }
    public int RouteCount { get; set; }

    /// <summary>这次是新建了公开名，还是挂到了已有的同名模型下。</summary>
    public bool CreatedNewModel { get; set; }

    /// <summary>已有模型的能力原本是空的（能力门不放行），这次补上了。</summary>
    public bool RepairedCapabilities { get; set; }

    /// <summary>把近期的「不可用」一起搬过来的线路数。陈年旧账重置成健康，不算在内。</summary>
    public int CarriedUnavailableRoutes { get; set; }
}

public sealed class PoolMigrationSkip
{
    public string PoolId { get; set; } = "";
    public string PoolName { get; set; } = "";
    public string Reason { get; set; } = "";
}

public sealed class LogicalModelUsageData
{
    public int Days { get; set; }
    public DateTime From { get; set; }
    public DateTime To { get; set; }
    public List<LogicalModelUsageItem> Items { get; set; } = new();
}

public sealed class LogicalModelUsageItem
{
    public string PublicId { get; set; } = "";

    /// <summary>日期刻度（yyyy-MM-dd），与 <see cref="DailyCalls"/> 一一对应。</summary>
    public List<string> Days { get; set; } = new();

    /// <summary>每天的调用次数，没有调用的那天是 0（不是缺项）——曲线才不会把空档画成连线。</summary>
    public long[] DailyCalls { get; set; } = Array.Empty<long>();

    public long TotalCalls { get; set; }
    public long TotalTokens { get; set; }

    /// <summary>只累加 CostStatus=priced 的花费。算不出钱的不按零成本混进来。</summary>
    public decimal TotalCostUsd { get; set; }

    /// <summary>缺价调用次数。大于零时列表上要标出来，否则花费会看着莫名其妙地低。</summary>
    public long UnpricedCalls { get; set; }
}

public sealed class LogicalModelsData { public List<LogicalModelItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class LogicalModelItem
{
    public string Id { get; set; } = "";
    public string PublicId { get; set; } = "";
    public string Name { get; set; } = "";
    public string ModelType { get; set; } = "";
    public List<string> Capabilities { get; set; } = new();
    public List<string> AllowedAppCallerCodes { get; set; } = new();
    public string RoutingStrategy { get; set; } = "priority";
    public bool Enabled { get; set; }

    /// <summary>这个用途没点名模型时用它。同租户同用途最多一个。</summary>
    public bool IsDefaultForType { get; set; }

    /// <summary>
    /// 「对这些调用方而言，我是默认」——不点名时优先于 IsDefaultForType。
    /// 授权名单回答「能不能点名我」，这一份回答「不点名时是不是我」，刻意分开两个字段。
    /// </summary>
    public List<string> DefaultForAppCallerCodes { get; set; } = new();

    public int DisplayOrder { get; set; }
    public string? Description { get; set; }
    public string? CreatedAt { get; set; }
    public string? UpdatedAt { get; set; }
    public List<ModelOfferingItem> Offerings { get; set; } = new();
}
public sealed class ModelOfferingItem
{
    public string Id { get; set; } = "";
    public string LogicalModelId { get; set; } = "";
    public string TargetKind { get; set; } = "model";
    public string TargetId { get; set; } = "";
    public string TargetName { get; set; } = "";
    public string? ProviderName { get; set; }
    public string? UpstreamModelId { get; set; }
    public string? Protocol { get; set; }
    public string? EndpointPath { get; set; }
    public int Priority { get; set; }
    public int Weight { get; set; }
    public bool Enabled { get; set; }
    public int HealthStatus { get; set; }
    public int ConsecutiveFailures { get; set; }
    public int ConsecutiveSuccesses { get; set; }
    public int? MaxConcurrency { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }

    /// <summary>
    /// 这条线路为什么不参与这次排队；null 表示参与。服务端按唯一判据算好，前端不再自己判——
    /// 前端曾经自己算过一份（enabled &amp;&amp; healthStatus === 0），把「降级但仍在用」的线路
    /// 显示成「没有主」，而运行时照样在用它。
    /// </summary>
    public string? SkipReason { get; set; }

    /// <summary>排队名次，1 就是这次会落到的那一条；0 表示不参与。</summary>
    public int QueuePosition { get; set; }

    /// <summary>
    /// 它指向的上游模型与所属上游都还启用着吗。运行时按 Offering 查目标时会过滤掉不可用的，
    /// 所以这一条不算进来，面板就会把一条指向已停用模型的线路报成「会落到它」。
    /// </summary>
    public bool TargetUsable { get; set; } = true;
}
/// <summary>一个对外模型的「调用全貌」：点名它之后会发生什么，用当前真实状态回答。</summary>
public sealed class CallTraceData
{
    public string PublicId { get; set; } = "";
    public string Name { get; set; } = "";
    public string ModelType { get; set; } = "";
    public bool Enabled { get; set; }
    public bool IsDefaultForType { get; set; }
    public string RoutingStrategy { get; set; } = "priority";

    /// <summary>第一屏那句结论：现在发一个请求会落到谁，或者为什么调不通。</summary>
    public string Conclusion { get; set; } = "";
    public CallTraceGate Gate { get; set; } = new();
    public CallTraceUnnamed Unnamed { get; set; } = new();
    public List<ModelOfferingItem> Routes { get; set; } = new();
    public List<CallTraceRouteExtra> RouteExtras { get; set; } = new();
    public CallTraceLedger Ledger { get; set; } = new();

    /// <summary>
    /// 判定流程图：每个菱形一个节点，每条岔路带当前状态（走 / 可能走 / 走不到）。
    ///
    /// 与 doc/design.platform.llm-gateway.model-architecture.md 第 3 节那张图同构——
    /// 那张是静态的，这份是这个模型此刻的样子。
    /// </summary>
    public List<CallTraceFlowNode> Flow { get; set; } = new();
}

/// <summary>目录闸：谁能点名它。</summary>
public sealed class CallTraceGate
{
    public bool Enabled { get; set; }

    /// <summary>没配授权名单 = 所有调用方都能点名它。</summary>
    public bool OpenToAllCallers { get; set; }
    public List<string> AllowedAppCallerCodes { get; set; } = new();
    public string Summary { get; set; } = "";
}

/// <summary>「只给 appCallerCode、不点名模型」那条路会不会落到它。</summary>
public sealed class CallTraceUnnamed
{
    /// <summary>
    /// 模型这一侧的条件成不成立：是本用途的默认、自己启用着、而且真有一条线路能接。
    ///
    /// 注意它**不是**「会落到它」的完整答案——那句话还要看是谁在调。
    /// 2026-09-15 之前面板只有这一半，于是那句结论没有主语：配了专属池的调用方
    /// 在运行时根本走不到对外模型这一档，面板却照样说「会落到它」。
    /// </summary>
    public bool ServesUnnamed { get; set; }

    /// <summary>这个用途现在的默认是谁；没有默认时为 null。</summary>
    public string? CurrentDefaultPublicId { get; set; }
    public string? CurrentDefaultName { get; set; }
    public string Summary { get; set; } = "";

    /// <summary>
    /// 逐个调用方的结论——这句话的主语。
    ///
    /// 按本用途登记的调用方逐条算：认对外模型目录的才可能落到这里，
    /// 配了专属池的走自己的池，状态不放行的请求根本发不出去。
    /// </summary>
    public List<CallTraceUnnamedCaller> Callers { get; set; } = new();

    /// <summary>这个用途登记了几个调用方；0 表示还没有人按这个用途调过。</summary>
    public int CallerCount { get; set; }

    /// <summary>其中有几个不点名时会落到这个模型。</summary>
    public int ReachingCallerCount { get; set; }
}

/// <summary>「不点名时会不会落到这个模型」在某一个调用方身上的答案。</summary>
public sealed class CallTraceUnnamedCaller
{
    public string AppCallerCode { get; set; } = "";

    /// <summary>UsesModelCatalog / TrafficRejected。</summary>
    public string Reach { get; set; } = "";

    /// <summary>不点名时会不会落到这个模型（调用方与模型两侧条件都成立才为真）。</summary>
    public bool ReachesThisModel { get; set; }

    /// <summary>一句人话结论，由后端下发，前端不另行推断。</summary>
    public string Verdict { get; set; } = "";
}

/// <summary>
/// 判定流程图上的一个节点。
///
/// 为什么流程图的每一支也由后端下发状态：前端一旦自己判「这支走不走」，就是第二份判据
/// （形状 3）——而画出来的那张图恰恰是最容易被人当真的东西，它错了比列表错了更糟。
/// </summary>
public sealed class CallTraceFlowNode
{
    public string Id { get; set; } = "";

    /// <summary>菱形里的问题；顺序节点（不分叉）留空。</summary>
    public string Question { get; set; } = "";

    public List<CallTraceFlowBranch> Branches { get; set; } = new();
}

/// <summary>判定流程图上的一条岔路。</summary>
public sealed class CallTraceFlowBranch
{
    /// <summary>这一支的条件。</summary>
    public string Label { get; set; } = "";

    /// <summary>走这一支会怎样。</summary>
    public string Outcome { get; set; } = "";

    /// <summary>
    /// taken   —— 当前状态下确定会走这一支；
    /// possible —— 取决于请求本身或调用方，可能走；
    /// blocked —— 当前状态下走不到。
    ///
    /// 有 possible 这一档是刻意的：同一个模型对不同调用方、点名与不点名走的不是同一条路，
    /// 硬画成一条确定路径就是在编（按权重时尤其明显）。
    /// </summary>
    public string State { get; set; } = "";

    /// <summary>一句补充，例如「3 个调用方」。没有就留 null。</summary>
    public string? Note { get; set; }
}

/// <summary>线路上那些只有全貌面板要用的附加值，按 OfferingId 对上。</summary>
public sealed class CallTraceRouteExtra
{
    public string OfferingId { get; set; } = "";

    /// <summary>按权重分配时这条线路分到的比例；按顺位时为 null。</summary>
    public double? WeightPercent { get; set; }

    /// <summary>单价一句话；登记不全时为 null，面板如实说「单价未登记」。</summary>
    public string? PriceSummary { get; set; }
    public string? LastFailedAt { get; set; }
}

/// <summary>账本：近 N 天这个模型花了多少。</summary>
public sealed class CallTraceLedger
{
    public int WindowDays { get; set; }
    public long Calls { get; set; }
    public decimal CostUsd { get; set; }

    /// <summary>算不出钱的调用数。把它们当零成本加进去就是在账上撒谎，所以单独计。</summary>
    public long UnpricedCalls { get; set; }
    public string? LastCallAt { get; set; }
}

public sealed class CreateLogicalModelRequest
{
    public string? PublicId { get; set; }
    public string? Name { get; set; }
    public string? ModelType { get; set; }
    public List<string> Capabilities { get; set; } = new();
    public List<string> AllowedAppCallerCodes { get; set; } = new();

    /// <summary>「对这些调用方而言我是默认」——不点名时优先于用途默认。</summary>
    public List<string> DefaultForAppCallerCodes { get; set; } = new();
    public string? RoutingStrategy { get; set; }
    public int? DisplayOrder { get; set; }
    public string? Description { get; set; }
}
public sealed class UpdateLogicalModelRequest
{
    public string? Name { get; set; }
    public List<string>? Capabilities { get; set; }
    public List<string>? AllowedAppCallerCodes { get; set; }
    /// <summary>「对这些调用方而言我是默认」；不传表示不改。</summary>
    public List<string>? DefaultForAppCallerCodes { get; set; }
    public string? RoutingStrategy { get; set; }
    public int? DisplayOrder { get; set; }
    public string? Description { get; set; }

    /// <summary>设为/取消「这个用途的默认」。设为 true 时会顶掉同用途原来的那个默认。</summary>
    public bool? IsDefaultForType { get; set; }
}
public sealed class CreateModelOfferingRequest
{
    public string? TargetKind { get; set; }
    public string? TargetId { get; set; }
    public string? UpstreamModelId { get; set; }
    public string? Protocol { get; set; }
    public string? EndpointPath { get; set; }
    public int? Priority { get; set; }
    public int? Weight { get; set; }
    public int? MaxConcurrency { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }
}
public sealed class UpdateModelOfferingRequest
{
    public string? UpstreamModelId { get; set; }
    public string? Protocol { get; set; }
    public string? EndpointPath { get; set; }
    public int? Priority { get; set; }
    public int? Weight { get; set; }
    public int? MaxConcurrency { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }
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

public sealed class InstallImageLayeringCapabilityRequest
{
    public string? ApiKey { get; set; }
}

public sealed class ImageLayeringCapabilityStatus
{
    public string CapabilityId { get; set; } = "image-layering";
    public string State { get; set; } = "not-installed";
    public bool Installed { get; set; }
    public bool Verified { get; set; }
    public bool HasKey { get; set; }
    public string? ExchangeId { get; set; }
    public string? LogicalModelId { get; set; }
    public string? OfferingId { get; set; }
    public string ModelId { get; set; } = "fal-qwen-image-layered";
    public string PublicId { get; set; } = "image-layering";
    public string? LastVerifiedAt { get; set; }
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
    public List<string> AllowedModelPoolIds { get; set; } = new();
    public string? DefaultModelPoolId { get; set; }
    public bool AllowCrossPoolFallback { get; set; }
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

// ── 快捷提 bug（Ctrl+B 全局面板，2026-07-27）──

/// <summary>控制台快捷提交的缺陷截图附件（base64 不含 data: 前缀）。</summary>
public sealed class BugReportAttachmentDto
{
    public string? Name { get; set; }
    public string? MimeType { get; set; }
    public long Size { get; set; }
    public string? DataBase64 { get; set; }
}

/// <summary>控制台快捷提交的缺陷内容。环境信息由前端自动采集，用户不必手填。</summary>
public sealed class BugReportSubmitRequest
{
    public string? Source { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Severity { get; set; }
    /// <summary>正文（描述 + 环境附录），缺陷系统可直接落库展示。</summary>
    public string? Content { get; set; }
    public Dictionary<string, string>? Environment { get; set; }
    public List<BugReportAttachmentDto>? Attachments { get; set; }
}

/// <summary>提交结果。delivery=forwarded 表示已进缺陷系统，local 表示仅本地留存。</summary>
public sealed class BugReportSubmitResult
{
    public string Id { get; set; } = string.Empty;
    public string Delivery { get; set; } = "local";
    public string? Reference { get; set; }
    public string? DegradeReason { get; set; }
}

/// <summary>本地留存的缺陷记录（列表展示用，不含附件 base64）。</summary>
public sealed class BugReportItem
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Severity { get; set; } = string.Empty;
    public string Delivery { get; set; } = string.Empty;
    public string? Reference { get; set; }
    public string? DegradeReason { get; set; }
    public string? Reporter { get; set; }
    public int AttachmentCount { get; set; }
    public string? CreatedAt { get; set; }
}

/// <summary>缺陷记录列表 + 当前是否配置了缺陷系统转发。</summary>
public sealed class BugReportListData
{
    public List<BugReportItem> Items { get; set; } = new();
    public bool ForwardConfigured { get; set; }
}

// ---------------------------------------------------------------------------
// 上游预设 / 连通性自测 / 模型发现（minimal-user-input.md）
// ---------------------------------------------------------------------------

/// <summary>一条内置上游预设。用户选它 = 一次性拿到地址、协议、并发的正确默认值。</summary>
public sealed class ProviderPresetItem
{
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string PlatformType { get; set; } = string.Empty;
    public string ApiUrl { get; set; } = string.Empty;
    public string? ProviderId { get; set; }
    public int MaxConcurrency { get; set; }
    /// <summary>去哪里领密钥。空字符串表示这个上游不需要密钥（本地部署）。</summary>
    public string KeyConsoleUrl { get; set; } = string.Empty;
    /// <summary>密钥常见前缀，用于填错时给一句「看起来不像这个平台的密钥」。</summary>
    public string KeyPrefixHint { get; set; } = string.Empty;
    public bool SupportsModelDiscovery { get; set; }
    public bool SupportsUpstreamPricing { get; set; }
    public string Summary { get; set; } = string.Empty;
    /// <summary>搜索用的别名（中英文、拼音），前端只做过滤不做翻译。</summary>
    public List<string> SearchTerms { get; set; } = new();

    /// <summary>不校验密钥的本地/自建上游给的占位密钥；需要真密钥的上游为空串。</summary>
    public string KeylessPlaceholder { get; set; } = string.Empty;
}

public sealed class ProviderPresetsData
{
    public List<ProviderPresetItem> Items { get; set; } = new();
}

/// <summary>连通性自测结果。失败时 nextStep 必须给出可执行的下一步，不许只说「失败」。</summary>
public sealed class PlatformTestResult
{
    public bool Reachable { get; set; }
    public int? HttpStatus { get; set; }
    public long ElapsedMs { get; set; }
    /// <summary>探测实际打的地址，让用户能核对是不是自己想的那个。</summary>
    public string ProbedUrl { get; set; } = string.Empty;
    public int? ModelCount { get; set; }
    public string? FailureKind { get; set; }
    public string Message { get; set; } = string.Empty;
    public string? NextStep { get; set; }
}

/// <summary>上游返回的一个模型，外加系统替用户推断出来的用途与价格。</summary>
public sealed class UpstreamModelItem
{
    public string ModelId { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    /// <summary>这个模型的用途；名录命中就是名录登记的事实，否则退回上游声明或按标识猜。</summary>
    public List<string> InferredCapabilities { get; set; } = new();

    /// <summary>
    /// 用途的来源：catalog = 内置名录查到的、upstream = 上游自己声明的、guess = 按模型标识猜的。
    /// 必须透出到界面——猜出来的用途和查出来的不是一回事，用户有权知道该不该信它。
    /// </summary>
    public string CapabilitySource { get; set; } = string.Empty;

    /// <summary>是否在内置名录里。不在名录的模型要走管理员显式放行才能入池。</summary>
    public bool InCatalog { get; set; }

    /// <summary>名录登记的展示名与出品方；不在名录时为空。</summary>
    public string? CatalogDisplayName { get; set; }
    public string? CatalogVendor { get; set; }

    /// <summary>能不能接收图片输入 / 是不是必须给图才能调（名录登记的事实）。</summary>
    public bool AcceptsImageInput { get; set; }
    public bool RequiresImageInput { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
    /// <summary>价格来源：upstream = 上游给的；null = 上游没给，界面要如实说「未提供」。</summary>
    public string? PriceSource { get; set; }
    /// <summary>该模型标识是否已经在本租户登记过，避免重复导入。</summary>
    public bool AlreadyImported { get; set; }
}

public sealed class UpstreamModelsData
{
    public string ProbedUrl { get; set; } = string.Empty;
    public int Total { get; set; }
    public int AlreadyImportedCount { get; set; }
    public bool PricingProvided { get; set; }

    /// <summary>
    /// 上游实际返回了多少个模型——**仅在被截断时非空**。
    /// 截断必须让用户看见，否则他会以为面板里这些就是全部（no silent caps）。
    /// </summary>
    public int? TruncatedFromTotal { get; set; }

    /// <summary>
    /// 这份清单与价格是什么时候从上游拉回来的（服务端时间）。
    /// minimal-user-input 第 2 条要求拉回来的值必须标「来源与时间」——面板可能开着不动，
    /// 用户得能分辨手上这份报价是刚拉的还是半小时前的，否则会照着过期价格做导入决定。
    /// </summary>
    public DateTime FetchedAt { get; set; }

    public List<UpstreamModelItem> Items { get; set; } = new();
}

/// <summary>批量导入：只带模型标识，用途与价格由服务端按发现结果补齐，前端可覆盖。</summary>
public sealed class ImportUpstreamModelsRequest
{
    public List<ImportUpstreamModelEntry>? Models { get; set; }

    /// <summary>
    /// 导入的同时把模型登上白名单（建逻辑模型 + 挂一条上游线路）。默认开。
    ///
    /// 关掉之前想清楚：不登记的话，导入只在 llmgw_models 里留下一条物理模型记录，
    /// 调用方按公开模型名请求时压根找不到它——用户点完「导入 N 个」看到成功提示，
    /// 白名单里却什么都没多，还得再去另一页把同一个模型手工建两遍。
    /// 这正是「模型」与「白名单」分成两页的实际代价，默认开就是为了不让用户承担它。
    /// </summary>
    public bool? PublishToWhitelist { get; set; }
}

public sealed class ImportUpstreamModelEntry
{
    public string? ModelId { get; set; }
    public List<string>? Capabilities { get; set; }

    /// <summary>
    /// 管理员对「不在内置名录里的模型」的显式放行。
    ///
    /// 白名单默认只放行名录内的模型：名录外的模型没人说得清它能吃什么、吐什么，
    /// 入了池就会被调度到，用户看到的是「一请求就报错」。要用就得有人明确按下放行，
    /// 而不是让系统按模型名猜一把替他决定——放行动作会进审计，责任落到人。
    /// </summary>
    public bool AllowOutsideCatalog { get; set; }
    public decimal? InputPricePerMillion { get; set; }
    public decimal? OutputPricePerMillion { get; set; }
    public decimal? PricePerCall { get; set; }
    public string? PriceCurrency { get; set; }
}

public sealed class ImportUpstreamModelsResult
{
    public int Requested { get; set; }
    public int Created { get; set; }
    public int Skipped { get; set; }
    public List<string> SkippedModelIds { get; set; } = new();
    public List<string> CreatedModelIds { get; set; } = new();

    /// <summary>
    /// 因为不在名录、又没有显式放行而被拦下的模型。
    /// 与 SkippedModelIds 分开列：那批是「已经有了」，这批是「需要你拍一下板」，
    /// 混在一起用户就分不清该做什么（失败必须给可执行的下一步）。
    /// </summary>
    public List<string> BlockedOutsideCatalog { get; set; } = new();

    /// <summary>
    /// 公开名撞上了一条**别的用途**的已有对外模型，因此没挂线路的那些。
    ///
    /// 与「已存在」分开列：已存在是正常的幂等结果，这个是要人去处理的冲突——
    /// 挂过去会让运行时按那条模型的用途走（一条生图线路被当成 chat 发出去），
    /// 而导入这边还会报「已挂到已有模型」。
    /// </summary>
    public List<string> CrossTypePublicIdConflicts { get; set; } = new();

    /// <summary>默认模型池同步是否失败。true 时模型已入库但不会被池路由选中，前端必须如实告知而不是报全绿。</summary>
    public bool PoolSyncFailed { get; set; }

    /// <summary>这次新登上白名单的公开模型名。</summary>
    public List<string> WhitelistedPublicIds { get; set; } = new();

    /// <summary>
    /// 挂到已有公开模型名下的线路数。
    ///
    /// 这是「一个模型多个来源」的自然入口：白名单里已经有 gpt-4o 了，再从另一个 Provider
    /// 导一次同名模型，不新建一个公开名，而是给它多挂一条线路。
    /// </summary>
    public int LinkedToExistingCount { get; set; }

    /// <summary>白名单登记失败时的原因。模型本身已入库，只是没登上名单——不许报成全绿。</summary>
    public string? WhitelistMessage { get; set; }

    /// <summary>需要额外告诉用户的话（目前只有池同步失败时非空）。</summary>
    public string? Message { get; set; }
}

// ── 生图模型契约（可在控制台里改，不用改代码不用发版）──────────────────────────
//
// 这几个词表是**写入侧与运行时的共同约定**：控制台只让填这些值，prd-api 那边
// ImageGenModelAdapterConfig 也只认这些值。写死在两边各一份就是判据分裂（形状 3），
// 所以这里是唯一的一份，`ImageGenConfigOverrideGuardTests` 逐项比对它与 prd-api 侧
// SizeParamFormats / SizeConstraintTypes 常量类，改一边忘另一边会红。

/// <summary>控制台这一侧允许填的值。改这里之前先看那条守卫。</summary>
public static class ImageGenConfigVocabulary
{
    public static readonly IReadOnlySet<string> SizeParamFormats =
        new HashSet<string>(StringComparer.Ordinal) { "WxH", "{width,height}", "aspect_ratio", "none" };

    public static readonly IReadOnlySet<string> SizeConstraintTypes =
        new HashSet<string>(StringComparer.Ordinal) { "whitelist", "range", "aspect_ratio", "adaptive" };

    public static readonly IReadOnlySet<string> ResolutionBuckets =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "1k", "2k", "4k" };

    /// <summary>尺寸只认「宽x高」。写成 1024*1024 或 1024 x 1024 都拦下来，别让它进库。</summary>
    public static readonly System.Text.RegularExpressions.Regex SizePattern =
        new(@"^\d{2,5}x\d{2,5}$", System.Text.RegularExpressions.RegexOptions.Compiled);
}

public sealed class ImageGenConfigsData
{
    public List<ImageGenConfigItem> Items { get; set; } = new();
    public int Total { get; set; }

    /// <summary>
    /// 代码内置的契约（prd-api 启动时发布进 `llmgw_imagegen_builtin_catalog`）。
    ///
    /// 这里刻意**不手抄一份**：我第一版抄了，抄成 26 条、内容还对不上真表的 19 条——
    /// 手抄的清单就是 no-rootless-tree 说的那种「看起来有根、根是硬编码快照」。
    /// 现在它由运行时发布，代码改了它自动跟着改。
    ///
    /// 有了它，控制台能回答两件事：「这个模型是不是已经有内置契约」，
    /// 以及「照着内置那条改一份」——比让人从零填二十个字段现实得多。
    /// </summary>
    public int BuiltinCount { get; set; }

    public List<ImageGenConfigItem> Builtin { get; set; } = new();

    /// <summary>内置快照是什么时候发布的。太旧说明 prd-api 没起来或版本对不上。</summary>
    public string? BuiltinPublishedAt { get; set; }

    /// <summary>改完多久生效。界面上要如实写出来，别让人保存完盯着屏幕猜。</summary>
    public int RefreshSeconds { get; set; }

    /// <summary>
    /// 上一轮同步的时间，取**所有消费进程里最旧的那个**。
    ///
    /// 取最新的那个会撒谎：两个进程各有一份进程全局的注册表（prd-api 与 llmgw-serving），
    /// 一个同步不上、另一个照常写时，取最新就等于让健康的那个替失败的那个作答——
    /// 界面报「刚同步过」，而走失败那个进程的请求还在用旧契约。
    /// 取最旧的，这一屏说的就是「所有进程都至少同步到了这个时刻」。
    /// 有任何一个进程从没同步过时为空。
    /// </summary>
    public string? SyncedAt { get; set; }

    /// <summary>
    /// 上一轮真正生效的那几个模式。只报数字答不出「生效的是不是我刚改的那条」，
    /// 所以逐条列出来，让界面能对着自己刚填的模式打勾。
    /// 多进程时取**交集**：只有每个进程都认到的那几条才算真生效。
    /// </summary>
    public List<string> SyncedPatterns { get; set; } = new();

    /// <summary>
    /// 逐个消费进程的同步状态。界面要能答「是哪个进程没跟上」，而不只是一个汇总时间。
    /// </summary>
    public List<ImageGenSyncHost> SyncHosts { get; set; } = new();
}

/// <summary>一个消费进程的同步状态。</summary>
public sealed class ImageGenSyncHost
{
    /// <summary>进程角色：prd-api / llmgw-serving。</summary>
    public string HostRole { get; set; } = string.Empty;

    /// <summary>它上一轮同步的时间。空 = 这个进程还没拉过，走它的请求仍用代码内置那份。</summary>
    public string? SyncedAt { get; set; }

    /// <summary>它这一轮认到几条覆盖。</summary>
    public int OverrideCount { get; set; }
}

public sealed class ImageGenConfigItem
{
    public string Id { get; set; } = "";
    public string ModelIdPattern { get; set; } = "";
    public int MatchOrder { get; set; }
    public bool Enabled { get; set; }
    public string DisplayName { get; set; } = "";
    public string Provider { get; set; } = "";
    public string? PlatformType { get; set; }
    public string? OfficialDocUrl { get; set; }
    public string SizeConstraintType { get; set; } = "";
    public string SizeConstraintDescription { get; set; } = "";
    public Dictionary<string, List<string>> SizesByResolution { get; set; } = new();
    public bool SizesNotApplicable { get; set; }
    public string SizeParamFormat { get; set; } = "";
    public bool InjectSizePrompt { get; set; }
    public int? MustBeDivisibleBy { get; set; }
    public int? MaxWidth { get; set; }
    public int? MaxHeight { get; set; }
    public int? MinWidth { get; set; }
    public int? MinHeight { get; set; }
    public long? MaxPixels { get; set; }
    public Dictionary<string, string> ParamRenames { get; set; } = new();
    public bool RequiresResolutionParam { get; set; }
    public bool SupportsImageToImage { get; set; }
    public bool SupportsInpainting { get; set; }
    public bool SupportsResponseFormat { get; set; }
    public List<string> Notes { get; set; } = new();
    public string? UpdatedAt { get; set; }
}

public sealed class UpsertImageGenConfigRequest
{
    public string? ModelIdPattern { get; set; }
    public int? MatchOrder { get; set; }
    public bool? Enabled { get; set; }
    public string? DisplayName { get; set; }
    public string? Provider { get; set; }
    public string? PlatformType { get; set; }
    public string? OfficialDocUrl { get; set; }
    public string? SizeConstraintType { get; set; }
    public string? SizeConstraintDescription { get; set; }
    public Dictionary<string, List<string>>? SizesByResolution { get; set; }
    public bool? SizesNotApplicable { get; set; }
    public string? SizeParamFormat { get; set; }
    public bool? InjectSizePrompt { get; set; }
    public int? MustBeDivisibleBy { get; set; }
    public int? MaxWidth { get; set; }
    public int? MaxHeight { get; set; }
    public int? MinWidth { get; set; }
    public int? MinHeight { get; set; }
    public long? MaxPixels { get; set; }
    public Dictionary<string, string>? ParamRenames { get; set; }
    public bool? RequiresResolutionParam { get; set; }
    public bool? SupportsImageToImage { get; set; }
    public bool? SupportsInpainting { get; set; }
    public bool? SupportsResponseFormat { get; set; }
    public List<string>? Notes { get; set; }
}

// ── 模型名录补登（让系统「认识」上游新出的模型，不用改代码）──────────────────────
//
// 名录回答「这个模型是什么」：算哪几种用途、能不能吃图、出品方是谁、有哪些等价写法。
// 内置那张表只有二十来条，而线上两个上游共 573 个模型——其余 95% 走关键词猜测，
// 一百多个连一条用途都猜不出来，导进来就是「哑」模型，不参与任何用途匹配。

public sealed class CatalogEntriesData
{
    public List<CatalogEntryItem> Items { get; set; } = new();
    public int Total { get; set; }

    /// <summary>代码内置那张表。补登 0 条不等于系统什么都不认识，也给「照这条补一份」当模板。</summary>
    public int BuiltinCount { get; set; }
    public List<CatalogEntryItem> Builtin { get; set; } = new();

    /// <summary>
    /// 运行时真正认的那几种用途。界面只让从这里挑——填一个运行时不认的词，
    /// 这条补登看着生效了、模型照样选不中，而且不会有任何东西报错。
    /// </summary>
    public List<string> KnownCapabilities { get; set; } = new();
}

public sealed class CatalogEntryItem
{
    public string Id { get; set; } = "";
    public string CanonicalId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string Vendor { get; set; } = "";
    public List<string> Capabilities { get; set; } = new();
    public bool AcceptsImageInput { get; set; }
    public bool RequiresImageInput { get; set; }
    public List<string> Aliases { get; set; } = new();
    public string? Notes { get; set; }
    public bool Enabled { get; set; } = true;
    public string? UpdatedAt { get; set; }
}

public sealed class UpsertCatalogEntryRequest
{
    public string? CanonicalId { get; set; }
    public string? DisplayName { get; set; }
    public string? Vendor { get; set; }
    public List<string>? Capabilities { get; set; }
    public bool? AcceptsImageInput { get; set; }
    public bool? RequiresImageInput { get; set; }
    public List<string>? Aliases { get; set; }
    public string? Notes { get; set; }
    public bool? Enabled { get; set; }
}
