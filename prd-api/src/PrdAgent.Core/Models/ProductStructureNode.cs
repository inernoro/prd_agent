namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 产品结构节点（功能模块 / 能力骨架树）。
///
/// 单产品维度的能力骨架：ParentId 为 null 即根节点，靠 ParentId 串成树（前端自建树）。
/// 功能（Feature）通过 Feature.StructureNodeId 挂载到某个结构节点上，实现「功能清单挂载」。
/// </summary>
public class ProductStructureNode
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>父节点 ID（null = 根节点）</summary>
    public string? ParentId { get; set; }

    /// <summary>节点名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>节点描述</summary>
    public string? Description { get; set; }

    /// <summary>节点类型（如「模块」「能力」，自由文本，可空）</summary>
    public string? NodeType { get; set; }

    /// <summary>同级排序（越小越靠前）</summary>
    public int SortOrder { get; set; }

    /// <summary>创建者用户 ID</summary>
    public string OwnerId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}
