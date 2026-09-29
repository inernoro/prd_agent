namespace PrdAgent.Core.Models;

/// <summary>
/// 产品评审智能体内的版本登记记录。
/// T 与 V 是独立编号空间；登记字段以原有立项/上线登记表为准。
/// </summary>
public class VersionRegistration
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    /// <summary>internal（T）/ formal（V）</summary>
    public string Kind { get; set; } = VersionRegistrationKind.Internal;
    public string Code { get; set; } = string.Empty;
    /// <summary>正式版本关联的内部版本号；手工来源同样保留在此。</summary>
    public string? TCode { get; set; }
    /// <summary>review_submission / internal_registration / manual_t / history_import</summary>
    public string SourceType { get; set; } = VersionRegistrationSourceType.ReviewSubmission;
    public string? ReviewSubmissionId { get; set; }
    public string? SourceInternalRegistrationId { get; set; }

    public string ProjectType { get; set; } = "standard";
    public string VersionType { get; set; } = "minor";
    public bool? NeedUiDesign { get; set; }
    public bool? IsAiPoc { get; set; }
    public bool? IsGlobalOpen { get; set; }
    public string? DemandSource { get; set; }
    public string? PlanName { get; set; }
    public string? PlanUrl { get; set; }
    public string? RequirementDescription { get; set; }
    public string? DepartmentName { get; set; }
    public string? OwnerName { get; set; }
    public List<string> ProjectMemberNames { get; set; } = new();
    public DateTime? PlannedProjectAt { get; set; }
    public DateTime? PlannedReleaseAt { get; set; }
    public string? ContractParty { get; set; }
    public string? DevelopmentStatus { get; set; }
    public string? Remark { get; set; }

    /// <summary>completed；保留状态字段，便于后续扩展撤回/作废但不回收编号。</summary>
    public string Status { get; set; } = VersionRegistrationStatus.Completed;
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    /// <summary>历史导入时关联的不可变快照。</summary>
    public string? SourceSnapshotId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>历史导入或当前登记簿的不可变存档。</summary>
public class VersionRegistrationSnapshot
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    /// <summary>history_import / current_registry</summary>
    public string SourceType { get; set; } = VersionRegistrationSnapshotSourceType.CurrentRegistry;
    public string? SourceAttachmentId { get; set; }
    public string? SourceFileName { get; set; }
    public int ImportedCount { get; set; }
    public int SkippedCount { get; set; }
    public List<VersionRegistration> Records { get; set; } = new();
    public List<VersionRegistrationImportError> Errors { get; set; } = new();
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>每种业务编号一条乐观并发序列，避免同时申领到同一编号。</summary>
public class VersionRegistrationSequence
{
    /// <summary>T 或 V，作为 Mongo _id 保证一类编号只有一条序列。</summary>
    public string Id { get; set; } = string.Empty;
    public int Major { get; set; }
    public int Medium { get; set; }
    public int Minor { get; set; }
    public long Revision { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class VersionRegistrationImportError
{
    public int Row { get; set; }
    public string Message { get; set; } = string.Empty;
}

public static class VersionRegistrationKind
{
    public const string Internal = "internal";
    public const string Formal = "formal";
}

public static class VersionRegistrationSourceType
{
    public const string ReviewSubmission = "review_submission";
    public const string InternalRegistration = "internal_registration";
    public const string ManualT = "manual_t";
    public const string HistoryImport = "history_import";
}

public static class VersionRegistrationSnapshotSourceType
{
    public const string HistoryImport = "history_import";
    public const string CurrentRegistry = "current_registry";
}

public static class VersionRegistrationStatus
{
    public const string Completed = "completed";
}
