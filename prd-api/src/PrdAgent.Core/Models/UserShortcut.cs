using System.Security.Cryptography;
using System.Text;

namespace PrdAgent.Core.Models;

/// <summary>
/// 用户快捷指令绑定（每个绑定拥有独立的 scs- token）
/// </summary>
public class UserShortcut
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属用户ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>用户自定义名称（如"工作收藏"、"灵感收集"）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Token 的 SHA256 哈希（用于校验，不存储明文）</summary>
    public string TokenHash { get; set; } = string.Empty;

    /// <summary>Token 前缀，用于展示（如 "scs-a1b2c3d4"）</summary>
    public string TokenPrefix { get; set; } = string.Empty;

    /// <summary>设备类型：ios / android / other</summary>
    public string DeviceType { get; set; } = "ios";

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>最后使用时间</summary>
    public DateTime? LastUsedAt { get; set; }

    /// <summary>累计收藏次数</summary>
    public int CollectCount { get; set; } = 0;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 生成新的 scs- token，返回明文（仅创建时返回一次）
    /// </summary>
    public static (string token, string hash, string prefix) GenerateToken()
    {
        var token = $"scs-{Guid.NewGuid():N}";
        var hash = HashToken(token);
        var prefix = token[..12]; // "scs-a1b2c3d4"
        return (token, hash, prefix);
    }

    /// <summary>
    /// 计算 token 的 SHA256 哈希
    /// </summary>
    public static string HashToken(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}
