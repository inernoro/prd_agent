namespace PrdAgent.Core.Models;

public class ImageAsset
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = string.Empty;
    /// <summary>
    /// 归属的视觉创作 WorkspaceId（用于共享场景下的可见性与归档）。
    /// 为空表示历史数据或非 workspace 场景。
    /// </summary>
    public string? WorkspaceId { get; set; }
    public string Sha256 { get; set; } = string.Empty;
    public string Mime { get; set; } = "image/png";
    public int Width { get; set; } = 0;
    public int Height { get; set; } = 0;
    public long SizeBytes { get; set; } = 0;
    public string Url { get; set; } = string.Empty;
    public string? Prompt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>文章配图场景：该图片在文章中的插入位置索引(0-based)</summary>
    public int? ArticleInsertionIndex { get; set; }

    /// <summary>文章配图场景：原始提示词标记文本(如"温馨的咖啡厅场景")</summary>
    public string? OriginalMarkerText { get; set; }
}


