using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 准星知识文档元信息。
/// </summary>
[AppOwnership(AppNames.ZhunxingAgent, AppNames.ZhunxingAgentDisplay, IsPrimary = true)]
public class ZhunxingKnowledgeDocument
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>文档标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>文档版本（如 v2026.02.01）</summary>
    public string Version { get; set; } = "v1.0";

    /// <summary>生效日期（UTC）</summary>
    public DateTime EffectiveDate { get; set; } = DateTime.UtcNow;

    /// <summary>适用范围（如 all-departments, r-and-d）</summary>
    public List<string> Scope { get; set; } = new();

    /// <summary>责任部门（如 HR）</summary>
    public string? OwnerDepartment { get; set; }

    /// <summary>分类节点 ID（分类树）</summary>
    public string? CategoryId { get; set; }

    /// <summary>标签键列表（标签字典）</summary>
    public List<string> TagKeys { get; set; } = new();

    /// <summary>上一版本文档 ID（版本链路）</summary>
    public string? PreviousVersionDocumentId { get; set; }

    /// <summary>下一版本文档 ID（版本链路）</summary>
    public string? NextVersionDocumentId { get; set; }

    /// <summary>到期时间（UTC，到期自动失效）</summary>
    public DateTime? ExpiresAt { get; set; }

    /// <summary>失效时间（UTC）</summary>
    public DateTime? InvalidatedAt { get; set; }

    /// <summary>失效执行人（system/用户ID）</summary>
    public string? InvalidatedBy { get; set; }

    /// <summary>失效原因（manual/expired）</summary>
    public string? InvalidationReason { get; set; }

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>创建人</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>最后更新人</summary>
    public string UpdatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 准星知识分类（树结构）。
/// </summary>
[AppOwnership(AppNames.ZhunxingAgent, AppNames.ZhunxingAgentDisplay, IsPrimary = true)]
public class ZhunxingKnowledgeCategory
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? ParentId { get; set; }
    public List<string> Path { get; set; } = new();
    public int SortOrder { get; set; }
    public bool IsActive { get; set; } = true;
    public string CreatedBy { get; set; } = string.Empty;
    public string UpdatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 准星标签字典。
/// </summary>
[AppOwnership(AppNames.ZhunxingAgent, AppNames.ZhunxingAgentDisplay, IsPrimary = true)]
public class ZhunxingKnowledgeTag
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public List<string> Aliases { get; set; } = new();
    public string? Description { get; set; }
    public string? Color { get; set; }
    public bool IsActive { get; set; } = true;
    public string CreatedBy { get; set; } = string.Empty;
    public string UpdatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 准星知识条款。
/// </summary>
[AppOwnership(AppNames.ZhunxingAgent, AppNames.ZhunxingAgentDisplay, IsPrimary = true)]
public class ZhunxingKnowledgeClause
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联文档 ID</summary>
    public string DocumentId { get; set; } = string.Empty;

    /// <summary>章节号（如 8.2）</summary>
    public string Chapter { get; set; } = string.Empty;

    /// <summary>条款标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>条款内容</summary>
    public string RuleText { get; set; } = string.Empty;

    /// <summary>关键词（检索召回）</summary>
    public List<string> Keywords { get; set; } = new();

    /// <summary>风险等级（public/internal/sensitive）</summary>
    public string RiskLevel { get; set; } = ZhunxingRiskLevels.Internal;

    /// <summary>条款排序（同文档内）</summary>
    public int SortOrder { get; set; } = 0;

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>创建人</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>最后更新人</summary>
    public string UpdatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class ZhunxingRiskLevels
{
    public const string Public = "public";
    public const string Internal = "internal";
    public const string Sensitive = "sensitive";
}

public static class ZhunxingAnswerRoles
{
    public const string Employee = "employee";
    public const string Supervisor = "supervisor";
    public const string Hr = "hr";
}

public static class ZhunxingDepartments
{
    public const string Hr = "hr";
    public const string Rnd = "rnd";
    public const string Sales = "sales";
    public const string CustomerSuccess = "customer-success";
    public const string Finance = "finance";
    public const string Operation = "operation";

    public static readonly IReadOnlyList<string> All = new[]
    {
        Hr,
        Rnd,
        Sales,
        CustomerSuccess,
        Finance,
        Operation,
    };

    public static readonly IReadOnlyDictionary<string, string> Labels = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [Hr] = "人事部",
        [Rnd] = "产研部",
        [Sales] = "市场销售部",
        [CustomerSuccess] = "客成部",
        [Finance] = "财务部",
        [Operation] = "运营部",
    };
}

public static class ZhunxingDepartmentHierarchy
{
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<string>> Children
        = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            [ZhunxingDepartments.Operation] = new[] { ZhunxingDepartments.Sales, ZhunxingDepartments.CustomerSuccess },
            [ZhunxingDepartments.Sales] = new[] { ZhunxingDepartments.CustomerSuccess },
        };
}

public class CreateZhunxingDocumentRequest
{
    public string Title { get; set; } = string.Empty;
    public string Version { get; set; } = "v1.0";
    public DateTime EffectiveDate { get; set; } = DateTime.UtcNow;
    public List<string>? Scope { get; set; }
    public string? OwnerDepartment { get; set; }
    public string? CategoryId { get; set; }
    public List<string>? TagKeys { get; set; }
    public string? PreviousVersionDocumentId { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

public class CreateZhunxingCategoryRequest
{
    public string Key { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? ParentId { get; set; }
    public int SortOrder { get; set; }
}

public class CreateZhunxingTagRequest
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public List<string>? Aliases { get; set; }
    public string? Description { get; set; }
    public string? Color { get; set; }
}

public class ZhunxingAccessScopeResult
{
    public bool Writable { get; set; }
    public bool CanManageAllDepartments { get; set; }
    public List<string> ManageableDepartments { get; set; } = new();
    public Dictionary<string, string> DepartmentLabels { get; set; } = new();
    public Dictionary<string, string> InheritedDepartments { get; set; } = new();
}

public class CreateZhunxingClauseRequest
{
    public string DocumentId { get; set; } = string.Empty;
    public string Chapter { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string RuleText { get; set; } = string.Empty;
    public List<string>? Keywords { get; set; }
    public string? RiskLevel { get; set; }
    public int SortOrder { get; set; }
}

public class ZhunxingAskRequest
{
    public string Question { get; set; } = string.Empty;
    public int TopK { get; set; } = 3;
    public string? AnswerRole { get; set; } = ZhunxingAnswerRoles.Employee;
}

public class ZhunxingAskResponse
{
    public bool Matched { get; set; }
    public string Answer { get; set; } = string.Empty;
    public string AnswerRole { get; set; } = ZhunxingAnswerRoles.Employee;
    public double Confidence { get; set; }
    public string RiskLevel { get; set; } = ZhunxingRiskLevels.Public;
    public List<ZhunxingDecisionStep> DecisionTree { get; set; } = new();
    public bool ConflictDetected { get; set; }
    public string? ConflictMessage { get; set; }
    public List<ZhunxingConflictClause> ConflictClauses { get; set; } = new();
    public List<ZhunxingCitation> Citations { get; set; } = new();
    public string? FollowUpSuggestion { get; set; }
}

public class ZhunxingDecisionStep
{
    public int StepNo { get; set; }
    public string Condition { get; set; } = string.Empty;
    public string Action { get; set; } = string.Empty;
    public string? ClauseId { get; set; }
    public string? Chapter { get; set; }
    public string? RiskLevel { get; set; }
}

public class ZhunxingConflictClause
{
    public string ClauseId { get; set; } = string.Empty;
    public string DocumentTitle { get; set; } = string.Empty;
    public string Chapter { get; set; } = string.Empty;
    public string ClauseTitle { get; set; } = string.Empty;
    public string RuleSummary { get; set; } = string.Empty;
    public string ConflictReason { get; set; } = string.Empty;
    public string RiskLevel { get; set; } = ZhunxingRiskLevels.Public;
}

public class ZhunxingCitation
{
    public string DocumentId { get; set; } = string.Empty;
    public string DocumentTitle { get; set; } = string.Empty;
    public string ClauseId { get; set; } = string.Empty;
    public string Chapter { get; set; } = string.Empty;
    public string ClauseTitle { get; set; } = string.Empty;
    public string Snippet { get; set; } = string.Empty;
    public string FullText { get; set; } = string.Empty;
    public string RiskLevel { get; set; } = ZhunxingRiskLevels.Public;
    public int MatchScore { get; set; }
}

public class ZhunxingBootstrapResult
{
    public string DocumentId { get; set; } = string.Empty;
    public string DocumentTitle { get; set; } = string.Empty;
    public int UpsertedClauseCount { get; set; }
}

public class UpdateZhunxingTopicSubscriptionRequest
{
    public List<string>? Topics { get; set; }
}

public class ZhunxingTopicSubscriptionResult
{
    public string UserId { get; set; } = string.Empty;
    public List<string> Topics { get; set; } = new();
    public DateTime UpdatedAt { get; set; }
}

public class ZhunxingTopicUpdateFeed
{
    public int Days { get; set; }
    public int TotalUpdates { get; set; }
    public int ReturnedUpdates { get; set; }
    public List<ZhunxingTopicUpdateItem> Items { get; set; } = new();
    public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;
}

public class ZhunxingTopicUpdateItem
{
    public string Topic { get; set; } = string.Empty;
    public string TopicLabel { get; set; } = string.Empty;
    public string DocumentId { get; set; } = string.Empty;
    public string DocumentTitle { get; set; } = string.Empty;
    public string ClauseId { get; set; } = string.Empty;
    public string Chapter { get; set; } = string.Empty;
    public string ClauseTitle { get; set; } = string.Empty;
    public string Summary { get; set; } = string.Empty;
    public string RiskLevel { get; set; } = ZhunxingRiskLevels.Public;
    public DateTime UpdatedAt { get; set; }
}

public class ZhunxingKnowledgeHeatmap
{
    public int Days { get; set; }
    public long TotalFeedbackCount { get; set; }
    public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;
    public List<ZhunxingHeatmapBucket> Buckets { get; set; } = new();
}

public class ZhunxingHeatmapBucket
{
    public string Topic { get; set; } = string.Empty;
    public string TopicLabel { get; set; } = string.Empty;
    public int QuestionCount { get; set; }
    public int NoMatchCount { get; set; }
    public int PendingCount { get; set; }
    public double AvgConfidence { get; set; }
    public double HeatScore { get; set; }
}

public class ZhunxingDocumentVersionTimelineResult
{
    public string DocumentId { get; set; } = string.Empty;
    public string RootDocumentId { get; set; } = string.Empty;
    public List<ZhunxingDocumentVersionNode> Nodes { get; set; } = new();
}

public class ZhunxingDocumentVersionNode
{
    public string DocumentId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public DateTime EffectiveDate { get; set; }
    public bool IsActive { get; set; }
    public string? PreviousVersionDocumentId { get; set; }
    public string? NextVersionDocumentId { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class ZhunxingDocumentDiffResult
{
    public string SourceDocumentId { get; set; } = string.Empty;
    public string TargetDocumentId { get; set; } = string.Empty;
    public string SourceVersion { get; set; } = string.Empty;
    public string TargetVersion { get; set; } = string.Empty;
    public int AddedCount { get; set; }
    public int RemovedCount { get; set; }
    public int ChangedCount { get; set; }
    public List<ZhunxingClauseDiffItem> Items { get; set; } = new();
}

public class ZhunxingClauseDiffItem
{
    public string ChangeType { get; set; } = ZhunxingDiffChangeTypes.Changed;
    public string? SourceClauseId { get; set; }
    public string? TargetClauseId { get; set; }
    public string Chapter { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? SourceRuleText { get; set; }
    public string? TargetRuleText { get; set; }
    public string? SourceRiskLevel { get; set; }
    public string? TargetRiskLevel { get; set; }
}

public class ZhunxingExpireDocumentsResult
{
    public int ExpiredCount { get; set; }
    public List<string> AffectedDocumentIds { get; set; } = new();
    public DateTime ExecutedAt { get; set; } = DateTime.UtcNow;
}

public class CreateZhunxingAskFeedbackRequest
{
    public string Question { get; set; } = string.Empty;
    public bool Matched { get; set; }
    public double? Confidence { get; set; }
    public string FeedbackType { get; set; } = ZhunxingFeedbackTypes.NoMatch;
    public string? Comment { get; set; }
    public List<string>? CitationClauseIds { get; set; }
}

public class ZhunxingAskFeedbackResult
{
    public string FeedbackId { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
}

[AppOwnership(AppNames.ZhunxingAgent, AppNames.ZhunxingAgentDisplay, IsPrimary = true)]
public class ZhunxingTopicSubscription
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public List<string> Topics { get; set; } = new();
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class ZhunxingFeedbackSummary
{
    public long TotalCount { get; set; }
    public long NoMatchCount { get; set; }
    public long AnswerInaccurateCount { get; set; }
    public long MissingContextCount { get; set; }
    public long PendingCount { get; set; }
    public long ResolvedCount { get; set; }
    public long ClosedCount { get; set; }
    public long FollowUpNotifiedCount { get; set; }
    public long ReplayVerifiedCount { get; set; }
    public long ReplayMatchedCount { get; set; }
    public List<ZhunxingFeedbackCluster> TopNoMatchQuestions { get; set; } = new();
}

public class ZhunxingFeedbackCluster
{
    public string ClusterKey { get; set; } = string.Empty;
    public string SampleQuestion { get; set; } = string.Empty;
    public int Count { get; set; }
    public DateTime LastOccurredAt { get; set; }
}

public class ZhunxingFeedbackListResult
{
    public long Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
    public List<ZhunxingFeedbackListItem> Items { get; set; } = new();
}

public class ZhunxingFeedbackListItem
{
    public string Id { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public bool Matched { get; set; }
    public double Confidence { get; set; }
    public string FeedbackType { get; set; } = string.Empty;
    public string? Comment { get; set; }
    public List<string> CitationClauseIds { get; set; } = new();
    public string Status { get; set; } = ZhunxingFeedbackStatuses.New;
    public string? OwnerDepartment { get; set; }
    public string? AssigneeUserId { get; set; }
    public string? ResolutionType { get; set; }
    public string? ResolutionNote { get; set; }
    public string? ResolvedBy { get; set; }
    public DateTime? ResolvedAt { get; set; }
    public string? ReplayQuestion { get; set; }
    public bool? ReplayMatched { get; set; }
    public double? ReplayConfidence { get; set; }
    public string? ReplayRiskLevel { get; set; }
    public string? ReplayAnswerSnippet { get; set; }
    public DateTime? ReplayAt { get; set; }
    public string? FollowUpNote { get; set; }
    public string? FollowUpBy { get; set; }
    public DateTime? FollowUpNotifiedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class UpdateZhunxingFeedbackWorkflowRequest
{
    public string? Status { get; set; }
    public string? OwnerDepartment { get; set; }
    public string? AssigneeUserId { get; set; }
    public string? ResolutionType { get; set; }
    public string? ResolutionNote { get; set; }
}

public class ReplayZhunxingFeedbackRequest
{
    public string? Question { get; set; }
    public int TopK { get; set; } = 3;
}

public class MarkZhunxingFeedbackFollowUpRequest
{
    public string? FollowUpNote { get; set; }
}

public class ZhunxingFeedbackReplayResult
{
    public string FeedbackId { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public bool Matched { get; set; }
    public double Confidence { get; set; }
    public string RiskLevel { get; set; } = ZhunxingRiskLevels.Public;
    public string Answer { get; set; } = string.Empty;
    public DateTime ReplayedAt { get; set; }
    public bool RegressionDetected { get; set; }
}

public class ZhunxingFeedbackFollowUpResult
{
    public string FeedbackId { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
    public DateTime FollowUpNotifiedAt { get; set; }
    public string Status { get; set; } = ZhunxingFeedbackStatuses.Closed;
}

[AppOwnership(AppNames.ZhunxingAgent, AppNames.ZhunxingAgentDisplay, IsPrimary = true)]
public class ZhunxingAskFeedback
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string Question { get; set; } = string.Empty;
    public bool Matched { get; set; }
    public double Confidence { get; set; }
    public string FeedbackType { get; set; } = ZhunxingFeedbackTypes.NoMatch;
    public string? Comment { get; set; }
    public List<string> CitationClauseIds { get; set; } = new();
    public string Status { get; set; } = ZhunxingFeedbackStatuses.New;
    public string? OwnerDepartment { get; set; }
    public string? AssigneeUserId { get; set; }
    public string? ResolutionType { get; set; }
    public string? ResolutionNote { get; set; }
    public string? ResolvedBy { get; set; }
    public DateTime? ResolvedAt { get; set; }
    public string? ReplayQuestion { get; set; }
    public bool? ReplayMatched { get; set; }
    public double? ReplayConfidence { get; set; }
    public string? ReplayRiskLevel { get; set; }
    public string? ReplayAnswerSnippet { get; set; }
    public DateTime? ReplayAt { get; set; }
    public string? FollowUpNote { get; set; }
    public string? FollowUpBy { get; set; }
    public DateTime? FollowUpNotifiedAt { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class ZhunxingFeedbackTypes
{
    public const string NoMatch = "no_match";
    public const string AnswerInaccurate = "answer_inaccurate";
    public const string MissingContext = "missing_context";
}

public static class ZhunxingFeedbackStatuses
{
    public const string New = "new";
    public const string Triaged = "triaged";
    public const string InProgress = "in_progress";
    public const string Resolved = "resolved";
    public const string Closed = "closed";
}

public static class ZhunxingFeedbackResolutionTypes
{
    public const string AddClause = "add_clause";
    public const string UpdateClause = "update_clause";
    public const string RetrievalTuning = "retrieval_tuning";
    public const string ProcessClarification = "process_clarification";
    public const string Other = "other";
}

public static class ZhunxingInvalidationReasons
{
    public const string Manual = "manual";
    public const string Expired = "expired";
}

public static class ZhunxingDiffChangeTypes
{
    public const string Added = "added";
    public const string Removed = "removed";
    public const string Changed = "changed";
}
