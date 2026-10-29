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
    /// <summary>空值与旧记录仍仅是设计Responses授权；task-sidecar为受控兼容SDK通道。</summary>
    public string Purpose { get; set; } = "design";
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TenantId { get; set; } = string.Empty;
    public string KeyPrefix { get; set; } = string.Empty;
    public string KeyHash { get; set; } = string.Empty;
    public string RunId { get; set; } = string.Empty;
    /// <summary>设计执行器仅继承发起任务的服务端许可，不能凭短期模型密钥扩大任务范围。</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string? TaskPermitId { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public string? TaskLeaseRunId { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public string? TaskLeaseOwnerHash { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public long? TaskLeaseFence { get; set; }
    /// <summary>新执行器短凭据必须绑定发行环境；旧设计凭据仍从父许可恢复来源。</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string? SourceDeployment { get; set; }
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
    /// <summary>PPT 完成合同标识；仅服务端从受信任务链写入，设计运行时不能自报。</summary>
    public string? PptCompletionId { get; set; }
    /// <summary>受信阶段：generation 或 manual-save。</summary>
    public string? PptCompletionPhase { get; set; }
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
    public string? TaskPermitId { get; set; }
    public int MaxPhysicalCalls { get; set; }
    public List<string> AllowedAppCallerCodes { get; set; } = new();
    public string? PriceVersion { get; set; }
    public string? PriceProtocol { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? CachedInputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? CacheWriteUsdPerMillion { get; set; }
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
    /// <summary>
    /// 仅显式绑定的 PPT 完成链启用。FutureHeldUsd 与单请求 ReservedUsd 分账，确保生成重试
    /// 不能抢走人工保存的冻结额度；缺失时，已绑定本 scope 的 PPT 物理请求必须默认拒绝。
    /// </summary>
    public GatewayPptCompletionBudgetRecord? PptCompletion { get; set; }
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
    public string? PriceVersion { get; set; }
    public string? PriceProtocol { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? CachedInputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? CacheWriteUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal InputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal OutputUsdPerMillion { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReservedUsd { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal ReleasedFutureHoldUsd { get; set; }
    public string? PptCompletionId { get; set; }
    public string? PptCompletionPhase { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal? SettledUsd { get; set; }
    public string Status { get; set; } = "reserved";
    public string? Detail { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class GatewayPptCompletionStageBudgetRecord
{
    public int MaxPhysicalCalls { get; set; }
    public int UsedPhysicalCalls { get; set; }
    public long MaxBodyUtf8Bytes { get; set; }
    public int MaxOutputTokens { get; set; }
    [BsonRepresentation(BsonType.Decimal128)] public decimal PerCallUpperUsd { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class GatewayPptCompletionBudgetRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string ContractHash { get; set; } = string.Empty;
    public string CandidateCommit { get; set; } = string.Empty;
    public string RootOutlineRunId { get; set; } = string.Empty;
    public string StableSourceHash { get; set; } = string.Empty;
    public string GenerationRunId { get; set; } = string.Empty;
    public string ManualRunId { get; set; } = string.Empty;
    /// <summary>完成态父稿正文哈希；与产物包哈希分别校验，禁止混用。</summary>
    public string ParentArtifactHash { get; set; } = string.Empty;
    /// <summary>完成态父稿的受信工作区产物包哈希。</summary>
    public string ParentPackageHash { get; set; } = string.Empty;
    public string Status { get; set; } = GatewayPptCompletionStatuses.Pending;
    [BsonRepresentation(BsonType.Decimal128)] public decimal FutureHeldUsd { get; set; }
    public GatewayPptCompletionStageBudgetRecord GenerationAndRepairs { get; set; } = new();
    public GatewayPptCompletionStageBudgetRecord ManualSave { get; set; } = new();
    [BsonRepresentation(BsonType.Decimal128)] public decimal TailHeldUsd { get; set; }
    public DateTime ExpiresAt { get; set; }
}

public static class GatewayPptCompletionStatuses
{
    public const string Pending = "pending";
    public const string GenerationActive = "generation-active";
    public const string GenerationRepairable = "generation-repairable";
    public const string GenerationComplete = "generation-complete";
    public const string ManualActive = "manual-active";
    public const string ManualFailed = "manual-failed";
    public const string Completed = "completed";
    public const string Closed = "closed";
}

public static class GatewayPptCompletionPhases
{
    public const string Generation = "generation";
    public const string ManualSave = "manual-save";
}

/// <summary>API 与 serving 共用的纯金额合同，不引入 API 对 serving host 的反向依赖。</summary>
public static class GatewayPptCompletionBudgetMath
{
    public const long ProtocolEnvelopeTokens = 4_096L;

    public static decimal PerCallUpper(
        GatewayRuntimeBudgetScopeRecord scope,
        long maxBodyUtf8Bytes,
        int maxOutputTokens)
    {
        var inputUpper = checked(maxBodyUtf8Bytes * scope.InputByteTokenMultiplier + ProtocolEnvelopeTokens);
        var longContext = inputUpper > scope.LongContextThresholdTokens;
        var inputRate = longContext ? scope.LongContextInputUsdPerMillion : scope.InputUsdPerMillion;
        var outputRate = longContext ? scope.LongContextOutputUsdPerMillion : scope.OutputUsdPerMillion;
        return Money(inputUpper, inputRate) + Money(maxOutputTokens, outputRate);
    }

    public static decimal FullEnvelope(
        GatewayPptCompletionStageBudgetRecord generation,
        GatewayPptCompletionStageBudgetRecord manual,
        decimal tailHeldUsd)
        => checked(generation.MaxPhysicalCalls * generation.PerCallUpperUsd
                   + manual.MaxPhysicalCalls * manual.PerCallUpperUsd
                   + tailHeldUsd);

    public static decimal Money(long tokens, decimal ratePerMillion)
        => decimal.Round(tokens * ratePerMillion / 1_000_000m, 9, MidpointRounding.AwayFromZero);
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
