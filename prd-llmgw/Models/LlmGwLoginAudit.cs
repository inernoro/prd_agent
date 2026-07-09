using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.LlmGw.Models;

/// <summary>
/// 网关控制台登录审计，存放在 llm_gateway.llmgw_login_audits。
/// </summary>
[BsonIgnoreExtraElements]
public class LlmGwLoginAudit
{
    [BsonId]
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Username { get; set; } = string.Empty;

    public string? UserId { get; set; }

    public bool Success { get; set; }

    public string? Reason { get; set; }

    public string? RemoteIp { get; set; }

    public string? UserAgent { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
