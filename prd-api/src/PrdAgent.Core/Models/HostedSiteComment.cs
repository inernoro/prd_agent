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

    /// <summary>软删除标记（删除不抹除记录，便于审计）</summary>
    public bool IsDeleted { get; set; }

    /// <summary>发表来源 IP（审计用，前端不展示）</summary>
    public string? IpAddress { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
