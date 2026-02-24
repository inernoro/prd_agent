namespace PrdAgent.Infrastructure.ModelPool.Models;

/// <summary>
/// 端点测试结果
/// </summary>
public class PoolTestResult
{
    /// <summary>是否成功</summary>
    public bool Success { get; init; }

    /// <summary>测试的端点 ID</summary>
    public string EndpointId { get; init; } = string.Empty;

    /// <summary>测试的模型名称</summary>
    public string ModelId { get; init; } = string.Empty;

    /// <summary>平台名称</summary>
    public string? PlatformName { get; init; }

    /// <summary>HTTP 状态码</summary>
    public int? StatusCode { get; init; }

    /// <summary>响应时间（毫秒）</summary>
    public long LatencyMs { get; init; }

    /// <summary>响应内容摘要（前 500 字符）</summary>
    public string? ResponsePreview { get; init; }

    /// <summary>错误消息</summary>
    public string? ErrorMessage { get; init; }

    /// <summary>Token 使用量</summary>
    public PoolTokenUsage? TokenUsage { get; init; }

    /// <summary>测试时间</summary>
    public DateTime TestedAt { get; init; } = DateTime.UtcNow;
}

/// <summary>
/// 端点测试请求
/// </summary>
public class PoolTestRequest
{
    /// <summary>
    /// 测试提示词（默认: "Say hello in 10 words."）
    /// </summary>
    public string Prompt { get; init; } = "Say hello in 10 words.";

    /// <summary>
    /// 模型类型
    /// </summary>
    public string ModelType { get; init; } = "chat";

    /// <summary>
    /// 超时秒数
    /// </summary>
    public int TimeoutSeconds { get; init; } = 30;

    /// <summary>
    /// 最大 Token 数
    /// </summary>
    public int MaxTokens { get; init; } = 100;
}
