using System.Security.Cryptography;

namespace PrdAgent.Core.Models;

/// <summary>
/// 托管站点 — 用户上传 HTML/ZIP 或工作流自动生成的可运行网页
/// </summary>
public class HostedSite
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>站点标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>站点描述</summary>
    public string? Description { get; set; }

    // ── 来源分类 ──

    /// <summary>来源类型：upload | workflow | api</summary>
    public string SourceType { get; set; } = "upload";

    /// <summary>来源引用（如 workflowExecutionId）</summary>
    public string? SourceRef { get; set; }

    // ── COS 存储 ──

    /// <summary>COS 上的目录前缀: web-hosting/sites/{siteId}/</summary>
    public string CosPrefix { get; set; } = string.Empty;

    /// <summary>入口文件名 (默认 index.html)</summary>
    public string EntryFile { get; set; } = "index.html";

    /// <summary>完整入口 URL (COS public URL + cosPrefix + entryFile)</summary>
    public string SiteUrl { get; set; } = string.Empty;

    /// <summary>站点包含的文件清单</summary>
    public List<HostedSiteFile> Files { get; set; } = new();

    /// <summary>站点总大小 (bytes)</summary>
    public long TotalSize { get; set; }

    // ── 元信息 ──

    /// <summary>用户标签</summary>
    public List<string> Tags { get; set; } = new();

    /// <summary>分类文件夹</summary>
    public string? Folder { get; set; }

    /// <summary>封面图 URL</summary>
    public string? CoverImageUrl { get; set; }

    // ── 所有权 ──

    /// <summary>所属用户 ID</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>浏览次数</summary>
    public long ViewCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>站点文件清单项</summary>
public class HostedSiteFile
{
    /// <summary>相对路径 (如 "index.html", "css/style.css")</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>COS 完整 key</summary>
    public string CosKey { get; set; } = string.Empty;

    /// <summary>文件大小 (bytes)</summary>
    public long Size { get; set; }

    /// <summary>MIME 类型</summary>
    public string MimeType { get; set; } = string.Empty;
}

/// <summary>
/// 网页分享链接 — 基于 Token 的分享机制（密码保护 + 过期时间）
/// </summary>
public class WebPageShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>短 Token（用于 URL）</summary>
    public string Token { get; set; } = GenerateToken();

    /// <summary>关联的站点 ID（单站点分享时）</summary>
    public string? SiteId { get; set; }

    /// <summary>关联的站点 ID 列表（合集分享时）</summary>
    public List<string> SiteIds { get; set; } = new();

    /// <summary>分享类型：single = 单站点, collection = 合集</summary>
    public string ShareType { get; set; } = "single";

    /// <summary>分享标题</summary>
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
