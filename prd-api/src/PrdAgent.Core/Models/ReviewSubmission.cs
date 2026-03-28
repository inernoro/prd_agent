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
}

public static class ReviewStatuses
{
    public const string Queued = "Queued";
    public const string Running = "Running";
    public const string Done = "Done";
    public const string Error = "Error";
}
