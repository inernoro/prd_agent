namespace PrdAgent.Core.Models;

/// <summary>
/// PR审查棱镜：PR 提交与审查快照
/// </summary>
public class PrReviewPrismSubmission
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>创建人 UserId</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>创建人展示名</summary>
    public string OwnerDisplayName { get; set; } = string.Empty;

    /// <summary>仓库 owner</summary>
    public string RepoOwner { get; set; } = string.Empty;

    /// <summary>仓库名</summary>
    public string RepoName { get; set; } = string.Empty;

    /// <summary>PR 编号</summary>
    public int PullRequestNumber { get; set; }

    /// <summary>PR 链接</summary>
    public string PullRequestUrl { get; set; } = string.Empty;

    /// <summary>用户备注（可选）</summary>
    public string? Note { get; set; }

    /// <summary>PR 标题（GitHub 拉取快照）</summary>
    public string PullRequestTitle { get; set; } = string.Empty;

    /// <summary>PR 作者（GitHub login）</summary>
    public string PullRequestAuthor { get; set; } = string.Empty;

    /// <summary>PR 状态：open/closed/merged</summary>
    public string PullRequestState { get; set; } = "open";

    /// <summary>当前 head sha</summary>
    public string? HeadSha { get; set; }

    /// <summary>L1 Gate 状态：pending/completed/missing/error</summary>
    public string GateStatus { get; set; } = PrReviewPrismGateStatuses.Pending;

    /// <summary>L1 Gate 结论：success/failure/neutral/... </summary>
    public string? GateConclusion { get; set; }

    /// <summary>L1 Gate 详情链接（GitHub checks 页面）</summary>
    public string? GateDetailsUrl { get; set; }

    /// <summary>决策建议（来自决策卡评论）</summary>
    public string? DecisionSuggestion { get; set; }

    /// <summary>风险分（0-100，来自决策卡评论）</summary>
    public int? RiskScore { get; set; }

    /// <summary>置信度（0-100，来自决策卡评论）</summary>
    public int? ConfidencePercent { get; set; }

    /// <summary>是否触发硬阻断（来自决策卡评论）</summary>
    public bool? BlockersTriggered { get; set; }

    /// <summary>阻断项（来自决策卡评论）</summary>
    public List<string> Blockers { get; set; } = new();

    /// <summary>风险建议项（来自决策卡评论）</summary>
    public List<string> Advisories { get; set; } = new();

    /// <summary>架构师关注问题（最多 3 条）</summary>
    public List<string> FocusQuestions { get; set; } = new();

    /// <summary>决策卡评论链接</summary>
    public string? DecisionCardCommentUrl { get; set; }

    /// <summary>决策卡更新时间</summary>
    public DateTime? DecisionCardUpdatedAt { get; set; }

    /// <summary>最近一次刷新时间</summary>
    public DateTime? LastRefreshedAt { get; set; }

    /// <summary>最近一次刷新错误信息</summary>
    public string? LastRefreshError { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class PrReviewPrismGateStatuses
{
    public const string Pending = "pending";
    public const string Completed = "completed";
    public const string Missing = "missing";
    public const string Error = "error";
}
