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

public sealed class LoginResultDto
{
    public string Token { get; init; } = string.Empty;
    public string? Username { get; init; }
    public string? DisplayName { get; init; }
    public string? ExpiresAt { get; init; }

    /// <summary>首登强制改密：为 true 时前端须跳「设置新口令」页，改密成功前不放行日志页。</summary>
    public bool MustChangePassword { get; init; }
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
}

// ── 日志列表 ──
public sealed class LlmLogListItem
{
    public string Id { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? PlatformId { get; set; }
    public string? PlatformName { get; set; }
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? UserId { get; set; }
    public string? Username { get; set; }
    public string? DisplayName { get; set; }
    public string? RequestType { get; set; }
    public string? AppCallerCode { get; set; }
    public string? AppCallerCodeDisplayName { get; set; }
    public string Status { get; set; } = string.Empty;
    public string? StartedAt { get; set; }
    public string? FirstByteAt { get; set; }
    public string? EndedAt { get; set; }
    public long? DurationMs { get; set; }
    public int? StatusCode { get; set; }
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public string? Error { get; set; }
    public bool? IsFallback { get; set; }
    public string? ExpectedModel { get; set; }
    public string? Protocol { get; set; }
    public string? ResolutionReason { get; set; }
    public string? Transport { get; set; }
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
    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? UserId { get; set; }
    public string? RequestType { get; set; }
    public string? AppCallerCode { get; set; }
    public string? AppCallerCodeDisplayName { get; set; }
    public string Provider { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? RequestBodyRedacted { get; set; }
    public string? SystemPromptText { get; set; }
    public string? QuestionText { get; set; }
    public string? AnswerText { get; set; }
    public string? ThinkingText { get; set; }
    public string? ResponseToolCalls { get; set; }
    public int? ToolCallCount { get; set; }
    public int? InputTokens { get; set; }
    public int? OutputTokens { get; set; }
    public string? StartedAt { get; set; }
    public string? FirstByteAt { get; set; }
    public string? EndedAt { get; set; }
    public long? DurationMs { get; set; }
    public string Status { get; set; } = string.Empty;
    public int? StatusCode { get; set; }
    public bool? IsFallback { get; set; }
    public string? FallbackReason { get; set; }
    public string? ExpectedModel { get; set; }
    public string? Protocol { get; set; }
    public string? ResolutionReason { get; set; }
    public string? Transport { get; set; }
    public string? FinishReason { get; set; }
    public bool? IsStreaming { get; set; }
    public string? Error { get; set; }
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
    public long? AverageDurationMs { get; set; }
    public List<LogsBucketItem> TransportDistribution { get; set; } = new();
    public List<LogsBucketItem> StatusDistribution { get; set; } = new();
}

public sealed class LogsBucketItem
{
    public string Key { get; set; } = "";
    public long Count { get; set; }
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

// ── 模型池（只读，网关配置面第一刀）──
public sealed class PoolsData { public List<PoolItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class PoolItem
{
    public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string Code { get; set; } = "";
    public int Priority { get; set; } public string ModelType { get; set; } = ""; public bool IsDefaultForType { get; set; }
    public int StrategyType { get; set; } public string? Description { get; set; }
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
    public List<PoolModelItem> Models { get; set; } = new();
}
public sealed class PoolModelItem
{
    public string ModelId { get; set; } = ""; public string PlatformId { get; set; } = ""; public int Priority { get; set; }
    public string? Protocol { get; set; } public int HealthStatus { get; set; } public string HealthStatusLabel { get; set; } = "";
    public string? LastFailedAt { get; set; } public string? LastSuccessAt { get; set; }
    public int ConsecutiveFailures { get; set; } public int ConsecutiveSuccesses { get; set; }
    public bool? EnablePromptCache { get; set; } public int? MaxTokens { get; set; }
    public decimal? InputPricePerMillion { get; set; } public decimal? OutputPricePerMillion { get; set; } public decimal? PricePerCall { get; set; }
}

// ── 平台（无任何密钥字段，仅 hasKey）──
public sealed class PlatformsData { public List<PlatformItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class PlatformItem
{
    public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string PlatformType { get; set; } = "";
    public string? ProviderId { get; set; } public string? ApiUrl { get; set; } public bool Enabled { get; set; }
    public int MaxConcurrency { get; set; } public string? Remark { get; set; } public bool HasKey { get; set; }
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
}

// ── 模型（无密钥，仅 hasKey）──
public sealed class ModelsData { public List<ModelItem> Items { get; set; } = new(); public long Total { get; set; } }
public sealed class ModelItem
{
    public string Id { get; set; } = ""; public string Name { get; set; } = ""; public string ModelName { get; set; } = "";
    public string? ApiUrl { get; set; } public string? Protocol { get; set; } public string? PlatformId { get; set; } public string? Group { get; set; }
    public int Timeout { get; set; } public int MaxRetries { get; set; } public int MaxConcurrency { get; set; } public int? MaxTokens { get; set; }
    public bool Enabled { get; set; } public int Priority { get; set; }
    public bool IsMain { get; set; } public bool IsIntent { get; set; } public bool IsVision { get; set; } public bool IsImageGen { get; set; }
    public bool? EnablePromptCache { get; set; } public string? Remark { get; set; } public bool HasKey { get; set; }
    public long CallCount { get; set; } public long SuccessCount { get; set; } public long FailCount { get; set; } public long TotalDuration { get; set; }
    public List<ModelCapabilityItem> Capabilities { get; set; } = new();
    public string? CreatedAt { get; set; } public string? UpdatedAt { get; set; }
}
public sealed class ModelCapabilityItem { public string Type { get; set; } = ""; public string Source { get; set; } = ""; public bool Value { get; set; } }

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
