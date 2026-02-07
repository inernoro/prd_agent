using System.Text.Json.Nodes;

namespace PrdAgent.Infrastructure.ModelPool.Models;

/// <summary>
/// 模型池调度请求 - 业务无关，仅包含调度所需信息
/// </summary>
public class PoolRequest
{
    /// <summary>
    /// 请求体（JSON 格式，model 字段会被自动替换）
    /// </summary>
    public JsonObject RequestBody { get; set; } = new();

    /// <summary>
    /// 模型类型（chat / vision / generation / intent / embedding）
    /// 用于选择正确的 API 端点路径
    /// </summary>
    public required string ModelType { get; init; }

    /// <summary>
    /// 是否启用流式响应
    /// </summary>
    public bool Stream { get; init; }

    /// <summary>
    /// 是否启用 Prompt Cache（仅部分平台支持）
    /// </summary>
    public bool EnablePromptCache { get; init; }

    /// <summary>
    /// 请求超时（秒）
    /// </summary>
    public int TimeoutSeconds { get; init; } = 120;

    // ========== 审计字段（可选，不参与业务逻辑）==========

    /// <summary>
    /// 请求 ID（用于审计追踪，由调用方传入）
    /// </summary>
    public string? RequestId { get; init; }

    /// <summary>
    /// 用户 ID（用于审计追踪，由调用方传入）
    /// </summary>
    public string? UserId { get; init; }
}
