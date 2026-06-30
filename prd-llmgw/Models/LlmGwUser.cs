using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.LlmGw.Models;

/// <summary>
/// 网关自有账户（独立账户体系，与 MAP/prd-api 用户表无关）。
/// 存放在共享 Mongo 的 llmgw_users 集合。
/// </summary>
[BsonIgnoreExtraElements]
public class LlmGwUser
{
    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Username { get; set; } = string.Empty;

    /// <summary>PBKDF2 格式：pbkdf2$iterations$saltB64$hashB64</summary>
    public string PasswordHash { get; set; } = string.Empty;

    public string DisplayName { get; set; } = string.Empty;

    public bool IsActive { get; set; } = true;

    public string[] Scopes { get; set; } = Array.Empty<string>();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
