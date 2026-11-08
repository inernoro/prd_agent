using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.LlmGateway;

public static class TaskExecutionOrigins
{
    public const string Interactive = "interactive";
    public const string Agent = "agent";
    public const string Scheduled = "scheduled";
    public static bool IsKnown(string? value) => value is Interactive or Agent or Scheduled;
}

/// <summary>
/// 一次已授权任务的服务端事实。内部 M2M key 只标识传输方，本记录决定是否能产生付费调用。
/// 次数预算跨实例共享，不代表美元额度或最终费用。Id 不提供给业务请求输入。
/// </summary>
[BsonIgnoreExtraElements]
public sealed class GatewayTaskPermitRecord
{
    public const int MaximumCalls = 256;
    public const int MaximumRuns = 16;
    public static readonly TimeSpan MaximumLifetime = TimeSpan.FromHours(24);
    public const string CollectionName = "llmgw_task_permits";
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public int ExecutionContractVersion { get; set; }
    public string? BusinessKeyHash { get; set; }
    public string? RequestFingerprint { get; set; }
    public string? AdmissionOwnerHash { get; set; }
    public long ActorAuthorizationVersion { get; set; }
    public long CredentialAuthorizationVersion { get; set; }
    public List<TaskExecutionLeaseRecord> Executions { get; set; } = new();
    public int? AcceptedResponseStatus { get; set; }
    public string? AcceptedResponseContentType { get; set; }
    public string? AcceptedResponseBody { get; set; }
    public string TenantId { get; set; } = string.Empty;
    public string ActorUserId { get; set; } = string.Empty;
    public List<string> SubjectUserIds { get; set; } = new();
    public bool AllowDelegatedSubjects { get; set; }
    public string TriggerCredentialId { get; set; } = string.Empty;
    public string Origin { get; set; } = string.Empty;
    public string SourceDeployment { get; set; } = string.Empty;
    public string SourceTask { get; set; } = string.Empty;
    public List<string> AllowedAppCallerCodes { get; set; } = new();
    public List<string> BoundRunIds { get; set; } = new();
    public int MaxRuns { get; set; } = 1;
    public int MaxCalls { get; set; }
    public int CallCount { get; set; }
    /// <summary>平台签发时冻结的通用金额合同，不接受业务请求自报或替换。</summary>
    public string? BudgetScopeId { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}

/// <summary>嵌入父任务的有界执行账本；主键、额度、撤销与租约在同一 Mongo 文档上原子裁决。</summary>
[BsonIgnoreExtraElements]
public sealed class TaskExecutionLeaseRecord
{
    public string RunId { get; set; } = string.Empty;
    public string State { get; set; } = TaskExecutionLeaseStates.Pending;
    public string OwnerHash { get; set; } = string.Empty;
    public long Fence { get; set; }
    public DateTime LeaseUntil { get; set; }
    public DateTime? FinishedAt { get; set; }
    public int DispatchCount { get; set; }
}

public static class TaskExecutionLeaseStates
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Cancelled = "cancelled";
    public const string OutcomeUnknown = "outcome-unknown";
}

[BsonIgnoreExtraElements]
public sealed class TaskAuthorizationRevocationRecord
{
    public const string CollectionName = "llmgw_task_authorizations";
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public long Version { get; set; }
    public bool Disabled { get; set; }
    public DateTime ChangedAt { get; set; }
}
