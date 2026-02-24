namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// LLM Gateway 统一接口 - 所有大模型调用的守门员
///
/// 设计原则：
/// 1. 所有 LLM 调用必须通过此接口
/// 2. 自动处理模型调度（根据 AppCallerCode 和模型池配置）
/// 3. 统一日志记录（包括期望模型 vs 实际模型）
/// 4. 统一健康管理（成功/失败反馈）
/// 5. 支持流式和非流式响应
///
/// 使用示例：
/// <code>
/// var request = new GatewayRequest
/// {
///     AppCallerCode = "visual-agent.image.vision::generation",
///     ModelType = "generation",
///     ExpectedModel = "nano-banana-pro",  // 仅作为提示，不强制
///     RequestBody = new JsonObject { ["prompt"] = "一只猫" }
/// };
///
/// // 非流式
/// var response = await gateway.SendAsync(request, ct);
///
/// // 流式
/// await foreach (var chunk in gateway.StreamAsync(request, ct))
/// {
///     Console.Write(chunk.Content);
/// }
/// </code>
/// </summary>
public interface ILlmGateway
{
    /// <summary>
    /// 发送非流式请求（Chat/Completion）
    /// </summary>
    Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default);

    /// <summary>
    /// 发送流式请求（Chat/Completion）
    /// </summary>
    IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest request, CancellationToken ct = default);

    /// <summary>
    /// 发送原始 HTTP 请求（用于图片生成等复杂场景）
    /// Gateway 负责：模型调度 + model 字段替换 + HTTP 发送 + 日志 + 健康管理
    /// 调用方负责：构建请求体（业务逻辑如尺寸适配、水印等）
    /// </summary>
    Task<GatewayRawResponse> SendRawAsync(GatewayRawRequest request, CancellationToken ct = default);

    /// <summary>
    /// 预解析模型调度结果（不发送请求）
    /// 用于前端展示可用模型池信息
    /// </summary>
    Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default);

    /// <summary>
    /// 获取指定 AppCallerCode 可用的模型池列表
    /// </summary>
    Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default);

    /// <summary>
    /// 创建 LLM 客户端（用于流式对话等场景）
    /// 这是一个简单的工厂方法，返回的客户端内部通过 Gateway 发送所有请求
    /// </summary>
    /// <param name="appCallerCode">应用调用标识（如 "prd-agent.chat::chat"）</param>
    /// <param name="modelType">模型类型（chat/vision/intent/generation）</param>
    /// <param name="maxTokens">最大 Token 数（默认 4096）</param>
    /// <param name="temperature">温度参数（默认 0.2）</param>
    /// <returns>LLM 客户端实例</returns>
    Core.Interfaces.ILLMClient CreateClient(
        string appCallerCode,
        string modelType,
        int maxTokens = 4096,
        double temperature = 0.2,
        bool includeThinking = false);
}

/// <summary>
/// 可用模型池信息
/// </summary>
public class AvailableModelPool
{
    /// <summary>
    /// 模型池 ID
    /// </summary>
    public string Id { get; init; } = string.Empty;

    /// <summary>
    /// 模型池名称
    /// </summary>
    public string Name { get; init; } = string.Empty;

    /// <summary>
    /// 模型池代码
    /// </summary>
    public string Code { get; init; } = string.Empty;

    /// <summary>
    /// 优先级
    /// </summary>
    public int Priority { get; init; }

    /// <summary>
    /// 来源类型
    /// </summary>
    public string ResolutionType { get; init; } = string.Empty;

    /// <summary>
    /// 是否为专属池
    /// </summary>
    public bool IsDedicated { get; init; }

    /// <summary>
    /// 是否为默认池
    /// </summary>
    public bool IsDefault { get; init; }

    /// <summary>
    /// 池内模型列表
    /// </summary>
    public List<PoolModelInfo> Models { get; init; } = new();
}

/// <summary>
/// 池内模型信息
/// </summary>
public class PoolModelInfo
{
    /// <summary>
    /// 模型名称
    /// </summary>
    public string ModelId { get; init; } = string.Empty;

    /// <summary>
    /// 平台 ID
    /// </summary>
    public string PlatformId { get; init; } = string.Empty;

    /// <summary>
    /// 平台名称
    /// </summary>
    public string? PlatformName { get; init; }

    /// <summary>
    /// 优先级
    /// </summary>
    public int Priority { get; init; }

    /// <summary>
    /// 健康状态
    /// </summary>
    public string HealthStatus { get; init; } = "Healthy";

    /// <summary>
    /// 健康评分（0-100）
    /// </summary>
    public int HealthScore { get; init; } = 100;
}
