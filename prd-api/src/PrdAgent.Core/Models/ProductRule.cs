namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 产品规则（单产品维度的全局核心规则）。
///
/// 产品级 productId 维度，记录该产品跨版本/跨功能通用的核心业务规则，
/// 供需求/功能编写与 AI 参考。Content 为 Markdown 正文。
/// </summary>
public class ProductRule
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>分类（自由文本，可空）</summary>
    public string? Category { get; set; }

    /// <summary>规则标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>规则正文（Markdown）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>状态：draft|active|deprecated（默认 active）</summary>
    public string Status { get; set; } = "active";

    /// <summary>排序（越小越靠前）</summary>
    public int SortOrder { get; set; }

    /// <summary>创建者用户 ID</summary>
    public string OwnerId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}
