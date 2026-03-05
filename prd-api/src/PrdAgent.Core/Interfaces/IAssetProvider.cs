namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 统一资产披露接口 — 任何模块想要在"我的资产"中展示内容，只需实现此接口并注册到 DI。
/// Controller 自动聚合所有 IAssetProvider，无需手动修改。
/// </summary>
public interface IAssetProvider
{
    /// <summary>来源显示名（如"视觉创作"、"PRD Agent"）</summary>
    string Source { get; }

    /// <summary>此 Provider 能产出的资产类型（如 ["image"]、["document"]），用于分类过滤</summary>
    string[] SupportedCategories { get; }

    /// <summary>获取指定用户的资产列表</summary>
    Task<List<UnifiedAsset>> GetAssetsAsync(string userId, int limit, CancellationToken ct);
}

/// <summary>
/// 统一资产模型 — 所有来源的资产归一化为此结构。
/// </summary>
public class UnifiedAsset
{
    public string Id { get; set; } = string.Empty;

    /// <summary>image | document | attachment</summary>
    public string Type { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    /// <summary>内容摘要（前80字），让卡片不再空白</summary>
    public string? Summary { get; set; }

    /// <summary>来源标签（如"视觉创作"、"PRD Agent"、"手动上传"）</summary>
    public string Source { get; set; } = string.Empty;

    public string? Url { get; set; }
    public string? ThumbnailUrl { get; set; }
    public string? Mime { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public long SizeBytes { get; set; }
    public DateTime CreatedAt { get; set; }
    public string? WorkspaceId { get; set; }
}
