using System.Security.Cryptography;

namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库分享链接 — 通过短 token 公开访问
/// </summary>
public class DocumentStoreShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>短 Token（用于 URL）</summary>
    public string Token { get; set; } = GenerateToken();

    /// <summary>关联的知识库 ID</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>知识库名称（快照）</summary>
    public string StoreName { get; set; } = string.Empty;

    /// <summary>分享标题（自定义）</summary>
    public string? Title { get; set; }

    /// <summary>分享描述</summary>
    public string? Description { get; set; }

    /// <summary>查看次数</summary>
    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>过期时间（null 表示永不过期）</summary>
    public DateTime? ExpiresAt { get; set; }

    public bool IsRevoked { get; set; }

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}
