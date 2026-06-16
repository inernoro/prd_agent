using System.Security.Cryptography;

namespace PrdAgent.Core.Models;

// ─────────────────────────────────────────────────────────────
// Workflow 工作流定义
// ─────────────────────────────────────────────────────────────

public class Workflow
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? Icon { get; set; }
    public string? AvatarUrl { get; set; }
    public List<string> Tags { get; set; } = new();

    // DAG
    public List<WorkflowNode> Nodes { get; set; } = new();
    public List<WorkflowEdge> Edges { get; set; } = new();

    // 运行时变量定义
    public List<WorkflowVariable> Variables { get; set; } = new();

    // 触发配置
    public List<WorkflowTrigger> Triggers { get; set; } = new();

    // 状态
    public bool IsEnabled { get; set; } = true;
    public DateTime? LastExecutedAt { get; set; }
    public long ExecutionCount { get; set; }

    // 所有权
    public string CreatedBy { get; set; } = string.Empty;
    public string? CreatedByName { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    // IForkable 字段（海鲜市场）
    public string? OwnerUserId { get; set; }
    public bool IsPublic { get; set; }
    public int ForkCount { get; set; }
    public string? ForkedFromId { get; set; }
    public string? ForkedFromOwnerName { get; set; }
    public string? ForkedFromOwnerAvatar { get; set; }
}

// ─────────────────────────────────────────────────────────────
// WorkflowNode 节点定义
// ─────────────────────────────────────────────────────────────

public class WorkflowNode
{
    public string NodeId { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// 节点类型：data-collector | script-executor | llm-analyzer | llm-code-executor | renderer
    /// </summary>
    public string NodeType { get; set; } = string.Empty;

    /// <summary>
    /// 节点特定配置（JSON 对象，根据 NodeType 结构不同）
    /// </summary>
    public Dictionary<string, object?> Config { get; set; } = new();

    public List<ArtifactSlot> InputSlots { get; set; } = new();
    public List<ArtifactSlot> OutputSlots { get; set; } = new();

    /// <summary>
    /// 可视化位置（前端画布坐标）
    /// </summary>
    public NodePosition? Position { get; set; }

    public RetryPolicy? Retry { get; set; }

    /// <summary>
    /// 断点：节点执行完成后暂停工作流
    /// </summary>
    public bool Breakpoint { get; set; }
}

public class ArtifactSlot
{
    public string SlotId { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// text | json | image | binary
    /// </summary>
    public string DataType { get; set; } = "text";

    public bool Required { get; set; } = true;
    public string? Description { get; set; }
}

public class NodePosition
{
    public double X { get; set; }
    public double Y { get; set; }
}

public class RetryPolicy
{
    public int MaxAttempts { get; set; } = 1;
    public int DelaySeconds { get; set; } = 5;
}

// ─────────────────────────────────────────────────────────────
// WorkflowEdge 连线
// ─────────────────────────────────────────────────────────────

public class WorkflowEdge
{
    public string EdgeId { get; set; } = Guid.NewGuid().ToString("N")[..8];
    public string SourceNodeId { get; set; } = string.Empty;
    public string SourceSlotId { get; set; } = string.Empty;
    public string TargetNodeId { get; set; } = string.Empty;
    public string TargetSlotId { get; set; } = string.Empty;
}

// ─────────────────────────────────────────────────────────────
// WorkflowTrigger 触发方式
// ─────────────────────────────────────────────────────────────

public class WorkflowTrigger
{
    public string TriggerId { get; set; } = Guid.NewGuid().ToString("N")[..8];

    /// <summary>
    /// manual | cron | webhook | event
    /// </summary>
    public string Type { get; set; } = "manual";

    // Cron
    public string? CronExpression { get; set; }
    public string? Timezone { get; set; } = "Asia/Shanghai";

    // Webhook
    public string? WebhookId { get; set; }

    // 事件驱动（对接 AutomationHub）
    public string? EventType { get; set; }

    // 运行时变量覆盖
    public Dictionary<string, string>? VariableOverrides { get; set; }
}

// ─────────────────────────────────────────────────────────────
// WorkflowVariable 运行时变量
// ─────────────────────────────────────────────────────────────

public class WorkflowVariable
{
    public string Key { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;

    /// <summary>
    /// string | number | date | select
    /// </summary>
    public string Type { get; set; } = "string";

    public string? DefaultValue { get; set; }
    public List<string>? Options { get; set; }
    public bool Required { get; set; } = true;
    public bool IsSecret { get; set; }
}

// ─────────────────────────────────────────────────────────────
// WorkflowExecution 执行实例
// ─────────────────────────────────────────────────────────────

public class WorkflowExecution
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string WorkflowId { get; set; } = string.Empty;
    public string WorkflowName { get; set; } = string.Empty;
    public string TraceId { get; set; } = string.Empty;

    // 触发信息
    public string TriggerType { get; set; } = "manual";
    public string? TriggeredBy { get; set; }
    public string? TriggeredByName { get; set; }

    // 运行时变量（本次执行的实际值）
    public Dictionary<string, string> Variables { get; set; } = new();

    // 工作流定义快照
    public List<WorkflowNode> NodeSnapshot { get; set; } = new();
    public List<WorkflowEdge> EdgeSnapshot { get; set; } = new();

    // 节点执行状态
    public List<NodeExecution> NodeExecutions { get; set; } = new();

    // 整体状态
    public string Status { get; set; } = WorkflowExecutionStatus.Queued;

    // 最终产物
    public List<ExecutionArtifact> FinalArtifacts { get; set; } = new();

    // 分享
    public List<string> ShareLinkIds { get; set; } = new();

    // 时间追踪
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public long? DurationMs { get; set; }
    public string? ErrorMessage { get; set; }

    // SSE 重连序列号
    public long LastSeq { get; set; }
}

public static class WorkflowExecutionStatus
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string WaitingApproval = "waiting_approval";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
    public const string Paused = "paused";
    public const string TimedOut = "timed_out";

    public static readonly string[] All = { Queued, Running, WaitingApproval, Completed, Failed, Cancelled, Paused, TimedOut };
}

// ─────────────────────────────────────────────────────────────
// NodeExecution 节点执行记录
// ─────────────────────────────────────────────────────────────

public class NodeExecution
{
    public string NodeId { get; set; } = string.Empty;
    public string NodeName { get; set; } = string.Empty;
    public string NodeType { get; set; } = string.Empty;

    /// <summary>
    /// pending | running | completed | failed | skipped
    /// </summary>
    public string Status { get; set; } = NodeExecutionStatus.Pending;

    public List<ArtifactRef> InputArtifactRefs { get; set; } = new();

    /// <summary>
    /// 实际收到的上游输入产物（工作流执行时自动记录，用于回放和调试）
    /// </summary>
    public List<ExecutionArtifact> InputArtifacts { get; set; } = new();

    public List<ExecutionArtifact> OutputArtifacts { get; set; } = new();

    /// <summary>
    /// 执行日志（截断保留最后 10KB）
    /// </summary>
    public string? Logs { get; set; }

    /// <summary>
    /// 完整日志 COS 地址（大于 10KB 时上传）
    /// </summary>
    public string? LogsCosUrl { get; set; }

    public int AttemptCount { get; set; }
    public string? ErrorMessage { get; set; }

    public DateTime? StartedAt { get; set; }
    public DateTime? CompletedAt { get; set; }
    public long? DurationMs { get; set; }
}

public static class NodeExecutionStatus
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string WaitingApproval = "waiting_approval";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
    public const string Paused = "paused";
}

public class ArtifactRef
{
    public string SourceNodeId { get; set; } = string.Empty;
    public string SlotId { get; set; } = string.Empty;
    public string ArtifactId { get; set; } = string.Empty;
}

// ─────────────────────────────────────────────────────────────
// ExecutionArtifact 执行产物
// ─────────────────────────────────────────────────────────────

public class ExecutionArtifact
{
    public string ArtifactId { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string MimeType { get; set; } = "text/plain";
    public string SlotId { get; set; } = string.Empty;

    /// <summary>
    /// 小文本直接内联（&lt; 64KB）
    /// </summary>
    public string? InlineContent { get; set; }

    /// <summary>
    /// 大文件存 COS
    /// </summary>
    public string? CosKey { get; set; }
    public string? CosUrl { get; set; }

    public long SizeBytes { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 标签（auto-generated = 自动透传产物，供前端区分显示）
    /// </summary>
    public List<string>? Tags { get; set; }
}

// ─────────────────────────────────────────────────────────────
// WorkflowSchedule 定时调度
// ─────────────────────────────────────────────────────────────

public class WorkflowSchedule
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string WorkflowId { get; set; } = string.Empty;
    /// <summary>WorkflowName 冗余便于列表展示（来自 Workflow.Name 快照）</summary>
    public string WorkflowName { get; set; } = string.Empty;
    /// <summary>用户给的别名，例如「每天早 9 点抓博主视频」</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>once = 一次性指定时间触发；cron = 按 Cron 循环</summary>
    public string Mode { get; set; } = "once";

    /// <summary>once 模式：触发时间（UTC）</summary>
    public DateTime? RunAtUtc { get; set; }

    /// <summary>cron 模式：5 字段 Cron 表达式（分 时 日 月 周）</summary>
    public string? CronExpression { get; set; }
    public string Timezone { get; set; } = "Asia/Shanghai";

    public bool IsEnabled { get; set; } = true;
    public DateTime? NextRunAt { get; set; }
    public DateTime? LastTriggeredAt { get; set; }
    public long TriggerCount { get; set; }

    public Dictionary<string, string>? VariableOverrides { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

// ─────────────────────────────────────────────────────────────
// ShareLink 分享链接
// ─────────────────────────────────────────────────────────────

public class ShareLink
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Token { get; set; } = GenerateToken();

    public string ResourceType { get; set; } = "workflow-execution";
    public string ResourceId { get; set; } = string.Empty;

    /// <summary>
    /// public = 任何人 | authenticated = 需登录
    /// </summary>
    public string AccessLevel { get; set; } = "public";
    public string? Password { get; set; }

    public string? Title { get; set; }
    public string? PreviewHtml { get; set; }
    public List<ShareArtifactRef> Artifacts { get; set; } = new();

    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; }
    public bool IsRevoked { get; set; }

    private static string GenerateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(9))
            .Replace("+", "-").Replace("/", "_").TrimEnd('=');
}

public class ShareArtifactRef
{
    public string ArtifactId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string MimeType { get; set; } = string.Empty;
    public string? Url { get; set; }
}

// ─────────────────────────────────────────────────────────────
// WorkflowSecret 工作流凭证
// ─────────────────────────────────────────────────────────────

public class WorkflowSecret
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string WorkflowId { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;

    /// <summary>
    /// AES-256-GCM 加密存储
    /// </summary>
    public string EncryptedValue { get; set; } = string.Empty;

    public string CreatedBy { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

// ─────────────────────────────────────────────────────────────
// 节点类型常量（保留旧名称兼容）
// ─────────────────────────────────────────────────────────────

public static class WorkflowNodeTypes
{
    public const string DataCollector = "data-collector";
    public const string ScriptExecutor = "script-executor";
    public const string LlmAnalyzer = "llm-analyzer";
    public const string LlmCodeExecutor = "llm-code-executor";
    public const string Renderer = "renderer";

    public static readonly string[] All =
    {
        DataCollector, ScriptExecutor, LlmAnalyzer, LlmCodeExecutor, Renderer
    };
}

// ─────────────────────────────────────────────────────────────
// 舱类型常量（新架构，替代 WorkflowNodeTypes）
// ─────────────────────────────────────────────────────────────

public static class CapsuleTypes
{
    // 触发类
    public const string Timer = "timer";
    public const string WebhookReceiver = "webhook-receiver";
    public const string ManualTrigger = "manual-trigger";
    public const string FileUpload = "file-upload";
    public const string EventTrigger = "event-trigger";

    // 处理类
    public const string TapdCollector = "tapd-collector";
    public const string HttpRequest = "http-request";
    public const string SmartHttp = "smart-http";
    public const string LlmAnalyzer = "llm-analyzer";
    public const string ScriptExecutor = "script-executor";
    public const string DataExtractor = "data-extractor";
    public const string DataMerger = "data-merger";
    public const string FormatConverter = "format-converter";
    public const string DataAggregator = "data-aggregator";

    // 流程控制类
    public const string Delay = "delay";
    public const string Condition = "condition";

    // 输出类
    public const string ReportGenerator = "report-generator";
    public const string WebpageGenerator = "webpage-generator";
    public const string FileExporter = "file-exporter";
    public const string WebhookSender = "webhook-sender";
    public const string NotificationSender = "notification-sender";
    public const string VideoGeneration = "video-generation";
    public const string SitePublisher = "site-publisher";
    public const string EmailSender = "email-sender";

    // CLI Agent / 远程 Agent 执行器
    public const string CliAgentExecutor = "cli-agent-executor";
    public const string CdsAgent = "cds-agent";

    // 短视频工作流类
    public const string DouyinParser = "douyin-parser";
    public const string VideoDownloader = "video-downloader";
    public const string VideoToText = "video-to-text";
    public const string TextToCopywriting = "text-to-copywriting";
    public const string TiktokCreatorFetch = "tiktok-creator-fetch";
    public const string HomepagePublisher = "homepage-publisher";
    public const string WeeklyPosterPublisher = "weekly-poster-publisher";
    public const string MediaRehost = "media-rehost";

    // 兼容旧类型映射
    public const string DataCollectorLegacy = "data-collector";
    public const string LlmCodeExecutorLegacy = "llm-code-executor";
    public const string RendererLegacy = "renderer";

    public static readonly string[] All =
    {
        // 触发类
        Timer, WebhookReceiver, ManualTrigger, FileUpload, EventTrigger,
        // 处理类
        TapdCollector, HttpRequest, SmartHttp, LlmAnalyzer, ScriptExecutor, DataExtractor, DataMerger, FormatConverter, DataAggregator,
        // 流程控制类
        Delay, Condition,
        // 输出类
        ReportGenerator, WebpageGenerator, FileExporter, WebhookSender, NotificationSender, VideoGeneration, SitePublisher, EmailSender, HomepagePublisher, WeeklyPosterPublisher,
        // CLI Agent / 远程 Agent 执行器
        CliAgentExecutor, CdsAgent,
        // 短视频工作流类
        DouyinParser, VideoDownloader, VideoToText, TextToCopywriting, TiktokCreatorFetch, MediaRehost,
        // 旧类型兼容
        DataCollectorLegacy, LlmCodeExecutorLegacy, RendererLegacy,
    };
}

// ─────────────────────────────────────────────────────────────
// 触发类型常量
// ─────────────────────────────────────────────────────────────

public static class WorkflowTriggerTypes
{
    public const string Manual = "manual";
    public const string Cron = "cron";
    public const string Webhook = "webhook";
    public const string Event = "event";
}

// ─────────────────────────────────────────────────────────────
// WorkflowChatMessage 工作流对话消息
// ─────────────────────────────────────────────────────────────

public class WorkflowChatMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的工作流 ID（新建场景可为空）</summary>
    public string? WorkflowId { get; set; }

    /// <summary>"user" | "assistant"</summary>
    public string Role { get; set; } = "user";

    /// <summary>消息内容（Markdown）</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>assistant 消息附带的工作流 JSON（已解析为结构化数据）</summary>
    public WorkflowChatGenerated? Generated { get; set; }

    /// <summary>校验/接线/缺项结果快照（持久化后刷新对话历史仍能恢复「应用门禁」与缺项卡）</summary>
    public WorkflowChatValidation? Validation { get; set; }

    /// <summary>本条 assistant 消息「自动创建」出的工作流 id（仅 isNew 自动建流时有值）。
    /// 刷新历史后据此判定该提案已落库，不再显示「应用到编辑器」/补齐入口。</summary>
    public string? GeneratedWorkflowId { get; set; }

    public string UserId { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public long Seq { get; set; }
}

/// <summary>
/// AI 生成的工作流配置（嵌入在 assistant 消息中）
/// </summary>
public class WorkflowChatGenerated
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public List<WorkflowNode>? Nodes { get; set; }
    public List<WorkflowEdge>? Edges { get; set; }
    public List<WorkflowVariable>? Variables { get; set; }

    /// <summary>是否为新建工作流（vs 修改现有工作流）</summary>
    public bool IsNew { get; set; }
}

/// <summary>
/// AI 生成工作流的校验快照（与 SSE workflow_validation 事件同形，随对话消息持久化）
/// </summary>
public class WorkflowChatValidation
{
    public bool Valid { get; set; }
    public List<WorkflowChatValidationIssue> Issues { get; set; } = new();
    public List<string> WireNotes { get; set; } = new();
    public List<PrdAgent.Core.Services.WorkflowRequiredInput> RequiredInputs { get; set; } = new();
}

public class WorkflowChatValidationIssue
{
    public string Target { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
}
