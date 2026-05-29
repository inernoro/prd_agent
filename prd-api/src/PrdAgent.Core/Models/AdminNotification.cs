using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class AdminNotification
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 用于幂等去重的业务键。
    /// </summary>
    public string? Key { get; set; }

    /// <summary>
    /// 目标用户 ID。为空表示全局通知（所有人可见）。
    /// </summary>
    public string? TargetUserId { get; set; }

    public string Title { get; set; } = string.Empty;
    public string? Message { get; set; }
    public string Level { get; set; } = "info";
    public string Status { get; set; } = "open";

    public string? ActionLabel { get; set; }
    public string? ActionUrl { get; set; }
    public string? ActionKind { get; set; }

    public string Source { get; set; } = "system";

    /// <summary>
    /// 附件列表（COS URL）
    /// </summary>
    public List<NotificationAttachment>? Attachments { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? HandledAt { get; set; }

    /// <summary>
    /// 过期时间。默认创建后 7 天自动过期，避免提醒一直挂在首页堆积。
    /// 显式指定时（如 webhook / 自动化规则）以指定值为准；需要永驻的通知可显式设 null。
    /// </summary>
    public DateTime? ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(7);
}

public class NotificationAttachment
{
    public string Name { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public long SizeBytes { get; set; }
    public string? MimeType { get; set; }
}
