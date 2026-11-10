namespace PrdAgent.Core.Models;

public enum ProductNotificationOneTimeRunState { Pending, Attempted, Sent }

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
    public string[]? ProtectedWebhooks { get; set; }
    public string?[]? WebhookGroupNames { get; set; }
    public bool Enabled { get; set; }
    public bool EnablementExplicit { get; set; }
    public ProductNotificationOneTimeRunState? OneTimeRunState { get; set; }
    public DateTime? NextRunAt { get; set; }
    public DateTime? LastRunAt { get; set; }
    public string? LastResult { get; set; }
    public ProductNotificationDelivery? LastDelivery { get; set; }
    public DateTime? LeaseUntil { get; set; }
    public string? LeaseId { get; set; }
    public DateTime UpdatedAt { get; set; }
    public ProductNotificationDebugRun? DebugRun { get; set; }

    public string[] GetProtectedWebhooks() =>
        ProtectedWebhooks is { Length: > 0 } webhooks ? webhooks : string.IsNullOrEmpty(ProtectedWebhook) ? [] : [ProtectedWebhook];

    public ProductNotificationOneTimeRunState GetOneTimeRunState()
    {
        if (OneTimeRunState is { } state) return state;
        if (Frequency != "once" || LastRunAt == null || NextRunAt != null) return ProductNotificationOneTimeRunState.Pending;
        return LastResult is "sent" or "partial" ? ProductNotificationOneTimeRunState.Sent : ProductNotificationOneTimeRunState.Attempted;
    }

    public bool HasCompletedOneTimeSchedule() =>
        Frequency == "once" && GetOneTimeRunState() != ProductNotificationOneTimeRunState.Pending;

    // The old worker cleared Enabled on one-time completion. A user could not disable a completed task in that version.
    public bool IsScheduleEnabled() => Enabled || (!EnablementExplicit && HasCompletedOneTimeSchedule());
}

public sealed record ProductNotificationDelivery(int Sent, int Failed, int Unknown);

public sealed class ProductNotificationDebugRun
{
    public string Id { get; set; } = "";
    public string Status { get; set; } = "sending";
    public DateTime RequestedAt { get; set; }
    public DateTime LeaseUntil { get; set; }
}
