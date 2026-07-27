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

    /// <summary>
    /// 划词锚定：被选中的原文片段（null 表示传统段落级评论，无正文定位）。
    /// 前端按 SelectedText + 前后上下文在已渲染正文中重定位并画黄色下划线；
    /// 正文更新后找不到原片段时仅不再画线，评论本身保留展示。
    /// </summary>
    public string? SelectedText { get; set; }

    /// <summary>选中片段前的上下文（约 50 字符，用于同一段文字多处出现时消歧）</summary>
    public string? ContextBefore { get; set; }

    /// <summary>选中片段后的上下文（约 50 字符）</summary>
    public string? ContextAfter { get; set; }

    /// <summary>选区起始字符偏移（相对该段落纯文本，仅作定位 hint）</summary>
    public int? StartOffset { get; set; }

    /// <summary>选区结束字符偏移（仅作定位 hint）</summary>
    public int? EndOffset { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}
