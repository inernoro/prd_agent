namespace PrdAgent.Core.Models;

/// <summary>
/// 海鲜市场 Fork 下载记录
/// </summary>
public class MarketplaceForkLog
{
    /// <summary>
    /// 记录 ID (Guid 字符串)
    /// </summary>
    public string Id { get; set; } = null!;

    /// <summary>
    /// 下载用户 ID
    /// </summary>
    public string UserId { get; set; } = null!;

    /// <summary>
    /// 用户显示名称（冗余存储，避免查询 users 表）
    /// </summary>
    public string? UserName { get; set; }

    /// <summary>
    /// 用户头像文件名
    /// </summary>
    public string? UserAvatarFileName { get; set; }

    /// <summary>
    /// 配置类型（prompt、refImage、watermark 等）
    /// </summary>
    public string ConfigType { get; set; } = null!;

    /// <summary>
    /// 原始配置 ID（被 Fork 的源配置）
    /// </summary>
    public string SourceConfigId { get; set; } = null!;

    /// <summary>
    /// 原始配置名称（冗余存储）
    /// </summary>
    public string SourceConfigName { get; set; } = null!;

    /// <summary>
    /// 新配置 ID（Fork 后生成的配置）
    /// </summary>
    public string ForkedConfigId { get; set; } = null!;

    /// <summary>
    /// 新配置名称（用户自定义的名称）
    /// </summary>
    public string ForkedConfigName { get; set; } = null!;

    /// <summary>
    /// 原作者用户 ID
    /// </summary>
    public string? SourceOwnerUserId { get; set; }

    /// <summary>
    /// 原作者显示名称
    /// </summary>
    public string? SourceOwnerName { get; set; }

    /// <summary>
    /// 下载时间（UTC）
    /// </summary>
    public DateTime CreatedAt { get; set; }

    /// <summary>
    /// 应用标识（仅适用于特定应用的配置，如 literary-agent、visual-agent）
    /// </summary>
    public string? AppKey { get; set; }
}
