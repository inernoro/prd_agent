namespace PrdAgent.Core.Models;

/// <summary>
/// 文档订阅同步日志（只记录"有意义的事件"：内容变化 + 错误）。
/// 无变化的同步只更新 DocumentEntry.LastSyncAt，不在此表落库，避免日志膨胀。
/// </summary>
public class DocumentSyncLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属订阅条目 ID（DocumentEntry.Id）</summary>
    public string EntryId { get; set; } = string.Empty;

    /// <summary>所属文档空间 ID（用于权限校验时快速过滤）</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>同步发生时间（UTC）</summary>
    public DateTime SyncedAt { get; set; } = DateTime.UtcNow;

    /// <summary>事件类型：change / error</summary>
    public string Kind { get; set; } = DocumentSyncLogKind.Change;

    /// <summary>同步前的内容 hash（首次同步时为 null）</summary>
    public string? PreviousHash { get; set; }

    /// <summary>同步后的内容 hash</summary>
    public string? CurrentHash { get; set; }

    /// <summary>同步前的内容字节数</summary>
    public long? PreviousLength { get; set; }

    /// <summary>同步后的内容字节数</summary>
    public long? CurrentLength { get; set; }

    /// <summary>变化摘要（一句话描述，例如 "正文 +120 字" 或 "+3 ~2 -1 文件"）</summary>
    public string? ChangeSummary { get; set; }

    /// <summary>GitHub 目录类型订阅的逐文件变化（其他类型为空）</summary>
    public List<DocumentSyncFileChange>? FileChanges { get; set; }

    /// <summary>错误信息（kind == error 时填充）</summary>
    public string? ErrorMessage { get; set; }

    /// <summary>同步耗时（毫秒）</summary>
    public int DurationMs { get; set; }
}

/// <summary>GitHub 目录同步时单个文件的变化记录</summary>
public class DocumentSyncFileChange
{
    /// <summary>文件路径（GitHub 仓库内相对路径）</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>变化类型：added / updated / deleted</summary>
    public string Action { get; set; } = string.Empty;
}

public static class DocumentSyncLogKind
{
    /// <summary>内容发生变化</summary>
    public const string Change = "change";

    /// <summary>同步出错</summary>
    public const string Error = "error";
}

public static class DocumentSyncFileAction
{
    public const string Added = "added";
    public const string Updated = "updated";
    public const string Deleted = "deleted";
}
