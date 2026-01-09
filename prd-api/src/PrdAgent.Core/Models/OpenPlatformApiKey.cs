namespace PrdAgent.Core.Models;

/// <summary>
/// 开放平台 API Key（仅存 hash，不落明文 key）
/// </summary>
public sealed class OpenPlatformApiKey
{
    /// <summary>
    /// 主键（MongoDB _id）：Guid 字符串（N）
    /// </summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>
    /// Key 归属用户（必须是系统内真实 userId，来源于 JWT sub）
    /// </summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>
    /// 显示名（可选）
    /// </summary>
    public string? Name { get; set; }

    /// <summary>
    /// 授权群组列表（仅允许调用这些群组）
    /// </summary>
    public List<string> AllowedGroupIds { get; set; } = new();

    /// <summary>
    /// Key 前缀（用于 UI 展示与快速定位，不包含敏感信息）
    /// 例如：sk_prd_{id}_xxxxxx... 的前 12-16 个字符（不含 secret）
    /// </summary>
    public string KeyPrefix { get; set; } = string.Empty;

    /// <summary>
    /// salt（base64）
    /// </summary>
    public string SaltBase64 { get; set; } = string.Empty;

    /// <summary>
    /// hash（base64），计算方式：SHA256(salt + secret)
    /// </summary>
    public string SecretHashBase64 { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastUsedAt { get; set; }
    public DateTime? RevokedAt { get; set; }

    public bool IsRevoked => RevokedAt.HasValue;
}

