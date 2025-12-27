namespace PrdAgent.Core.Models;

public class DesktopPresenceEntry
{
    public string UserId { get; set; } = "anonymous";
    public string ClientId { get; set; } = "unknown";
    public string ClientType { get; set; } = "desktop";

    public DateTime LastSeenAt { get; set; }

    public DesktopRequestRecord? LastRequest { get; set; }

    public List<DesktopRequestRecord> RecentRequests { get; set; } = new();
}

public class DesktopRequestRecord
{
    public DateTime At { get; set; }
    public string RequestId { get; set; } = string.Empty;

    public string Method { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string? Query { get; set; }

    public int StatusCode { get; set; }
    public long DurationMs { get; set; }
}


