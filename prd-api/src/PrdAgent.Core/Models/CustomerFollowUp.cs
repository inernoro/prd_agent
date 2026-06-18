namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 客户「动态跟进」时间线条目（仿 ProductItemActivity）。
///
/// 一条记录即一次跟进/沟通，富文本 HTML 内容，按 CustomerId 归集，前端按时间倒序渲染。
/// </summary>
public class CustomerFollowUp
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属客户 Id</summary>
    public string CustomerId { get; set; } = string.Empty;

    /// <summary>跟进内容（富文本 HTML）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>创建人 UserId</summary>
    public string CreatedByUserId { get; set; } = string.Empty;

    /// <summary>创建人显示名（冗余展示）</summary>
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}
