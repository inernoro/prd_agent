using System.Text.Json;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// LLM Gateway 统一响应模型
/// </summary>
public class GatewayResponse
{
    /// <summary>
    /// 是否成功
    /// </summary>
    public bool Success { get; init; }

    /// <summary>
    /// 错误码（失败时）
    /// </summary>
    public string? ErrorCode { get; init; }

    /// <summary>
    /// 错误消息（失败时）
    /// </summary>
    public string? ErrorMessage { get; init; }

    /// <summary>
    /// HTTP 状态码
    /// </summary>
    public int StatusCode { get; init; }

    /// <summary>
    /// 响应内容（非流式）
    /// </summary>
    public string? Content { get; init; }

    /// <summary>
    /// 响应内容（JSON 解析后）
    /// </summary>
    public JsonDocument? ContentJson { get; init; }

    /// <summary>
    /// 模型调度信息
    /// </summary>
    public GatewayModelResolution? Resolution { get; init; }

    /// <summary>
    /// Token 使用量
    /// </summary>
    public GatewayTokenUsage? TokenUsage { get; init; }

    /// <summary>
    /// 请求耗时（毫秒）
    /// </summary>
    public long DurationMs { get; init; }

    /// <summary>
    /// 首字节时间（毫秒）
    /// </summary>
    public long? TimeToFirstByteMs { get; init; }

    /// <summary>
    /// 日志 ID
    /// </summary>
    public string? LogId { get; init; }

    public static GatewayResponse Fail(string errorCode, string errorMessage, int statusCode = 500)
    {
        return new GatewayResponse
        {
            Success = false,
            ErrorCode = errorCode,
            ErrorMessage = errorMessage,
            StatusCode = statusCode
        };
    }

    public static GatewayResponse Ok(string content, GatewayModelResolution resolution, int statusCode = 200)
    {
        return new GatewayResponse
        {
            Success = true,
            Content = content,
            Resolution = resolution,
            StatusCode = statusCode
        };
    }
}

/// <summary>
/// 模型调度结果
/// </summary>
public class GatewayModelResolution
{
    /// <summary>
    /// 调度类型
    /// DedicatedPool: 专属模型池
    /// DefaultPool: 默认模型池
    /// DirectModel: 直接指定模型
    /// Legacy: 传统配置 (IsImageGen 等)
    /// </summary>
    public string ResolutionType { get; init; } = string.Empty;

    /// <summary>
    /// 期望的模型名称（调用方传入）
    /// </summary>
    public string? ExpectedModel { get; init; }

    /// <summary>
    /// 实际使用的模型名称
    /// </summary>
    public string ActualModel { get; init; } = string.Empty;

    /// <summary>
    /// 实际使用的平台 ID
    /// </summary>
    public string ActualPlatformId { get; init; } = string.Empty;

    /// <summary>
    /// 实际使用的平台名称
    /// </summary>
    public string? ActualPlatformName { get; init; }

    /// <summary>
    /// 模型池 ID（如果通过模型池调度）
    /// </summary>
    public string? ModelGroupId { get; init; }

    /// <summary>
    /// 模型池名称
    /// </summary>
    public string? ModelGroupName { get; init; }

    /// <summary>
    /// 模型池代码
    /// </summary>
    public string? ModelGroupCode { get; init; }

    /// <summary>
    /// 模型在池中的优先级
    /// </summary>
    public int? ModelPriority { get; init; }

    /// <summary>
    /// 模型健康状态
    /// </summary>
    public string? HealthStatus { get; init; }

    /// <summary>
    /// 是否匹配期望（ExpectedModel == ActualModel）
    /// </summary>
    public bool MatchedExpectation =>
        string.IsNullOrWhiteSpace(ExpectedModel) ||
        string.Equals(ExpectedModel, ActualModel, StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// Token 使用量
/// </summary>
public class GatewayTokenUsage
{
    /// <summary>
    /// 输入 Token 数
    /// </summary>
    public int? InputTokens { get; init; }

    /// <summary>
    /// 输出 Token 数
    /// </summary>
    public int? OutputTokens { get; init; }

    /// <summary>
    /// 总 Token 数
    /// </summary>
    public int? TotalTokens => (InputTokens ?? 0) + (OutputTokens ?? 0);

    /// <summary>
    /// 缓存创建 Token 数（仅 Claude）
    /// </summary>
    public int? CacheCreationInputTokens { get; init; }

    /// <summary>
    /// 缓存读取 Token 数（仅 Claude）
    /// </summary>
    public int? CacheReadInputTokens { get; init; }

    /// <summary>
    /// Token 统计来源
    /// stream_event: 从流事件中提取
    /// response_body: 从响应体中提取
    /// estimated: 估算值
    /// missing: 无法获取
    /// </summary>
    public string Source { get; init; } = "missing";
}

/// <summary>
/// 流式响应块
/// </summary>
public class GatewayStreamChunk
{
    /// <summary>
    /// 块类型
    /// </summary>
    public GatewayChunkType Type { get; init; }

    /// <summary>
    /// 内容（增量文本）
    /// </summary>
    public string? Content { get; init; }

    /// <summary>
    /// 完成原因（仅 Done 类型）
    /// </summary>
    public string? FinishReason { get; init; }

    /// <summary>
    /// Token 使用量（仅 Done 类型）
    /// </summary>
    public GatewayTokenUsage? TokenUsage { get; init; }

    /// <summary>
    /// 模型调度信息（首个块中）
    /// </summary>
    public GatewayModelResolution? Resolution { get; init; }

    /// <summary>
    /// 错误信息（仅 Error 类型）
    /// </summary>
    public string? Error { get; init; }

    /// <summary>
    /// 原始 SSE 数据
    /// </summary>
    public string? RawData { get; init; }

    public static GatewayStreamChunk Text(string content) => new() { Type = GatewayChunkType.Text, Content = content };
    public static GatewayStreamChunk Start(GatewayModelResolution resolution) => new() { Type = GatewayChunkType.Start, Resolution = resolution };
    public static GatewayStreamChunk Done(string? finishReason, GatewayTokenUsage? usage) => new() { Type = GatewayChunkType.Done, FinishReason = finishReason, TokenUsage = usage };
    public static GatewayStreamChunk Fail(string error) => new() { Type = GatewayChunkType.Error, Error = error };
}

/// <summary>
/// 流式块类型
/// </summary>
public enum GatewayChunkType
{
    /// <summary>
    /// 开始（包含调度信息）
    /// </summary>
    Start,

    /// <summary>
    /// 文本内容
    /// </summary>
    Text,

    /// <summary>
    /// 工具调用
    /// </summary>
    ToolCall,

    /// <summary>
    /// 完成
    /// </summary>
    Done,

    /// <summary>
    /// 错误
    /// </summary>
    Error
}

/// <summary>
/// 图片生成响应
/// </summary>
public class ImageGenGatewayResponse : GatewayResponse
{
    /// <summary>
    /// 生成的图片列表
    /// </summary>
    public List<GeneratedImage> Images { get; init; } = new();

    /// <summary>
    /// 请求的尺寸
    /// </summary>
    public string? RequestedSize { get; init; }

    /// <summary>
    /// 实际使用的尺寸
    /// </summary>
    public string? EffectiveSize { get; init; }

    /// <summary>
    /// 尺寸是否被调整
    /// </summary>
    public bool SizeAdjusted { get; init; }
}

/// <summary>
/// 生成的图片
/// </summary>
public class GeneratedImage
{
    public int Index { get; init; }
    public string? Url { get; init; }
    public string? OriginalUrl { get; init; }
    public string? Sha256 { get; init; }
    public string? RevisedPrompt { get; init; }
}
