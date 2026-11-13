namespace PrdAgent.Core.Models;

/// <summary>同批回收标记；不复制正文、附件或历史，避免恢复出陈旧快照。</summary>
public sealed class DocumentTrashState
{
    public const int RetentionDays = 30;
    public string BatchId { get; set; } = Guid.NewGuid().ToString("N");
    public string? RootEntryId { get; set; }
    public DateTime DeletedAt { get; set; } = DateTime.UtcNow;
    public string DeletedBy { get; set; } = string.Empty;
    public bool Pending { get; set; }
    /// <summary>本批次回收的条目数，沿用空间创建口径；null 兼容早期回收标记。</summary>
    public int? DocumentCount { get; set; }
    public bool CanRestore(DateTime now) => !Pending && now < DeletedAt.AddDays(RetentionDays);
}
