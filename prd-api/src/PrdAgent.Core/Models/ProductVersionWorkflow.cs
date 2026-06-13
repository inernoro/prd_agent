namespace PrdAgent.Core.Models;

public class ProductInitiation
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProductId { get; set; } = string.Empty;
    public string? TCode { get; set; }
    public string? SystemName { get; set; }
    public string? AppName { get; set; }
    public string ProjectType { get; set; } = "standard";
    public string? CustomerSource { get; set; }
    public string PlanName { get; set; } = string.Empty;
    public string? RequirementDescription { get; set; }
    public string? DepartmentName { get; set; }
    public string? PlanUrl { get; set; }
    public string VersionType { get; set; } = "minor";
    public List<string> RequirementIds { get; set; } = new();
    public string Status { get; set; } = "draft";
    public string? ReviewSubmissionId { get; set; }
    public int? ReviewScore { get; set; }
    public bool? ReviewPassed { get; set; }
    public bool? ReviewMeetingRequired { get; set; }
    public DateTime? ExpectedMeetingAt { get; set; }
    public DateTime? FirstDraftMeetingAt { get; set; }
    public DateTime? SecondDraftMeetingAt { get; set; }
    public DateTime? ThirdDraftMeetingAt { get; set; }
    public DateTime? ProjectAt { get; set; }
    public DateTime? PlannedProjectAt { get; set; }
    public bool? NeedUiDesign { get; set; }
    public bool? IsAiPoc { get; set; }
    public string DevelopmentStatus { get; set; } = "待开发";
    public string? Remark { get; set; }
    public string? PrimaryOwnerId { get; set; }
    public string? ApprovalComment { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
    public string SourceType { get; set; } = "system";
    public Dictionary<string, string> LegacyData { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }
}

public class ProductRelease
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProductId { get; set; } = string.Empty;
    public string? InitiationId { get; set; }
    public string? TCode { get; set; }
    public string VCode { get; set; } = string.Empty;
    public string? SystemName { get; set; }
    public string? AppName { get; set; }
    public bool IsTemporaryOptimization { get; set; }
    public string ProjectType { get; set; } = "standard";
    public string PlanName { get; set; } = string.Empty;
    public string VersionType { get; set; } = "minor";
    public string? PlanUrl { get; set; }
    public string? DepartmentName { get; set; }
    public string? OwnerId { get; set; }
    public string OpenBrandScope { get; set; } = "上线全域开放";
    public List<string> RequirementIds { get; set; } = new();
    public List<string> TeamMemberIds { get; set; } = new();
    public DateTime? PlannedReleaseAt { get; set; }
    public DateTime? ReleasedAt { get; set; }
    public string? AnnouncementUrl { get; set; }
    public string Status { get; set; } = "announcement_pending";
    /// <summary>继承来源的上一正式版本上线记录 ID</summary>
    public string? PreviousReleaseId { get; set; }
    /// <summary>本正式版本的功能清单（相对上一版的变更记录）</summary>
    public List<ReleaseFeatureItem> FeatureManifest { get; set; } = new();
    public string CreatedBy { get; set; } = string.Empty;
    public string SourceType { get; set; } = "system";
    public Dictionary<string, string> LegacyData { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }
}

/// <summary>正式版本功能清单条目 — 关联功能实体并标注相对上一版的变更类型</summary>
public class ReleaseFeatureItem
{
    public string FeatureId { get; set; } = string.Empty;
    /// <summary>变更类型：added / modified / deprecated / unchanged，见 FeatureChangeType</summary>
    public string ChangeType { get; set; } = FeatureChangeType.Unchanged;
    public string? ChangeNote { get; set; }
}
