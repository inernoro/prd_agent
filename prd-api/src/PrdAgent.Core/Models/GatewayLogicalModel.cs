using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 面向调用方公开的逻辑模型。调用方只选择 PublicId，不感知具体 Provider、Endpoint 或凭据。
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
[BsonIgnoreExtraElements]
public sealed class GatewayLogicalModel
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string PublicId { get; set; } = string.Empty;
    public string PublicIdNormalized { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string ModelType { get; set; } = string.Empty;
    public List<string> Capabilities { get; set; } = new();
    public List<string> AllowedAppCallerCodes { get; set; } = new();
    public string RoutingStrategy { get; set; } = "priority";
    public bool Enabled { get; set; } = true;
    public int DisplayOrder { get; set; } = 100;
    public string? Description { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 逻辑模型的一条上游供给。TargetKind=model 时 TargetId 指向 llmgw_models；
/// TargetKind=exchange 时 TargetId 指向 llmgw_model_exchanges。
/// </summary>
[AppOwnership(AppNames.Llm, AppNames.LlmDisplay, IsPrimary = true)]
[BsonIgnoreExtraElements]
public sealed class GatewayModelOffering
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string LogicalModelId { get; set; } = string.Empty;
    public string TargetKind { get; set; } = "model";
    public string TargetId { get; set; } = string.Empty;
    public string? UpstreamModelId { get; set; }
    public string? Protocol { get; set; }
    public string? EndpointPath { get; set; }
    public int Priority { get; set; } = 100;
    public int Weight { get; set; } = 100;
    public bool Enabled { get; set; } = true;
    public ModelHealthStatus HealthStatus { get; set; } = ModelHealthStatus.Healthy;
    public DateTime? LastFailedAt { get; set; }
    public DateTime? LastSuccessAt { get; set; }
    public int ConsecutiveFailures { get; set; }
    public int ConsecutiveSuccesses { get; set; }
    public int? MaxConcurrency { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
