namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 业务模型目录兼容接口。
/// 供旧 Controller 在自己的路由下暴露模型列表；返回 DTO 沿用“模型池”命名，数据权威已是
/// LLM Gateway 对外逻辑模型目录。
/// </summary>
public interface IModelPoolQueryService
{
    /// <summary>
    /// 根据 appCallerCode 与 modelType 查询运行时对外模型目录；暂不可用项保留并下发健康状态。
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
    public long? AverageDurationMs { get; set; }
    public int RecentTenRequests { get; set; }
    public decimal? RecentTenSuccessRatePercent { get; set; }
    /// <summary>
    /// 网关声明的能力标签。前端据此二次确认「这条能不能拿来生图」——
    /// 后端已经过滤过一遍，这个字段是给旧后端 + 新前端那种组合兜底的。
    /// </summary>
    public List<string> Capabilities { get; set; } = new();
}

/// <summary>
/// 模型池内的模型项
/// </summary>
public class ModelPoolModelItem
{
    public string ModelId { get; set; } = string.Empty;
    public string PlatformId { get; set; } = string.Empty;
    /// <summary>目录生成时固化的实际供应商型号；只用于诊断同一物理线路被多个逻辑模型重复暴露。</summary>
    public string? ActualModelId { get; set; }
    /// <summary>实际供应商平台快照；与 <see cref="ActualModelId"/> 组成物理线路身份。</summary>
    public string? ActualPlatformId { get; set; }
    public int Priority { get; set; }
    public string HealthStatus { get; set; } = "Healthy";
}
