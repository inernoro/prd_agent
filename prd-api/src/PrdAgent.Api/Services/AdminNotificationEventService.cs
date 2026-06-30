using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public sealed class AdminNotificationEventService
{
    private static readonly HashSet<string> AllowedSources = new(StringComparer.OrdinalIgnoreCase)
    {
        "admin-notice",
        "server-expiry",
        "user-voice",
        "team-activity-voice",
        "api-request-alert",
        "api-request-log",
        "gateway-alert",
        "system",
        "system-alert",
        "platform-key-integrity",
        "llm-gateway-quota",
        "open-platform",
        "defect-agent",
        "report-agent",
    };

    private static readonly HashSet<string> AllowedLevels = new(StringComparer.OrdinalIgnoreCase)
    {
        "info",
        "success",
        "warning",
        "error",
    };

    private readonly MongoDbContext _db;
    private readonly ILogger<AdminNotificationEventService> _logger;

    public AdminNotificationEventService(MongoDbContext db, ILogger<AdminNotificationEventService> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task<AdminNotificationEventResult> CreateAsync(AdminNotificationEventRequest request, string actorUserId, CancellationToken ct)
    {
        var source = NormalizeText(request.Source, "system", 96);
        if (!AllowedSources.Contains(source))
            throw new InvalidOperationException($"不支持的通知来源：{source}");

        var title = NormalizeText(request.Title, string.Empty, 160);
        if (string.IsNullOrWhiteSpace(title))
            throw new InvalidOperationException("通知标题不能为空");

        var message = NormalizeNullableText(request.Message, 1000);
        var level = NormalizeText(request.Level, "info", 32);
        if (!AllowedLevels.Contains(level)) level = "info";

        var now = DateTime.UtcNow;
        var key = BuildEventKey(source, request.DedupKey);
        var notification = new AdminNotification
        {
            Key = key,
            TargetUserId = NormalizeNullableText(request.TargetUserId, 128),
            Title = title,
            Message = message,
            Level = level,
            Status = "open",
            ActionLabel = NormalizeNullableText(request.ActionLabel, 64),
            ActionUrl = NormalizeNullableText(request.ActionUrl, 1024),
            ActionKind = NormalizeNullableText(request.ActionKind, 64),
            Source = source,
            Attachments = NormalizeAttachments(request.Attachments),
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = ResolveExpiresAt(request.ExpiresInDays, now),
        };

        if (string.IsNullOrWhiteSpace(key))
        {
            await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct);
            _logger.LogInformation("管理员通知事件已创建 source={Source} actor={ActorUserId} notification={NotificationId}", source, actorUserId, notification.Id);
            return new AdminNotificationEventResult(notification, true);
        }

        var existing = await _db.AdminNotifications
            .Find(x => x.Key == key)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);

        if (existing == null)
        {
            await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct);
            _logger.LogInformation("管理员通知事件已创建 source={Source} key={Key} actor={ActorUserId} notification={NotificationId}", source, key, actorUserId, notification.Id);
            return new AdminNotificationEventResult(notification, true);
        }

        var update = Builders<AdminNotification>.Update
            .Set(x => x.TargetUserId, notification.TargetUserId)
            .Set(x => x.Title, notification.Title)
            .Set(x => x.Message, notification.Message)
            .Set(x => x.Level, notification.Level)
            .Set(x => x.Status, "open")
            .Set(x => x.ActionLabel, notification.ActionLabel)
            .Set(x => x.ActionUrl, notification.ActionUrl)
            .Set(x => x.ActionKind, notification.ActionKind)
            .Set(x => x.Source, notification.Source)
            .Set(x => x.Attachments, notification.Attachments)
            .Set(x => x.UpdatedAt, now)
            .Set(x => x.HandledAt, null)
            .Set(x => x.ExpiresAt, notification.ExpiresAt);

        await _db.AdminNotifications.UpdateOneAsync(x => x.Id == existing.Id, update, cancellationToken: ct);
        var updated = await _db.AdminNotifications.Find(x => x.Id == existing.Id).FirstAsync(ct);
        _logger.LogInformation("管理员通知事件已更新 source={Source} key={Key} actor={ActorUserId} notification={NotificationId}", source, key, actorUserId, updated.Id);
        return new AdminNotificationEventResult(updated, false);
    }

    private static string? BuildEventKey(string source, string? dedupKey)
    {
        var normalized = NormalizeNullableText(dedupKey, 160);
        if (string.IsNullOrWhiteSpace(normalized)) return null;
        return $"admin-event:{source}:{normalized}";
    }

    private static DateTime? ResolveExpiresAt(int? expiresInDays, DateTime now)
    {
        if (expiresInDays == null) return now.AddDays(7);
        if (expiresInDays <= 0) return null;
        return now.AddDays(Math.Min(expiresInDays.Value, 90));
    }

    private static List<NotificationAttachment>? NormalizeAttachments(IEnumerable<AdminNotificationEventAttachmentRequest>? attachments)
    {
        var items = new List<NotificationAttachment>();
        foreach (var item in attachments ?? [])
        {
            var url = NormalizeNullableText(item.Url, 2048);
            if (string.IsNullOrWhiteSpace(url)) continue;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) continue;
            if (!string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase))
                continue;

            items.Add(new NotificationAttachment
            {
                Name = NormalizeText(item.Name, "attachment", 160),
                Url = url,
                SizeBytes = Math.Max(0, item.SizeBytes),
                MimeType = NormalizeNullableText(item.MimeType, 96),
            });

            if (items.Count >= 6) break;
        }

        return items.Count == 0 ? null : items;
    }

    private static string NormalizeText(string? value, string fallback, int maxLength)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(trimmed)) trimmed = fallback;
        return trimmed.Length > maxLength ? trimmed[..maxLength] : trimmed;
    }

    private static string? NormalizeNullableText(string? value, int maxLength)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(trimmed)) return null;
        return trimmed.Length > maxLength ? trimmed[..maxLength] : trimmed;
    }
}

public sealed record AdminNotificationEventResult(AdminNotification Notification, bool Created);

public sealed class AdminNotificationEventRequest
{
    public string? Source { get; set; }
    public string? Title { get; set; }
    public string? Message { get; set; }
    public string? Level { get; set; }
    public string? TargetUserId { get; set; }
    public string? ActionLabel { get; set; }
    public string? ActionUrl { get; set; }
    public string? ActionKind { get; set; }
    public string? DedupKey { get; set; }
    public int? ExpiresInDays { get; set; }
    public List<AdminNotificationEventAttachmentRequest>? Attachments { get; set; }
}

public sealed class AdminNotificationEventAttachmentRequest
{
    public string? Name { get; set; }
    public string? Url { get; set; }
    public long SizeBytes { get; set; }
    public string? MimeType { get; set; }
}
