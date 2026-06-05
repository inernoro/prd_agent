namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 对象动态/讨论时间线（评论 + 系统活动合流，参考 Jira / Linear）。
///
/// 一条记录既可能是用户评论(Type=comment)，也可能是系统活动(状态流转/转交/创建/缺陷转化)。
/// 前端按时间正序渲染成一条统一的活动流。按 EntityType+EntityId 归集，ProductId 用于鉴权。
/// </summary>
public class ProductItemActivity
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>对象类型（requirement / feature / ...）</summary>
    public string EntityType { get; set; } = string.Empty;

    /// <summary>对象 Id</summary>
    public string EntityId { get; set; } = string.Empty;

    /// <summary>所属产品 Id（鉴权用）</summary>
    public string ProductId { get; set; } = string.Empty;

    /// <summary>类型：comment / transition / assign / created / convert</summary>
    public string Type { get; set; } = ProductActivityType.Comment;

    /// <summary>操作人 UserId</summary>
    public string ActorId { get; set; } = string.Empty;

    /// <summary>操作人显示名（冗余展示）</summary>
    public string? ActorName { get; set; }

    /// <summary>评论内容（富文本 HTML）；系统活动可为空</summary>
    public string? Content { get; set; }

    /// <summary>变更前值（状态/处理人的显示文本）</summary>
    public string? FromValue { get; set; }

    /// <summary>变更后值（状态/处理人的显示文本）</summary>
    public string? ToValue { get; set; }

    /// <summary>评论中 @ 提醒的用户 Id 列表</summary>
    public List<string> Mentions { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>动态时间线条目类型常量</summary>
public static class ProductActivityType
{
    public const string Comment = "comment";
    public const string Transition = "transition";
    public const string Assign = "assign";
    public const string Created = "created";
    public const string Convert = "convert";
}
