using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 托管站点评论 —— 访客在分享页 / 站点详情上对某个托管站点发表的评论。
///
/// 评论恒以 SiteId 维度组织（一个站点的所有评论聚在一起），不区分来自哪条分享链接，
/// 但保留 ShareToken 快照便于追溯"这条评论是从哪个分享链接进来发的"。
///
/// BsonIgnoreExtraElements: 与 hosted_sites 同样的 schema drift 常态防御，
/// 避免后续加字段时反序列化老文档抛 FormatException。
/// </summary>
[BsonIgnoreExtraElements]
public class HostedSiteComment
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>被评论的站点 ID</summary>
    public string SiteId { get; set; } = string.Empty;

    /// <summary>评论来源的分享 Token 快照（经分享页发表时记录；站内/owner 视角发表为 null）</summary>
    public string? ShareToken { get; set; }

    /// <summary>评论作者用户 ID（发表必须登录，恒非空）</summary>
    public string AuthorUserId { get; set; } = string.Empty;

    /// <summary>作者显示名称快照（发表当时的昵称，避免改名后历史评论错位）</summary>
    public string AuthorName { get; set; } = "用户";

    /// <summary>作者头像文件名快照（用于前端渲染头像，可为空）</summary>
    public string? AuthorAvatarFileName { get; set; }

    /// <summary>评论正文</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>根讨论的网页定位信息；整页评论和回复为空。</summary>
    public HostedSiteCommentAnchor? Anchor { get; set; }

    /// <summary>回复所属的根讨论 ID。只允许一层关联。</summary>
    public string? ParentId { get; set; }

    public bool IsResolved { get; set; }

    /// <summary>软删除标记（删除不抹除记录，便于审计）</summary>
    public bool IsDeleted { get; set; }

    /// <summary>发表来源 IP（审计用，前端不展示）</summary>
    public string? IpAddress { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>网页批注的可迁移定位信息。选择器只作为定位数据，不作为代码执行。</summary>
[BsonIgnoreExtraElements]
public class HostedSiteCommentAnchor
{
    public string Kind { get; set; } = "element";
    public string PagePath { get; set; } = string.Empty;
    public string Selector { get; set; } = string.Empty;
    public string TagName { get; set; } = string.Empty;
    public string Text { get; set; } = string.Empty;
    public string Prefix { get; set; } = string.Empty;
    public string Suffix { get; set; } = string.Empty;
    public string ElementText { get; set; } = string.Empty;
    public string ContentVersion { get; set; } = string.Empty;
}

public static class HostedSiteCommentRules
{
    public static bool IsValidAnchor(HostedSiteCommentAnchor? anchor) => anchor == null ||
        ((anchor.Kind == "element" || anchor.Kind == "text")
         && !string.IsNullOrWhiteSpace(anchor.PagePath) && anchor.PagePath.StartsWith('/') && anchor.PagePath.Length <= 2000
         && !string.IsNullOrWhiteSpace(anchor.Selector) && anchor.Selector.Length <= 2000
         && !string.IsNullOrWhiteSpace(anchor.TagName) && anchor.TagName.Length <= 40
         && System.Text.RegularExpressions.Regex.IsMatch(anchor.TagName, "^[A-Za-z][A-Za-z0-9-]*$")
         && anchor.Text != null && anchor.Text.Length <= 1000
         && (anchor.Kind != "text" || !string.IsNullOrWhiteSpace(anchor.Text))
         && anchor.Prefix != null && anchor.Prefix.Length <= 100
         && anchor.Suffix != null && anchor.Suffix.Length <= 100
         && anchor.ElementText != null && anchor.ElementText.Length <= 1000
         && anchor.ContentVersion != null && anchor.ContentVersion.Length <= 100);

    public static bool CanResolve(HostedSiteComment comment, HostedSite site, string? userId) =>
        !comment.IsDeleted && string.IsNullOrEmpty(comment.ParentId) && !string.IsNullOrWhiteSpace(userId)
        && (comment.AuthorUserId == userId || site.OwnerUserId == userId);

    public static bool CanReplyTo(HostedSiteComment? parent, string siteId) =>
        parent != null && !parent.IsDeleted && parent.SiteId == siteId && string.IsNullOrEmpty(parent.ParentId);
}
