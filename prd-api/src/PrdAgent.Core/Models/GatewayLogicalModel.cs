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

    /// <summary>
    /// 自动半开验证租约截止时间。与模型池成员同义：租约期间只有拿到租约的那个请求能把
    /// 不可用 Offering 当候选，避免冷却结束后并发流量一起冲刚回血的上游。
    ///
    /// 补这个字段之前，Offering 被标为不可用后是**永远不会自己回来**的——所有候选查询都
    /// 无条件 `Ne(HealthStatus, Unavailable)`，摘掉之后它再也拿不到一次成功来翻身，只能等
    /// 有人去控制台改一次密钥。一个模型挂多条上游本该更稳，那样反而是线路越多、熄灭得越多。
    /// </summary>
    public DateTime? HalfOpenLeaseUntil { get; set; }

    /// <summary>
    /// 人工请求进入半开验证的时间。Offering 仍保持不可用，必须先拿到半开租约才会被试探，
    /// 防止控制台上点一下「恢复」就把并发流量直接放回刚恢复的上游。
    /// </summary>
    public DateTime? ManualRecoveryAt { get; set; }

    public int? MaxConcurrency { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public string? Notes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
