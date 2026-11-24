using MongoDB.Driver;
using System.Security.Cryptography;
using System.Text;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public sealed class AdminNotificationEventService
{
    private static readonly HashSet<string> AllowedLevels = new(StringComparer.OrdinalIgnoreCase)
    {
        "info",
        "success",
        "warning",
        "error",
    };

    private readonly MongoDbContext _db;
    private readonly AdminPushDispatchSignal _dispatchSignal;
    private readonly ILogger<AdminNotificationEventService> _logger;

    public AdminNotificationEventService(
        MongoDbContext db,
        AdminPushDispatchSignal dispatchSignal,
        ILogger<AdminNotificationEventService> logger)
    {
        _db = db;
        _dispatchSignal = dispatchSignal;
        _logger = logger;
    }

    public async Task<AdminNotificationEventResult> CreateAsync(AdminNotificationEventRequest request, string actorUserId, CancellationToken ct)
    {
        var source = AdminNotificationSourceCatalog.NormalizeSource(NormalizeText(request.Source, "system", 96));
        if (!AdminNotificationSourceCatalog.AllowedEventSources.Contains(source, StringComparer.OrdinalIgnoreCase))
            throw new InvalidOperationException($"不支持的通知来源：{source}");

        var title = NormalizeText(request.Title, string.Empty, 160);
        if (string.IsNullOrWhiteSpace(title))
            throw new InvalidOperationException("通知标题不能为空");

        var message = NormalizeNullableText(request.Message, 1000);
        var level = NormalizeText(request.Level, "info", 32);
        if (!AllowedLevels.Contains(level)) level = "info";
        var targetUserId = NormalizeNullableText(request.TargetUserId, 128);
        if (!string.IsNullOrWhiteSpace(targetUserId))
        {
            var targetExists = await _db.Users.Find(user =>
                    user.UserId == targetUserId
                    && user.Status == UserStatus.Active
                    && user.UserType == UserType.Human)
                .AnyAsync(ct);
            if (!targetExists)
                throw new InvalidOperationException("通知目标用户不存在或不可用，请更新目标用户 ID 后重试");
        }

        var now = DateTime.UtcNow;
        var key = BuildEventKey(source, request.DedupKey);
        var notification = new AdminNotification
        {
            Key = key,
            TargetUserId = targetUserId,
            Title = title,
            Message = message,
            Level = level,
            Status = "open",
            ActionLabel = NormalizeNullableText(request.ActionLabel, 64),
            ActionUrl = NormalizeNullableText(request.ActionUrl, 1024),
            ActionKind = NormalizeNullableText(request.ActionKind, 64),
            Source = source,
            Section = AdminNotificationSourceCatalog.ResolveSection(source, request.Section, targetUserId),
            Attachments = NormalizeAttachments(request.Attachments),
            CreatedAt = now,
            UpdatedAt = now,
            ExpiresAt = ResolveExpiresAt(request.ExpiresInDays, now),
        };

        if (!string.IsNullOrWhiteSpace(request.IncidentId))
        {
            return await UpsertIncidentAsync(notification, request, now, ct);
        }

        if (string.IsNullOrWhiteSpace(key))
        {
            await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct);
            _dispatchSignal.NotifyPending();
            _logger.LogInformation("管理员通知事件已创建 source={Source} actor={ActorUserId} notification={NotificationId}", source, actorUserId, notification.Id);
            return new AdminNotificationEventResult(notification, true);
        }

        var existing = await _db.AdminNotifications
            .Find(x => x.Key == key && x.TargetUserId == targetUserId)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync(ct);

        if (existing == null)
        {
            // 按目标隔离幂等身份，避免相同业务键的另一收件人抢占原通知。
            var identity = System.Text.Json.JsonSerializer.Serialize(new[] { key, targetUserId });
            notification.Id = "event-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
            try
            {
                await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct);
                _dispatchSignal.NotifyPending();
                _logger.LogInformation("管理员通知事件已创建 source={Source} key={Key} actor={ActorUserId} notification={NotificationId}", source, key, actorUserId, notification.Id);
                return new AdminNotificationEventResult(notification, true);
            }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            {
                existing = await _db.AdminNotifications.Find(x => x.Id == notification.Id).FirstAsync(ct);
            }
        }

        var update = Builders<AdminNotification>.Update
            .Set(x => x.TargetUserId, notification.TargetUserId)
            .Set(x => x.Title, notification.Title)
            .Set(x => x.Message, notification.Message)
            .Set(x => x.Level, notification.Level)
            .Set(x => x.ActionLabel, notification.ActionLabel)
            .Set(x => x.ActionUrl, notification.ActionUrl)
            .Set(x => x.ActionKind, notification.ActionKind)
            .Set(x => x.Source, notification.Source)
            .Set(x => x.Section, notification.Section)
            .Set(x => x.Attachments, notification.Attachments)
            .Set(x => x.UpdatedAt, now)
            .Set(x => x.ExpiresAt, notification.ExpiresAt);

        await _db.AdminNotifications.UpdateOneAsync(x => x.Id == existing.Id, update, cancellationToken: ct);
        // 相同幂等事件持续更新不撤销用户确认；新故障须由结构化生命周期开启新代次。
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

    private async Task<AdminNotificationEventResult> UpsertIncidentAsync(
        AdminNotification incoming, AdminNotificationEventRequest request, DateTime now, CancellationToken ct)
    {
        incoming.IncidentId = NormalizeNullableText(request.IncidentId, 256);
        incoming.IncidentState = request.IncidentState?.Trim().ToLowerInvariant() ?? "unknown";
        incoming.RequestOutcome = request.RequestOutcome?.Trim().ToLowerInvariant() ?? "unknown";
        if (incoming.IncidentState is not ("active" or "recovered" or "unknown")
            || incoming.RequestOutcome is not ("request_failed" or "request_succeeded" or "fallback_succeeded" or "all_failed" or "unknown"))
            throw new InvalidOperationException("通知事实状态无效，请检查事件来源后重试");
        incoming.FirstOccurredAt = request.FirstOccurredAt;
        incoming.LastOccurredAt = request.LastOccurredAt;
        incoming.RecoveredAt = request.RecoveredAt;
        incoming.OccurrenceCount = request.OccurrenceCount ?? 1;
        incoming.EvidenceRequestId = NormalizeNullableText(request.EvidenceRequestId, 160);
        if (incoming.OccurrenceCount < 1 || incoming.LastOccurredAt is null || incoming.FirstOccurredAt is null
            || incoming.FirstOccurredAt > incoming.LastOccurredAt
            || (incoming.IncidentState == "recovered" && (incoming.RecoveredAt is null || incoming.RecoveredAt < incoming.LastOccurredAt))
            || (incoming.IncidentState != "recovered" && incoming.RecoveredAt is not null))
            throw new InvalidOperationException("通知缺少有效的发生时间或恢复证据，请检查事件来源后重试");
        // 故障来源的管理员分区不能被事件载荷降为个人分区。
        incoming.Section = AdminNotificationSourceCatalog.ResolveSection(incoming.Source, null, incoming.TargetUserId);
        var identity = System.Text.Json.JsonSerializer.Serialize(new[] { incoming.Source, incoming.TargetUserId, incoming.IncidentId });
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
        incoming.Id = $"incident-{hash}";
        incoming.Key = $"admin-incident:{hash}";
        incoming.Level = incoming.IncidentState == "recovered" ? "success" : incoming.Level;
        incoming.ExpiresAt = incoming.IncidentState == "recovered" ? incoming.ExpiresAt : null;
        incoming.PushEpisodeStartedAtUtcTicks = now.Ticks;

        for (var attempt = 0; attempt < 5; attempt++)
        {
            var existing = await _db.AdminNotifications.Find(x => x.Id == incoming.Id).FirstOrDefaultAsync(ct);
            if (existing is null)
            {
                try
                {
                    await _db.AdminNotifications.InsertOneAsync(incoming, cancellationToken: ct);
                    _dispatchSignal.NotifyPending();
                    return new(incoming, true);
                }
                catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey) { continue; }
            }
            if (!ShouldApplyIncident(existing, incoming)) return new(existing, false);
            var changedState = existing.IncidentState != incoming.IncidentState;
            var escalated = incoming.Level == "error" && existing.Level != "error";
            var newEpisode = changedState || escalated;
            var update = Builders<AdminNotification>.Update
                .Set(x => x.Title, incoming.Title).Set(x => x.Message, incoming.Message)
                .Set(x => x.Level, incoming.Level).Set(x => x.IncidentState, incoming.IncidentState)
                .Set(x => x.RequestOutcome, incoming.RequestOutcome)
                .Set(x => x.OccurrenceCount, Math.Max(existing.OccurrenceCount, incoming.OccurrenceCount))
                .Set(x => x.FirstOccurredAt, existing.FirstOccurredAt ?? incoming.FirstOccurredAt)
                .Set(x => x.LastOccurredAt, incoming.LastOccurredAt).Set(x => x.RecoveredAt, incoming.RecoveredAt)
                .Set(x => x.EvidenceRequestId, incoming.EvidenceRequestId)
                .Set(x => x.ActionLabel, incoming.ActionLabel).Set(x => x.ActionUrl, incoming.ActionUrl)
                .Set(x => x.ActionKind, incoming.ActionKind).Set(x => x.ExpiresAt, incoming.ExpiresAt)
                .Set(x => x.UpdatedAt, now > existing.UpdatedAt.AddMilliseconds(1) ? now : existing.UpdatedAt.AddMilliseconds(1));
            if (newEpisode)
                update = update.Set(x => x.Status, "open").Set(x => x.HandledAt, null)
                    .Inc(x => x.PushEpisode, 1).Set(x => x.PushEpisodeStartedAtUtcTicks, now.Ticks);
            var filter = Builders<AdminNotification>.Filter.Eq(x => x.Id, existing.Id)
                & Builders<AdminNotification>.Filter.Eq(x => x.UpdatedAt, existing.UpdatedAt)
                & Builders<AdminNotification>.Filter.Eq(x => x.PushEpisode, existing.PushEpisode)
                & Builders<AdminNotification>.Filter.Eq(x => x.Status, existing.Status);
            var result = await _db.AdminNotifications.UpdateOneAsync(filter, update, cancellationToken: ct);
            if (result.MatchedCount == 0) continue;
            if (newEpisode) _dispatchSignal.NotifyPending();
            return new(await _db.AdminNotifications.Find(x => x.Id == incoming.Id).FirstAsync(ct), false);
        }
        throw new InvalidOperationException("通知正在更新，请稍后重试");
    }

    internal static bool ShouldApplyIncident(AdminNotification existing, AdminNotification incoming)
    {
        var previous = existing.RecoveredAt ?? existing.LastOccurredAt;
        var observed = incoming.RecoveredAt ?? incoming.LastOccurredAt;
        if (previous > observed) return false;
        // 相同时刻不能用成功覆盖失败；同一快照重复上报不累计或反复唤醒。
        if (previous == observed)
            return incoming.IncidentState == "active" && existing.IncidentState != "active"
                || incoming.IncidentState == existing.IncidentState
                   && (incoming.OccurrenceCount > existing.OccurrenceCount || incoming.Level == "error" && existing.Level != "error");
        return true;
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
    public string? IncidentId { get; set; }
    public string? IncidentState { get; set; }
    public string? RequestOutcome { get; set; }
    public long? OccurrenceCount { get; set; }
    public DateTime? FirstOccurredAt { get; set; }
    public DateTime? LastOccurredAt { get; set; }
    public DateTime? RecoveredAt { get; set; }
    public string? EvidenceRequestId { get; set; }
    public string? Source { get; set; }
    public string? Title { get; set; }
    public string? Message { get; set; }
    public string? Level { get; set; }
    public string? TargetUserId { get; set; }
    public string? TargetUsername { get; set; }
    public string? ActionLabel { get; set; }
    public string? ActionUrl { get; set; }
    public string? ActionKind { get; set; }
    public string? Section { get; set; }
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
