using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 周报
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay, IsPrimary = true)]
public class WeeklyReport
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>报告人 UserId</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>报告人名称（冗余）</summary>
    public string? UserName { get; set; }

    /// <summary>报告人头像文件名（冗余）</summary>
    public string? AvatarFileName { get; set; }

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>团队名称（冗余）</summary>
    public string? TeamName { get; set; }

    /// <summary>使用的模板 ID</summary>
    public string TemplateId { get; set; } = string.Empty;

    /// <summary>ISO 周年（注意跨年周的年份可能与日历年不同）</summary>
    public int WeekYear { get; set; }

    /// <summary>ISO 周数（1-53）</summary>
    public int WeekNumber { get; set; }

    /// <summary>周期开始日期（周一）</summary>
    public DateTime PeriodStart { get; set; }

    /// <summary>周期结束日期（周日）</summary>
    public DateTime PeriodEnd { get; set; }

    /// <summary>
    /// 状态：
    /// - not-started: 未开始
    /// - draft: 草稿
    /// - submitted: 已提交
    /// - reviewed: 已审阅
    /// - returned: 已退回
    /// - overdue: 逾期
    /// </summary>
    public string Status { get; set; } = WeeklyReportStatus.Draft;

    /// <summary>周报内容章节</summary>
    public List<WeeklyReportSection> Sections { get; set; } = new();

    /// <summary>提交时间</summary>
    public DateTime? SubmittedAt { get; set; }

    /// <summary>审阅时间</summary>
    public DateTime? ReviewedAt { get; set; }

    /// <summary>审阅人 UserId</summary>
    public string? ReviewedBy { get; set; }

    /// <summary>审阅人名称（冗余）</summary>
    public string? ReviewedByName { get; set; }

    /// <summary>退回原因</summary>
    public string? ReturnReason { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 周报内容章节
/// </summary>
public class WeeklyReportSection
{
    /// <summary>模板章节快照（创建时深拷贝，不受后续模板修改影响）</summary>
    public ReportTemplateSection TemplateSection { get; set; } = new();

    /// <summary>章节内容条目</summary>
    public List<WeeklyReportItem> Items { get; set; } = new();
}

/// <summary>
/// 周报内容条目
/// </summary>
public class WeeklyReportItem
{
    /// <summary>内容文本</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>数据来源：manual / git / jira 等</summary>
    public string Source { get; set; } = "manual";

    /// <summary>来源引用（如 commit hash、issue ID）</summary>
    public string? SourceRef { get; set; }
}

/// <summary>
/// 周报状态常量
/// </summary>
public static class WeeklyReportStatus
{
    public const string NotStarted = "not-started";
    public const string Draft = "draft";
    public const string Submitted = "submitted";
    public const string Reviewed = "reviewed";
    public const string Returned = "returned";
    public const string Overdue = "overdue";

    public static readonly string[] All = { NotStarted, Draft, Submitted, Reviewed, Returned, Overdue };
}
