using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 网页托管 ZIP 优化临时会话。只保存私有源包和临时预览的引用；确认前不会创建或覆盖站点。
/// </summary>
[BsonIgnoreExtraElements]
public class HostedSiteOptimizationSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = string.Empty;
    public string? TargetSiteId { get; set; }
    public string SourceFileName { get; set; } = string.Empty;
    public string SourceObjectKey { get; set; } = string.Empty;
    public string SourceSha256 { get; set; } = string.Empty;
    public string Status { get; set; } = HostedSiteOptimizationStatuses.AwaitingDecision;
    public string? CompletedSiteId { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Folder { get; set; }
    public List<string> Tags { get; set; } = new();
    public HostedSiteOptimizationAnalysis Analysis { get; set; } = new();
    public List<HostedSiteFile> PreviewFiles { get; set; } = new();
    public string? PreviewEntryFile { get; set; }
    public long PreviewTotalSize { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddHours(2);
}

public static class HostedSiteOptimizationStatuses
{
    public const string AwaitingDecision = "awaiting-decision";
    public const string PreviewReady = "preview-ready";
    public const string Saving = "saving";
    public const string CleanupPending = "cleanup-pending";
}

public class HostedSiteOptimizationAnalysis
{
    public bool Blocked { get; set; }
    public string? Error { get; set; }
    public bool Recommended { get; set; }
    public int OriginalEntries { get; set; }
    public int OriginalFiles { get; set; }
    public long OriginalArchiveBytes { get; set; }
    public long OriginalUncompressedBytes { get; set; }
    public int OptimizedFiles { get; set; }
    public long OptimizedUncompressedBytes { get; set; }
    public int RemovedFiles { get; set; }
    public long SavedUncompressedBytes { get; set; }
    public int NodeModulesFiles { get; set; }
    public int DevelopmentFiles { get; set; }
    public int LocalizedDependencies { get; set; }
    public List<string> Reasons { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
}

public class HostedSiteOptimizationReviewResult
{
    public string Outcome { get; set; } = "saved";
    public HostedSite? Site { get; set; }
    public string? SessionId { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public HostedSiteOptimizationAnalysis? Analysis { get; set; }
}

public class HostedSiteOptimizationPreviewResult
{
    public string SessionId { get; set; } = string.Empty;
    public string PreviewUrl { get; set; } = string.Empty;
    public string EntryFile { get; set; } = string.Empty;
    public int FileCount { get; set; }
    public long TotalSize { get; set; }
    public DateTime ExpiresAt { get; set; }
    public HostedSiteOptimizationAnalysis Analysis { get; set; } = new();
}

public class ConfirmHostedSiteOptimizationRequest
{
    /// <summary>optimized 或 original。</summary>
    public string Variant { get; set; } = "optimized";
}
