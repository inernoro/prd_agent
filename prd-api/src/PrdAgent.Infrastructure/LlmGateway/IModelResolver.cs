using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 模型调度执行器接口
/// 用于单元测试时可以 Mock 模型池数据
/// </summary>
public interface IModelResolver
{
    /// <summary>
    /// 解析模型调度结果
    /// </summary>
    /// <param name="appCallerCode">应用调用标识</param>
    /// <param name="modelType">模型类型</param>
    /// <param name="expectedModel">期望模型名（可选，用于日志记录）</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>调度结果</returns>
    Task<ModelResolutionResult> ResolveAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
        CancellationToken ct = default);

    /// <summary>
    /// 获取指定 AppCallerCode 的可用模型池列表
    /// </summary>
    Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default);

    /// <summary>
    /// 记录模型调用成功
    /// </summary>
    Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default);

    /// <summary>
    /// 记录模型调用失败
    /// </summary>
    Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default);
}

/// <summary>
/// 模型调度结果
/// </summary>
public class ModelResolutionResult
{
    /// <summary>
    /// 调度是否成功
    /// </summary>
    public bool Success { get; init; }

    /// <summary>
    /// 错误消息（调度失败时）
    /// </summary>
    public string? ErrorMessage { get; init; }

    /// <summary>
    /// 调度类型
    /// DedicatedPool: 专属模型池
    /// DefaultPool: 默认模型池
    /// Legacy: 传统配置 (IsImageGen 等)
    /// NotFound: 未找到可用模型
    /// </summary>
    public string ResolutionType { get; init; } = "NotFound";

    /// <summary>
    /// 期望的模型名称（调用方传入）
    /// </summary>
    public string? ExpectedModel { get; init; }

    /// <summary>
    /// 实际使用的模型名称
    /// </summary>
    public string? ActualModel { get; init; }

    /// <summary>
    /// 实际使用的平台 ID
    /// </summary>
    public string? ActualPlatformId { get; init; }

    /// <summary>
    /// 实际使用的平台名称
    /// </summary>
    public string? ActualPlatformName { get; init; }

    /// <summary>
    /// 平台类型（openai, claude 等）
    /// </summary>
    public string? PlatformType { get; init; }

    /// <summary>
    /// 本次调用使用的协议（最终保证有值）。
    /// 解析优先级：池条目 Protocol > 模型 Protocol > 平台 PlatformType。
    /// P1 协议下沉：存量数据 Protocol 均为 null，最终落到 PlatformType，路由结果与改动前一致。
    /// </summary>
    public string Protocol { get; init; } = string.Empty;

    /// <summary>
    /// 协议/模型解析来源说明（调试用，记录最终命中的协议层级与原因）。
    /// </summary>
    public string? ResolutionReason { get; init; }

    /// <summary>
    /// API URL
    /// </summary>
    public string? ApiUrl { get; init; }

    /// <summary>
    /// API Key（已解密）
    /// </summary>
    public string? ApiKey { get; init; }

    /// <summary>
    /// 模型池 ID
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
    /// 是否支持函数调用（function_calling 能力）。
    /// null = 未知（能力未分类，best-effort 放行）；true = 支持；false = 明确不支持（带 tools 时网关熔断报错，不骗用户）。
    /// 仅在解析上下文已持有 LLMModel 对象时填充（直连/Legacy 路径）；池路径无模型对象，留 null（见 debt.llm-gateway-protocol-fidelity）。
    /// </summary>
    public bool? SupportsFunctionCalling { get; init; }

    // ========== Exchange 中继信息 ==========

    /// <summary>是否为 Exchange 中继模型</summary>
    public bool IsExchange { get; init; }

    /// <summary>Exchange 配置 ID</summary>
    public string? ExchangeId { get; init; }

    /// <summary>Exchange 显示名称（自包含，用于日志）</summary>
    public string? ExchangeName { get; init; }

    /// <summary>Exchange 转换器类型（如 "fal-image-edit"）</summary>
    public string? ExchangeTransformerType { get; init; }

    /// <summary>Exchange 认证方案（如 "Bearer", "Key", "XApiKey"）</summary>
    public string? ExchangeAuthScheme { get; init; }

    /// <summary>Exchange 转换器配置</summary>
    public Dictionary<string, object>? ExchangeTransformerConfig { get; init; }

    /// <summary>
    /// 是否匹配期望
    /// </summary>
    public bool MatchedExpectation =>
        string.IsNullOrWhiteSpace(ExpectedModel) ||
        string.Equals(ExpectedModel, ActualModel, StringComparison.OrdinalIgnoreCase);

    // ========== 降级/回退信息 ==========

    /// <summary>
    /// 是否发生了降级/回退
    /// </summary>
    public bool IsFallback { get; init; }

    /// <summary>
    /// 降级原因描述
    /// </summary>
    public string? FallbackReason { get; init; }

    /// <summary>
    /// 原始配置的模型池 ID（降级前）
    /// </summary>
    public string? OriginalPoolId { get; init; }

    /// <summary>
    /// 原始配置的模型池名称（降级前）
    /// </summary>
    public string? OriginalPoolName { get; init; }

    /// <summary>
    /// 原始配置的模型列表（包含健康状态）
    /// </summary>
    public List<OriginalModelInfo>? OriginalModels { get; init; }

    /// <summary>
    /// 转换为 GatewayModelResolution（用于响应）
    /// </summary>
    public GatewayModelResolution ToGatewayResolution()
    {
        return new GatewayModelResolution
        {
            Success = Success,
            ErrorMessage = ErrorMessage,
            ResolutionType = ResolutionType,
            ExpectedModel = ExpectedModel,
            ActualModel = ActualModel ?? string.Empty,
            ActualPlatformId = ActualPlatformId ?? string.Empty,
            ActualPlatformName = ActualPlatformName,
            PlatformType = PlatformType,
            Protocol = Protocol,
            ResolutionReason = ResolutionReason,
            ApiUrl = ApiUrl,
            ModelGroupId = ModelGroupId,
            ModelGroupName = ModelGroupName,
            ModelGroupCode = ModelGroupCode,
            ModelPriority = ModelPriority,
            HealthStatus = HealthStatus,
            // 降级信息
            IsFallback = IsFallback,
            FallbackReason = FallbackReason,
            OriginalPoolId = OriginalPoolId,
            OriginalPoolName = OriginalPoolName,
            OriginalModels = OriginalModels?.Select(m => new OriginalModelDto
            {
                ModelId = m.ModelId,
                PlatformId = m.PlatformId,
                HealthStatus = m.HealthStatus,
                IsAvailable = m.IsAvailable,
                ConsecutiveFailures = m.ConsecutiveFailures
            }).ToList(),
            // Exchange 中继信息
            IsExchange = IsExchange,
            ExchangeId = ExchangeId,
            ExchangeName = ExchangeName,
            ExchangeTransformerType = ExchangeTransformerType,
            // 发送阶段所需字段（compute-then-send 原则）
            ApiKey = ApiKey,
            ExchangeAuthScheme = ExchangeAuthScheme,
            ExchangeTransformerConfig = ExchangeTransformerConfig
        };
    }

    public static ModelResolutionResult NotFound(string? expectedModel, string message)
    {
        return new ModelResolutionResult
        {
            Success = false,
            ResolutionType = "NotFound",
            ExpectedModel = expectedModel,
            ErrorMessage = message
        };
    }

    /// <summary>
    /// 计算本次调用使用的协议（P1 协议下沉）。
    /// 优先级：池条目 Protocol > 模型级 Protocol > 平台 PlatformType（兜底，保证有值）。
    /// platformType 已经是字符串（LLMPlatform.PlatformType 为 string，默认 "openai"），
    /// 这里不做大小写归一化，保持与既有把 PlatformType 当字符串透传的逻辑完全一致，
    /// 从而保证存量数据（Protocol 全为 null）的路由结果与改动前零差异。
    /// 同时回传命中的层级原因，供日志调试。
    /// </summary>
    private static (string Protocol, string Reason) ResolveProtocol(
        string? itemProtocol, string? modelProtocol, string? platformType)
    {
        if (!string.IsNullOrWhiteSpace(itemProtocol))
            return (itemProtocol, "protocol-from-pool-item");
        if (!string.IsNullOrWhiteSpace(modelProtocol))
            return (modelProtocol, "protocol-from-model");
        return (platformType ?? string.Empty, "protocol-from-platform-type");
    }

    public static ModelResolutionResult FromPool(
        string resolutionType,
        string? expectedModel,
        ModelGroupItem model,
        ModelGroup group,
        LLMPlatform platform,
        string? apiKey)
    {
        // P1 协议下沉：池条目 Protocol > 模型 Protocol > 平台 PlatformType。
        // 注意：池条目（ModelGroupItem.ModelId）引用的模型级 Protocol 不在本上下文，
        // 改动前路由完全依赖 platform.PlatformType，故此处模型级以 null 参与链，
        // 等价于直接落到 platform.PlatformType（向后兼容零差异）。
        var (protocol, reason) = ResolveProtocol(model.Protocol, null, platform.PlatformType);
        return new ModelResolutionResult
        {
            Success = true,
            ResolutionType = resolutionType,
            ExpectedModel = expectedModel,
            ActualModel = model.ModelId,
            ActualPlatformId = model.PlatformId,
            ActualPlatformName = platform.Name,
            PlatformType = platform.PlatformType,
            Protocol = protocol,
            ResolutionReason = reason,
            ApiUrl = platform.ApiUrl,
            ApiKey = apiKey,
            ModelGroupId = group.Id,
            ModelGroupName = group.Name,
            ModelGroupCode = group.Code,
            ModelPriority = model.Priority,
            HealthStatus = model.HealthStatus.ToString()
        };
    }

    public static ModelResolutionResult FromExchangePool(
        string resolutionType,
        string? expectedModel,
        ModelGroupItem model,
        ModelGroup group,
        ModelExchange exchange,
        string? apiKey)
    {
        return new ModelResolutionResult
        {
            Success = true,
            ResolutionType = resolutionType,
            ExpectedModel = expectedModel,
            ActualModel = model.ModelId,
            ActualPlatformId = model.PlatformId,
            ActualPlatformName = $"Exchange:{exchange.Name}",
            PlatformType = "exchange",
            // Exchange 中继：改动前 PlatformType 固定为 "exchange"，协议链以 null 模型级参与，
            // 池条目 Protocol 优先，否则落到 "exchange"，保持与既有行为一致。
            Protocol = string.IsNullOrWhiteSpace(model.Protocol) ? "exchange" : model.Protocol,
            ResolutionReason = string.IsNullOrWhiteSpace(model.Protocol)
                ? "protocol-from-platform-type"
                : "protocol-from-pool-item",
            ApiUrl = exchange.TargetUrl,
            ApiKey = apiKey,
            ModelGroupId = group.Id,
            ModelGroupName = group.Name,
            ModelGroupCode = group.Code,
            ModelPriority = model.Priority,
            HealthStatus = model.HealthStatus.ToString(),
            // Exchange 特有
            IsExchange = true,
            ExchangeId = exchange.Id,
            ExchangeName = exchange.Name,
            ExchangeTransformerType = exchange.TransformerType,
            ExchangeAuthScheme = exchange.TargetAuthScheme,
            ExchangeTransformerConfig = exchange.TransformerConfig
        };
    }

    public static ModelResolutionResult FromLegacy(
        string? expectedModel,
        LLMModel model,
        LLMPlatform platform,
        string? apiKey)
    {
        // P1 协议下沉：直连模型有真实 LLMModel 对象，模型级 Protocol 参与链；
        // 存量数据 Protocol 为 null → 落到 platform.PlatformType（向后兼容零差异）。
        var (protocol, reason) = ResolveProtocol(null, model.Protocol, platform.PlatformType);
        return new ModelResolutionResult
        {
            Success = true,
            ResolutionType = "Legacy",
            ExpectedModel = expectedModel,
            ActualModel = model.ModelName,
            ActualPlatformId = model.PlatformId ?? string.Empty,
            ActualPlatformName = platform.Name,
            PlatformType = platform.PlatformType,
            Protocol = protocol,
            ResolutionReason = reason,
            ApiUrl = model.ApiUrl ?? platform.ApiUrl,
            ApiKey = apiKey,
            HealthStatus = "Healthy",
            // 直连/Legacy 路径持有真实 LLMModel，可读 function_calling 能力供 G4 软门使用
            SupportsFunctionCalling = FunctionCallingCapability(model)
        };
    }

    public static ModelResolutionResult FromPinned(
        string? expectedModel,
        LLMModel model,
        LLMPlatform platform,
        string? apiKey)
    {
        var result = FromLegacy(expectedModel, model, platform, apiKey);
        return new ModelResolutionResult
        {
            Success = result.Success,
            ResolutionType = "PinnedModel",
            ExpectedModel = result.ExpectedModel,
            ActualModel = result.ActualModel,
            ActualPlatformId = result.ActualPlatformId,
            ActualPlatformName = result.ActualPlatformName,
            PlatformType = result.PlatformType,
            Protocol = result.Protocol,
            ResolutionReason = result.ResolutionReason,
            ApiUrl = result.ApiUrl,
            ApiKey = result.ApiKey,
            HealthStatus = result.HealthStatus,
            SupportsFunctionCalling = result.SupportsFunctionCalling
        };
    }

    public static ModelResolutionResult FromLegacyConfig(
        string? expectedModel,
        string resolutionType,
        string provider,
        string model,
        string? apiUrl,
        string? apiKey)
    {
        var protocol = string.Equals(provider, "Claude", StringComparison.OrdinalIgnoreCase)
            || string.Equals(provider, "Anthropic", StringComparison.OrdinalIgnoreCase)
            ? "anthropic"
            : "openai";

        return new ModelResolutionResult
        {
            Success = true,
            ResolutionType = resolutionType,
            ExpectedModel = expectedModel,
            ActualModel = model,
            ActualPlatformId = resolutionType,
            ActualPlatformName = provider,
            PlatformType = protocol,
            Protocol = protocol,
            ResolutionReason = "protocol-from-legacy-config",
            ApiUrl = apiUrl,
            ApiKey = apiKey,
            HealthStatus = "Healthy"
        };
    }

    /// <summary>
    /// 从模型能力描述符读 function_calling：无该条目返回 null（未知/未分类），有则返回其 Value。
    /// </summary>
    private static bool? FunctionCallingCapability(LLMModel model)
    {
        var cap = model.Capabilities?.FirstOrDefault(c =>
            string.Equals(c.Type, "function_calling", StringComparison.OrdinalIgnoreCase));
        return cap?.Value;
    }
}

/// <summary>
/// 模型调度执行计划（用于测试断言）
/// </summary>
public class ModelResolutionPlan
{
    /// <summary>
    /// 输入：AppCallerCode
    /// </summary>
    public string AppCallerCode { get; init; } = string.Empty;

    /// <summary>
    /// 输入：ModelType
    /// </summary>
    public string ModelType { get; init; } = string.Empty;

    /// <summary>
    /// 输入：ExpectedModel
    /// </summary>
    public string? ExpectedModel { get; init; }

    /// <summary>
    /// 第一步：是否找到 AppCaller 配置
    /// </summary>
    public bool FoundAppCaller { get; init; }

    /// <summary>
    /// 第一步：AppCaller 绑定的模型池 ID 列表
    /// </summary>
    public List<string> DedicatedPoolIds { get; init; } = new();

    /// <summary>
    /// 第二步：是否找到专属模型池
    /// </summary>
    public bool FoundDedicatedPools { get; init; }

    /// <summary>
    /// 第二步：专属模型池数量
    /// </summary>
    public int DedicatedPoolCount { get; init; }

    /// <summary>
    /// 第三步（回退）：是否找到默认模型池
    /// </summary>
    public bool FoundDefaultPools { get; init; }

    /// <summary>
    /// 第三步（回退）：默认模型池数量
    /// </summary>
    public int DefaultPoolCount { get; init; }

    /// <summary>
    /// 第四步（回退）：是否找到传统配置模型
    /// </summary>
    public bool FoundLegacyModel { get; init; }

    /// <summary>
    /// 最终选择的调度类型
    /// </summary>
    public string FinalResolutionType { get; init; } = string.Empty;

    /// <summary>
    /// 最终选择的模型池 ID
    /// </summary>
    public string? FinalModelGroupId { get; init; }

    /// <summary>
    /// 最终选择的模型 ID
    /// </summary>
    public string? FinalModelId { get; init; }

    /// <summary>
    /// 最终选择的平台 ID
    /// </summary>
    public string? FinalPlatformId { get; init; }

    /// <summary>
    /// 选择该模型的原因
    /// </summary>
    public string SelectionReason { get; init; } = string.Empty;
}

/// <summary>
/// 原始配置的模型信息（用于展示降级前的状态）
/// </summary>
public class OriginalModelInfo
{
    /// <summary>模型 ID</summary>
    public string ModelId { get; init; } = string.Empty;

    /// <summary>平台 ID</summary>
    public string PlatformId { get; init; } = string.Empty;

    /// <summary>健康状态</summary>
    public string HealthStatus { get; init; } = string.Empty;

    /// <summary>是否可用</summary>
    public bool IsAvailable { get; init; }

    /// <summary>连续失败次数</summary>
    public int ConsecutiveFailures { get; init; }
}
