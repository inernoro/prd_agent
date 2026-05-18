using System.Security.Cryptography;

namespace PrdAgent.Core.Models;

/// <summary>
/// 海鲜市场技能公开分享链接 — 免登录只读浏览技能包（SKILL.md + 文件树）
/// </summary>
public class MarketplaceSkillShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>短 Token（用于 URL）</summary>
    public string Token { get; set; } = GenerateToken();

    /// <summary>关联的技能 ID</summary>
    public string SkillId { get; set; } = string.Empty;

    /// <summary>技能标题（快照）</summary>
    public string SkillTitle { get; set; } = string.Empty;

    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建者显示名称（快照）</summary>
    public string? CreatedByName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>过期时间（null = 永久；技能本就为广泛分享）</summary>
    public DateTime? ExpiresAt { get; set; }

    public bool IsRevoked { get; set; }

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}
