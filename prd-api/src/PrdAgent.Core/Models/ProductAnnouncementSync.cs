namespace PrdAgent.Core.Models;

/// <summary>公开公告索引，不是第二份版本主数据。完整成功的抓取才提交水位。</summary>
public sealed class ProductAnnouncement
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Url { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public bool Committed { get; set; }
    public DateTime FetchedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>全局单任务队列及租约，客户端断开不影响执行。</summary>
public sealed class ProductAnnouncementSync
{
    public const string SingletonId = "product-version-announcements";
    public string Id { get; set; } = SingletonId;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public string Status { get; set; } = "idle";
    public string RunId { get; set; } = string.Empty;
    public string Trigger { get; set; } = string.Empty;
    public string RequestedBy { get; set; } = string.Empty;
    public string? ScheduledMonth { get; set; }
    public string? CompletedMonth { get; set; }
    public string? LeaseOwner { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public DateTime? RequestedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
    public DateTime? LastSuccessAt { get; set; }
    public DateTime? NextRunAt { get; set; }
    public DateTime? CalendarRetryAt { get; set; }
    public string? CalendarError { get; set; }
    public string Message { get; set; } = "每月首个法定工作日北京时间 08:00 更新公告";
    public int Pages { get; set; }
    public int Discovered { get; set; }
    public int Updated { get; set; }
    public int Conflicts { get; set; }
}

public sealed class ProductWorkdayCalendar
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public int Year { get; set; }
    public Dictionary<string, bool> Overrides { get; set; } = new();
    public List<string> Papers { get; set; } = new();
    public DateTime FetchedAt { get; set; } = DateTime.UtcNow;
}
