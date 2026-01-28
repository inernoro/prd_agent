namespace PrdAgent.Core.Models;

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

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? HandledAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
}
