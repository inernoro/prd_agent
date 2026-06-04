namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 需求实体。
///
/// 需求分级(Grade)、连接客户(CustomerIds)、被多个版本关联(VersionIds)、落到功能、
/// 被缺陷追溯(缺陷侧持 RequirementId)。流程流转走绑定的 WorkflowDefinition。
/// </summary>
public class Requirement
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>需求编号（如 REQ-2026-0001，自动生成）</summary>
    public string RequirementNo { get; set; } = string.Empty;

    /// <summary>需求标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>需求描述 / 背景</summary>
    public string? Description { get; set; }

    /// <summary>需求分级，见 ProductItemGrade（P0/P1/P2/P3）</summary>
    public string Grade { get; set; } = ProductItemGrade.P2;

    /// <summary>父需求 ID（需求分解层级，可空）</summary>
    public string? ParentId { get; set; }

    /// <summary>关联客户 ID 列表（需求连接客户，N:N）</summary>
    public List<string> CustomerIds { get; set; } = new();

    /// <summary>关联的版本 ID 列表（版本关联需求的反向冗余，N:N）</summary>
    public List<string> VersionIds { get; set; } = new();

    /// <summary>当前状态 Key（绑定 WorkflowDefinition）</summary>
    public string? CurrentState { get; set; }

    /// <summary>绑定的表单模板 ID</summary>
    public string? TemplateId { get; set; }

    /// <summary>绑定的流程定义 ID</summary>
    public string? WorkflowDefId { get; set; }

    /// <summary>自定义表单填写值</summary>
    public Dictionary<string, string> FormData { get; set; } = new();

    /// <summary>负责人 UserId</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>指派处理人 UserId（可空）</summary>
    public string? AssigneeId { get; set; }

    /// <summary>来源缺陷 Id（由缺陷转需求时记录，用于溯源追溯）</summary>
    public string? SourceDefectId { get; set; }

    /// <summary>进入当前状态的时间（SLA 时效计算用）</summary>
    public DateTime? StateEnteredAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>需求 / 功能 / 缺陷 通用分级常量（P0 最高，P3 最低）</summary>
public static class ProductItemGrade
{
    public const string P0 = "p0";
    public const string P1 = "p1";
    public const string P2 = "p2";
    public const string P3 = "p3";

    public static readonly string[] All = { P0, P1, P2, P3 };
}
