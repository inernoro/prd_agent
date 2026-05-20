namespace PrdAgent.Core.Models;

/// <summary>
/// CDS Agent 知识库改写草稿。草稿独立于正式 DocumentEntry/ParsedPrd，apply 前不得覆盖原文。
/// </summary>
public class KnowledgeBaseDraft
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    public string StoreId { get; set; } = string.Empty;

    public string EntryId { get; set; } = string.Empty;

    public string? BaseDocumentId { get; set; }

    public string BaseContentHash { get; set; } = string.Empty;

    public DateTime BaseUpdatedAt { get; set; }

    public string? TitleDraft { get; set; }

    public string ContentDraft { get; set; } = string.Empty;

    public string Status { get; set; } = KnowledgeBaseDraftStatuses.Draft;

    public string CreatedBy { get; set; } = string.Empty;

    public string? ApplyApprovalId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? AppliedAt { get; set; }
}

public static class KnowledgeBaseDraftStatuses
{
    public const string Draft = "draft";
    public const string Applied = "applied";
    public const string Rejected = "rejected";
    public const string Discarded = "discarded";
    public const string ApplyFailed = "apply_failed";

    public static readonly string[] All =
    {
        Draft,
        Applied,
        Rejected,
        Discarded,
        ApplyFailed
    };
}
