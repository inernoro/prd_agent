namespace PrdAgent.Core.Models;

/// <summary>
/// 外部 Agent 提交的缺陷修复报告
/// </summary>
public class DefectFixReport
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的分享链接 ID</summary>
    public string ShareLinkId { get; set; } = string.Empty;

    /// <summary>分享 Token（冗余，便于匿名端点快速查找）</summary>
    public string ShareToken { get; set; } = string.Empty;

    /// <summary>Agent 自报名称</summary>
    public string? AgentName { get; set; }

    /// <summary>Agent 标识（User-Agent 或自定义 header）</summary>
    public string? AgentIdentifier { get; set; }

    /// <summary>修复报告条目列表</summary>
    public List<DefectFixReportItem> Items { get; set; } = new();

    /// <summary>报告总状态：pending | partial | completed</summary>
    public string Status { get; set; } = DefectFixReportStatus.Pending;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>提交者 IP（审计）</summary>
    public string? IpAddress { get; set; }

    /// <summary>提交者 User-Agent（审计）</summary>
    public string? UserAgent { get; set; }
}

/// <summary>
/// 修复报告中的单条缺陷分析
/// </summary>
public class DefectFixReportItem
{
    /// <summary>缺陷 ID</summary>
    public string DefectId { get; set; } = string.Empty;

    /// <summary>缺陷编号（快照）</summary>
    public string? DefectNo { get; set; }

    /// <summary>缺陷标题（快照）</summary>
    public string? DefectTitle { get; set; }

    /// <summary>可信度评分 0-100</summary>
    public int ConfidenceScore { get; set; }

    /// <summary>Agent 分析内容</summary>
    public string? Analysis { get; set; }

    /// <summary>修复建议</summary>
    public string? FixSuggestion { get; set; }

    /// <summary>验收状态：pending | accepted | rejected</summary>
    public string AcceptStatus { get; set; } = DefectFixAcceptStatus.Pending;

    /// <summary>审核者 ID</summary>
    public string? ReviewedBy { get; set; }

    /// <summary>审核者名称</summary>
    public string? ReviewedByName { get; set; }

    /// <summary>审核时间</summary>
    public DateTime? ReviewedAt { get; set; }

    /// <summary>审核备注</summary>
    public string? ReviewNote { get; set; }
}

public static class DefectFixAcceptStatus
{
    public const string Pending = "pending";
    public const string Accepted = "accepted";
    public const string Rejected = "rejected";
}

public static class DefectFixReportStatus
{
    public const string Pending = "pending";
    public const string Partial = "partial";
    public const string Completed = "completed";
}
