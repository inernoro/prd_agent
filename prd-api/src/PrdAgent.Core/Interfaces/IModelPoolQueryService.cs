namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 模型池查询服务 — 三级互斥解析（专属池 > 默认池 > 传统配置）
/// 供各应用 Controller 在自己的路由下暴露模型列表，而非直接调用管理端点。
/// </summary>
public interface IModelPoolQueryService
{
    /// <summary>
    /// 根据 appCallerCode 与 modelType 查询可用模型池列表。
    /// 返回结果按照优先级互斥：专属池 > 默认池 > 传统配置。
    /// </summary>
    /// <param name="appCallerCode">应用标识（如 visual-agent.image.text2img::generation），可为 null</param>
    /// <param name="modelType">模型类型（如 generation、chat、intent、vision）</param>
    /// <param name="ct">取消令牌</param>
    Task<List<ModelPoolForAppResult>> GetModelPoolsAsync(string? appCallerCode, string modelType, CancellationToken ct = default);
}

/// <summary>
/// 模型池查询结果（简化版，用于应用内部展示）
/// </summary>
public class ModelPoolForAppResult
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Code { get; set; } = string.Empty;
    public int Priority { get; set; }
    public string ModelType { get; set; } = string.Empty;
    public bool IsDefaultForType { get; set; }
    public string? Description { get; set; }
    public List<ModelPoolModelItem> Models { get; set; } = new();

    /// <summary>解析类型：DedicatedPool(专属池)、DefaultPool(默认池)、DirectModel(传统配置)</summary>
    public string ResolutionType { get; set; } = string.Empty;
    /// <summary>是否为该应用的专属模型池</summary>
    public bool IsDedicated { get; set; }
    /// <summary>是否为该类型的默认模型池</summary>
    public bool IsDefault { get; set; }
    /// <summary>是否为传统配置模型</summary>
    public bool IsLegacy { get; set; }
}

/// <summary>
/// 模型池内的模型项
/// </summary>
public class ModelPoolModelItem
{
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;
    public int Priority { get; set; }
    public string HealthStatus { get; set; } = "Healthy";
}
