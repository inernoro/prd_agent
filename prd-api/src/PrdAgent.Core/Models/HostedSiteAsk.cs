using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 「向我提问」会话 —— 一个访客对着一个托管站点的一轮连续问答。
///
/// 与评论不同，提问允许匿名（站点 owner 显式打开 AskAllowAnonymous 后），
/// 所以 VisitorUserId 可为空，靠 SessionId 串起同一个人的多轮对话。
/// </summary>
[BsonIgnoreExtraElements]
public class HostedSiteAskSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>被提问的站点 ID</summary>
    public string SiteId { get; set; } = string.Empty;

    /// <summary>站点 owner（冗余一份，owner 查"我的站点被问了什么"时不必回表 join）</summary>
    public string SiteOwnerUserId { get; set; } = string.Empty;

    /// <summary>经哪条分享链接进来的（站内预览发起为 null）</summary>
    public string? ShareToken { get; set; }

    /// <summary>提问者用户 ID；匿名访客为 null</summary>
    public string? VisitorUserId { get; set; }

    /// <summary>提问者显示名快照；匿名为 null</summary>
    public string? VisitorName { get; set; }

    /// <summary>
    /// 部署作用域盖戳。共享 Mongo 下分支预览与生产读写同一个库，
    /// 不盖戳就会在 owner 的会话列表里混进其它部署的记录（cross-project-isolation 通道 4）。
    /// </summary>
    public string? DeploymentSlug { get; set; }

    /// <summary>本轮问答数（每问一次 +1，用于配额与列表展示）</summary>
    public int MessageCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 「向我提问」的单条消息（一问一答各一条）。
/// 落 Model / PlatformName 是 ai-model-visibility 规则第 4 条的要求：
/// AI 产出的记录必须能回答"这条是哪个模型答的"。
/// </summary>
[BsonIgnoreExtraElements]
public class HostedSiteAskMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    public string SiteId { get; set; } = string.Empty;

    /// <summary>角色：user | assistant</summary>
    public string Role { get; set; } = "user";

    public string Content { get; set; } = string.Empty;

    /// <summary>回答用的模型 / 平台（Role=assistant 时填，来自网关 Start chunk 的 Resolution）</summary>
    public string? Model { get; set; }
    public string? PlatformName { get; set; }

    /// <summary>本次喂给模型的页面正文字符数（成本回看用）</summary>
    public int ContextChars { get; set; }

    /// <summary>回答耗时（毫秒，Role=assistant 时填）</summary>
    public int? ElapsedMs { get; set; }

    /// <summary>失败时的错误摘要（Role=assistant 且回答失败时填）</summary>
    public string? Error { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
