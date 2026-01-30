namespace PrdAgent.Core.Models;

/// <summary>
/// 文学创作 Agent 应用级配置（如底图/参考图等）
/// </summary>
public class LiteraryAgentConfig
{
    /// <summary>
    /// 主键（使用 appKey 作为 ID，如 "literary-agent"）
    /// </summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>
    /// 参考图/底图的 SHA256（用于图生图）
    /// </summary>
    public string? ReferenceImageSha256 { get; set; }

    /// <summary>
    /// 参考图/底图的 COS URL（用于前端预览）
    /// </summary>
    public string? ReferenceImageUrl { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
