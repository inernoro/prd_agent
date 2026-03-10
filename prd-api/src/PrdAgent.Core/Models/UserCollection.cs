namespace PrdAgent.Core.Models;

/// <summary>
/// 用户收藏内容（通过快捷指令、网页、桌面端收藏的链接/视频/文章等）
/// </summary>
public class UserCollection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属用户ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 内容类型：video / article / image / link / text
    /// </summary>
    public string ContentType { get; set; } = ContentTypes.Link;

    /// <summary>
    /// 来源平台：douyin / kuaishou / bilibili / xiaohongshu / wechat / other
    /// </summary>
    public string Platform { get; set; } = Platforms.Other;

    /// <summary>原始链接</summary>
    public string SourceUrl { get; set; } = string.Empty;

    /// <summary>解析后真实链接（短链跳转后的目标）</summary>
    public string? ResolvedUrl { get; set; }

    /// <summary>内容标题</summary>
    public string? Title { get; set; }

    /// <summary>内容摘要/描述</summary>
    public string? Description { get; set; }

    /// <summary>封面图URL</summary>
    public string? CoverUrl { get; set; }

    /// <summary>作者</summary>
    public string? Author { get; set; }

    /// <summary>用户指定 + 自动推断的标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>分类文件夹ID（预留）</summary>
    public string? FolderId { get; set; }

    /// <summary>
    /// 来源渠道：shortcuts / web / desktop
    /// </summary>
    public string Source { get; set; } = "shortcuts";

    /// <summary>用户附加的备注文字</summary>
    public string? Note { get; set; }

    /// <summary>额外元数据</summary>
    public Dictionary<string, object> Metadata { get; set; } = new();

    /// <summary>关联的 ChannelTask ID（如有）</summary>
    public string? ChannelTaskId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 收藏内容类型常量
/// </summary>
public static class ContentTypes
{
    public const string Video = "video";
    public const string Article = "article";
    public const string Image = "image";
    public const string Link = "link";
    public const string Text = "text";
}

/// <summary>
/// 来源平台常量
/// </summary>
public static class Platforms
{
    public const string Douyin = "douyin";
    public const string Kuaishou = "kuaishou";
    public const string Bilibili = "bilibili";
    public const string Xiaohongshu = "xiaohongshu";
    public const string Wechat = "wechat";
    public const string Other = "other";

    public static string GetDisplayName(string platform) => platform switch
    {
        Douyin => "抖音",
        Kuaishou => "快手",
        Bilibili => "B站",
        Xiaohongshu => "小红书",
        Wechat => "公众号",
        Other => "其他",
        _ => platform
    };
}
