using System.Security.Cryptography;

namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷外部传输临时令牌（默认 3 天有效）
/// </summary>
public class DefectShareToken
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>公开访问 token（URL-safe）</summary>
    public string Token { get; set; } = GenerateToken();

    public string DefectId { get; set; } = string.Empty;
    public string DefectNo { get; set; } = string.Empty;

    /// <summary>创建人</summary>
    public string CreatedBy { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }

    /// <summary>可手动吊销</summary>
    public bool IsRevoked { get; set; }

    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(24))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}

