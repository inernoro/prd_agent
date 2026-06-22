namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷修复追踪记录：把缺陷、修复报告、commit、预览验收和发布状态串起来。
/// </summary>
public class DefectResolutionTrace
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>缺陷 ID</summary>
    public string DefectId { get; set; } = string.Empty;

    /// <summary>缺陷编号（快照）</summary>
    public string? DefectNo { get; set; }

    /// <summary>缺陷标题（快照）</summary>
    public string? DefectTitle { get; set; }

    /// <summary>关联的修复报告 ID</summary>
    public string? FixReportId { get; set; }

    /// <summary>关联的分享链接 ID</summary>
    public string? ShareLinkId { get; set; }

    /// <summary>分享 Token（冗余，便于开放接口侧排查）</summary>
    public string? ShareToken { get; set; }

    /// <summary>Agent 自报名称</summary>
    public string? AgentName { get; set; }

    /// <summary>Agent 标识（appId / User-Agent / 自定义 header）</summary>
    public string? AgentIdentifier { get; set; }

    /// <summary>仓库名，如 inernoro/prd_agent</summary>
    public string? Repository { get; set; }

    /// <summary>修复所在分支</summary>
    public string? Branch { get; set; }

    /// <summary>完整 commit sha</summary>
    public string CommitSha { get; set; } = string.Empty;

    /// <summary>短 commit sha</summary>
    public string ShortSha { get; set; } = string.Empty;

    /// <summary>commit message 快照</summary>
    public string? CommitMessage { get; set; }

    /// <summary>commit 详情链接</summary>
    public string? CommitUrl { get; set; }

    /// <summary>PR 编号</summary>
    public int? PullRequestNumber { get; set; }

    /// <summary>PR 链接</summary>
    public string? PullRequestUrl { get; set; }

    /// <summary>CDS 预览地址</summary>
    public string? PreviewUrl { get; set; }

    /// <summary>视觉验收报告 ID</summary>
    public string? VisualReportId { get; set; }

    /// <summary>视觉验收报告链接</summary>
    public string? VisualReportUrl { get; set; }

    /// <summary>正式环境视觉验收状态：pending | passed | failed</summary>
    public string ValidationStatus { get; set; } = DefectResolutionValidationStatus.Pending;

    /// <summary>视觉验收结论：pass | conditional | fail</summary>
    public string? ValidationVerdict { get; set; }

    /// <summary>视觉验收完成时间</summary>
    public DateTime? ValidationAt { get; set; }

    /// <summary>知识库名称</summary>
    public string? KnowledgeBaseName { get; set; }

    /// <summary>知识库文档 ID</summary>
    public string? KnowledgeBaseDocId { get; set; }

    /// <summary>知识库文档链接</summary>
    public string? KnowledgeBaseUrl { get; set; }

    /// <summary>风险等级：light | medium | heavy</summary>
    public string RiskLevel { get; set; } = DefectResolutionRiskLevel.Light;

    /// <summary>修复状态：fixed | preview_verified | validation_failed | waiting_publish | published</summary>
    public string FixStatus { get; set; } = DefectResolutionFixStatus.Fixed;

    /// <summary>发布状态：unknown | pending | published</summary>
    public string PublishStatus { get; set; } = DefectResolutionPublishStatus.Unknown;

    /// <summary>确认包含该修复的线上 commit sha</summary>
    public string? PublishedByCommitSha { get; set; }

    /// <summary>首次确认发布的时间</summary>
    public DateTime? PublishedAt { get; set; }

    /// <summary>已通知的缺陷提交人 UserId</summary>
    public string? NotifiedUserId { get; set; }

    /// <summary>通知时间</summary>
    public DateTime? NotifiedAt { get; set; }

    /// <summary>通知状态：none | pending | sent | failed</summary>
    public string NotifyStatus { get; set; } = DefectResolutionNotifyStatus.None;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class DefectResolutionRiskLevel
{
    public const string Light = "light";
    public const string Medium = "medium";
    public const string Heavy = "heavy";
}

public static class DefectResolutionFixStatus
{
    public const string Fixed = "fixed";
    public const string PreviewVerified = "preview_verified";
    public const string ValidationFailed = "validation_failed";
    public const string WaitingPublish = "waiting_publish";
    public const string Published = "published";
}

public static class DefectResolutionPublishStatus
{
    public const string Unknown = "unknown";
    public const string Pending = "pending";
    public const string Published = "published";
}

public static class DefectResolutionNotifyStatus
{
    public const string None = "none";
    public const string Pending = "pending";
    public const string Sent = "sent";
    public const string Failed = "failed";
}

public static class DefectResolutionValidationStatus
{
    public const string Pending = "pending";
    public const string Passed = "passed";
    public const string Failed = "failed";
    public const string Invalid = "invalid";
}
