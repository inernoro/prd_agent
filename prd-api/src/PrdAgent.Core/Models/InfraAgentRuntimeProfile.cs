using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// CDS Agent runtime 的系统级模型配置。
/// API key 使用 IDataProtector 加密落库，列表接口只暴露是否已配置。
/// </summary>
[BsonIgnoreExtraElements]
public class InfraAgentRuntimeProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Name { get; set; } = string.Empty;

    public string Runtime { get; set; } = InfraAgentRuntimes.ClaudeSdk;

    public string Protocol { get; set; } = InfraAgentRuntimeProtocols.Anthropic;

    public string BaseUrl { get; set; } = string.Empty;

    public string Model { get; set; } = string.Empty;

    public string ApiKeyEncrypted { get; set; } = string.Empty;

    public double ResourceCpuCores { get; set; } = 2;

    public int ResourceMemoryMb { get; set; } = 4096;

    public int TimeoutSeconds { get; set; } = 900;

    public string NetworkPolicy { get; set; } = InfraAgentRuntimeNetworkPolicies.Restricted;

    public int AutoCleanupMinutes { get; set; } = 30;

    public bool IsDefault { get; set; }

    public string CreatedByUserId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public static class InfraAgentRuntimeProtocols
{
    public const string Anthropic = "anthropic";
    public const string OpenAiCompatible = "openai-compatible";
}

public static class InfraAgentRuntimeNetworkPolicies
{
    public const string Restricted = "restricted";
    public const string EgressOnly = "egress-only";
    public const string Open = "open";
}
