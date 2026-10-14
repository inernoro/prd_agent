namespace PrdAgent.Core.Models;

/// <summary>
/// 录音分片上传会话。音频总量仍受文档上传 20 MB 上限约束；新分片实体在对象存储，
/// Mongo 只保留清单和写入状态。历史 Mongo 字节由迁移任务逐步搬走。
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

    /// <summary>正式对象存储归档状态。失败时保留已确认的分片对象供后台重试。</summary>
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
    /// 同时检查 pending 标记并先原子认领，禁止按本字段建立 TTL 索引。
    /// 回收顺序固定为“先删分片、再删会话”：TTL 若先删掉父会话，分片会失去
    /// 可关联的父记录，转录 outbox 也无法恢复。

    /// </summary>
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(1);
}

/// <summary>录音上传分片清单；Data 仅用于读取和迁移历史内联字节。</summary>
public class DocumentRecordingUploadChunk
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    /// <summary>对象分片所属部署实例，防止共享 Mongo 的预览分支跨桶清理。</summary>
    public string OwnerInstanceId { get; set; } = string.Empty;

    public int Index { get; set; }

    [MongoDB.Bson.Serialization.Attributes.BsonIgnoreIfNull]
    public byte[]? Data { get; set; }

    public string? StorageKey { get; set; }

    public string? Sha256 { get; set; }

    /// <summary>对象已确认写入。false 是可恢复的上传意图，不计入会话偏移。</summary>
    public bool ObjectStored { get; set; }

    /// <summary>回收意图；写入方必须停止重传，清理方可在崩溃后重试。</summary>
    public bool Deleting { get; set; }

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
