using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报点赞记录（一个用户对同一篇周报最多一条）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportLike
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的周报 ID</summary>
    public string ReportId { get; set; } = string.Empty;

    /// <summary>点赞用户 UserId</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>点赞用户显示名快照</summary>
    public string UserName { get; set; } = string.Empty;

    /// <summary>点赞用户头像文件名快照</summary>
    public string? AvatarFileName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
