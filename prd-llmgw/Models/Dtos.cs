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
    public string? FinishReason { get; set; }
    public bool? IsStreaming { get; set; }
    public string? Error { get; set; }
}

// ── 元信息 ──
public sealed class LogsMeta
{
    public List<string> Models { get; set; } = new();
    public List<string> Statuses { get; set; } = new();
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
