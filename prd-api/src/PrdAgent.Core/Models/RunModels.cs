namespace PrdAgent.Core.Models;

public static class RunKinds
{
    public const string Chat = "chat";
    public const string ImageGen = "imageGen";
    public const string Workflow = "workflow";
}

public static class RunStatuses
{
    public const string Queued = "Queued";
    public const string Running = "Running";
    public const string Done = "Done";
    public const string Error = "Error";
    public const string Cancelled = "Cancelled";
}

/// <summary>
/// Run 元信息（热数据：状态/游标/关联业务字段）。
/// </summary>
public class RunMeta
{
    public string RunId { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;

    public string Status { get; set; } = RunStatuses.Queued;

    public string? GroupId { get; set; }
    public string? SessionId { get; set; }
    public string? CreatedByUserId { get; set; }

    public string? UserMessageId { get; set; }
    public string? AssistantMessageId { get; set; }

    public long LastSeq { get; set; }

    public bool CancelRequested { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? StartedAt { get; set; }
    public DateTime? EndedAt { get; set; }

    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }

    /// <summary>
    /// 执行参数（JSON）：用于 worker 在不依赖外部 DB 的情况下恢复执行上下文。
    /// - 注意：仅允许存小字段；大内容（图片/base64）必须落 COS。
    /// </summary>
    public string? InputJson { get; set; }
}

public class RunEventRecord
{
    public string RunId { get; set; } = string.Empty;
    public long Seq { get; set; }
    public string EventName { get; set; } = string.Empty;
    public string PayloadJson { get; set; } = "{}";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class RunSnapshot
{
    public long Seq { get; set; }
    public string SnapshotJson { get; set; } = "{}";
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


