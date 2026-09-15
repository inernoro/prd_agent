using System.Security.Cryptography;
using System.Text;
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

    public Task NotifyQuotaExceededAsync(
        string? platformName,
        string? modelName,
        CancellationToken ct = default)
    {
        var environment = ResolveQuotaEnvironment(Environment.GetEnvironmentVariable);
        var platform = NormalizeQuotaDetail(platformName);
        var model = NormalizeQuotaDetail(modelName);

        return UpsertNotificationAsync(
            key: BuildQuotaNotificationKey(environment.Identity, platform, model),
            title: "AI 服务额度不足",
            message: BuildQuotaNotificationMessage(environment.Label, platform, model),
            level: "error",
            source: "llm-gateway-quota",
            targetUserId: null,
            ct: ct);
    }

    internal static string BuildQuotaNotificationMessage(
        string environmentLabel,
        string platformName,
        string modelName)
        => $"上游 AI 服务因额度不足拒绝了本次调用，本次 AI 创作未完成。\n" +
           $"环境：{environmentLabel}\n" +
           $"模型：{modelName}\n" +
           $"平台：{platformName}\n" +
           "请稍后重试；管理员需要检查服务额度或切换可用配置。诊断信息已保留。";

    internal static string BuildQuotaNotificationKey(
        string environmentIdentity,
        string platformName,
        string modelName)
    {
        var identity = $"{environmentIdentity}\n{platformName}\n{modelName}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))
            .ToLowerInvariant()[..16];
        return $"llm-quota-exceeded:v2:{hash}";
    }

    internal static (string Label, string Identity) ResolveQuotaEnvironment(
        Func<string, string?> readEnvironmentVariable)
    {
        var projectId = NormalizeEnvironmentValue(readEnvironmentVariable("CDS_PROJECT_ID"));
        var branch = NormalizeEnvironmentValue(readEnvironmentVariable("VITE_GIT_BRANCH"))
                     ?? NormalizeEnvironmentValue(readEnvironmentVariable("BULLMQ_PREFIX"));

        if (projectId != null)
        {
            return branch != null
                ? ($"CDS 预览环境（分支：{branch}）", $"cds:{projectId}:{branch}")
                : ($"CDS 预览环境（项目：{projectId}）", $"cds:{projectId}");
        }

        var hostEnvironment = NormalizeEnvironmentValue(readEnvironmentVariable("ASPNETCORE_ENVIRONMENT"))
                              ?? NormalizeEnvironmentValue(readEnvironmentVariable("DOTNET_ENVIRONMENT"));
        return hostEnvironment?.ToLowerInvariant() switch
        {
            "production" => ("正式环境", "production"),
            "staging" => ("预发布环境", "staging"),
            "test" or "testing" or "tests" => ("测试环境", "test"),
            "development" => ("本地开发环境", "development"),
            { Length: > 0 } value => ($"{hostEnvironment} 环境", value),
            _ => ("未识别环境", "unknown"),
        };
    }

    private static string NormalizeQuotaDetail(string? value)
    {
        var normalized = NormalizeEnvironmentValue(value);
        if (normalized == null) return "未能从网关响应确认";
        return normalized.Length <= 160 ? normalized : normalized[..160];
    }

    private static string? NormalizeEnvironmentValue(string? value)
    {
        var normalized = value?.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
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
                Status = "open",
                // 故障转移是「持续到恢复为止」的运营告警:就地更新 + 恢复时由 CloseNotificationByKeyAsync 关闭。
                // 显式置空覆盖 AdminNotification 的 7 天默认过期,避免未恢复的故障 7 天后从首页静默消失。
                ExpiresAt = null
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
