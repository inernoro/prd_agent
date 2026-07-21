namespace PrdAgent.Core.Models;

/// <summary>
/// 模型解析类型（用于日志记录和追踪）
/// </summary>
public enum ModelResolutionType
{
    /// <summary>
    /// 直连单模型（显式指定 platformId + modelId）
    /// </summary>
    DirectModel = 0,

    /// <summary>
    /// 默认模型池（ModelGroup.IsDefaultForType = true）
    /// </summary>
    DefaultPool = 1,

    /// <summary>
    /// 专属模型池（AppCaller 绑定的 ModelGroupIds）
    /// </summary>
    DedicatedPool = 2,

    /// <summary>
    /// 传统配置（IsMain/IsVision/IsImageGen/IsIntent 标记）
    /// </summary>
    Legacy = 3,

    /// <summary>
    /// 租户逻辑模型；真实 Provider、Endpoint 与 Offering 对调用应用隐藏。
    /// </summary>
    LogicalModel = 4
}

public static class ModelResolutionTypeMapper
{
    public static ModelResolutionType? Parse(string? resolutionType)
    {
        if (string.IsNullOrWhiteSpace(resolutionType))
            return null;

        return resolutionType switch
        {
            "GatewayRegistryPool" => ModelResolutionType.DedicatedPool,
            "DedicatedPool" => ModelResolutionType.DedicatedPool,
            "DefaultPool" => ModelResolutionType.DefaultPool,
            "DirectModel" => ModelResolutionType.DirectModel,
            "Legacy" => ModelResolutionType.Legacy,
            "LogicalModel" => ModelResolutionType.LogicalModel,
            _ => null
        };
    }
}
