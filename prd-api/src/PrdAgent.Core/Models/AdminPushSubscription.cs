using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

[BsonIgnoreExtraElements]
public class AdminPushSubscription
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string TopicKey { get; set; } = string.Empty;
    public bool Enabled { get; set; }
    public string ChannelType { get; set; } = "url";
    public string Method { get; set; } = "GET";
    public string UrlTemplate { get; set; } = string.Empty;
    public string? BodyTemplate { get; set; }
    public string ContentType { get; set; } = "application/json";
    public string? BarkKey { get; set; }
    public string? BarkServerUrl { get; set; }
    public string? BarkGroup { get; set; }
    public string? BarkSound { get; set; }
    public string? BarkLevel { get; set; }
    public string? BarkIcon { get; set; }
    public string? BarkUrlTemplate { get; set; }
    public bool BarkCall { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public class AdminPushDeliveryLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string SubscriptionId { get; set; } = string.Empty;
    public string NotificationId { get; set; } = string.Empty;
    public string TopicKey { get; set; } = string.Empty;
    public string ChannelType { get; set; } = string.Empty;
    public string Method { get; set; } = string.Empty;
    public string RequestUrl { get; set; } = string.Empty;
    public string? RequestBody { get; set; }
    public int? StatusCode { get; set; }
    public bool Success { get; set; }
    public string? ErrorMessage { get; set; }
    public long DurationMs { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
