namespace PrdAgent.Core.Models;

/// <summary>
/// 产品评审员 — 方案提交记录
/// </summary>
public class ReviewSubmission
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>提交人 UserId</summary>
    public string SubmitterId { get; set; } = string.Empty;

    /// <summary>提交人展示名</summary>
    public string SubmitterName { get; set; } = string.Empty;

    /// <summary>方案标题（由提交人填写）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>已上传的 .md 文件 AttachmentId</summary>
    public string AttachmentId { get; set; } = string.Empty;

    /// <summary>原始文件名</summary>
    public string FileName { get; set; } = string.Empty;

    /// <summary>提取的 Markdown 文本内容（评审时使用）</summary>
    public string? ExtractedContent { get; set; }

    /// <summary>评审状态：Queued / Running / Done / Error</summary>
    public string Status { get; set; } = ReviewStatuses.Queued;

    /// <summary>评审结果 ID（Done 后填写）</summary>
    public string? ResultId { get; set; }

    /// <summary>评审结果快照：是否通过（≥80分为通过，Done 后填写）</summary>
    public bool? IsPassed { get; set; }

    public string? ErrorMessage { get; set; }

    public DateTime SubmittedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }

    /// <summary>
    /// 该提交被用户「重新上传方案救机会」的次数；语义 = 用户主动改/换内容的次数。
    /// 0 = 首次提交从未折腾过；≥1 = 用户至少救过一次。一次性通过率统计依赖此字段。
    /// 注意：不含 LLM 网关 Error 后的"重新评审"重跑（那是系统恢复，不归咎用户），见 ErrorRetryCount。
    /// </summary>
    public int RerunCount { get; set; } = 0;

    /// <summary>
    /// LLM 网关 Error 后用户点「重新评审」触发的系统重跑次数；与用户方案质量无关，仅用于运维统计。
    /// 一次性通过率公式不消费此字段。
    /// </summary>
    public int ErrorRetryCount { get; set; } = 0;

    /// <summary>申诉状态：null（未申诉）/ Pending / Approved / Rejected</summary>
    public string? AppealStatus { get; set; }

    /// <summary>最新一条申诉的 Id（ReviewAppeal.Id）</summary>
    public string? LatestAppealId { get; set; }

    /// <summary>最新申诉被受理的时间（通过 或 驳回）</summary>
    public DateTime? AppealResolvedAt { get; set; }
}

public static class ReviewStatuses
{
    public const string Queued = "Queued";
    public const string Running = "Running";
    public const string Done = "Done";
    public const string Error = "Error";
}
