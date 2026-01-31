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
    /// 是否匹配期望
    /// </summary>
    public bool MatchedExpectation =>
        string.IsNullOrWhiteSpace(ExpectedModel) ||
        string.Equals(ExpectedModel, ActualModel, StringComparison.OrdinalIgnoreCase);

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
            ApiUrl = ApiUrl,
            ModelGroupId = ModelGroupId,
            ModelGroupName = ModelGroupName,
            ModelGroupCode = ModelGroupCode,
            ModelPriority = ModelPriority,
            HealthStatus = HealthStatus
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

    public static ModelResolutionResult FromPool(
        string resolutionType,
        string? expectedModel,
        ModelGroupItem model,
        ModelGroup group,
        LLMPlatform platform,
        string? apiKey)
    {
        return new ModelResolutionResult
        {
            Success = true,
            ResolutionType = resolutionType,
            ExpectedModel = expectedModel,
            ActualModel = model.ModelId,
            ActualPlatformId = model.PlatformId,
            ActualPlatformName = platform.Name,
            PlatformType = platform.PlatformType,
            ApiUrl = platform.ApiUrl,
            ApiKey = apiKey,
            ModelGroupId = group.Id,
            ModelGroupName = group.Name,
            ModelGroupCode = group.Code,
            ModelPriority = model.Priority,
            HealthStatus = model.HealthStatus.ToString()
        };
    }

    public static ModelResolutionResult FromLegacy(
        string? expectedModel,
        LLMModel model,
        LLMPlatform platform,
        string? apiKey)
    {
        return new ModelResolutionResult
        {
            Success = true,
            ResolutionType = "Legacy",
            ExpectedModel = expectedModel,
            ActualModel = model.ModelName,
            ActualPlatformId = model.PlatformId ?? string.Empty,
            ActualPlatformName = platform.Name,
            PlatformType = platform.PlatformType,
            ApiUrl = model.ApiUrl ?? platform.ApiUrl,
            ApiKey = apiKey,
            HealthStatus = "Healthy"
        };
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
