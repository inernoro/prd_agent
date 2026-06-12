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

    /// <summary>
    /// 分组可见性：inherit = 跟随空间角色（默认，存量分组零行为变化）| restricted = 受限，
    /// 仅空间 owner 与 AccessRules 命中的成员可见/可操作。解析逻辑见 WebPageGroupAccess。
    /// </summary>
    public string Visibility { get; set; } = WebPageGroupVisibility.Inherit;

    /// <summary>受限分组的授权规则（visibility=restricted 时生效；inherit 时忽略）</summary>
    public List<WebPageGroupAccessRule> AccessRules { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 分组授权规则：把分组内容授予某个成员（user）或某个角色标签（label）的成员，
/// 角色档位仅 viewer（可看）/ editor（可编辑），owner 不下放到分组级。
/// </summary>
[BsonIgnoreExtraElements]
public class WebPageGroupAccessRule
{
    /// <summary>授权对象类型：user = 具体成员 | label = 角色标签（TeamMember.Labels）</summary>
    public string SubjectType { get; set; } = WebPageGroupSubjectType.User;

    /// <summary>授权对象：user 时为 UserId；label 时为标签文本</summary>
    public string SubjectId { get; set; } = string.Empty;

    /// <summary>授予角色：viewer | editor</summary>
    public string Role { get; set; } = Security.WebHostingRoles.Viewer;
}

/// <summary>分组可见性常量</summary>
public static class WebPageGroupVisibility
{
    /// <summary>跟随空间角色（默认）</summary>
    public const string Inherit = "inherit";

    /// <summary>受限：仅空间 owner 与授权规则命中的成员可见</summary>
    public const string Restricted = "restricted";

    public static readonly string[] All = { Inherit, Restricted };
}

/// <summary>分组授权对象类型常量</summary>
public static class WebPageGroupSubjectType
{
    public const string User = "user";
    public const string Label = "label";

    public static readonly string[] All = { User, Label };
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
