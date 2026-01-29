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

    /// <summary>
    /// 原图 URL（无水印）。用于作为参考图时避免水印叠加。
    /// 若无水印配置则与 Url 相同或为空。
    /// </summary>
    public string? OriginalUrl { get; set; }

    /// <summary>
    /// 原图 SHA256。用于参考图查询时定位无水印版本。
    /// </summary>
    public string? OriginalSha256 { get; set; }

    // ===== 多图组合功能：VLM 图片描述 =====

    /// <summary>
    /// VLM 生成的图片描述（用于多图组合时的语义理解）。
    /// 最大 500 字符。
    /// </summary>
    public string? Description { get; set; }

    /// <summary>
    /// 描述提取时间（UTC）。
    /// </summary>
    public DateTime? DescriptionExtractedAt { get; set; }

    /// <summary>
    /// 提取描述时使用的模型标识（如 gpt-4o、claude-3-5-sonnet）。
    /// </summary>
    public string? DescriptionModelId { get; set; }
}


