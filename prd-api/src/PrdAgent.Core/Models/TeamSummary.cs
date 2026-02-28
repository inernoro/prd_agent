using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 团队周报汇总（AI 聚合生成）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class TeamSummary
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>团队名称（冗余）</summary>
    public string TeamName { get; set; } = string.Empty;

    /// <summary>ISO 周年</summary>
    public int WeekYear { get; set; }

    /// <summary>ISO 周数</summary>
    public int WeekNumber { get; set; }

    /// <summary>周期开始日期</summary>
    public DateTime PeriodStart { get; set; }

    /// <summary>周期结束日期</summary>
    public DateTime PeriodEnd { get; set; }

    /// <summary>汇总内容段落</summary>
    public List<TeamSummarySection> Sections { get; set; } = new();

    /// <summary>参与汇总的周报 ID 列表</summary>
    public List<string> SourceReportIds { get; set; } = new();

    /// <summary>团队总人数</summary>
    public int MemberCount { get; set; }

    /// <summary>已提交人数</summary>
    public int SubmittedCount { get; set; }

    /// <summary>生成者 UserId</summary>
    public string? GeneratedBy { get; set; }

    /// <summary>生成者名称（冗余）</summary>
    public string? GeneratedByName { get; set; }

    public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 团队汇总段落
/// </summary>
public class TeamSummarySection
{
    /// <summary>段落标题（如"本周亮点"、"关键指标"、"风险与阻塞"等）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>段落条目</summary>
    public List<string> Items { get; set; } = new();
}
