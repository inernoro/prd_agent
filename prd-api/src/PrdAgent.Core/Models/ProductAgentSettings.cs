namespace PrdAgent.Core.Models;

/// <summary>产品管理应用级设置。</summary>
public class ProductAgentSettings
{
    public const string SingletonId = "product-agent-settings";

    public string Id { get; set; } = SingletonId;
    public List<string> AdminIds { get; set; } = new();
    [System.Text.Json.Serialization.JsonIgnore]
    public ProductClaimWebhookConfig ClaimWebhook { get; set; } = new();
    [System.Text.Json.Serialization.JsonIgnore]
    public string? ScheduledNotificationDebugWebhook { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public ProductNotificationGroupDirectory? ScheduledNotificationGroups { get; set; }
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string UpdatedBy { get; set; } = string.Empty;
}

public sealed class ProductNotificationGroupDirectory
{
    public string Revision { get; set; } = Guid.NewGuid().ToString("N");
    public List<ProductNotificationGroup> Items { get; set; } = [];
}

public sealed class ProductNotificationGroup
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Revision { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    [System.Text.Json.Serialization.JsonIgnore]
    public string ProtectedWebhook { get; set; } = "";
}

public class ProductClaimWebhookConfig
{
    public bool Enabled { get; set; }
    public bool DebugMode { get; set; }
    public DateTime? InitializedAt { get; set; }
    public bool NotifyInternal { get; set; } = true;
    public bool NotifyFormal { get; set; } = true;
    [System.Text.Json.Serialization.JsonIgnore]
    public string? ProtectedUrl { get; set; }
}

public class ProductClaimNotification
{
    public string Status { get; set; } = "pending";
    public bool ManualDispatchApproved { get; set; }
    public string OwnerId { get; set; } = string.Empty;
    public int Attempts { get; set; }
    public DateTime NextAttemptAt { get; set; } = DateTime.UtcNow;
    public string? LeaseId { get; set; }
    public string? Error { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public string Snapshot { get; set; } = string.Empty;
}
