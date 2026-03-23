using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 每日打点记录
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class ReportDailyLog
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>用户名称（冗余）</summary>
    public string? UserName { get; set; }

    /// <summary>日期（唯一索引 UserId+Date，一天一条）</summary>
    public DateTime Date { get; set; }

    /// <summary>打点条目列表</summary>
    public List<DailyLogItem> Items { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 每日打点条目
/// </summary>
public class DailyLogItem
{
    /// <summary>工作内容描述</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>分类标签（系统内置分类或自定义标签）</summary>
    public string Category { get; set; } = DailyLogCategory.Other;

    /// <summary>自定义标签列表（用户或团队级别自定义，如 ["需求评审", "代码复查"]）</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>耗时（分钟，选填）</summary>
    public int? DurationMinutes { get; set; }

    /// <summary>计划目标 ISO 周所属年份（仅 Todo 有效）</summary>
    public int? PlanWeekYear { get; set; }

    /// <summary>计划目标 ISO 周（1-53，仅 Todo 有效）</summary>
    public int? PlanWeekNumber { get; set; }

    /// <summary>条目创建时间（UTC）</summary>
    public DateTime? CreatedAt { get; set; }
}

/// <summary>
/// 打点分类常量
/// </summary>
public static class DailyLogCategory
{
    public const string Development = "development";
    public const string Meeting = "meeting";
    public const string Communication = "communication";
    public const string Documentation = "documentation";
    public const string Testing = "testing";
    public const string Todo = "todo";
    public const string Other = "other";

    public static readonly string[] All = { Development, Meeting, Communication, Documentation, Testing, Todo, Other };
}
