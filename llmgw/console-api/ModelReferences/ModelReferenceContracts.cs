using MongoDB.Bson;

namespace PrdAgent.LlmGw.ModelReferences;

public sealed class ReferenceIdentity
{
    public bool HasCatalogSnapshot { get; set; }
    public string? ModelType { get; set; }
    public List<string> Capabilities { get; set; } = [];
    public List<string> AllowedAppCallerCodes { get; set; } = [];
    public string? LogicalId { get; set; }
    public string? PublicId { get; set; }
    public List<string> Aliases { get; set; } = [];
    public List<string> PoolIds { get; set; } = [];
    public string? ProviderId { get; set; }
    public string? PhysicalModelId { get; set; }
    public string? UpstreamModelId { get; set; }
    public string? OfferingId { get; set; }
    public string? OfferingFingerprint { get; set; }
}
public sealed class ReferenceMigrationMapping
{
    public string TenantId { get; set; } = "";
    public string? ModelType { get; set; }
    public string? ScopeConsumerKey { get; set; }
    public string? ScopeRecordId { get; set; }
    public string? ScopePath { get; set; }
    public ReferenceIdentity Source { get; set; } = new();
    public ReferenceIdentity Target { get; set; } = new();
}
public sealed class ReferenceConsumerResult
{
    public string Key { get; set; } = "";
    public int Count { get; set; }
    public int Affected { get; set; }
    public int Migrated { get; set; }
    public int Blocked { get; set; }
    public int Unknown { get; set; }
    public int Residual { get; set; }
    public int Excluded { get; set; }
    public List<string> Reasons { get; set; } = [];
}
public sealed class ReferenceFinding
{
    public string ConsumerKey { get; set; } = "";
    public string Collection { get; set; } = "";
    public string RecordId { get; set; } = "";
    public string? OwnerId { get; set; }
    public string Path { get; set; } = "";
    public string Status { get; set; } = "affected";
    public string? Reason { get; set; }
}
public sealed class ReferenceCoverage
{
    public string RegistryVersion { get; set; } = ModelReferenceRegistry.Version;
    public string RegistryHash { get; set; } = ModelReferenceRegistry.Hash;
    public bool CanComplete => Blocked == 0 && Unknown == 0;
    public int Affected => Consumers.Sum(x => x.Affected);
    public int Migrated { get; set; }
    public bool Verified { get; set; }
    public DateTime? VerifiedAt { get; set; }
    public DateTime? ValidUntil { get; set; }
    public int Blocked => Consumers.Sum(x => x.Blocked);
    public int Unknown => Consumers.Sum(x => x.Unknown);
    public int Residual => Consumers.Sum(x => x.Residual);
    public List<ReferenceConsumerResult> Consumers { get; set; } = [];
    public List<ReferenceFinding> Items { get; set; } = [];
}
public sealed class ReferenceFieldChange
{
    public string Path { get; set; } = "";
    public bool Existed { get; set; }
    public BsonValue Before { get; set; } = BsonNull.Value;
    public BsonValue After { get; set; } = BsonNull.Value;
}
public sealed class ReferenceDocumentChange
{
    public string ConsumerKey { get; set; } = "";
    public string Database { get; set; } = "map";
    public string Collection { get; set; } = "";
    public string RecordId { get; set; } = "";
    public List<ReferenceFieldChange> Fields { get; set; } = [];
    // Only safe identity/owner/revision fields, never complete configuration documents.
    public List<ReferenceFieldChange> Conditions { get; set; } = [];
    public Dictionary<string, int> ArrayLengths { get; set; } = new();
    public string Status { get; set; } = "pending";
}
public sealed class ReferenceMigrationPlan
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string IntentId => Id;
    public long Revision { get; set; } = 1;
    public string TenantId { get; set; } = "";
    public string ActorId { get; set; } = "";
    public string? ClientRequestId { get; set; }
    public ReferenceMigrationMapping Mapping { get; set; } = new();
    public ReferenceCoverage Coverage { get; set; } = new();
    public List<ReferenceDocumentChange> Changes { get; set; } = [];
    public List<ReferenceFinding> AffectedFindings { get; set; } = [];
    public string Status { get; set; } = "planned";
    public string? LeaseToken { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
public sealed record ReferenceSnapshotEntry(string ConsumerKey, string Path, string IdentityKind,
    string Value, string? ProviderId = null, string? Reason = null);
public sealed record RuntimeModelReferenceSnapshot(bool Complete, IReadOnlyList<ReferenceSnapshotEntry> Items);
public interface IRuntimeModelReferenceSnapshotProvider
{
    Task<RuntimeModelReferenceSnapshot> ReadAsync(ReferenceMigrationMapping mapping, CancellationToken ct);
}
// Caller must reuse authoritative tenant + appCaller + capability validation before any write.
public interface IModelReferenceTargetValidator
{
    Task<IReadOnlyList<string>> ValidateAsync(ReferenceMigrationMapping mapping, IReadOnlyList<string> consumerKeys, CancellationToken ct);
    Task<IReadOnlyList<string>> ValidateFindingsAsync(ReferenceMigrationMapping mapping, IReadOnlyList<ReferenceFinding> findings, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<string>>(["目标校验尚未接入逐引用路径与用途，请先完成能力授权核对。"]);
}
public interface IModelReferenceStore
{
    Task<IReadOnlyList<BsonDocument>> ReadAsync(ReferenceCollection definition, string tenantId, CancellationToken ct);
    // Names/types only, server-side projection. A failed inventory is a coverage blocker.
    Task<IReadOnlyList<string>> SelectionPathsAsync(ReferenceCollection definition, string tenantId, CancellationToken ct);
    Task<bool> CompareAndSwapAsync(ReferenceDocumentChange change, string tenantId, CancellationToken ct);
    Task<bool> IsAppliedAsync(ReferenceDocumentChange change, string tenantId, CancellationToken ct);
    Task InsertPlanAsync(ReferenceMigrationPlan plan, CancellationToken ct);
    Task<ReferenceMigrationPlan?> ReadPlanAsync(string intentId, string tenantId, CancellationToken ct);
    Task<bool> SavePlanAsync(ReferenceMigrationPlan plan, long expectedRevision, CancellationToken ct);
}
public sealed class ModelReferenceException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
