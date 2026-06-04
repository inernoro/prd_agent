namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 详情描述模板（方便用户按预设结构编写需求/功能等的描述）。
///
/// 与 ProductFormTemplate（字段集合）不同：本实体存的是一段富文本(HTML)内容骨架，
/// 用户在对象详情的「描述」区一键套用，避免每次从空白开始写。按 EntityType 归类。
/// </summary>
public class ProductDescTemplate
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>适用对象类型（requirement / feature / version / customer / defect ...）</summary>
    public string EntityType { get; set; } = string.Empty;

    /// <summary>模板名称（如「用户故事」「PRD 标准结构」）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>模板内容（富文本 HTML）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>排序（越小越靠前）</summary>
    public int SortOrder { get; set; }

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
