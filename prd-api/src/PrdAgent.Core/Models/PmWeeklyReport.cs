namespace PrdAgent.Core.Models;

/// <summary>
/// 项目周报 — 项目级 Markdown 周报，支持 md 文档导入与图片展示。
/// 正文为 Markdown 文本（含图片链接 / base64），前端用 reading 版式渲染。
/// </summary>
public class PmWeeklyReport
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属项目</summary>
    public string ProjectId { get; set; } = string.Empty;

    /// <summary>周报标题（如「第 22 周 / 2026-05-26 ~ 05-30」）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>周起始日（可空，用于排序与周次展示）</summary>
    public DateTime? WeekStart { get; set; }

    /// <summary>正文（Markdown）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>作者 UserId</summary>
    public string AuthorId { get; set; } = string.Empty;

    /// <summary>作者名称（冗余，便于展示）</summary>
    public string? AuthorName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
