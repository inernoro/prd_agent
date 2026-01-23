namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷报告
/// </summary>
public class DefectReport
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>提交者 UserId</summary>
    public string OwnerUserId { get; set; } = null!;

    /// <summary>缺陷标题</summary>
    public string Title { get; set; } = null!;

    /// <summary>缺陷描述 (Markdown)</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>重现步骤</summary>
    public List<string> ReproSteps { get; set; } = new();

    /// <summary>期望行为</summary>
    public string? ExpectedBehavior { get; set; }

    /// <summary>实际行为</summary>
    public string? ActualBehavior { get; set; }

    /// <summary>环境信息</summary>
    public DefectEnvironment? Environment { get; set; }

    /// <summary>附件 ID 列表（截图/日志）</summary>
    public List<string> AttachmentIds { get; set; } = new();

    /// <summary>当前状态</summary>
    public DefectStatus Status { get; set; } = DefectStatus.Draft;

    /// <summary>优先级（AI 评估）</summary>
    public DefectPriority? Priority { get; set; }

    /// <summary>影响范围（AI 评估）</summary>
    public DefectImpact? Impact { get; set; }

    /// <summary>AI 复现置信度</summary>
    public ReproConfidence? ReproConfidence { get; set; }

    /// <summary>关联仓库配置 ID</summary>
    public string? RepoConfigId { get; set; }

    /// <summary>关联产品 ID</summary>
    public string? ProductId { get; set; }

    /// <summary>关联模块 ID</summary>
    public string? ModuleId { get; set; }

    /// <summary>关联 GitHub Issue 编号</summary>
    public int? GithubIssueNumber { get; set; }

    /// <summary>关联 GitHub PR 编号</summary>
    public int? GithubPrNumber { get; set; }

    /// <summary>指派的审核人 UserId</summary>
    public string? AssigneeUserId { get; set; }

    /// <summary>标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>重复缺陷 ID（如被标记为重复）</summary>
    public string? DuplicateOfId { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? ClosedAt { get; set; }
}

/// <summary>
/// 缺陷状态枚举
/// </summary>
public enum DefectStatus
{
    Draft,
    Submitted,
    Reviewing,
    Analyzed,
    Rejected,
    Fixing,
    PrCreated,
    Merged,
    Verified,
    Closed
}

/// <summary>
/// 优先级
/// </summary>
public enum DefectPriority
{
    P0_Blocker,
    P1_Critical,
    P2_Normal,
    P3_Minor
}

/// <summary>
/// 影响范围
/// </summary>
public enum DefectImpact
{
    CoreFunction,
    EdgeFunction,
    UiCosmetic,
    Performance,
    Security
}

/// <summary>
/// 复现置信度
/// </summary>
public enum ReproConfidence
{
    High,
    Medium,
    Low,
    Unknown
}

/// <summary>
/// 环境信息
/// </summary>
public class DefectEnvironment
{
    public string? Browser { get; set; }
    public string? Os { get; set; }
    public string? AppVersion { get; set; }
    public string? ScreenResolution { get; set; }
    public Dictionary<string, string>? CustomFields { get; set; }
}
