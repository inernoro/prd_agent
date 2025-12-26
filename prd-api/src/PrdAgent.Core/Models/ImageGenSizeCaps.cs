namespace PrdAgent.Core.Models;

/// <summary>
/// 生图 size 能力缓存（用于解决上游“allowed size 白名单”导致的参数不兼容问题）
/// - 按 modelId（已配置模型）或 platformId+modelName（平台回退调用）进行缓存
/// - allowedSizes 为上游报错中给出的允许尺寸列表（如 1664x928,1328x1328）
/// </summary>
public class ImageGenSizeCaps
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 已配置模型 id（优先命中）
    /// </summary>
    public string? ModelId { get; set; }

    /// <summary>
    /// 平台回退调用场景：平台 id
    /// </summary>
    public string? PlatformId { get; set; }

    /// <summary>
    /// 平台回退调用场景：模型名（规范化为 trim 后原值；查询时使用 lower）
    /// </summary>
    public string? ModelName { get; set; }

    /// <summary>
    /// 允许的尺寸白名单（格式：\"{w}x{h}\"，例如 \"1664x928\"）
    /// </summary>
    public List<string> AllowedSizes { get; set; } = new();

    /// <summary>
    /// 数据来源：upstream-error / manual / ...
    /// </summary>
    public string Source { get; set; } = "upstream-error";

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}


