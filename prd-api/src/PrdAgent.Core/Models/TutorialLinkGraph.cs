namespace PrdAgent.Core.Models;

/// <summary>
/// 教程与产品页面双链图谱。MAP 运行时保存草稿、已发布版本和有限历史，
/// Git 中的映射文件只作为生成输入与可审计快照。
/// </summary>
public sealed class TutorialLinkGraph
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string StoreId { get; set; } = string.Empty;
    public string Publisher { get; set; } = string.Empty;
    public TutorialLinkGraphRevision? Draft { get; set; }
    public TutorialLinkGraphRevision? Published { get; set; }
    public List<TutorialLinkGraphPublishedVersion> Versions { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class TutorialLinkGraphRevision
{
    public int SchemaVersion { get; set; } = 2;
    public string GraphSha256 { get; set; } = string.Empty;
    public string SourceRevision { get; set; } = string.Empty;
    public string ManifestSha256 { get; set; } = string.Empty;
    public string VerifiedAtCommit { get; set; } = string.Empty;
    public string? Generator { get; set; }
    public DateTime GeneratedAt { get; set; }
    public DateTime SavedAt { get; set; } = DateTime.UtcNow;
    public string SavedBy { get; set; } = string.Empty;
    public List<TutorialLinkSurface> Surfaces { get; set; } = new();
}

public sealed class TutorialLinkGraphPublishedVersion
{
    public string VersionId { get; set; } = Guid.NewGuid().ToString("N");
    public TutorialLinkGraphRevision Revision { get; set; } = new();
    public DateTime PublishedAt { get; set; } = DateTime.UtcNow;
    public string PublishedBy { get; set; } = string.Empty;
    public string? RolledBackFromVersionId { get; set; }
}

public sealed class TutorialLinkSurface
{
    public string Id { get; set; } = string.Empty;
    public string? Label { get; set; }
    public List<string> Routes { get; set; } = new();
    public string PagePath { get; set; } = string.Empty;
    public List<string> ChangeSources { get; set; } = new();
    public List<string> TutorialSourceIds { get; set; } = new();
    public List<TutorialStepLink> TutorialLinks { get; set; } = new();
    public List<TutorialLinkAnchor> Anchors { get; set; } = new();
}

public sealed class TutorialStepLink
{
    public string SourceId { get; set; } = string.Empty;
    public List<string> StepIds { get; set; } = new();
    public List<string> EvidenceIds { get; set; } = new();
    public List<string> Impact { get; set; } = new();
}

public sealed class TutorialLinkAnchor
{
    public string Name { get; set; } = string.Empty;
    public string Product { get; set; } = string.Empty;
    public string Tutorial { get; set; } = string.Empty;
}
