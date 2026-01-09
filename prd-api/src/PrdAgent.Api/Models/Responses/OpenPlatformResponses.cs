namespace PrdAgent.Api.Models.Responses;

public sealed class OpenPlatformApiKeyDto
{
    public string Id { get; set; } = string.Empty;
    public string OwnerUserId { get; set; } = string.Empty;
    public string? Name { get; set; }
    public string KeyPrefix { get; set; } = string.Empty;
    public List<string> AllowedGroupIds { get; set; } = new();
    public DateTime CreatedAt { get; set; }
    public DateTime? LastUsedAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}

public sealed class CreateOpenPlatformApiKeyResponse
{
    /// <summary>
    /// 明文 key（仅创建成功时返回一次，服务端不落库）
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    public OpenPlatformApiKeyDto Key { get; set; } = new();
}

