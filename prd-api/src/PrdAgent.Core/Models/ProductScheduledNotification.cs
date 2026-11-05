namespace PrdAgent.Core.Models;

public sealed class ProductScheduledNotification
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Revision { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Message { get; set; } = "";
    public bool MentionAll { get; set; }
    public string Frequency { get; set; } = "";
    public string Time { get; set; } = "";
    public string? Date { get; set; }
    public int? Day { get; set; }
    public string ProtectedWebhook { get; set; } = "";
    public bool Enabled { get; set; }
    public DateTime? NextRunAt { get; set; }
    public DateTime? LastRunAt { get; set; }
    public string? LastResult { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public string? LeaseId { get; set; }
    public DateTime UpdatedAt { get; set; }
}
