namespace PrdAgent.Core.Models;

/// <summary>
/// 产品评审员 — 申诉记录。
/// 提交人对评审结果（仅未通过）发起，由有 ReviewAgentAppealReview 权限的管理员审理。
/// </summary>
public class ReviewAppeal
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的 ReviewSubmission.Id</summary>
    public string SubmissionId { get; set; } = string.Empty;

    /// <summary>申诉发起人（= submission 原提交人）</summary>
    public string SubmitterId { get; set; } = string.Empty;
    public string SubmitterName { get; set; } = string.Empty;

    /// <summary>申诉理由（富文本 HTML，含 &lt;img src="attachmentUrl"&gt;）</summary>
    public string ReasonHtml { get; set; } = string.Empty;

    /// <summary>富文本中引用的图片 AttachmentId 列表（便于后续清理）</summary>
    public List<string> ImageAttachmentIds { get; set; } = new();

    /// <summary>申诉状态：Pending / Approved / Rejected</summary>
    public string Status { get; set; } = AppealStatuses.Pending;

    /// <summary>受理人 UserId</summary>
    public string? ResolverId { get; set; }
    public string? ResolverName { get; set; }

    /// <summary>受理意见（通过/驳回 理由，必填）</summary>
    public string? ResolverComment { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ResolvedAt { get; set; }
}

public static class AppealStatuses
{
    public const string Pending = "Pending";
    public const string Approved = "Approved";
    public const string Rejected = "Rejected";
}
