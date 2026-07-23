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

    public string FileName { get; set; } = string.Empty;

    public string MimeType { get; set; } = "audio/webm";

    public string Status { get; set; } = DocumentRecordingUploadStatus.Uploading;

    /// <summary>下一片必须使用的顺序编号，从 0 开始。</summary>
    public int NextChunkIndex { get; set; }

    public long UploadedBytes { get; set; }

    public string? EntryId { get; set; }

    /// <summary>正式对象存储归档状态。R2/COS 不可用时为 pending，Mongo 分片继续保留。</summary>
    public string ArchiveStatus { get; set; } = DocumentRecordingArchiveStatus.None;

    public int ArchiveAttempts { get; set; }

    public DateTime? ArchiveNextAttemptAt { get; set; }

    public string? ArchiveError { get; set; }

    public string? ArchiveUrl { get; set; }

    public string LiveTranscriptStatus { get; set; } = DocumentLiveTranscriptStatus.Pending;

    public string? LiveTranscript { get; set; }

    public string? LiveTranscriptProvider { get; set; }

    public string? LiveTranscriptModel { get; set; }

    public string? LiveTranscriptError { get; set; }

    public DateTime? LiveTranscriptUpdatedAt { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>未完成会话的清理时间；建议为本集合建立 TTL 索引。</summary>
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
