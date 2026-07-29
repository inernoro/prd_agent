namespace PrdAgent.Core.Models;

/// <summary>
/// 录音分片上传会话。音频总量仍受文档上传 20 MB 上限约束，分片单独落 Mongo，
/// 完成时按 Index 拼接后写入正式附件存储。
/// </summary>
public class DocumentRecordingUploadSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string StoreId { get; set; } = string.Empty;

    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 创建该录音会话的部署实例。共享 MongoDB 的主干和预览分支只能处理自己的归档任务。
    /// </summary>
    public string OwnerInstanceId { get; set; } = string.Empty;

    public string FileName { get; set; } = string.Empty;

    public string MimeType { get; set; } = "audio/webm";

    public string Status { get; set; } = DocumentRecordingUploadStatus.Uploading;

    /// <summary>下一片必须使用的顺序编号，从 0 开始。</summary>
    public int NextChunkIndex { get; set; }

    public long UploadedBytes { get; set; }

    public string? EntryId { get; set; }

    /// <summary>
    /// 持久化的转录任务 outbox。会话进入完成态时与终态原子写入；固定 ID 任务
    /// 成功结束后才清除，覆盖任务创建、执行和容器重启的完整生命周期。
    /// </summary>
    public bool DeferredTranscriptionRunPending { get; set; }

    /// <summary>正式对象存储归档状态。R2/COS 不可用时为 pending，Mongo 分片继续保留。</summary>
    public string ArchiveStatus { get; set; } = DocumentRecordingArchiveStatus.None;

    public int ArchiveAttempts { get; set; }

    public DateTime? ArchiveNextAttemptAt { get; set; }

    public string? ArchiveError { get; set; }

    public string? ArchiveUrl { get; set; }

    /// <summary>归档 Worker 的本次租约令牌，防止过期 Worker 覆盖重新认领者。</summary>
    public string? ArchiveLeaseId { get; set; }

    /// <summary>完成上传请求的本次租约令牌，防止过期请求提交或释放新的认领。</summary>
    public string? CompletionLeaseId { get; set; }

    /// <summary>过期清理的原子认领令牌；只有持有者可以删除对应分片和会话。</summary>
    public string? CleanupLeaseId { get; set; }

    /// <summary>由 Mongo 原子递增的完成租约版本，用于跨实例写栅栏，不依赖应用服务器时钟。</summary>
    public long CompletionLeaseVersion { get; set; }

    public string LiveTranscriptStatus { get; set; } = DocumentLiveTranscriptStatus.Pending;

    public string? LiveTranscript { get; set; }

    public string? LiveTranscriptProvider { get; set; }

    public string? LiveTranscriptModel { get; set; }

    public string? LiveTranscriptError { get; set; }

    public DateTime? LiveTranscriptUpdatedAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 会话最早可清理时间。待归档或待转录 outbox 会延长该时间；清理逻辑还必须
    /// 同时检查 pending 标记并先原子认领，禁止仅按本字段建立无条件 TTL 索引。
    /// </summary>
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(1);
}

/// <summary>录音上传分片。单片限制为 1 MB，避免触碰 Mongo 单文档上限。</summary>
public class DocumentRecordingUploadChunk
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    public int Index { get; set; }

    public byte[] Data { get; set; } = Array.Empty<byte>();

    public long SizeBytes { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class DocumentRecordingUploadStatus
{
    public const string Uploading = "uploading";

    /// <summary>
    /// 原子认领的中间态：某个 /complete 请求已抢到会话并正在创建条目。
    /// 用于阻止并发 /complete 各自创建重复音频条目；条目创建成功后翻转为 Completed。
    /// </summary>
    public const string Completing = "completing";

    public const string Completed = "completed";
    public const string Cancelled = "cancelled";
}

public static class DocumentLiveTranscriptStatus
{
    public const string Pending = "pending";
    public const string Active = "active";
    public const string Completed = "completed";
    public const string Degraded = "degraded";
}

public static class DocumentRecordingArchiveStatus
{
    public const string None = "none";
    public const string Pending = "pending";
    public const string Archiving = "archiving";
    public const string Completed = "completed";
}
