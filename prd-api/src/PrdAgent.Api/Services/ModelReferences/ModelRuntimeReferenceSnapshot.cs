namespace PrdAgent.Api.Services.ModelReferences;

/// <summary>单个实际 MAP 进程的型号引用清单；只包含身份元数据，不接收任意配置对象。</summary>
public sealed class ModelRuntimeReferenceSnapshot
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public int SchemaVersion { get; set; } = 1;
    public string TenantId { get; set; } = string.Empty;
    public string DeploymentIdentity { get; set; } = string.Empty;
    public string? DeploymentScope { get; set; }
    public string? DurableScope { get; set; }
    public string? ActualCommit { get; set; }
    public string InstanceId { get; set; } = string.Empty;
    public DateTime HeartbeatAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public string LegacyFallbackAuthority { get; set; } = string.Empty;
    public List<string> ExpectedConsumerKeys { get; set; } = [];
    public List<ModelRuntimeReferenceEntry> Entries { get; set; } = [];
}

public sealed class ModelRuntimeReferenceEntry
{
    public string ConsumerKey { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string IdentityKind { get; set; } = string.Empty;
    public string? Value { get; set; }
    public string? PlatformId { get; set; }
    public string State { get; set; } = "unknown";
}

public sealed record ModelRuntimeSnapshotIdentity(
    string TenantId, string DeploymentIdentity, string? DeploymentScope,
    string? DurableScope, string? ActualCommit, string InstanceId);

public sealed record ModelRuntimeStoredSelection(string? Model, string? PlatformId = null);

public sealed record ModelRuntimeDatabaseReferences(
    bool Complete, IReadOnlyList<ModelRuntimeStoredSelection> MainModels,
    IReadOnlyList<ModelRuntimeStoredSelection> ActiveConfigs);
