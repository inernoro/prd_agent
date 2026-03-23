using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报浏览事件（允许同一用户重复记录，用于统计浏览频次）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportViewEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的周报 ID</summary>
    public string ReportId { get; set; } = string.Empty;

    /// <summary>浏览用户 UserId</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>浏览用户显示名快照</summary>
    public string UserName { get; set; } = string.Empty;

    /// <summary>浏览用户头像文件名快照</summary>
    public string? AvatarFileName { get; set; }

    /// <summary>浏览时间（UTC）</summary>
    public DateTime ViewedAt { get; set; } = DateTime.UtcNow;
}
