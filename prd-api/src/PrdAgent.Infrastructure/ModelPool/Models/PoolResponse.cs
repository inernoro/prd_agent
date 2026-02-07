namespace PrdAgent.Infrastructure.ModelPool.Models;

/// <summary>
/// 模型池调度响应 - 包含调度结果和元数据
/// </summary>
public class PoolResponse
{
    /// <summary>
    /// 是否成功
    /// </summary>
    public bool Success { get; init; }

    /// <summary>
    /// HTTP 状态码
    /// </summary>
    public int StatusCode { get; init; }

    /// <summary>
    /// 响应内容（原始字符串）
    /// </summary>
    public string? Content { get; init; }

    /// <summary>
    /// 错误码
    /// </summary>
    public string? ErrorCode { get; init; }

    /// <summary>
    /// 错误消息
    /// </summary>
    public string? ErrorMessage { get; init; }

    /// <summary>
    /// 实际使用的端点信息
    /// </summary>
    public DispatchedEndpointInfo? DispatchedEndpoint { get; init; }

    /// <summary>
    /// 请求耗时（毫秒）
    /// </summary>
    public long DurationMs { get; init; }

    /// <summary>
    /// 使用的策略类型
    /// </summary>
    public PoolStrategyType StrategyUsed { get; init; }

    /// <summary>
    /// 尝试的端点数量（Sequential/Race 模式下可能 > 1）
    /// </summary>
    public int EndpointsAttempted { get; init; } = 1;

    public static PoolResponse Fail(string errorCode, string errorMessage, int statusCode = 500)
    {
        return new PoolResponse
        {
            Success = false,
            ErrorCode = errorCode,
            ErrorMessage = errorMessage,
            StatusCode = statusCode
        };
    }
}

/// <summary>
/// 实际调度的端点信息
/// </summary>
public class DispatchedEndpointInfo
{
    /// <summary>端点 ID</summary>
    public string EndpointId { get; init; } = string.Empty;

    /// <summary>模型名称</summary>
    public string ModelId { get; init; } = string.Empty;

    /// <summary>平台 ID</summary>
    public string PlatformId { get; init; } = string.Empty;

    /// <summary>平台名称</summary>
    public string? PlatformName { get; init; }

    /// <summary>平台类型</summary>
    public string PlatformType { get; init; } = string.Empty;

    /// <summary>API URL</summary>
    public string ApiUrl { get; init; } = string.Empty;
}

/// <summary>
/// 流式响应块
/// </summary>
public class PoolStreamChunk
{
    /// <summary>块类型</summary>
    public PoolChunkType Type { get; init; }

    /// <summary>内容（增量文本）</summary>
    public string? Content { get; init; }

    /// <summary>完成原因</summary>
    public string? FinishReason { get; init; }

    /// <summary>错误信息</summary>
    public string? Error { get; init; }

    /// <summary>调度端点信息（仅 Start 块）</summary>
    public DispatchedEndpointInfo? DispatchedEndpoint { get; init; }

    /// <summary>原始 SSE 数据</summary>
    public string? RawData { get; init; }

    /// <summary>Token 使用量（仅 Done 块）</summary>
    public PoolTokenUsage? TokenUsage { get; init; }

    public static PoolStreamChunk Text(string content) => new() { Type = PoolChunkType.Text, Content = content };
    public static PoolStreamChunk Start(DispatchedEndpointInfo info) => new() { Type = PoolChunkType.Start, DispatchedEndpoint = info };
    public static PoolStreamChunk Done(string? finishReason, PoolTokenUsage? usage) => new() { Type = PoolChunkType.Done, FinishReason = finishReason, TokenUsage = usage };
    public static PoolStreamChunk Fail(string error) => new() { Type = PoolChunkType.Error, Error = error };
}

/// <summary>
/// 流式块类型
/// </summary>
public enum PoolChunkType
{
    Start, Text, Done, Error
}

/// <summary>
/// Token 使用量
/// </summary>
public class PoolTokenUsage
{
    public int? InputTokens { get; init; }
    public int? OutputTokens { get; init; }
    public int? TotalTokens => (InputTokens ?? 0) + (OutputTokens ?? 0);
    public int? CacheCreationInputTokens { get; init; }
    public int? CacheReadInputTokens { get; init; }
    public string Source { get; init; } = "missing";
}
