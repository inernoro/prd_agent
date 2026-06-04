namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 对象 AI 摘要缓存（需求/功能/缺陷）。
///
/// 同一对象的 AI 摘要只在「首个打开者」触发生成后落库，之后所有人读缓存、不重复调 LLM；
/// 谁点「重新摘要」就覆盖此记录，后续人以最新一份为准。按 (EntityType, EntityId) 唯一。
/// </summary>
public class ProductItemSummary
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>对象类型（requirement / feature / defect）</summary>
    public string EntityType { get; set; } = string.Empty;

    /// <summary>对象 Id</summary>
    public string EntityId { get; set; } = string.Empty;

    /// <summary>AI 生成的摘要正文</summary>
    public string Summary { get; set; } = string.Empty;

    /// <summary>生成人 UserId</summary>
    public string GeneratedById { get; set; } = string.Empty;

    /// <summary>生成人显示名（冗余展示）</summary>
    public string? GeneratedByName { get; set; }

    public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
