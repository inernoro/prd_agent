namespace PrdAgent.Core.Models;

/// <summary>
/// 底图/参考图配置（支持多个配置，每个配置包含提示词和图片）
/// </summary>
public class ReferenceImageConfig
{
    /// <summary>
    /// 主键（Guid）
    /// </summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 配置名称（如"科技风格"、"水墨风格"等）
    /// </summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 参考图风格提示词（如"请参考图中的风格、色调和构图方式来生成图片"）
    /// </summary>
    public string Prompt { get; set; } = string.Empty;

    /// <summary>
    /// 参考图的 SHA256（用于图生图）
    /// </summary>
    public string? ImageSha256 { get; set; }

    /// <summary>
    /// 参考图的 COS URL（用于前端预览）
    /// </summary>
    public string? ImageUrl { get; set; }

    /// <summary>
    /// 是否为当前激活的配置
    /// </summary>
    public bool IsActive { get; set; }

    /// <summary>
    /// 所属应用标识（如 "literary-agent"）
    /// </summary>
    public string AppKey { get; set; } = "literary-agent";

    /// <summary>
    /// 创建者管理员 ID
    /// </summary>
    public string? CreatedByAdminId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
