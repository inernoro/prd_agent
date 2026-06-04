namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 大版本升级申请。
///
/// 大版本升级需走可配置的申请表单（字段由 ProductFormTemplate(entityType=upgrade-request) 决定），
/// 关联本次升级要交付的需求、功能与知识库条目；走流程流转审批（绑定 WorkflowDefinition 时）。
/// </summary>
public class VersionUpgradeRequest
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>申请编号（如 UPG-2026-0001，自动生成）</summary>
    public string UpgradeNo { get; set; } = string.Empty;

    /// <summary>申请标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>升级理由 / 背景</summary>
    public string? Reason { get; set; }

    /// <summary>源版本 ID（从哪个版本升，可空）</summary>
    public string? FromVersionId { get; set; }

    /// <summary>目标版本 ID（升到已建的某版本，可空）</summary>
    public string? TargetVersionId { get; set; }

    /// <summary>目标版本名（若目标版本尚未建，可先填名字）</summary>
    public string? TargetVersionName { get; set; }

    /// <summary>本次升级关联的需求 ID 列表</summary>
    public List<string> RequirementIds { get; set; } = new();

    /// <summary>本次升级关联的功能 ID 列表</summary>
    public List<string> FeatureIds { get; set; } = new();

    /// <summary>本次升级关联的知识库条目 ID 列表（DocumentEntry）</summary>
    public List<string> KnowledgeEntryIds { get; set; } = new();

    /// <summary>
    /// 申请状态：draft(草稿) / submitted(已提交) / approved(已批准) / rejected(已驳回)。
    /// 见 UpgradeRequestStatus。绑定 WorkflowDefinition 时由 CurrentState 接管展示。
    /// </summary>
    public string Status { get; set; } = UpgradeRequestStatus.Draft;

    /// <summary>当前状态 Key（绑定 WorkflowDefinition 时使用）</summary>
    public string? CurrentState { get; set; }

    /// <summary>绑定的表单模板 ID（决定 FormData 字段集合）</summary>
    public string? TemplateId { get; set; }

    /// <summary>绑定的流程定义 ID</summary>
    public string? WorkflowDefId { get; set; }

    /// <summary>自定义表单填写值</summary>
    public Dictionary<string, string> FormData { get; set; } = new();

    public string OwnerId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>大版本升级申请状态常量（默认状态机，可被 WorkflowDefinition 覆盖）</summary>
public static class UpgradeRequestStatus
{
    public const string Draft = "draft";
    public const string Submitted = "submitted";
    public const string Approved = "approved";
    public const string Rejected = "rejected";

    public static readonly string[] All = { Draft, Submitted, Approved, Rejected };
}
