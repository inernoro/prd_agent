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
    /// 当前解析模型允许的最大输出 Token 数。
    /// null 表示模型/池未声明上限，Gateway 保持调用方请求值不变。
    /// </summary>
    public int? MaxTokens { get; init; }

    /// <summary>平台级跨实例最大并发；null/0 表示不启用平台并发门。</summary>
    public int? PlatformMaxConcurrency { get; init; }

    /// <summary>模型级跨实例最大并发；null/0 表示不启用模型并发门。</summary>
    public int? ModelMaxConcurrency { get; init; }

    /// <summary>
    /// 是否支持函数调用（function_calling 能力）。
    /// null = 未知（能力未分类，best-effort 放行）；true = 支持；false = 明确不支持（带 tools 时网关熔断报错，不骗用户）。
    /// 池路径优先读取 ModelGroupItem.Capabilities 快照；旧池成员无快照时可由解析阶段匹配的 LLMModel 能力兜底。
    /// </summary>
    public bool? SupportsFunctionCalling { get; init; }

    /// <summary>是否支持视觉输入。false 表示明确不支持，null 表示未知。</summary>
    public bool? SupportsVision { get; init; }

    /// <summary>是否支持图片生成。false 表示明确不支持，null 表示未知。</summary>
    public bool? SupportsImageGeneration { get; init; }

    /// <summary>是否支持 thinking/reasoning 输出。false 表示明确不支持，null 表示未知。</summary>
    public bool? SupportsThinking { get; init; }

    /// <summary>是否支持结构化输出（json_schema/json_object/response_format）。false 表示明确不支持，null 表示未知。</summary>
    public bool? SupportsStructuredOutput { get; init; }

    /// <summary>是否支持 token logprobs/top_logprobs。false 表示明确不支持，null 表示未知。</summary>
    public bool? SupportsLogprobs { get; init; }

    /// <summary>是否支持并行工具调用（parallel_tool_calls）。false 表示明确不支持，null 表示未知。</summary>
    public bool? SupportsParallelToolCalls { get; init; }

    /// <summary>
    /// 字段级参数能力矩阵。key 为请求参数名（如 seed/stop），value=false 表示明确不支持，缺失表示未知。
    /// </summary>
    public Dictionary<string, bool>? ParameterCapabilities { get; init; }

    /// <summary>输入 Token 单价快照（币种由 PriceCurrency 指定，单位为每百万 Token）。</summary>
    public decimal? InputPricePerMillion { get; init; }

    /// <summary>输出 Token 单价快照（币种由 PriceCurrency 指定，单位为每百万 Token）。</summary>
    public decimal? OutputPricePerMillion { get; init; }

    /// <summary>每次调用固定费用快照（币种由 PriceCurrency 指定）。</summary>
    public decimal? PricePerCall { get; init; }

    /// <summary>价格币种。MAP 模型池历史价格字段为 CNY。</summary>
    public string? PriceCurrency { get; init; }

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
    /// 同一次解析阶段预计算出的后续可重试候选。
    /// 发送阶段只能消费这里的结果，不能在失败后再次调用 resolver，避免“算/发”混在一起。
    /// </summary>
    public List<ModelResolutionResult>? RetryCandidates { get; set; }

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
            MaxTokens = MaxTokens,
            PlatformMaxConcurrency = PlatformMaxConcurrency,
            ModelMaxConcurrency = ModelMaxConcurrency,
            SupportsFunctionCalling = SupportsFunctionCalling,
            SupportsVision = SupportsVision,
            SupportsImageGeneration = SupportsImageGeneration,
            SupportsThinking = SupportsThinking,
            SupportsStructuredOutput = SupportsStructuredOutput,
            SupportsLogprobs = SupportsLogprobs,
            SupportsParallelToolCalls = SupportsParallelToolCalls,
            ParameterCapabilities = ParameterCapabilities,
            InputPricePerMillion = InputPricePerMillion,
            OutputPricePerMillion = OutputPricePerMillion,
            PricePerCall = PricePerCall,
            PriceCurrency = PriceCurrency,
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
            ExchangeTransformerConfig = ExchangeTransformerConfig,
            RetryCandidates = RetryCandidates
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
        string? apiKey,
        LLMModel? modelConfig = null)
    {
        // P1 协议下沉：池条目 Protocol > 模型 Protocol > 平台 PlatformType。
        // 旧池成员可能没有能力快照；解析阶段可传入匹配到的 LLMModel，只补协议/能力元数据，
        // 不参与选路、不覆盖池成员价格和 MaxTokens，避免发送阶段二次 resolve。
        var (protocol, reason) = ResolveProtocol(model.Protocol, modelConfig?.Protocol, platform.PlatformType);
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
            HealthStatus = model.HealthStatus.ToString(),
            MaxTokens = model.MaxTokens,
            PlatformMaxConcurrency = platform.MaxConcurrency,
            ModelMaxConcurrency = modelConfig?.MaxConcurrency,
            SupportsFunctionCalling = FunctionCallingCapability(model, modelConfig),
            SupportsVision = VisionCapability(model, modelConfig),
            SupportsImageGeneration = ImageGenerationCapability(model, modelConfig),
            SupportsThinking = ThinkingCapability(model, modelConfig),
            SupportsStructuredOutput = StructuredOutputCapability(model, modelConfig),
            SupportsLogprobs = LogprobsCapability(model, modelConfig),
            SupportsParallelToolCalls = ParallelToolCallsCapability(model, modelConfig),
            ParameterCapabilities = ExtractParameterCapabilities(EffectiveCapabilities(model, modelConfig)),
            InputPricePerMillion = model.InputPricePerMillion,
            OutputPricePerMillion = model.OutputPricePerMillion,
            PricePerCall = model.PricePerCall,
            PriceCurrency = NormalizeModelPoolPriceCurrency(model.PriceCurrency)
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
            MaxTokens = model.MaxTokens,
            // Exchange 特有
            IsExchange = true,
            ExchangeId = exchange.Id,
            ExchangeName = exchange.Name,
            ExchangeTransformerType = exchange.TransformerType,
            ExchangeAuthScheme = exchange.TargetAuthScheme,
            ExchangeTransformerConfig = exchange.TransformerConfig,
            SupportsFunctionCalling = FunctionCallingCapability(model),
            SupportsVision = VisionCapability(model),
            SupportsImageGeneration = ImageGenerationCapability(model),
            SupportsThinking = ThinkingCapability(model),
            SupportsStructuredOutput = StructuredOutputCapability(model),
            SupportsLogprobs = LogprobsCapability(model),
            SupportsParallelToolCalls = ParallelToolCallsCapability(model),
            ParameterCapabilities = ExtractParameterCapabilities(model.Capabilities),
            InputPricePerMillion = model.InputPricePerMillion,
            OutputPricePerMillion = model.OutputPricePerMillion,
            PricePerCall = model.PricePerCall,
            PriceCurrency = NormalizeModelPoolPriceCurrency(model.PriceCurrency)
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
            MaxTokens = model.MaxTokens,
            PlatformMaxConcurrency = platform.MaxConcurrency,
            ModelMaxConcurrency = model.MaxConcurrency,
            // 直连/Legacy 路径持有真实 LLMModel，可读 function_calling 能力供 G4 软门使用
            SupportsFunctionCalling = FunctionCallingCapability(model),
            SupportsVision = VisionCapability(model),
            SupportsImageGeneration = ImageGenerationCapability(model),
            SupportsThinking = ThinkingCapability(model),
            SupportsStructuredOutput = StructuredOutputCapability(model),
            SupportsLogprobs = LogprobsCapability(model),
            SupportsParallelToolCalls = ParallelToolCallsCapability(model),
            ParameterCapabilities = ExtractParameterCapabilities(model.Capabilities)
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
            MaxTokens = result.MaxTokens,
            PlatformMaxConcurrency = result.PlatformMaxConcurrency,
            ModelMaxConcurrency = result.ModelMaxConcurrency,
            SupportsFunctionCalling = result.SupportsFunctionCalling,
            SupportsVision = result.SupportsVision,
            SupportsImageGeneration = result.SupportsImageGeneration,
            SupportsThinking = result.SupportsThinking,
            SupportsStructuredOutput = result.SupportsStructuredOutput,
            SupportsLogprobs = result.SupportsLogprobs,
            SupportsParallelToolCalls = result.SupportsParallelToolCalls,
            ParameterCapabilities = result.ParameterCapabilities,
            InputPricePerMillion = result.InputPricePerMillion,
            OutputPricePerMillion = result.OutputPricePerMillion,
            PricePerCall = result.PricePerCall,
            PriceCurrency = result.PriceCurrency
        };
    }

    private const string DefaultModelPoolPriceCurrency = "CNY";

    private static string NormalizeModelPoolPriceCurrency(string? currency)
    {
        var normalized = currency?.Trim().ToUpperInvariant();
        return normalized is "CNY" or "USD" ? normalized : DefaultModelPoolPriceCurrency;
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

    private static bool? FunctionCallingCapability(ModelGroupItem model)
    {
        return CapabilityValue(model.Capabilities, "function_calling", "tool_calling", "tools");
    }

    private static bool? FunctionCallingCapability(ModelGroupItem model, LLMModel? modelConfig)
        => CapabilityValue(EffectiveCapabilities(model, modelConfig), "function_calling", "tool_calling", "tools");

    private static bool? VisionCapability(LLMModel model)
        => model.IsVision || CapabilityValue(model.Capabilities, "vision", "image_input", "multimodal") == true
            ? true
            : CapabilityValue(model.Capabilities, "vision", "image_input", "multimodal");

    private static bool? VisionCapability(ModelGroupItem model)
        => model.IsVision || CapabilityValue(model.Capabilities, "vision", "image_input", "multimodal") == true
            ? true
            : CapabilityValue(model.Capabilities, "vision", "image_input", "multimodal");

    private static bool? VisionCapability(ModelGroupItem model, LLMModel? modelConfig)
    {
        var capabilities = EffectiveCapabilities(model, modelConfig);
        return model.IsVision || modelConfig?.IsVision == true || CapabilityValue(capabilities, "vision", "image_input", "multimodal") == true
            ? true
            : CapabilityValue(capabilities, "vision", "image_input", "multimodal");
    }

    private static bool? ImageGenerationCapability(LLMModel model)
        => model.IsImageGen || CapabilityValue(model.Capabilities, "image_generation", "text_to_image", "image") == true
            ? true
            : CapabilityValue(model.Capabilities, "image_generation", "text_to_image", "image");

    private static bool? ImageGenerationCapability(ModelGroupItem model)
        => model.IsImageGen || CapabilityValue(model.Capabilities, "image_generation", "text_to_image", "image") == true
            ? true
            : CapabilityValue(model.Capabilities, "image_generation", "text_to_image", "image");

    private static bool? ImageGenerationCapability(ModelGroupItem model, LLMModel? modelConfig)
    {
        var capabilities = EffectiveCapabilities(model, modelConfig);
        return model.IsImageGen || modelConfig?.IsImageGen == true || CapabilityValue(capabilities, "image_generation", "text_to_image", "image") == true
            ? true
            : CapabilityValue(capabilities, "image_generation", "text_to_image", "image");
    }

    private static bool? ThinkingCapability(LLMModel model)
        => CapabilityValue(model.Capabilities, "thinking", "reasoning");

    private static bool? ThinkingCapability(ModelGroupItem model)
        => CapabilityValue(model.Capabilities, "thinking", "reasoning");

    private static bool? ThinkingCapability(ModelGroupItem model, LLMModel? modelConfig)
        => CapabilityValue(EffectiveCapabilities(model, modelConfig), "thinking", "reasoning");

    private static bool? StructuredOutputCapability(LLMModel model)
        => CapabilityValue(model.Capabilities, "structured_output", "json_schema", "json_mode", "response_format");

    private static bool? StructuredOutputCapability(ModelGroupItem model)
        => CapabilityValue(model.Capabilities, "structured_output", "json_schema", "json_mode", "response_format");

    private static bool? StructuredOutputCapability(ModelGroupItem model, LLMModel? modelConfig)
        => CapabilityValue(EffectiveCapabilities(model, modelConfig), "structured_output", "json_schema", "json_mode", "response_format");

    private static bool? LogprobsCapability(LLMModel model)
        => CapabilityValue(model.Capabilities, "logprobs", "top_logprobs", "token_logprobs");

    private static bool? LogprobsCapability(ModelGroupItem model)
        => CapabilityValue(model.Capabilities, "logprobs", "top_logprobs", "token_logprobs");

    private static bool? LogprobsCapability(ModelGroupItem model, LLMModel? modelConfig)
        => CapabilityValue(EffectiveCapabilities(model, modelConfig), "logprobs", "top_logprobs", "token_logprobs");

    private static bool? ParallelToolCallsCapability(LLMModel model)
        => CapabilityValue(model.Capabilities, "parallel_tool_calls", "parallel_tools", "parallel_function_calling");

    private static bool? ParallelToolCallsCapability(ModelGroupItem model)
        => CapabilityValue(model.Capabilities, "parallel_tool_calls", "parallel_tools", "parallel_function_calling");

    private static bool? ParallelToolCallsCapability(ModelGroupItem model, LLMModel? modelConfig)
        => CapabilityValue(EffectiveCapabilities(model, modelConfig), "parallel_tool_calls", "parallel_tools", "parallel_function_calling");

    private static IEnumerable<LLMModelCapability>? EffectiveCapabilities(ModelGroupItem model, LLMModel? modelConfig)
        => model.Capabilities is { Count: > 0 } ? model.Capabilities : modelConfig?.Capabilities;

    private static bool? CapabilityValue(IEnumerable<LLMModelCapability>? capabilities, params string[] types)
    {
        if (capabilities is null) return null;
        var wanted = new HashSet<string>(types, StringComparer.OrdinalIgnoreCase);
        var cap = capabilities.FirstOrDefault(c => wanted.Contains(c.Type));
        return cap?.Value;
    }

    private static Dictionary<string, bool>? ExtractParameterCapabilities(IEnumerable<LLMModelCapability>? capabilities)
    {
        if (capabilities is null) return null;
        var result = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        foreach (var capability in capabilities)
        {
            var parameterName = ParameterCapabilityName(capability.Type);
            if (parameterName is null) continue;
            result[parameterName] = capability.Value;
        }
        return result.Count == 0 ? null : result;
    }

    private static string? ParameterCapabilityName(string? type)
    {
        if (string.IsNullOrWhiteSpace(type)) return null;
        var normalized = type.Trim();
        foreach (var prefix in new[] { "parameter:", "parameter.", "param:", "param." })
        {
            if (normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                var name = normalized[prefix.Length..].Trim();
                return name.Length == 0 ? null : name;
            }
        }
        return null;
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
