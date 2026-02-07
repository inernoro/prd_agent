namespace PrdAgent.Infrastructure.ModelPool.Models;

/// <summary>
/// 模型池端点定义 - 描述一个可用的模型 API 端点
/// 不包含业务逻辑，仅描述连接信息和调度权重
/// </summary>
public class PoolEndpoint
{
    /// <summary>
    /// 端点唯一标识（池内唯一，格式: {platformId}:{modelId}）
    /// </summary>
    public string EndpointId { get; set; } = string.Empty;

    /// <summary>
    /// 模型名称（如 gpt-4o, claude-3-opus）
    /// </summary>
    public string ModelId { get; set; } = string.Empty;

    /// <summary>
    /// 平台 ID
    /// </summary>
    public string PlatformId { get; set; } = string.Empty;

    /// <summary>
    /// 平台类型（openai, claude 等，用于选择适配器）
    /// </summary>
    public string PlatformType { get; set; } = "openai";

    /// <summary>
    /// 平台名称（用于日志和显示）
    /// </summary>
    public string? PlatformName { get; set; }

    /// <summary>
    /// API 基础 URL
    /// </summary>
    public string ApiUrl { get; set; } = string.Empty;

    /// <summary>
    /// API 密钥（已解密）
    /// </summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// 组内优先级（越小越优先，从 1 开始）
    /// </summary>
    public int Priority { get; set; } = 1;

    /// <summary>
    /// 最大输出 Token 数
    /// </summary>
    public int? MaxTokens { get; set; }

    /// <summary>
    /// 是否启用 Prompt Cache
    /// </summary>
    public bool? EnablePromptCache { get; set; }
}
