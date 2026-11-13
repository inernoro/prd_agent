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
        var message = $"模型池“{pool.Name}”当前记录的 {pool.Models?.Count ?? 0} 条线路均不可用。" +
                      "使用该池的新请求暂时没有可用线路，请切换可用模型或检查该池配置。后续检测确认恢复后更新状态。";

        await UpsertNotificationAsync(
            key: key,
            title: $"模型池 \"{pool.Name}\" 全部不可用",
            message: message,
            level: "warning",
            source: "model-pool-probe",
            ct: ct,
            incidentId: $"model-pool:{pool.Id}", incidentState: "active", requestOutcome: "unknown",
            actionUrl: $"/logs?modelPoolId={Uri.EscapeDataString(pool.Id)}");

        _logger.LogWarning("[PoolFailoverNotifier] 模型池全部不可用通知已发送: {PoolName}", pool.Name);
    }

    public async Task NotifyPoolRecoveredAsync(
        ModelGroup pool, string recoveredModelId, TimeSpan downDuration, CancellationToken ct = default)
    {
        // 1. 发送恢复通知
        var fault = await _db.AdminNotifications.Find(n => n.Key == $"pool-exhausted:{pool.Id}")
            .SortByDescending(n => n.CreatedAt).FirstOrDefaultAsync(ct);
        if (fault == null || fault.IncidentState == "recovered") return;
        var recoveryKey = $"pool-recovered:{pool.Id}:episode:{fault.PushEpisode}";
        var durationStr = downDuration.TotalMinutes >= 1
            ? $"{downDuration.TotalMinutes:F0} 分钟"
            : $"{downDuration.TotalSeconds:F0} 秒";

        await UpsertNotificationAsync(
            key: recoveryKey,
            title: $"模型池 \"{pool.Name}\" 已有可用线路",
            message: $"模型池 \"{pool.Name}\" 中 {recoveredModelId} 已通过检测，至少一条线路可用。\n" +
                (downDuration > TimeSpan.Zero ? $"本次记录的不可用时长约 {durationStr}。" : "完整故障持续时间未确认。"),
            level: "success",
            source: "model-pool-probe",
            ct: ct,
            incidentId: $"model-pool:{pool.Id}", incidentState: "recovered", requestOutcome: "unknown",
            actionUrl: $"/logs?modelPoolId={Uri.EscapeDataString(pool.Id)}");

        // 2. 关闭对应的故障通知
        var exhaustedKey = $"pool-exhausted:{pool.Id}";
        await CloseNotificationByKeyAsync(exhaustedKey, ct);

        _logger.LogInformation(
            "[PoolFailoverNotifier] 模型池恢复通知已发送: {PoolName}, Model={Model}, DownDuration={Duration}",
            pool.Name, recoveredModelId, durationStr);
    }

    public async Task NotifyUserFailureAsync(
        string userId, string modelType, string poolName, CancellationToken ct = default, string? poolId = null)
    {
        var key = string.IsNullOrWhiteSpace(poolId) ? $"pool-unavailable-user:{userId}:{modelType}"
            : $"pool-unavailable-user:v2:{userId}:{modelType}:{PoolIdentity(poolId)}";

        await UpsertNotificationAsync(
            key: key,
            title: $"所选模型 {poolName} 暂时不可用",
            message: $"本次选择的模型“{poolName}”暂时没有可用线路，请切换可用模型或稍后重试。历史失败请求不会自动重做。",
            level: "warning",
            source: "model-pool-probe",
            targetUserId: userId,
            ct: ct,
            incidentId: string.IsNullOrWhiteSpace(poolId) ? null : $"model-pool:{poolId}",
            incidentState: string.IsNullOrWhiteSpace(poolId) ? "unknown" : "active",
            requestOutcome: "request_failed");
    }

    public async Task CloseUserFailureNotificationsAsync(string modelType, CancellationToken ct = default, string? poolId = null, DateTime? recoveredAt = null)
    {
        // A successful probe of one pool cannot prove that every pool of this type is healthy.
        // Legacy callers without a stable pool ID have no evidence to close user incidents.
        if (string.IsNullOrWhiteSpace(poolId))
        {
            _logger.LogWarning("[PoolFailoverNotifier] 恢复事件缺少模型池身份，保留用户故障状态: ModelType={ModelType}", modelType);
            return;
        }
        var incidentId = $"model-pool:{poolId}";
        var now = recoveredAt ?? DateTime.UtcNow;
        var filter = Builders<AdminNotification>.Filter.Eq(n => n.IncidentId, incidentId)
            & Builders<AdminNotification>.Filter.Eq(n => n.Source, "model-pool-probe")
            & Builders<AdminNotification>.Filter.Eq(n => n.RequestOutcome, "request_failed")
            & Builders<AdminNotification>.Filter.Ne(n => n.IncidentState, "recovered")
            & Builders<AdminNotification>.Filter.Lt(n => n.LastOccurredAt, now);
        var failures = await _db.AdminNotifications.Find(filter).ToListAsync(ct);
        if (failures.Count == 0) return;
        var confirmed = new List<AdminNotification>();
        foreach (var failure in failures)
        {
            var current = filter & Builders<AdminNotification>.Filter.Eq(n => n.Id, failure.Id)
                & Builders<AdminNotification>.Filter.Eq(n => n.OccurrenceCount, failure.OccurrenceCount)
                & Builders<AdminNotification>.Filter.Eq(n => n.PushEpisode, failure.PushEpisode)
                & Builders<AdminNotification>.Filter.Eq(n => n.LastOccurredAt, failure.LastOccurredAt);
            var result = await _db.AdminNotifications.UpdateOneAsync(current, Builders<AdminNotification>.Update
                .Set(n => n.Status, "closed").Set(n => n.IncidentState, "recovered")
                .Set(n => n.RecoveredAt, now).Set(n => n.UpdatedAt, DateTime.UtcNow), cancellationToken: ct);
            if (result.ModifiedCount == 1) confirmed.Add(failure);
        }
        var poolName = await _db.ModelGroups.Find(x => x.Id == poolId).Project(x => x.Name).FirstOrDefaultAsync(ct);
        foreach (var userId in confirmed.Where(n => !string.IsNullOrWhiteSpace(n.TargetUserId))
                     .Select(n => n.TargetUserId!).Distinct())
        {
            await UpsertNotificationAsync(
                key: $"pool-recovered-user:v2:{userId}:{modelType}:{PoolIdentity(poolId)}:episode:{confirmed.Where(n => n.TargetUserId == userId).Max(n => n.PushEpisode)}",
                title: string.IsNullOrWhiteSpace(poolName) ? "所选模型已出现可用线路" : $"{poolName} 已出现可用线路",
                message: $"{(string.IsNullOrWhiteSpace(poolName) ? "此前不可用的所选模型" : poolName)}已通过检测，至少一条线路恢复可用。您可以重试之前失败的请求。",
                level: "success", source: "model-pool-probe", targetUserId: userId, ct: ct,
                incidentId: incidentId, incidentState: "recovered", requestOutcome: "unknown");
        }
    }

    private static string PoolIdentity(string poolId)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(poolId))).ToLowerInvariant()[..24];

    public Task NotifyQuotaExceededAsync(
        string? platformName,
        string? modelName,
        CancellationToken ct = default)
    {
        var environment = ResolveQuotaEnvironment(Environment.GetEnvironmentVariable);
        var safePlatform = SafeQuotaObjectName(platformName);
        var safeModel = SafeQuotaObjectName(modelName);
        var platform = safePlatform ?? "未能从网关响应确认";
        var model = safeModel ?? "未能从网关响应确认";
        var knownObject = safePlatform != null && safeModel != null;
        var key = BuildQuotaNotificationKey(environment.Identity, platform, model);

        return UpsertNotificationAsync(
            key: key,
            title: knownObject ? $"{platform} · {model}：上游额度不足" : "上游额度不足（对象尚未确认）",
            message: BuildQuotaNotificationMessage(environment.Label, platform, model),
            level: "error",
            source: "llm-gateway-quota",
            targetUserId: null,
            ct: ct,
            incidentId: knownObject ? key : null,
            incidentState: knownObject ? "active" : "unknown",
            requestOutcome: "unknown");
    }

    internal static string BuildQuotaNotificationMessage(
        string environmentLabel,
        string platformName,
        string modelName)
        => "上游因额度不足拒绝了一次调用，整次请求结果尚未确认。" +
           "管理员请检查该平台账户余额和线路额度，或切换可用配置。\n" +
           $"环境：{environmentLabel}；模型：{modelName}；平台：{platformName}。";

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

    private static string? SafeQuotaObjectName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 160 || value.Any(char.IsControl)) return null;
        var name = value.Trim();
        if (name.Any(c => !char.IsLetterOrDigit(c) && !" -_./():+".Contains(c)) || name.Contains("://")) return null;
        if (new[] { "authorization", "api_key", "api-key", "apikey", "password", "secret" }
            .Any(marker => name.Contains(marker, StringComparison.OrdinalIgnoreCase))) return null;
        if (name.Split(' ', ':', '/').Any(part => part.Equals("bearer", StringComparison.OrdinalIgnoreCase)
            || part.Equals("token", StringComparison.OrdinalIgnoreCase)
            || part.StartsWith("sk-", StringComparison.OrdinalIgnoreCase)
            || part.StartsWith("eyJ", StringComparison.Ordinal))) return null;
        return name;
    }

    private static string? NormalizeEnvironmentValue(string? value)
    {
        var normalized = value?.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private async Task UpsertNotificationAsync(
        string key, string title, string message, string level, string source,
        string? targetUserId = null, CancellationToken ct = default,
        string? incidentId = null, string? incidentState = null, string? requestOutcome = null,
        string? actionUrl = null, DateTime? observedAt = null)
    {
        // The event time belongs to this observation, not to a later CAS retry.
        var eventAt = observedAt ?? DateTime.UtcNow;
        var existing = await _db.AdminNotifications
            .Find(n => n.Key == key)
            .SortByDescending(n => n.CreatedAt)
            .FirstOrDefaultAsync(ct);
        var section = string.IsNullOrWhiteSpace(targetUserId)
            ? AdminNotificationSections.Admin : AdminNotificationSections.Personal;

        if (existing != null)
        {
            var update = Builders<AdminNotification>.Update
                .Set(n => n.Title, title)
                .Set(n => n.Message, message)
                .Set(n => n.Level, level)
                .Set(n => n.Section, section)
                .Set(n => n.UpdatedAt, DateTime.UtcNow);
            var writeFilter = Builders<AdminNotification>.Filter.Eq(n => n.Id, existing.Id);
            if (incidentId != null)
            {
                var olderThanRecovery = incidentState == "active" && existing.IncidentState == "recovered"
                    && existing.RecoveredAt.HasValue && eventAt < existing.RecoveredAt.Value;
                update = update.Set(n => n.IncidentId, incidentId);
                if (!olderThanRecovery)
                    update = update.Set(n => n.IncidentState, incidentState).Set(n => n.RequestOutcome, requestOutcome)
                        .Set(n => n.RecoveredAt, incidentState == "recovered" ? eventAt : null);
                if (incidentState == "active")
                {
                    // Missing tracking fields are not evidence of historical occurrence counts.
                    if (existing.IncidentId == incidentId && existing.FirstOccurredAt.HasValue)
                        update = update.Inc(n => n.OccurrenceCount, 1)
                            .Min(n => n.FirstOccurredAt, eventAt).Max(n => n.LastOccurredAt, eventAt);
                    else
                        update = update.Set(n => n.OccurrenceCount, 1)
                            .Set(n => n.FirstOccurredAt, eventAt).Set(n => n.LastOccurredAt, eventAt);
                }
                if (!olderThanRecovery && existing.IncidentState == "recovered" && incidentState == "active")
                    update = update.Set(n => n.Status, "open").Inc(n => n.PushEpisode, 1)
                        .Set(n => n.PushEpisodeStartedAtUtcTicks, DateTime.UtcNow.Ticks).Set(n => n.HandledAt, null);
                // Only one observer can open this recurrence. A loser reloads the current
                // state and counts its real failure once without opening another episode.
                writeFilter &= Builders<AdminNotification>.Filter.Eq(n => n.IncidentState, existing.IncidentState)
                    & Builders<AdminNotification>.Filter.Eq(n => n.IncidentId, existing.IncidentId)
                    & Builders<AdminNotification>.Filter.Eq(n => n.FirstOccurredAt, existing.FirstOccurredAt)
                    & (existing.PushEpisode == 0
                        ? Builders<AdminNotification>.Filter.Eq(n => n.PushEpisode, 0)
                          | Builders<AdminNotification>.Filter.Exists(n => n.PushEpisode, false)
                        : Builders<AdminNotification>.Filter.Eq(n => n.PushEpisode, existing.PushEpisode));
            }
            else if (incidentState != null)
                update = update.Set(n => n.IncidentState, incidentState).Set(n => n.RequestOutcome, requestOutcome);

            if (string.IsNullOrWhiteSpace(targetUserId) && actionUrl != null)
                update = update.Set(n => n.ActionUrl, actionUrl).Set(n => n.ActionLabel, "查看线路日志")
                    .Set(n => n.ActionKind, "llm-gateway");
            var result = await _db.AdminNotifications.UpdateOneAsync(writeFilter, update, cancellationToken: ct);
            if (result.MatchedCount == 0)
                await UpsertNotificationAsync(key, title, message, level, source, targetUserId, ct,
                    incidentId, incidentState, requestOutcome, actionUrl, eventAt);
        }
        else
        {
            var notification = new AdminNotification
            {
                Id = "pool-notification-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant()[..32],
                Key = key,
                Title = title,
                Message = message,
                Level = level,
                Source = source,
                Section = section,
                TargetUserId = targetUserId,
                Status = "open",
                IncidentId = incidentId,
                IncidentState = incidentState,
                RequestOutcome = requestOutcome,
                FirstOccurredAt = incidentId != null && incidentState == "active" ? eventAt : null,
                LastOccurredAt = incidentId != null && incidentState == "active" ? eventAt : null,
                RecoveredAt = incidentState == "recovered" ? eventAt : null,
                ActionUrl = string.IsNullOrWhiteSpace(targetUserId) ? actionUrl : null,
                ActionLabel = string.IsNullOrWhiteSpace(targetUserId) && actionUrl != null ? "查看线路日志" : null,
                ActionKind = string.IsNullOrWhiteSpace(targetUserId) && actionUrl != null ? "llm-gateway" : null,
                // 故障转移是「持续到恢复为止」的运营告警:就地更新 + 恢复时由 CloseNotificationByKeyAsync 关闭。
                // 显式置空覆盖 AdminNotification 的 7 天默认过期,避免未恢复的故障 7 天后从首页静默消失。
                ExpiresAt = incidentState == "recovered" ? DateTime.UtcNow.AddDays(7) : null
            };

            try { await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: ct); }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            {
                await UpsertNotificationAsync(key, title, message, level, source, targetUserId, ct,
                    incidentId, incidentState, requestOutcome, actionUrl, eventAt);
            }
        }
    }

    private async Task CloseNotificationByKeyAsync(string key, CancellationToken ct)
    {
        var filter = Builders<AdminNotification>.Filter.And(
            Builders<AdminNotification>.Filter.Eq(n => n.Key, key));

        var update = Builders<AdminNotification>.Update
            .Set(n => n.Status, "closed")
            .Set(n => n.IncidentState, "recovered")
            .Set(n => n.RecoveredAt, DateTime.UtcNow)
            .Set(n => n.UpdatedAt, DateTime.UtcNow);

        await _db.AdminNotifications.UpdateManyAsync(filter, update, cancellationToken: ct);
    }
}
