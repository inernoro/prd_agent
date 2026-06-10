namespace PrdAgent.Core.Models;

public class ProductInitiation
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProductId { get; set; } = string.Empty;
    public string? TCode { get; set; }
    public string ProjectType { get; set; } = "standard";
    public string? CustomerSource { get; set; }
    public string PlanName { get; set; } = string.Empty;
    public string? PlanUrl { get; set; }
    public string VersionType { get; set; } = "minor";
    public List<string> RequirementIds { get; set; } = new();
    public string Status { get; set; } = "draft";
    public string? ReviewSubmissionId { get; set; }
    public int? ReviewScore { get; set; }
    public bool? ReviewPassed { get; set; }
    public bool? ReviewMeetingRequired { get; set; }
    public DateTime? ExpectedMeetingAt { get; set; }
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
    public bool IsTemporaryOptimization { get; set; }
    public string PlanName { get; set; } = string.Empty;
    public string VersionType { get; set; } = "minor";
    public string? PlanUrl { get; set; }
    public List<string> RequirementIds { get; set; } = new();
    public List<string> TeamMemberIds { get; set; } = new();
    public DateTime? PlannedReleaseAt { get; set; }
    public DateTime? ReleasedAt { get; set; }
    public string? AnnouncementUrl { get; set; }
    public string Status { get; set; } = "announcement_pending";
    public string CreatedBy { get; set; } = string.Empty;
    public string SourceType { get; set; } = "system";
    public Dictionary<string, string> LegacyData { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }
}
