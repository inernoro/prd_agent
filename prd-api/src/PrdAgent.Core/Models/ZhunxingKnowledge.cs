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

public class CreateZhunxingDocumentRequest
{
    public string Title { get; set; } = string.Empty;
    public string Version { get; set; } = "v1.0";
    public DateTime EffectiveDate { get; set; } = DateTime.UtcNow;
    public List<string>? Scope { get; set; }
    public string? OwnerDepartment { get; set; }
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
}

public class ZhunxingAskResponse
{
    public bool Matched { get; set; }
    public string Answer { get; set; } = string.Empty;
    public double Confidence { get; set; }
    public string RiskLevel { get; set; } = ZhunxingRiskLevels.Public;
    public List<ZhunxingCitation> Citations { get; set; } = new();
    public string? FollowUpSuggestion { get; set; }
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
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class ZhunxingFeedbackTypes
{
    public const string NoMatch = "no_match";
    public const string AnswerInaccurate = "answer_inaccurate";
    public const string MissingContext = "missing_context";
}
