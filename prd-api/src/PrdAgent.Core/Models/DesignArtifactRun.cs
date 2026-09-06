namespace PrdAgent.Core.Models;

/// <summary>
/// 跨网页托管、知识库与 HTML PPT 的统一设计任务。
/// 事件流保存在 Redis；此记录保存可恢复、可审计的业务事实与知识快照。
/// </summary>
public class DesignArtifactRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string UserId { get; set; } = string.Empty;

    public string Status { get; set; } = RunStatuses.Queued;

    public string ArtifactType { get; set; } = DesignArtifactTypes.WebPage;

    public string Operation { get; set; } = DesignArtifactOperations.Generate;

    public string SourceSurface { get; set; } = DesignArtifactSourceSurfaces.WebHosting;

    public string Runtime { get; set; } = DesignArtifactRuntimes.MapGateway;

    /// <summary>
    /// 远程执行器在能力探针通过时冻结的 CDS 连接。Worker 只能使用该连接，
    /// 禁止按更新时间重新选择另一个基础设施目标。
    /// </summary>
    public string? RuntimeConnectionId { get; set; }

    public string Instruction { get; set; } = string.Empty;

    public string? Title { get; set; }

    public string? TargetSiteId { get; set; }

    public string? ArtifactSiteId { get; set; }

    public string? ArtifactRevisionId { get; set; }

    public string? LinkedRunId { get; set; }

    public int Progress { get; set; }

    public string Phase { get; set; } = "任务已进入队列";

    public string? Error { get; set; }

    /// <summary>当前执行尝试的租约所有者。每次认领使用唯一值，作为所有写入的 fencing token。</summary>
    public string? LeaseOwnerId { get; set; }

    /// <summary>执行租约到期时间。活跃 worker 必须周期续租；过期任务由恢复器终结。</summary>
    public DateTime? LeaseExpiresAt { get; set; }

    /// <summary>最近一次成功续租时间，用于区分活跃实例与已经退出的实例。</summary>
    public DateTime? HeartbeatAt { get; set; }

    /// <summary>排队任务最近一次被恢复器补投队列的时间，限制多实例重复补投频率。</summary>
    public DateTime? RecoveryEnqueuedAt { get; set; }

    /// <summary>异常终结的 committing 任务是否仍需按 Run 来源清理未发布产物。</summary>
    public bool CleanupPending { get; set; }

    /// <summary>最近一次产物补偿尝试时间，用于诊断与恢复器重试。</summary>
    public DateTime? CleanupAttemptedAt { get; set; }

    /// <summary>最近一次产物补偿失败原因；成功后清空。</summary>
    public string? CleanupLastError { get; set; }

    /// <summary>生成站点补偿已确认的站点 ID；与对象 key 一起先于站点账本删除持久化。</summary>
    public string? CleanupArtifactSiteId { get; set; }

    /// <summary>生成站点补偿待删除的对象 key。站点账本删除后进程退出时，恢复器据此继续清理。</summary>
    public List<string> CleanupAssetKeys { get; set; } = new();

    /// <summary>持久化清理计划对应的站点账本是否已通过采用围栏删除。</summary>
    public bool CleanupSiteRecordDeleted { get; set; }

    /// <summary>跨实例清理租约，避免两个恢复器同时改写同一持久化清理计划。</summary>
    public string? CleanupLeaseOwnerId { get; set; }

    public DateTime? CleanupLeaseExpiresAt { get; set; }

    public List<DesignKnowledgeSnapshot> KnowledgeReferences { get; set; } = new();

    /// <summary>OpenDesign 工作区输入包的对象存储物理 key。只由 MAP 与 CDS 控制面读取。</summary>
    public string? WorkspaceInputAssetKey { get; set; }

    public string? WorkspaceInputSha256 { get; set; }

    /// <summary>输入快照的不可变版本。结果提交必须原样带回，防止旧任务覆盖新输入。</summary>
    public string? WorkspaceBaseRevision { get; set; }

    /// <summary>CDS 原子提交的结果包对象存储物理 key。</summary>
    public string? WorkspaceResultAssetKey { get; set; }

    public string? WorkspaceResultSha256 { get; set; }

    /// <summary>结果上传开始前持久化的精确物理 key；恢复器据此覆盖 SaveAsync 成功但终态 CAS 尚未发生的崩溃窗口。</summary>
    public string? WorkspacePendingResultAssetKey { get; set; }

    /// <summary>本次结果写入 attempt 的唯一围栏，防止旧请求清理新请求或同内容获胜对象。</summary>
    public string? WorkspacePendingResultAttemptId { get; set; }

    /// <summary>结果对象写入状态：writing、stored 或 save-failed。</summary>
    public string? WorkspacePendingResultWriteState { get; set; }

    /// <summary>开始写入时的进程代际；同代恢复器不得接管仍处于 writing 的对象。</summary>
    public string? WorkspacePendingResultProcessEpoch { get; set; }

    public DateTime? WorkspacePendingResultStartedAt { get; set; }

    public string? WorkspacePendingResultWriteError { get; set; }

    /// <summary>结果写入后终态 CAS 失败时的待回收对象 key；先持久化再删除，避免进程中断后失去恢复线索。</summary>
    public string? WorkspaceRejectedResultAssetKey { get; set; }

    public DateTime? WorkspaceRejectedResultCleanupAttemptedAt { get; set; }

    public string? WorkspaceRejectedResultCleanupError { get; set; }

    /// <summary>本次远程运行已通过 MAP 代理进入 LLMGW 的真实请求数。</summary>
    public int RuntimeModelCallCount { get; set; }

    public int RuntimeModelCallLimit { get; set; } = 72;

    public DateTime? RuntimeTicketExpiresAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? CompletedAt { get; set; }
}

public class DesignKnowledgeSnapshot
{
    public string EntryId { get; set; } = string.Empty;

    public string? StoreId { get; set; }

    public string? StoreName { get; set; }

    public string Title { get; set; } = string.Empty;

    public string Content { get; set; } = string.Empty;

    public string ContentHash { get; set; } = string.Empty;
}

public static class DesignArtifactTypes
{
    public const string WebPage = "web-page";
    public const string HtmlPpt = "html-ppt";
}

public static class DesignArtifactOperations
{
    public const string Generate = "generate";
    public const string Edit = "edit";
}

public static class DesignArtifactSourceSurfaces
{
    public const string WebHosting = "web-hosting";
    public const string KnowledgeBase = "knowledge-base";
    public const string HtmlPpt = "html-ppt";
}

public static class DesignArtifactRuntimes
{
    public const string MapGateway = "map-gateway";
    public const string OpenDesign = "open-design";
    public const string Codex = "codex";
    public const string Claude = "claude";
    public const string HtmlPptPipeline = "html-ppt-pipeline";
}

public static class DesignWorkspaceResultWriteStates
{
    public const string Writing = "writing";
    public const string Stored = "stored";
    public const string SaveFailed = "save-failed";
}
