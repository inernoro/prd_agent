namespace PrdAgent.Core.Models;

/// <summary>公开公告抓取台账；公告信息和详情待办逐条保存，版本主数据仍由版本表维护。</summary>
public sealed class ProductAnnouncement
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Url { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string ApplicationName { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public string PublishedAtRaw { get; set; } = string.Empty;
    public string FooterTimeRaw { get; set; } = string.Empty;
    public DateTime? PublishedAt { get; set; }
    public DateTime? FooterTime { get; set; }
    public string DetailStatus { get; set; } = "pending";
    public string? LastError { get; set; }
    public int Attempts { get; set; }
    public int SourcePage { get; set; }
    public DateTime? LastAttemptAt { get; set; }
    public DateTime? DetailFetchedAt { get; set; }
    public string MatchStatus { get; set; } = "pending";
    public int MatchedCount { get; set; }
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
    /// <summary>完整保存一页列表后才推进；任务失败、服务重启均从此页继续。</summary>
    public int NextPage { get; set; } = 1;
    public bool ListingComplete { get; set; }
    public string ScanMode { get; set; } = "full";
    public string? ImportedSeedHash { get; set; }
    public DateTime? SeedImportedAt { get; set; }
}

/// <summary>真实公开源的本地初始化快照；不完整快照只补台账，不代表全量水位。</summary>
public sealed class ProductAnnouncementSeed
{
    public int SchemaVersion { get; set; }
    public string SourceUrl { get; set; } = string.Empty;
    public DateTime FetchedAt { get; set; }
    public bool ScanCompleted { get; set; }
    public int ExpectedPages { get; set; }
    public int PagesScanned { get; set; }
    public List<ProductAnnouncement> Records { get; set; } = new();
}

public sealed class ProductWorkdayCalendar
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public int Year { get; set; }
    public Dictionary<string, bool> Overrides { get; set; } = new();
    public List<string> Papers { get; set; } = new();
    public DateTime FetchedAt { get; set; } = DateTime.UtcNow;
}
