namespace PrdAgent.Core.Models;

public class ProductInitiation
{
    /// <summary>服务端派生的正式申领表单规则，不写入立项主数据。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnore]
    public bool? ReleaseTrainingRequired { get; set; }
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProductId { get; set; } = string.Empty;
    /// <summary>立项关联的产品目录条目（替代手填系统/应用）</summary>
    public string? LinkedProductId { get; set; }
    /// <summary>立项编号 T{a}.{b}.{c}，从全域记录筛选对应应用后，按版本级别递增。</summary>
    public string? TCode { get; set; }
    /// <summary>实际发号完成时间；普通资料编辑不会改变此时间。</summary>
    public DateTime? IssuedAt { get; set; }
    /// <summary>只读删除资格：全局最后成功发号、无下游且为申请人本人，不落库。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnore]
    public bool CanDelete { get; set; }
    [MongoDB.Bson.Serialization.Attributes.BsonIgnore]
    public bool CanChangeVersionType { get; set; }
    public string? SystemName { get; set; }
    public string? AppName { get; set; }
    public string ProjectType { get; set; } = "standard";
    public string? CustomerSource { get; set; }
    public string? DemandSource { get; set; }
    public string PlanName { get; set; } = string.Empty;
    public string? RequirementDescription { get; set; }
    public string? DepartmentName { get; set; }
    /// <summary>业务产品负责人；与实际提交人CreatedBy、历史审批人PrimaryOwnerId分别保留。</summary>
    public string? OwnerId { get; set; }
    public string? OwnerName { get; set; }
    public List<string> ProjectMemberNames { get; set; } = new();
    public string? PlanUrl { get; set; }
    public string VersionType { get; set; } = "minor";
    public List<string> RequirementIds { get; set; } = new();
    public string Status { get; set; } = "draft";
    public string? ReviewSubmissionId { get; set; }
    public int? ReviewScore { get; set; }
    public bool? ReviewPassed { get; set; }
    public bool? ReviewMeetingRequired { get; set; }
    public DateTime? ExpectedMeetingAt { get; set; }
    /// <summary>需开评审会时计划召开的稿次总数（1–3）</summary>
    public int? MeetingDraftCount { get; set; }
    /// <summary>线下评审会各稿次结果（产品经理后续回填，可修改）</summary>
    public List<InitiationMeetingDraftRound> MeetingDraftRounds { get; set; } = new();
    /// <summary>每次 Agent 评审尝试记录（含重新发起）</summary>
    public List<InitiationReviewAttempt> ReviewAttempts { get; set; } = new();
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
    /// <summary>自动发号后的需求状态待同步标记，后台幂等重试，不重新发号。</summary>
    public bool RequirementSyncPending { get; set; }
    public ProductClaimNotification? ClaimNotification { get; set; }
    public string CreatedBy { get; set; } = string.Empty;
    public string SourceType { get; set; } = "system";
    /// <summary>无编号历史导入行的规范化指纹，重导时用于去重。</summary>
    public string? ImportFingerprint { get; set; }
    public Dictionary<string, string> LegacyData { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public bool IsDeleted { get; set; }
}

/// <summary>立项 Agent 评审单次尝试</summary>
public class InitiationReviewAttempt
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public int AttemptNo { get; set; }
    public string? SubmissionId { get; set; }
    public string? PlanFileName { get; set; }
    public int? ReviewScore { get; set; }
    public bool? ReviewPassed { get; set; }
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; set; }
}

/// <summary>立项线下评审会单稿次结果</summary>
public class InitiationMeetingDraftRound
{
    public int Round { get; set; }
    public DateTime? HeldAt { get; set; }
    public bool? Passed { get; set; }
    public string? Notes { get; set; }
}

public class ProductRelease
{
    public ProductClaimNotification? ClaimNotification { get; set; }
    [MongoDB.Bson.Serialization.Attributes.BsonIgnore]
    public bool CanDelete { get; set; }
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ProductId { get; set; } = string.Empty;
    public string? InitiationId { get; set; }
    public string? TCode { get; set; }
    /// <summary>正式版本编号 V{a}.{b}.{c}，从全域记录筛选对应应用后，独立于T序列递增。</summary>
    public string VCode { get; set; } = string.Empty;
    public string? SystemName { get; set; }
    public string? AppName { get; set; }
    public bool IsTemporaryOptimization { get; set; }
    public string ProjectType { get; set; } = "standard";
    public string PlanName { get; set; } = string.Empty;
    public string VersionType { get; set; } = "minor";
    public string? PlanUrl { get; set; }
    public string? DepartmentName { get; set; }
    public string? DemandSource { get; set; }
    public string? RequirementDescription { get; set; }
    public string? OwnerName { get; set; }
    public List<string> ProjectMemberNames { get; set; } = new();
    public string? ContractParty { get; set; }
    public string? Remark { get; set; }
    public bool? IsGlobalOpen { get; set; }
    public bool IsManualTCode { get; set; }
    public string? OwnerId { get; set; }
    public string OpenBrandScope { get; set; } = "上线全域开放";
    public List<string> RequirementIds { get; set; } = new();
    public List<string> TeamMemberIds { get; set; } = new();
    public DateTime? PlannedReleaseAt { get; set; }
    /// <summary>预计培训时长，单位为分钟；不表示日期或时刻。</summary>
    public int? PlannedTrainingMinutes { get; set; }
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

/// <summary>产品管理版本工作流的不可变导入/当前存档；不改写旧版本登记存档。</summary>
public class ProductVersionWorkflowSnapshot
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string SourceType { get; set; } = "history_import";
    public string? SourceFileName { get; set; }
    public int ImportedCount { get; set; }
    public int SkippedCount { get; set; }
    public List<ProductInitiation> Initiations { get; set; } = new();
    public List<ProductRelease> Releases { get; set; } = new();
    public List<VersionRegistrationImportError> Errors { get; set; } = new();
    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
