namespace PrdAgent.Core.Models;

/// <summary>
/// 账户数据分享请求（用于用户间深拷贝 Workspace、提示词等数据）。
/// 流程：发送方创建 → 接收方收到通知 → 接受/拒绝 → 后台执行深拷贝。
/// </summary>
public class AccountDataTransfer
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    // ── 发送方 ──
    public string SenderUserId { get; set; } = string.Empty;
    public string SenderUserName { get; set; } = string.Empty;
    public string? SenderUserAvatar { get; set; }

    // ── 接收方 ──
    public string ReceiverUserId { get; set; } = string.Empty;
    public string? ReceiverUserName { get; set; }

    /// <summary>分享内容清单</summary>
    public List<DataTransferItem> Items { get; set; } = new();

    /// <summary>状态：pending → processing → completed / rejected / expired / cancelled / partial</summary>
    public string Status { get; set; } = "pending";

    /// <summary>发送方附言</summary>
    public string? Message { get; set; }

    /// <summary>处理结果摘要</summary>
    public DataTransferResult? Result { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? HandledAt { get; set; }
    public DateTime ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(7);
}

/// <summary>
/// 分享清单中的单个条目
/// </summary>
public class DataTransferItem
{
    /// <summary>源类型：workspace | literary-prompt | ref-image-config</summary>
    public string SourceType { get; set; } = string.Empty;

    /// <summary>源文档 ID</summary>
    public string SourceId { get; set; } = string.Empty;

    /// <summary>显示名称（创建时快照，不依赖源数据）</summary>
    public string DisplayName { get; set; } = string.Empty;

    /// <summary>应用标识：literary-agent | visual-agent</summary>
    public string? AppKey { get; set; }

    /// <summary>应用标识的中文显示名（由后端填充，前端直接展示）</summary>
    public string? AppKeyDisplayName { get; set; }

    /// <summary>附加预览信息（如图片数量）</summary>
    public string? PreviewInfo { get; set; }

    // ── 接受后回填 ──
    public string? ClonedId { get; set; }

    /// <summary>pending | success | failed | source_missing</summary>
    public string CloneStatus { get; set; } = "pending";

    public string? CloneError { get; set; }
}

/// <summary>
/// 深拷贝执行结果摘要
/// </summary>
public class DataTransferResult
{
    public int TotalItems { get; set; }
    public int SuccessCount { get; set; }
    public int FailedCount { get; set; }
    public int SkippedCount { get; set; }
    public long TotalAssetsCopied { get; set; }
    public long TotalMessagesCopied { get; set; }
}
