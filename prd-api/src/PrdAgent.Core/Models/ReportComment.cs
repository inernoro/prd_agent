using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报评论（段落级 + 支持回复）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportComment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的周报 ID</summary>
    public string ReportId { get; set; } = string.Empty;

    /// <summary>段落索引（0-based）</summary>
    public int SectionIndex { get; set; }

    /// <summary>段落标题快照（创建时记录，后续段落标题变化不影响评论归属）</summary>
    public string SectionTitleSnapshot { get; set; } = string.Empty;

    /// <summary>父评论 ID（null 表示顶级评论）</summary>
    public string? ParentCommentId { get; set; }

    /// <summary>评论作者 UserId</summary>
    public string AuthorUserId { get; set; } = string.Empty;

    /// <summary>评论作者显示名（冗余）</summary>
    public string AuthorDisplayName { get; set; } = string.Empty;

    /// <summary>评论内容</summary>
    public string Content { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}
