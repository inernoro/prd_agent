using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// 模型池故障/恢复通知实现
/// 利用 AdminNotification.Key 字段做幂等去重，同一事件只保留最新一条
/// </summary>
public class PoolFailoverNotifier : IPoolFailoverNotifier
{
    private readonly MongoDbContext _db;
    private readonly ILogger<PoolFailoverNotifier> _logger;

    public PoolFailoverNotifier(MongoDbContext db, ILogger<PoolFailoverNotifier> logger)
    {
        _db = db;
        _logger = logger;
    }

    public async Task NotifyPoolExhaustedAsync(ModelGroup pool, CancellationToken ct = default)
    {
        var key = $"pool-exhausted:{pool.Id}";
        var modelDetails = string.Join("、",
            pool.Models?.Select(m => $"{m.ModelId}（连续失败 {m.ConsecutiveFailures} 次）") ?? []);

        var message = $"模型池 \"{pool.Name}\"（{pool.ModelType}）中 {pool.Models?.Count ?? 0} 个端点全部失败。\n" +
                      $"系统已启动自动探活，恢复后将自动通知。\n" +
                      $"失败端点：{modelDetails}";

        await UpsertNotificationAsync(
            key: key,
            title: $"模型池 \"{pool.Name}\" 全部不可用",
            message: message,
            level: "warning",
            source: "model-pool-probe",
            ct: ct);

        _logger.LogWarning("[PoolFailoverNotifier] 模型池全部不可用通知已发送: {PoolName}", pool.Name);
    }

    public async Task NotifyPoolRecoveredAsync(
        ModelGroup pool, string recoveredModelId, TimeSpan downDuration, CancellationToken ct = default)
    {
        // 1. 发送恢复通知
        var recoveryKey = $"pool-recovered:{pool.Id}";
        var durationStr = downDuration.TotalMinutes >= 1
            ? $"{downDuration.TotalMinutes:F0} 分钟"
            : $"{downDuration.TotalSeconds:F0} 秒";

        await UpsertNotificationAsync(
            key: recoveryKey,
            title: $"模型池 \"{pool.Name}\" 已恢复",
            message: $"模型池 \"{pool.Name}\" 中 {recoveredModelId} 已通过探活恢复为健康状态。\n故障持续时间：{durationStr}。",
            level: "success",
            source: "model-pool-probe",
            ct: ct);

        // 2. 关闭对应的故障通知
        var exhaustedKey = $"pool-exhausted:{pool.Id}";
        await CloseNotificationByKeyAsync(exhaustedKey, ct);

        _logger.LogInformation(
            "[PoolFailoverNotifier] 模型池恢复通知已发送: {PoolName}, Model={Model}, DownDuration={Duration}",
            pool.Name, recoveredModelId, durationStr);
    }

    public async Task NotifyUserFailureAsync(
        string userId, string modelType, string poolName, CancellationToken ct = default)
    {
        var key = $"pool-unavailable-user:{userId}:{modelType}";

        await UpsertNotificationAsync(
            key: key,
            title: "AI 服务暂时不可用",
            message: $"当前 {modelType} 类型的 AI 模型暂时全部不可用，系统正在自动恢复中。恢复后将自动通知您。",
            level: "warning",
            source: "model-pool-probe",
            targetUserId: userId,
            ct: ct);
    }

    public async Task CloseUserFailureNotificationsAsync(string modelType, CancellationToken ct = default)
    {
        var keyPrefix = $"pool-unavailable-user:";
        var keySuffix = $":{modelType}";

        // 1. 先查出所有受影响的用户通知（需要提取 userId 来发恢复消息）
        var filter = Builders<AdminNotification>.Filter.And(
            Builders<AdminNotification>.Filter.Regex(n => n.Key, $"^{keyPrefix}.*{keySuffix}$"),
            Builders<AdminNotification>.Filter.Eq(n => n.Status, "open"));

        var openNotifications = await _db.AdminNotifications
            .Find(filter)
            .ToListAsync(ct);

        if (openNotifications.Count == 0)
            return;

        // 2. 关闭所有故障通知
        var update = Builders<AdminNotification>.Update
            .Set(n => n.Status, "closed")
            .Set(n => n.HandledAt, DateTime.UtcNow)
            .Set(n => n.UpdatedAt, DateTime.UtcNow);

        await _db.AdminNotifications.UpdateManyAsync(filter, update, cancellationToken: ct);

        // 3. 向每个受影响用户发送恢复通知（以最新一条为准，Key 幂等去重）
        var affectedUserIds = openNotifications
            .Where(n => !string.IsNullOrWhiteSpace(n.TargetUserId))
            .Select(n => n.TargetUserId!)
            .Distinct()
            .ToList();

        foreach (var userId in affectedUserIds)
        {
            var recoveryKey = $"pool-recovered-user:{userId}:{modelType}";

            await UpsertNotificationAsync(
                key: recoveryKey,
                title: "AI 服务已恢复",
                message: $"{modelType} 类型的 AI 模型已恢复正常，您现在可以继续使用。",
                level: "success",
                source: "model-pool-probe",
                targetUserId: userId,
                ct: ct);
        }

        _logger.LogInformation(
            "[PoolFailoverNotifier] 已关闭 {Count} 条用户故障通知并发送恢复消息: ModelType={ModelType}, AffectedUsers={Users}",
            openNotifications.Count, modelType, affectedUserIds.Count);
    }

    private async Task UpsertNotificationAsync(
        string key, string title, string message, string level, string source,
        string? targetUserId = null, CancellationToken ct = default)
    {
        var existing = await _db.AdminNotifications
            .Find(n => n.Key == key && n.Status == "open")
            .FirstOrDefaultAsync(ct);

        if (existing != null)
        {
            var update = Builders<AdminNotification>.Update
                .Set(n => n.Title, title)
                .Set(n => n.Message, message)
                .Set(n => n.Level, level)
                .Set(n => n.UpdatedAt, DateTime.UtcNow);

            await _db.AdminNotifications.UpdateOneAsync(
                n => n.Id == existing.Id, update, cancellationToken: ct);
        }
        else
        {
            var notification = new AdminNotification
            {
                Key = key,
                Title = title,
                Message = message,
                Level = level,
                Source = source,
                TargetUserId = targetUserId,
                Status = "open"
            };

            await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct);
        }
    }

    private async Task CloseNotificationByKeyAsync(string key, CancellationToken ct)
    {
        var filter = Builders<AdminNotification>.Filter.And(
            Builders<AdminNotification>.Filter.Eq(n => n.Key, key),
            Builders<AdminNotification>.Filter.Eq(n => n.Status, "open"));

        var update = Builders<AdminNotification>.Update
            .Set(n => n.Status, "closed")
            .Set(n => n.HandledAt, DateTime.UtcNow)
            .Set(n => n.UpdatedAt, DateTime.UtcNow);

        await _db.AdminNotifications.UpdateManyAsync(filter, update, cancellationToken: ct);
    }
}
