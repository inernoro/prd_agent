using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Infrastructure.LlmGateway;

[BsonIgnoreExtraElements]
public sealed class GatewayServiceKeyRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string? TeamId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string KeyPrefix { get; set; } = string.Empty;
    public string KeyHash { get; set; } = string.Empty;
    public string CreatedByUserId { get; set; } = string.Empty;
    public string CreatedByUsername { get; set; } = string.Empty;
    public bool Enabled { get; set; } = true;
    public string SourceSystem { get; set; } = "external";
    /// <summary>稳定的调用工作负载标识，由控制台创建时绑定，禁止由请求自报。</summary>
    public string ClientCode { get; set; } = string.Empty;
    /// <summary>密钥使用环境：development / test / staging / production。</summary>
    public string Environment { get; set; } = string.Empty;
    /// <summary>单值用途：runtime / release-gate / canary / external-platform。</summary>
    public string Purpose { get; set; } = string.Empty;
    public List<string> AppCallerCodes { get; set; } = new();
    public List<string> IngressProtocols { get; set; } = new();
    public List<string> Scopes { get; set; } = new();
    public List<string> AllowedCidrs { get; set; } = new();
    public int? RateLimitPerMinute { get; set; }
    public string? RotatesKeyId { get; set; }
    public string? RotatedByKeyId { get; set; }
    public string RotationState { get; set; } = "active";
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastUsedAt { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayLegacyKeyCutoverRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string Status { get; set; } = "observing";
    public DateTime? DeadlineAt { get; set; }
    public List<string> AllowedAppCallerCodes { get; set; } = new();
    public List<string> SuccessorServiceKeyIds { get; set; } = new();
    public List<string> RequiredIngressProtocols { get; set; } = new();
    public List<string> RequiredScopes { get; set; } = new();
    public long RequiredSuccessorObservations { get; set; } = 1;
    public long SuccessorObservedCount { get; set; }
    public Dictionary<string, long> SuccessorObservationCounts { get; set; } = new(StringComparer.Ordinal);
    public DateTime? LastSuccessorUsedAt { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class GatewayLegacyKeyUsageRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string SourceSystem { get; set; } = string.Empty;
    public string AppCallerCode { get; set; } = string.Empty;
    public string IngressProtocol { get; set; } = string.Empty;
    public long TotalCount { get; set; }
    public long AllowedCount { get; set; }
    public long RejectedCount { get; set; }
    public DateTime FirstSeenAt { get; set; } = DateTime.UtcNow;
    public DateTime LastSeenAt { get; set; } = DateTime.UtcNow;
    public string LastDecision { get; set; } = string.Empty;
}

[BsonIgnoreExtraElements]
public sealed class GatewayServiceKeyRateWindowRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string ServiceKeyId { get; set; } = string.Empty;
    public DateTime WindowStart { get; set; }
    public long Count { get; set; }
    public DateTime ExpiresAt { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayTenantGovernanceRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    [BsonRepresentation(BsonType.Decimal128)] public decimal? MonthlyBudgetUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? BudgetReservationUsd { get; set; }
    public int? RateLimitPerMinute { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class GatewayTenantRateWindowRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public DateTime WindowStart { get; set; }
    public long Count { get; set; }
    public DateTime ExpiresAt { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayServiceKeyDirectoryRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string KeyHash { get; set; } = string.Empty;
    public string TenantId { get; set; } = string.Empty;
    public string ServiceKeyId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class GatewayBudgetMonthRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string AppCallerCode { get; set; } = string.Empty;
    public string RequestType { get; set; } = string.Empty;
    public DateTime MonthStart { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal BudgetUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReservedUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal SpentUsd { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class GatewayBudgetReservationRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string AppCallerCode { get; set; } = string.Empty;
    public string RequestType { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public DateTime MonthStart { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReservedUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? SettledUsd { get; set; }
    public string Status { get; set; } = "reserved";
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddHours(24);
}

[BsonIgnoreExtraElements]
public sealed class GatewayRequestExecutionRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string AppCallerCode { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public string Operation { get; set; } = string.Empty;
    public string Fingerprint { get; set; } = string.Empty;
    public string Status { get; set; } = "running";
    public string? ResponseJson { get; set; }
    public string? ErrorCode { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(7);
}

[BsonIgnoreExtraElements]
public sealed class GatewayMultipartObjectRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string RequestId { get; set; } = string.Empty;
    public string RefKey { get; set; } = string.Empty;
    public string Sha256 { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string Status { get; set; } = "uploaded";
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddHours(24);
    public DateTime? DeletedAt { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayLifecycleRunRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string Mode { get; set; } = "dry-run";
    public string Status { get; set; } = "running";
    public DateTime StartedAt { get; set; } = DateTime.UtcNow;
    public DateTime? DryRunCompletedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public long ExpiredRequestLogs { get; set; }
    public long SensitiveLogs { get; set; }
    public long ExpiredShadowComparisons { get; set; }
    public long ExpiredOperationAudits { get; set; }
    public long ExpiredLoginAudits { get; set; }
    public long ExpiredMultipartObjects { get; set; }
    public long RedactedSensitiveLogs { get; set; }
    public long DeletedMultipartObjects { get; set; }
    public DateTime? OldestExpiredRequestLogAt { get; set; }
    public DateTime? OldestSensitiveLogAt { get; set; }
    public DateTime? OldestExpiredShadowAt { get; set; }
    public DateTime? OldestExpiredOperationAuditAt { get; set; }
    public DateTime? OldestExpiredLoginAuditAt { get; set; }
    public DateTime? OldestExpiredMultipartAt { get; set; }
    public bool RetentionIndexesReady { get; set; }
    public string[] MissingRetentionIndexes { get; set; } = [];
    public string? Detail { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayProviderConcurrencySlotRecord
{
    public string Id { get; set; } = string.Empty;
    public string TenantId { get; set; } = string.Empty;
    public string ResourceKey { get; set; } = string.Empty;
    public int Slot { get; set; }
    public string LeaseId { get; set; } = string.Empty;
    public string OwnerInstance { get; set; } = string.Empty;
    public DateTime AcquiredAt { get; set; }
    public DateTime ExpiresAt { get; set; }
}
