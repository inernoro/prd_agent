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

    /// <summary>统一短链全局序号（/s/{seq}），0 表示尚未分配。</summary>
    public long ShortSeq { get; set; }

    /// <summary>关联的知识库 ID</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>知识库名称（快照）</summary>
    public string StoreName { get; set; } = string.Empty;

    /// <summary>
    /// 单篇文档分享：指向 DocumentEntry.Id。
    /// null = 分享整个知识库；非 null = 只分享该篇文档。
    /// </summary>
    public string? EntryId { get; set; }

    /// <summary>被分享文档的标题快照（仅单篇分享时有值）</summary>
    public string? EntryTitle { get; set; }

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
