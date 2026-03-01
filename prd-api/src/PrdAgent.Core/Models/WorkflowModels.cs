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
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";

    public static readonly string[] All = { Queued, Running, Completed, Failed, Cancelled };
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
    public List<ExecutionArtifact> OutputArtifacts { get; set; } = new();

    /// <summary>
    /// 执行日志（截断保留最后 10KB）
    /// </summary>
    public string? Logs { get; set; }

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
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
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
}

// ─────────────────────────────────────────────────────────────
// WorkflowSchedule 定时调度
// ─────────────────────────────────────────────────────────────

public class WorkflowSchedule
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string WorkflowId { get; set; } = string.Empty;
    public string CronExpression { get; set; } = string.Empty;
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

    // 处理类
    public const string TapdCollector = "tapd-collector";
    public const string HttpRequest = "http-request";
    public const string SmartHttp = "smart-http";
    public const string LlmAnalyzer = "llm-analyzer";
    public const string ScriptExecutor = "script-executor";
    public const string DataExtractor = "data-extractor";
    public const string DataMerger = "data-merger";
    public const string FormatConverter = "format-converter";

    // 流程控制类
    public const string Delay = "delay";
    public const string Condition = "condition";

    // 输出类
    public const string ReportGenerator = "report-generator";
    public const string FileExporter = "file-exporter";
    public const string WebhookSender = "webhook-sender";
    public const string NotificationSender = "notification-sender";

    // 兼容旧类型映射
    public const string DataCollectorLegacy = "data-collector";
    public const string LlmCodeExecutorLegacy = "llm-code-executor";
    public const string RendererLegacy = "renderer";

    public static readonly string[] All =
    {
        // 触发类
        Timer, WebhookReceiver, ManualTrigger, FileUpload,
        // 处理类
        TapdCollector, HttpRequest, SmartHttp, LlmAnalyzer, ScriptExecutor, DataExtractor, DataMerger, FormatConverter,
        // 流程控制类
        Delay, Condition,
        // 输出类
        ReportGenerator, FileExporter, WebhookSender, NotificationSender,
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
