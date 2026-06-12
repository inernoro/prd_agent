namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 产品版本（版本化管理主轴）。
///
/// 版本关联需求(RequirementIds)与功能版本(FeatureVersionIds)，挂"版本知识库"
/// (KnowledgeStoreId，内含 MRD/SRS/PRD)。大版本(IsMajor)可发起升级申请
/// (VersionUpgradeRequest，P2)。ParentVersionId 串起版本演进链。
/// </summary>
public class ProductVersion
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>版本名（如 v2.0 / 2026Q1）</summary>
    public string VersionName { get; set; } = string.Empty;

    /// <summary>版本描述 / 目标</summary>
    public string? Description { get; set; }

    /// <summary>是否为大版本（大版本升级需走升级申请表单）</summary>
    public bool IsMajor { get; set; }

    /// <summary>父版本 ID（版本演进链，可空）</summary>
    public string? ParentVersionId { get; set; }

    /// <summary>
    /// 版本生命周期：planning(规划) / developing(开发) / testing(测试) / released(已发布) / deprecated(已废弃)。
    /// 见 ProductVersionLifecycle。也可由绑定的 WorkflowDefinition 接管，二选一。
    /// </summary>
    public string Lifecycle { get; set; } = ProductVersionLifecycle.Planning;

    /// <summary>当前状态 Key（绑定 WorkflowDefinition 时使用，覆盖 Lifecycle 的展示）</summary>
    public string? CurrentState { get; set; }

    /// <summary>计划发布时间</summary>
    public DateTime? PlannedReleaseAt { get; set; }

    /// <summary>实际发布时间</summary>
    public DateTime? ReleasedAt { get; set; }

    /// <summary>本版本关联的需求 ID 列表（版本关联需求，N:N）</summary>
    public List<string> RequirementIds { get; set; } = new();

    /// <summary>本版本包含的功能版本 ID 列表（功能版本化，N:N）</summary>
    public List<string> FeatureVersionIds { get; set; } = new();

    /// <summary>版本知识库绑定的 DocumentStore ID（含 MRD/SRS/PRD，find-or-create）</summary>
    public string? KnowledgeStoreId { get; set; }

    /// <summary>绑定的表单模板 ID</summary>
    public string? TemplateId { get; set; }

    /// <summary>绑定的流程定义 ID</summary>
    public string? WorkflowDefId { get; set; }

    /// <summary>自定义表单填写值</summary>
    public Dictionary<string, string> FormData { get; set; } = new();

    public string OwnerId { get; set; } = string.Empty;

    /// <summary>历史导入来源系统。</summary>
    public string? SourceSystem { get; set; }

    /// <summary>来源系统中的唯一 ID，用于幂等导入。</summary>
    public string? ExternalId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>版本生命周期常量（默认状态机，可被自定义 WorkflowDefinition 覆盖）</summary>
public static class ProductVersionLifecycle
{
    public const string Planning = "planning";
    public const string Developing = "developing";
    public const string Testing = "testing";
    public const string Released = "released";
    public const string Deprecated = "deprecated";

    public static readonly string[] All = { Planning, Developing, Testing, Released, Deprecated };
}
