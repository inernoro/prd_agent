namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 产品字典/术语（单产品维度的术语定义）。
///
/// 产品级 productId 维度，统一该产品内的术语口径，供需求/功能编写与 AI 消歧。
/// Definition 为 Markdown 定义，Aliases 为别名列表。
/// </summary>
public class ProductTerm
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属产品 ID</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>术语</summary>
    public string Term { get; set; } = string.Empty;

    /// <summary>别名列表</summary>
    public List<string> Aliases { get; set; } = new();

    /// <summary>术语定义（Markdown）</summary>
    public string Definition { get; set; } = string.Empty;

    /// <summary>分类（自由文本，可空）</summary>
    public string? Category { get; set; }

    /// <summary>排序（越小越靠前）</summary>
    public int SortOrder { get; set; }

    /// <summary>创建者用户 ID</summary>
    public string OwnerId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}
