using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.LlmGateway;

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

/// <summary>
/// MAP 为单次远程设计任务签发的短期 LLMGW 凭据。数据库只保存密钥哈希；调用身份、
/// 运行标识和冻结模型策略都由网关从本记录恢复，不能由设计执行器自行扩大权限。
/// </summary>
[BsonIgnoreExtraElements]
public sealed class GatewayRuntimeGrantRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string KeyPrefix { get; set; } = string.Empty;
    public string KeyHash { get; set; } = string.Empty;
    public string RunId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string AppCallerCode { get; set; } = string.Empty;
    public string Environment { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? ModelPoolId { get; set; }
    public string? PinnedPlatformId { get; set; }
    public string? PinnedModelId { get; set; }
    public double? Temperature { get; set; }
    public double? TopP { get; set; }
    public string? ReasoningMode { get; set; }
    public string? ReasoningEffort { get; set; }
    public string? OutputTokenMode { get; set; }
    public bool RequireDeclaredParameters { get; set; }
    public int MaxCalls { get; set; } = 256;
    public int CallCount { get; set; }
    /// <summary>仅显式运维绑定的任务预算作用域；null 表示沿用既有运行授权行为。</summary>
    public string? BudgetScopeId { get; set; }
    /// <summary>任务预算允许的单请求输出硬上限；由网关在 token policy 之后再次收紧。</summary>
    public int? BudgetMaxOutputTokens { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastUsedAt { get; set; }
}

/// <summary>
/// 一次受权 PPT 任务链共享的发送前预算。它不替代租户月预算，也不参与未显式绑定的请求。
/// </summary>
[BsonIgnoreExtraElements]
public sealed class GatewayRuntimeBudgetScopeRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string RootOutlineRunId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string SourcePlanHash { get; set; } = string.Empty;
    [BsonRepresentation(BsonType.Decimal128)] public decimal ImmutableCarryUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal AuthorizedLimitUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal SpentUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReservedUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal InputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal OutputUsdPerMillion { get; set; }
    public long LongContextThresholdTokens { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal LongContextInputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal LongContextOutputUsdPerMillion { get; set; }
    public int InputByteTokenMultiplier { get; set; } = 4;
    public int MaxOutputTokens { get; set; }
    public string ExpectedLogicalModelPublicId { get; set; } = string.Empty;
    public string ExpectedProvider { get; set; } = string.Empty;
    public string ExpectedModel { get; set; } = string.Empty;
    public string Status { get; set; } = "active";
    public string ActivatedByUserId { get; set; } = string.Empty;
    public List<GatewayRuntimeBudgetReservationRecord> Reservations { get; set; } = new();
    public DateTime ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ClosedAt { get; set; }
    public string? ClosedByUserId { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayRuntimeBudgetReservationRecord
{
    public string RequestId { get; set; } = string.Empty;
    public string GrantId { get; set; } = string.Empty;
    public string RunId { get; set; } = string.Empty;
    public string AppCallerCode { get; set; } = string.Empty;
    public long RequestBodyUtf8Bytes { get; set; }
    public long InputTokenUpperBound { get; set; }
    public int MaxOutputTokens { get; set; }
    public string LogicalModelPublicId { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string? OfferingId { get; set; }
    public string PricingTier { get; set; } = "standard";
    [BsonRepresentation(BsonType.Decimal128)] public decimal InputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal OutputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReservedUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? SettledUsd { get; set; }
    public string Status { get; set; } = "reserved";
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
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
    public long ExpiredOperationAudits { get; set; }
    public long ExpiredLoginAudits { get; set; }
    public long ExpiredMultipartObjects { get; set; }
    public long RedactedSensitiveLogs { get; set; }
    public long DeletedMultipartObjects { get; set; }
    public DateTime? OldestExpiredRequestLogAt { get; set; }
    public DateTime? OldestSensitiveLogAt { get; set; }
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

[BsonIgnoreExtraElements]
public sealed class GatewayOfferingRateWindowRecord
{
    public string Id { get; set; } = string.Empty;
    public string TenantId { get; set; } = string.Empty;
    public string OfferingId { get; set; } = string.Empty;
    public DateTime WindowStart { get; set; }
    public long Count { get; set; }
    public DateTime ExpiresAt { get; set; }
}
