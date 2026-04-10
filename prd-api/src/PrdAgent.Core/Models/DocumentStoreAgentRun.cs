namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库 Agent 任务基类：字幕生成 + 文档再加工 共用。
///
/// 遵循 server-authority.md 规则：
/// - 通过 Run/Worker 与 HTTP 请求解耦
/// - Worker 内使用 CancellationToken.None 写入 MongoDB
/// - 事件通过 IRunEventStore 推送，SSE 支持 afterSeq 续传
/// </summary>
public class DocumentStoreAgentRun
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>类型：subtitle（字幕生成） / reprocess（文档再加工）</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>源文档条目 ID（字幕：音视频/图片；再加工：文字 entry）</summary>
    public string SourceEntryId { get; set; } = string.Empty;

    /// <summary>所属知识库</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>发起用户</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>任务状态</summary>
    public string Status { get; set; } = DocumentStoreRunStatus.Queued;

    /// <summary>当前阶段（前端用来画进度条）</summary>
    public string Phase { get; set; } = string.Empty;

    /// <summary>进度百分比（0-100）</summary>
    public int Progress { get; set; }

    /// <summary>失败时的错误信息</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>生成成功后对应的新 entry ID（字幕/再加工产物）</summary>
    public string? OutputEntryId { get; set; }

    /// <summary>再加工模板 key（summary/minutes/blog/custom）</summary>
    public string? TemplateKey { get; set; }

    /// <summary>再加工自定义提示词（templateKey == custom 时）</summary>
    public string? CustomPrompt { get; set; }

    /// <summary>再加工流式写入的累计文本（断线续传兜底）</summary>
    public string? GeneratedText { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }
}

public static class DocumentStoreAgentRunKind
{
    public const string Subtitle = "subtitle";
    public const string Reprocess = "reprocess";
}

public static class DocumentStoreRunStatus
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string Done = "done";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
}

/// <summary>字幕生成 / 再加工 的 RunKinds（用于 IRunEventStore）</summary>
public static class DocumentStoreRunKinds
{
    public const string Subtitle = "docStoreSubtitle";
    public const string Reprocess = "docStoreReprocess";
}
