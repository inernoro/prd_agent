namespace PrdAgent.Core.Models;

/// <summary>Run 创建时的非秘密请求快照；可空项未声明时沿用执行器既有行为。</summary>
public sealed class DesignArtifactLlmRequestPolicy
{
    public int Version { get; set; } = 1;
    public string? Model { get; set; }
    public string? ModelPoolId { get; set; }
    public string? PinnedPlatformId { get; set; }
    public string? PinnedModelId { get; set; }
    public double? Temperature { get; set; }
    public double? TopP { get; set; }
    public string? ReasoningMode { get; set; }
    public string? ReasoningEffort { get; set; }
    /// <summary>仅显式 omit 省略执行器输出 Token 上限；null 保留既有请求，不与 strict 隐式联动。</summary>
    public string? OutputTokenMode { get; set; }
    public bool RequireDeclaredParameters { get; set; }
}

/// <summary>
/// HTML PPT 任务开始时冻结的内容合同。正文与确认大纲由 MAP 确定性写入，OpenDesign 只负责
/// 设计、实现与质量修复；重连和重启不得重新解析浏览器里的临时状态。
/// </summary>
public sealed class DesignArtifactPresentationInput
{
    public int Version { get; set; } = 2;
    public int TargetPages { get; set; }
    public string SourceContent { get; set; } = string.Empty;
    public string SourceContentHash { get; set; } = string.Empty;
    public string OutlineJson { get; set; } = string.Empty;
    public string OutlineHash { get; set; } = string.Empty;
    /// <summary>服务端冻结的资料块、页绑定与有限用户编辑覆盖；不是提示词，也不从普通 Content 猜测来源。</summary>
    public string? SourcePlanJson { get; set; }
    public string? SourcePlanHash { get; set; }
    public string Theme { get; set; } = string.Empty;
    public string? ParentRunId { get; set; }
    public string? ParentPackageHash { get; set; }
    /// <summary>用户在隔离编辑器里形成的非可信 HTML 提案；只能作为 OpenDesign edit 输入，不能直接发布。</summary>
    public string? ManualEditHtml { get; set; }
    public string? ManualEditHtmlHash { get; set; }

    /// <summary>
    /// 质量失败任务最后一份经服务器接收的只读候选。它只允许在 presentation-only restart 中作为
    /// OpenDesign 的非最终起点；不能充当父稿、成功产物、发布版本或手动编辑提案。
    /// </summary>
    public string? RepairCandidateHtml { get; set; }
    public string? RepairCandidateHtmlHash { get; set; }
}

/// <summary>
/// 隔离浏览器质量证据的有界摘要。逐视口测量与截图保存在受信产物包，Run 只保存可聚合指标和引用，
/// 不复制 HTML、模型正文或隐式推理。
/// </summary>
public sealed class DesignArtifactBrowserQualitySummary
{
    public string SchemaVersion { get; set; } = string.Empty;
    public string RuleVersion { get; set; } = string.Empty;
    public string HeuristicVersion { get; set; } = string.Empty;
    public bool FirstPassPassed { get; set; }
    public int RepairAttempts { get; set; }
    public bool RepairSucceeded { get; set; }
    public bool FinalHardPassed { get; set; }
    public double FinalScore { get; set; }
    public List<string> Viewports { get; set; } = new();
    public string EvidenceRef { get; set; } = string.Empty;
}

/// <summary>
/// 跨网页托管、知识库与 HTML PPT 的统一设计任务。
/// v2 权威生命周期事件与状态保存在同一 Mongo 文档；Redis 仅服务历史流程和兼容投影。
/// </summary>
[MongoDB.Bson.Serialization.Attributes.BsonIgnoreExtraElements]
public class DesignArtifactRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>创建时冻结的项目、分支和 revision 执行范围。历史读取不补写，缺失保留 null。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? DeploymentSlug { get; set; }

    public string UserId { get; set; } = string.Empty;

    public string Status { get; set; } = RunStatuses.Queued;

    public string ArtifactType { get; set; } = DesignArtifactTypes.WebPage;

    public string Operation { get; set; } = DesignArtifactOperations.Generate;

    public string SourceSurface { get; set; } = DesignArtifactSourceSurfaces.WebHosting;

    public string Runtime { get; set; } = DesignArtifactRuntimes.MapGateway;

    /// <summary>
    /// 发起这次生成时选中的目标团队空间，在**请求那一刻**就冻结下来。
    ///
    /// 之前这件事只活在浏览器的完成回调里：用户在终态事件到达前关掉页面或切走，
    /// 服务端照样把站点生成完，但它会留在个人空间；换个标签页恢复也重建不出原来的目标，
    /// 回调还可能读到「现在选中的分组」而不是「发起时的分组」。归属是发起时的意图，
    /// 属于服务端该记住的事。个人空间为 null。
    /// </summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? DestinationTeamId { get; set; }

    /// <summary>
    /// 应用目标空间时的失败原因（例如期间被移出团队）。站点已经建好了，所以不让它失败整轮，
    /// 但也不许静默——前端拿到它就按「已生成，但归属团队失败」提示，与浏览器还在时的行为一致。
    /// </summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? DestinationApplyError { get; set; }

    /// <summary>本次实际执行的模型名（来自网关 Start 分片）。ai-model-visibility §4 要求报告实体落这个字段。</summary>
    public string? ResolvedModel { get; set; }

    /// <summary>本次实际执行的平台名。与 ResolvedModel 同源，前端顶部按「{模型} · {平台}」展示。</summary>
    public string? ResolvedPlatform { get; set; }

    /// <summary>缺失仅代表旧任务，执行/读取不得回填或伪造历史冻结值。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactLlmRequestPolicy? LlmRequestPolicy { get; set; }

    /// <summary>公共生命周期合同版本。存量 Run 缺失时只按只读 v1 兼容，不宣称 manifest 完整。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public int? ContractVersion { get; set; }

    /// <summary>公共生命周期 CAS 版本；只有 lifecycle service 可以推进。</summary>
    public int LifecycleVersion { get; set; }

    /// <summary>Mongo 权威事件序号；与公开 SSE id 使用同一数值。</summary>
    public long LifecycleEventSequence { get; set; }

    /// <summary>长期保留的脱敏生命周期事件；不存模型正文或任意 payload。</summary>
    public List<DesignArtifactEventEnvelope> LifecycleEvents { get; set; } = new();

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactWorkspaceRef? WorkspaceRef { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactCapabilitySnapshot? Capability { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactVersionBoundary? VersionBoundary { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactContractManifest? Manifest { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactManifestValidationReceipt? ManifestValidation { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactPlanReceipt? PlanReceipt { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? ParentPlanRunId { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? ParentPlanContentHash { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? PublishBindingOperationId { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? PublishBindingFingerprint { get; set; }

    /// <summary>公共生命周期只保存稳定失败码，不保存 provider 异常或请求正文。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? LifecycleFailureCode { get; set; }

    /// <summary>
    /// 远端执行器经过白名单收敛的失败事实。旧任务缺失时保持 null；不得放入原始诊断或页面正文。
    /// </summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactRuntimeFailure? RuntimeFailure { get; set; }

    /// <summary>
    /// 远程执行器在能力探针通过时冻结的 CDS 连接。Worker 只能使用该连接，
    /// 禁止按更新时间重新选择另一个基础设施目标。
    /// </summary>
    public string? RuntimeConnectionId { get; set; }

    public string Instruction { get; set; } = string.Empty;

    /// <summary>
    /// 输入信任边界。用户要求始终是 user-supplied；存在知识快照时为
    /// mixed-user-and-server-knowledge，不能把整份输入误标成知识库权威正文。
    /// </summary>
    public string InputAuthority { get; set; } = DesignArtifactInputAuthorities.UserSupplied;

    /// <summary>用户提供内容的 SHA-256，仅用于审计分区，不把用户正文冒充为知识来源。</summary>
    public string? UserSuppliedContentHash { get; set; }

    public string? Title { get; set; }

    /// <summary>HTML PPT 专用冻结输入；网页任务和历史任务保持 null。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactPresentationInput? PresentationInput { get; set; }

    /// <summary>
    /// 服务端认领过的 PPT 任务预算身份。仅受信 grant 服务写入；一旦存在，父链或来源追溯失败
    /// 也必须拒绝发送，不能静默退回无保护的普通 grant。
    /// </summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? RuntimeBudgetScopeId { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? PptCompletionId { get; set; }

    public string? TargetSiteId { get; set; }

    public string? ArtifactSiteId { get; set; }

    public string? ArtifactRevisionId { get; set; }

    /// <summary>已持久化但尚未发布绑定的站点；编辑任务在草稿完成后写入。</summary>
    public string? ProducedArtifactSiteId { get; set; }

    /// <summary>已持久化的草稿或基线版本；不等同于 published 生命周期绑定。</summary>
    public string? ProducedArtifactRevisionId { get; set; }

    public string? LinkedRunId { get; set; }

    /// <summary>服务重启后从哪条历史 Run 的冻结输入重开；历史 Run 本身不改写。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? RestartedFromRunId { get; set; }

    /// <summary>重开幂等键的 SHA-256，不保存客户端原值。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? RestartIdempotencyKeyHash { get; set; }

    public int Progress { get; set; }

    /// <summary>有限、稳定的用户可见阶段码；不保存执行器命令、路径或工具参数。</summary>
    public string PhaseCode { get; set; } = DesignArtifactPhaseCodes.Queued;

    public string Phase { get; set; } = "任务已进入队列";

    /// <summary>任务创建后第一次向用户提供可见状态的时间。</summary>
    public DateTime? FirstVisibleFeedbackAt { get; set; }

    /// <summary>第一个经过工作区凭证校验的真实页面预览时间。</summary>
    public DateTime? FirstPreviewAt { get; set; }

    /// <summary>
    /// 最近一次经过工作区票据和 1 MiB 上限校验的真实页面预览。
    /// 绑定在所属 Run 上，供终态失败后重新打开工作台恢复最后成果；不进入生命周期事件或错误详情。
    /// </summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? LatestPreviewHtml { get; set; }

    /// <summary>LatestPreviewHtml 对应的执行器单调 revision；旧任务缺失时保持 null。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public int? LatestPreviewRevision { get; set; }

    /// <summary>最近一次有效阶段或预览更新时间，用于计算最大静止间隔。</summary>
    public DateTime? LastProgressAt { get; set; }

    /// <summary>相邻服务端权威进度时间点之间的最大秒数；旧任务缺失时不回填、不冒充零等待。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public double? MaxStaticGapSeconds { get; set; }

    /// <summary>带游标重新建立任务事件流的次数；首连 afterSeq=0 不计入。</summary>
    public int StreamReconnectCount { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DateTime? LastStreamReconnectAt { get; set; }

    /// <summary>最终产物的浏览器质量摘要；旧任务缺失时只读兼容，不回填。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactBrowserQualitySummary? BrowserQuality { get; set; }

    public string? Error { get; set; }

    /// <summary>
    /// 用户通过显式取消 API 提交的服务器权威取消意图。浏览器断开、SSE 中止或 Worker 停机
    /// 都不得写入此字段。
    /// </summary>
    public DateTime? CancelRequestedAt { get; set; }

    /// <summary>提交取消意图的用户；当前仅允许任务所有者取消。</summary>
    public string? CancelRequestedByUserId { get; set; }

    /// <summary>任务真正进入 Cancelled 终态的时间，与请求时间分开记录。</summary>
    public DateTime? CancelledAt { get; set; }

    /// <summary>当前执行尝试的租约所有者。每次认领使用唯一值，作为所有写入的 fencing token。</summary>
    public string? LeaseOwnerId { get; set; }

    /// <summary>执行租约到期时间。活跃 worker 必须周期续租；过期任务由恢复器终结。</summary>
    public DateTime? LeaseExpiresAt { get; set; }

    /// <summary>最近一次成功续租时间，用于区分活跃实例与已经退出的实例。</summary>
    public DateTime? HeartbeatAt { get; set; }

    /// <summary>排队任务最近一次被恢复器补投队列的时间，限制多实例重复补投频率。</summary>
    public DateTime? RecoveryEnqueuedAt { get; set; }

    /// <summary>
    /// 分支重新部署后，本版本从上一版 revision 接管这条无人执行任务的时间。
    /// 中断原因从这里读，不靠某一轮恢复的内存状态，接管与终结分在两轮也不会把原因丢成「服务重启」。
    /// </summary>
    public DateTime? RetiredRevisionAdoptedAt { get; set; }

    /// <summary>
    /// 上一版 revision 留下的任务被判为「结果已写成托管版本」、不予接管的时间。
    /// 记下后接管判据不再选中它，免得这类行每轮占满恢复批次。
    /// </summary>
    public DateTime? RetiredRevisionSkippedAt { get; set; }

    /// <summary>异常终结的 committing 任务是否仍需按 Run 来源清理未发布产物。</summary>
    public bool CleanupPending { get; set; }

    /// <summary>最近一次产物补偿尝试时间，用于诊断与恢复器重试。</summary>
    public DateTime? CleanupAttemptedAt { get; set; }

    /// <summary>最近一次产物补偿失败原因；成功后清空。</summary>
    public string? CleanupLastError { get; set; }

    /// <summary>生成站点补偿已确认的站点 ID；与对象 key 一起先于站点账本删除持久化。</summary>
    public string? CleanupArtifactSiteId { get; set; }

    /// <summary>当前多资产发布尝试的唯一 fencing token；恢复清理取得所有权时清空。</summary>
    public string? CleanupPublishAttemptId { get; set; }

    /// <summary>生成站点补偿待删除的对象 key。站点账本删除后进程退出时，恢复器据此继续清理。</summary>
    public List<string> CleanupAssetKeys { get; set; } = new();

    /// <summary>持久化清理计划对应的站点账本是否已通过采用围栏删除。</summary>
    public bool CleanupSiteRecordDeleted { get; set; }

    /// <summary>真正进入补偿清理的持久标记；不能用上传预写账本的 CleanupPending 代替。</summary>
    public DateTime? CleanupStartedAt { get; set; }

    /// <summary>跨实例清理租约，避免两个恢复器同时改写同一持久化清理计划。</summary>
    public string? CleanupLeaseOwnerId { get; set; }

    public DateTime? CleanupLeaseExpiresAt { get; set; }

    public List<DesignKnowledgeSnapshot> KnowledgeReferences { get; set; } = new();

    // Older readers ignore extra Run fields, but not fields inside KnowledgeReferences[].
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    [System.Text.Json.Serialization.JsonIgnore]
    public DesignKnowledgeOriginalSnapshot? KnowledgeOriginals { get; set; }

    /// <summary>创建时冻结的风格与提示词。缺失 = 改动前的旧运行，执行器按内置默认处理。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactDesignDirection? DesignDirection { get; set; }

    /// <summary>任务开始时确定性形成并冻结的设计简报。旧运行缺失时只读兼容，不补写。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactDesignBrief? DesignBrief { get; set; }

    /// <summary>由既有设计方向、个人风格、资料与附件映射出的品牌包；不复制 OpenDesign 设计系统。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactBrandPackage? BrandPackage { get; set; }

    /// <summary>冻结设计上下文的可追溯来源；旧运行缺失时只读兼容，不回填。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DesignArtifactContextProvenance? DesignContextProvenance { get; set; }

    /// <summary>直接上传的文档（事实来源，与知识库引用并列；不写进站点的知识来源记录）。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public List<DesignUploadedSource>? UploadedSources { get; set; }

    /// <summary>修改时附上的截图（视觉参考，不是事实来源）。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public List<DesignReferenceImage>? ReferenceImages { get; set; }

    /// <summary>OpenDesign 工作区输入包的对象存储物理 key。只由 MAP 与 CDS 控制面读取。</summary>
    public string? WorkspaceInputAssetKey { get; set; }

    public string? WorkspaceInputSha256 { get; set; }

    /// <summary>输入快照的不可变版本。结果提交必须原样带回，防止旧任务覆盖新输入。</summary>
    public string? WorkspaceBaseRevision { get; set; }

    /// <summary>CDS 原子提交的结果包对象存储物理 key。</summary>
    public string? WorkspaceResultAssetKey { get; set; }

    public string? WorkspaceResultSha256 { get; set; }

    /// <summary>
    /// 已通过结果契约校验的 manifest.json 内容哈希。结果尚处于 pending 时也会保留，
    /// 但是否已经原子提交必须以 WorkspaceResultAssetKey 为准。
    /// </summary>
    public string? WorkspaceManifestSha256 { get; set; }

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

    public DateTime? RuntimeTicketExpiresAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? CompletedAt { get; set; }

    /// <summary>
    /// 生成站点发布动态已完成幂等投影的时间。为空时恢复器补记；编辑草稿与失败任务始终为空。
    /// </summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DateTime? PublishedActivityRecordedAt { get; set; }

    /// <summary>发布动态投影已进入 recorded/skipped 终态的时间；用于让坏候选永久退出恢复队列。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public DateTime? PublishedActivityProjectionCompletedAt { get; set; }

    /// <summary>recorded | skipped；仅保存有界投影结果，不保存异常正文。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? PublishedActivityProjectionOutcome { get; set; }

    /// <summary>投影终态稳定原因码，例如 site_missing_or_mismatch。</summary>
    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public string? PublishedActivityProjectionCode { get; set; }
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

public sealed class DesignKnowledgeOriginalSnapshot
{
    public int Version { get; set; } = 1;
    public List<DesignKnowledgeOriginalBinding> References { get; set; } = new();
}

public sealed class DesignKnowledgeOriginalBinding
{
    public string EntryId { get; set; } = string.Empty;
    public string StoreId { get; set; } = string.Empty;
    // null means a verified document-only source, not an unfrozen legacy Run.
    public DesignKnowledgeOriginalFile? File { get; set; }
}

public sealed class DesignKnowledgeOriginalFile
{
    public string AttachmentId { get; set; } = string.Empty;
    public string FileName { get; set; } = string.Empty;
    public string MimeType { get; set; } = string.Empty;
    public long Size { get; set; }
    public string Sha256 { get; set; } = string.Empty;

    /// <summary>仅内部持久化；禁止投影到客户端或远程工作区。</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public string StorageKey { get; set; } = string.Empty;
}

public static class DesignArtifactTypes
{
    public const string WebPage = "web-page";
    public const string HtmlPpt = "html-ppt";
}

public static class DesignArtifactOperations
{
    public const string Plan = "plan";
    public const string Generate = "generate";
    public const string Edit = "edit";
}

public static class DesignArtifactSourceSurfaces
{
    public const string WebHosting = "web-hosting";
    public const string KnowledgeBase = "knowledge-base";
    public const string HtmlPpt = "html-ppt";
}

public static class DesignArtifactInputAuthorities
{
    public const string UserSupplied = "user-supplied";
    public const string MixedUserAndServerKnowledge = "mixed-user-and-server-knowledge";
}

public static class DesignArtifactRuntimes
{
    public const string MapGateway = "map-gateway";
    public const string OpenDesign = "open-design";
    public const string Codex = "codex";
    public const string Claude = "claude";
    public const string HtmlPptPipeline = "html-ppt-pipeline";
}

/// <summary>
/// 普通用户可见的有限阶段集合。执行器原始事件必须先收敛到这些值，
/// 禁止把命令、路径、工具参数或隐式推理当作阶段。
/// </summary>
public static class DesignArtifactPhaseCodes
{
    public const string Queued = "queued";
    public const string WaitingCapacity = "waiting-capacity";
    public const string ServiceRecovering = "service-recovering";
    public const string PreparingWorkspace = "preparing-workspace";
    public const string ReadingSources = "reading-sources";
    public const string StartingDesign = "starting-design";
    public const string ComposingPage = "composing-page";
    public const string ReviewingPage = "reviewing-page";
    public const string RepairingQuality = "repairing-quality";
    public const string CollectingArtifact = "collecting-artifact";
    public const string CommittingArtifact = "committing-artifact";
    public const string SavingResult = "saving-result";
    public const string Completed = "completed";
    public const string Interrupted = "interrupted";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

public static class DesignWorkspaceResultWriteStates
{
    public const string Writing = "writing";
    public const string Stored = "stored";
    public const string SaveFailed = "save-failed";
}
