using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 团队空间内容分组 — 网页托管团队空间内的「专题」与「日常分类」。
///
/// 与个人空间的 Folder（站点字段派生的纯字符串）不同，分组是团队级独立实体：
/// 可以先建空分组再往里加内容，归属关系存在 HostedSite.GroupId 上。
/// 仅网页托管模块消费；一个分组只属于一个团队。
/// </summary>
[BsonIgnoreExtraElements]
public class WebPageGroup
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属团队 ID</summary>
    public string TeamId { get; set; } = string.Empty;

    /// <summary>分组类型：topic = 专题 | daily = 日常分类</summary>
    public string Kind { get; set; } = WebPageGroupKind.Daily;

    /// <summary>分组名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>排序权重（小的在前）</summary>
    public int SortOrder { get; set; }

    /// <summary>创建者 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>网页托管团队分组类型常量</summary>
public static class WebPageGroupKind
{
    /// <summary>专题（围绕一个主题策划的内容集合）</summary>
    public const string Topic = "topic";

    /// <summary>日常分类（日常内容的常规归类）</summary>
    public const string Daily = "daily";

    public static readonly string[] All = { Topic, Daily };
}
