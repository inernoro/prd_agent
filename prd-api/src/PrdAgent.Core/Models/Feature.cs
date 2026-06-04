namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 功能实体（持久存在，跨版本演进）。
///
/// 功能本身是长期实体；它在每个产品版本里的形态用 FeatureVersion 表达（功能版本化）。
/// 功能可实现一个或多个需求(RequirementIds)，可被缺陷追溯。
/// </summary>
public class Feature
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>功能编号（如 FEA-2026-0001，自动生成）</summary>
    public string FeatureNo { get; set; } = string.Empty;

    /// <summary>功能名称</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>功能描述</summary>
    public string? Description { get; set; }

    /// <summary>功能分级，见 ProductItemGrade</summary>
    public string Grade { get; set; } = ProductItemGrade.P2;

    /// <summary>父功能 ID（功能模块分解层级，可空）</summary>
    public string? ParentId { get; set; }

    /// <summary>实现的需求 ID 列表（功能落需求，N:N）</summary>
    public List<string> RequirementIds { get; set; } = new();

    /// <summary>当前状态 Key（绑定 WorkflowDefinition）</summary>
    public string? CurrentState { get; set; }

    /// <summary>绑定的表单模板 ID</summary>
    public string? TemplateId { get; set; }

    /// <summary>绑定的流程定义 ID</summary>
    public string? WorkflowDefId { get; set; }

    /// <summary>自定义表单填写值</summary>
    public Dictionary<string, string> FormData { get; set; } = new();

    public string OwnerId { get; set; } = string.Empty;

    /// <summary>处理人（负责推进该功能的 MAP 用户）</summary>
    public string? AssigneeId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>
/// 功能版本化 — 功能在某个产品版本里的快照 / 变更记录。
/// 实现"功能管理版本"：同一功能在不同版本下有各自的变更类型与状态。
/// </summary>
public class FeatureVersion
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>关联功能 ID</summary>
    public string FeatureId { get; set; } = string.Empty;

    /// <summary>关联产品版本 ID</summary>
    public string VersionId { get; set; } = string.Empty;

    /// <summary>功能自身的版本标签（如 1.2，区别于产品版本）</summary>
    public string? FeatureVersionLabel { get; set; }

    /// <summary>变更类型：added(新增) / modified(优化) / deprecated(废弃)，见 FeatureChangeType</summary>
    public string ChangeType { get; set; } = FeatureChangeType.Added;

    /// <summary>本版本下的功能变更说明</summary>
    public string? ChangeNote { get; set; }

    /// <summary>当前状态 Key（开发/测试/上线，可走 WorkflowDefinition）</summary>
    public string? CurrentState { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>功能版本变更类型常量</summary>
public static class FeatureChangeType
{
    public const string Added = "added";
    public const string Modified = "modified";
    public const string Deprecated = "deprecated";

    public static readonly string[] All = { Added, Modified, Deprecated };
}
