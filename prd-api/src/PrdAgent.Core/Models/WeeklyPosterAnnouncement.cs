using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报海报 — 登录后主页轮播弹窗,末页 CTA 跳转到完整周报。
/// 草稿由 weekly-update-summary 技能生成,管理员手动补齐配图后点击发布。
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class WeeklyPosterAnnouncement
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>ISO 周标识,例如 "2026-W17"。同 WeekKey 的草稿可多次覆盖,已发布的唯一。</summary>
    public string WeekKey { get; set; } = string.Empty;

    /// <summary>海报标题(弹窗顶部)</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>副标题(可选)</summary>
    public string? Subtitle { get; set; }

    /// <summary>状态:draft / published / archived</summary>
    public string Status { get; set; } = WeeklyPosterStatus.Draft;

    /// <summary>轮播页(顺序按 Order 升序)</summary>
    public List<WeeklyPosterPage> Pages { get; set; } = new();

    /// <summary>末页 CTA 按钮文案</summary>
    public string CtaText { get; set; } = "阅读完整周报";

    /// <summary>末页 CTA 跳转 URL(支持站内路径或完整 URL)</summary>
    public string CtaUrl { get; set; } = "/changelog";

    /// <summary>发布时间</summary>
    public DateTime? PublishedAt { get; set; }

    /// <summary>发布人 UserId</summary>
    public string? PublishedBy { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class WeeklyPosterPage
{
    /// <summary>页码,从 0 开始</summary>
    public int Order { get; set; }

    /// <summary>页面标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>页面正文(markdown,纯文本都可,换行自动 break)</summary>
    public string Body { get; set; } = string.Empty;

    /// <summary>配图生成提示词 — 管理员复制去视觉创作生成,也可直接粘贴 URL</summary>
    public string ImagePrompt { get; set; } = string.Empty;

    /// <summary>配图 URL(空值时前端走渐变色兜底)</summary>
    public string? ImageUrl { get; set; }

    /// <summary>卡片主色调十六进制(如 "#7c3aed"),空值走默认紫</summary>
    public string? AccentColor { get; set; }
}

public static class WeeklyPosterStatus
{
    public const string Draft = "draft";
    public const string Published = "published";
    public const string Archived = "archived";
}
