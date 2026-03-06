using System.Security.Cryptography;

namespace PrdAgent.Core.Models;

/// <summary>
/// 网页收藏 - 用户存储和管理的网页书签
/// </summary>
public class WebPage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>网页 URL</summary>
    public string Url { get; set; } = string.Empty;

    /// <summary>网页标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>网页描述/摘要</summary>
    public string? Description { get; set; }

    /// <summary>网站 Favicon URL</summary>
    public string? FaviconUrl { get; set; }

    /// <summary>网页截图/封面图 URL</summary>
    public string? CoverImageUrl { get; set; }

    /// <summary>用户标签（自由标注）</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>所属文件夹（一级分类）</summary>
    public string? Folder { get; set; }

    /// <summary>用户备注</summary>
    public string? Note { get; set; }

    /// <summary>是否收藏/置顶</summary>
    public bool IsFavorite { get; set; }

    /// <summary>是否公开（在用户个人主页可见）</summary>
    public bool IsPublic { get; set; }

    /// <summary>所属用户 ID</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>浏览次数（分享后的外部访问计数）</summary>
    public long ViewCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 网页分享链接 - 基于现有 ShareLink 模式的轻量扩展
/// </summary>
public class WebPageShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>短 Token（用于 URL）</summary>
    public string Token { get; set; } = GenerateToken();

    /// <summary>关联的网页 ID（单个网页分享时）</summary>
    public string? WebPageId { get; set; }

    /// <summary>关联的网页 ID 列表（合集分享时）</summary>
    public List<string> WebPageIds { get; set; } = new();

    /// <summary>分享类型：single = 单页, collection = 合集</summary>
    public string ShareType { get; set; } = "single";

    /// <summary>分享标题（合集场景可自定义）</summary>
    public string? Title { get; set; }

    /// <summary>分享描述</summary>
    public string? Description { get; set; }

    /// <summary>访问级别：public = 任何人 | password = 需密码</summary>
    public string AccessLevel { get; set; } = "public";

    /// <summary>访问密码（AccessLevel = password 时有效）</summary>
    public string? Password { get; set; }

    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; }
    public bool IsRevoked { get; set; }

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}
