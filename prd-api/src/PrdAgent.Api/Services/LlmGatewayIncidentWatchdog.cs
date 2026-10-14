using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services;

/// <summary>
/// 将独立 LLM Gateway 的上游故障投影为 MAP 管理员通知。
/// 只消费脱敏后的请求日志，不读取或复制请求正文、响应正文和密钥。
/// </summary>
public sealed class LlmGatewayIncidentWatchdog : BackgroundService
{
    private readonly LlmGatewayDataContext _gatewayDb;
    private readonly MongoDbContext _mapDb;
    private readonly AdminPushDispatchSignal _pushSignal;
    private readonly ILogger<LlmGatewayIncidentWatchdog> _logger;
    private readonly TimeSpan _interval;
    private readonly TimeSpan _lookback;
    private readonly bool _canPublishNotifications;
    private readonly string _internalTenantId;

    public LlmGatewayIncidentWatchdog(
        LlmGatewayDataContext gatewayDb,
        MongoDbContext mapDb,
        AdminPushDispatchSignal pushSignal,
        IConfiguration configuration,
        ILogger<LlmGatewayIncidentWatchdog> logger)
    {
        _gatewayDb = gatewayDb;
        _mapDb = mapDb;
        _pushSignal = pushSignal;
        _logger = logger;
        _internalTenantId = configuration["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenantId
            ? tenantId
            : GatewayTenantDefaults.InternalTenantId;
        _canPublishNotifications = CanPublishNotifications(configuration);
        _interval = TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue("LlmGateway:IncidentWatchdog:IntervalSeconds", 30), 10, 300));
        _lookback = TimeSpan.FromMinutes(Math.Clamp(
            configuration.GetValue("LlmGateway:IncidentWatchdog:LookbackMinutes", 15), 2, 120));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_canPublishNotifications)
        {
            _logger.LogInformation(
                "[LlmGatewayIncidentWatchdog] 当前为非权威部署，跳过共享管理员通知写入");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await SweepOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[LlmGatewayIncidentWatchdog] 扫描失败，下轮自动重试");
            }

            await Task.Delay(_interval, stoppingToken);
        }
    }

    internal static bool CanPublishNotifications(IConfiguration configuration)
        => DeploymentAuthority.IsAuthoritativeDeployment(configuration);

    internal async Task SweepOnceAsync(CancellationToken ct)
    {
        var since = DateTime.UtcNow - _lookback;
        var logs = await _gatewayDb.LlmRequestLogs
            .Find(x => x.StartedAt >= since
                       && x.TenantId == _internalTenantId
                       && x.IsHealthProbe != true
                       && (x.Status == "failed" || x.Status == "succeeded"))
            .SortByDescending(x => x.StartedAt)
            .Limit(5000)
            .ToListAsync(ct);

        var signals = LlmGatewayIncidentPolicy.BuildSignals(logs);
        var changed = false;
        foreach (var signal in signals)
        {
            changed |= signal.IsFailure
                ? await UpsertFailureAsync(signal, ct)
                : await CloseFailureAndNotifyRecoveryAsync(signal, ct);
        }

        changed |= await NotifyConsumptionAlertsAsync(ct);
        if (changed)
        {
            _pushSignal.NotifyPending();
        }
    }

    private async Task<bool> NotifyConsumptionAlertsAsync(CancellationToken ct)
    {
        var alerts = _gatewayDb.Database.GetCollection<BsonDocument>("llmgw_consumption_alerts");
        var filter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("TenantId", _internalTenantId),
            Builders<BsonDocument>.Filter.Eq("Status", "open"),
            Builders<BsonDocument>.Filter.Eq("NotifiedAt", BsonNull.Value),
            Builders<BsonDocument>.Filter.Gte("CreatedAt", DateTime.UtcNow.AddDays(-2)));
        var pending = await alerts.Find(filter).Sort(Builders<BsonDocument>.Sort.Ascending("CreatedAt"))
            .Limit(100).ToListAsync(ct);
        var changed = false;
        foreach (var alert in pending)
        {
            var notification = BuildConsumptionNotification(alert);
            if (notification is null) continue;
            // 固定通知 _id + SetOnInsert：多实例、崩溃重试不会再次生成相同通知或复活已处理通知。
            var update = Builders<AdminNotification>.Update
                .SetOnInsert(x => x.Key, notification.Key)
                .SetOnInsert(x => x.Title, notification.Title)
                .SetOnInsert(x => x.Message, notification.Message)
                .SetOnInsert(x => x.Level, notification.Level)
                .SetOnInsert(x => x.Status, notification.Status)
                .SetOnInsert(x => x.Source, notification.Source)
                .SetOnInsert(x => x.Section, notification.Section)
                .SetOnInsert(x => x.ActionLabel, notification.ActionLabel)
                .SetOnInsert(x => x.ActionUrl, notification.ActionUrl)
                .SetOnInsert(x => x.ActionKind, notification.ActionKind)
                .SetOnInsert(x => x.CreatedAt, notification.CreatedAt)
                .SetOnInsert(x => x.UpdatedAt, notification.UpdatedAt)
                .SetOnInsert(x => x.ExpiresAt, notification.ExpiresAt);
            try
            {
                var result = await _mapDb.AdminNotifications.UpdateOneAsync(
                    x => x.Id == notification.Id, update, new UpdateOptions { IsUpsert = true }, ct);
                changed |= result.UpsertedId is not null;
            }
            catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
            {
                // 另一个权威副本已插入同一通知，继续标记已转发。
            }
            await alerts.UpdateOneAsync(Builders<BsonDocument>.Filter.Eq("_id", alert["_id"]),
                Builders<BsonDocument>.Update.Set("NotifiedAt", DateTime.UtcNow), cancellationToken: ct);
        }
        return changed;
    }

    internal static AdminNotification? BuildConsumptionNotification(BsonDocument alert)
    {
        var id = alert.GetValue("_id", "").ToString();
        if (string.IsNullOrWhiteSpace(id)) return null;
        var blocked = alert.GetValue("Kind", "warning").AsString == "blocked";
        var caller = alert.GetValue("AppCallerCode", "unknown").AsString;
        var origin = alert.GetValue("Origin", "general").AsString == "automatic" ? "自动任务" : "一般调用";
        var requestId = alert.GetValue("RequestId", "").AsString;
        return new AdminNotification
        {
            Id = $"llmgw-consumption-{id}", Key = $"llmgw-consumption:{id}",
            Title = blocked ? "模型调用频率超限，平台已拦截" : "模型调用接近频率上限",
            Message = $"{caller} 的{origin}在 {alert.GetValue("WindowSeconds", 60)} 秒窗口内达到 "
                      + $"{alert.GetValue("Count", 0)}/{alert.GetValue("Limit", 0)} 次。"
                      + (blocked ? "超额请求已在发送上游之前拒绝。" : "已达到预警阈值，请检查是否存在异常自动触发。")
                      + $"来源部署：{alert.GetValue("SourceDeployment", "未标记")}；请求编号：{requestId}。",
            Level = blocked ? "error" : "warning", Source = "gateway-alert",
            Section = AdminNotificationSections.Admin,
            ActionLabel = "查看消费预警", ActionUrl = $"/logs?requestId={Uri.EscapeDataString(requestId)}",
            ActionKind = "llm-gateway",
        };
    }

    private async Task<bool> UpsertFailureAsync(LlmGatewayIncidentSignal signal, CancellationToken ct)
    {
        var key = $"llmgw-upstream:{signal.Fingerprint}";
        var existing = await _mapDb.AdminNotifications
            .Find(x => x.Key == key)
            .SortByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);
        var now = DateTime.UtcNow;
        var actionUrl = $"/logs?requestId={Uri.EscapeDataString(signal.RequestId)}";
        var message = $"{signal.AppCallerLabel} 调用 {signal.ModelLabel} 失败：{signal.FailureSummary}。"
                      + $"\n平台：{signal.PlatformLabel}；最近窗口失败 {signal.FailureCount} 次；请求编号：{signal.RequestId}。"
                      + "\n系统会持续观察该上游；出现成功请求后自动关闭本故障并通知恢复。";

        if (existing is not null)
        {
            var shouldReopen = string.Equals(existing.Status, "closed", StringComparison.OrdinalIgnoreCase);
            if (!shouldReopen
                && string.Equals(existing.Title, $"LLM Gateway 上游异常：{signal.ModelLabel}", StringComparison.Ordinal)
                && string.Equals(existing.Message, message, StringComparison.Ordinal)
                && string.Equals(existing.ActionUrl, actionUrl, StringComparison.Ordinal))
            {
                return false;
            }

            var update = Builders<AdminNotification>.Update
                .Set(x => x.Title, $"LLM Gateway 上游异常：{signal.ModelLabel}")
                .Set(x => x.Message, message)
                .Set(x => x.Level, "error")
                .Set(x => x.ActionLabel, "查看网关日志")
                .Set(x => x.ActionUrl, actionUrl)
                .Set(x => x.ActionKind, "llm-gateway")
                .Set(x => x.UpdatedAt, now);
            if (shouldReopen)
            {
                update = update
                    .Set(x => x.Status, "open")
                    .Unset(x => x.HandledAt);
            }
            await _mapDb.AdminNotifications.UpdateOneAsync(x => x.Id == existing.Id, update, cancellationToken: ct);
            return shouldReopen;
        }

        await _mapDb.AdminNotifications.InsertOneAsync(new AdminNotification
        {
            Id = $"llmgw-upstream-{signal.Fingerprint}",
            Key = key,
            Title = $"LLM Gateway 上游异常：{signal.ModelLabel}",
            Message = message,
            Level = "error",
            Status = "open",
            Source = "gateway-alert",
            Section = AdminNotificationSections.Admin,
            ActionLabel = "查看网关日志",
            ActionUrl = actionUrl,
            ActionKind = "llm-gateway",
            ExpiresAt = null,
        }, cancellationToken: ct);

        _logger.LogWarning(
            "[LlmGatewayIncidentWatchdog] 上游故障已通知: Platform={Platform}, Model={Model}, RequestId={RequestId}",
            signal.PlatformLabel, signal.ModelLabel, signal.RequestId);
        return true;
    }

    private async Task<bool> CloseFailureAndNotifyRecoveryAsync(LlmGatewayIncidentSignal signal, CancellationToken ct)
    {
        var failureKey = $"llmgw-upstream:{signal.Fingerprint}";
        var now = DateTime.UtcNow;
        var transitionFilter = Builders<AdminNotification>.Filter.And(
            Builders<AdminNotification>.Filter.Eq(x => x.Key, failureKey),
            Builders<AdminNotification>.Filter.Ne(x => x.Status, "closed"));
        var transitionUpdate = Builders<AdminNotification>.Update
                .Set(x => x.Status, "closed")
                .Set(x => x.HandledAt, now)
                .Set(x => x.UpdatedAt, now);
        var transitioned = await _mapDb.AdminNotifications.FindOneAndUpdateAsync(
            transitionFilter,
            transitionUpdate,
            new FindOneAndUpdateOptions<AdminNotification, AdminNotification> { ReturnDocument = ReturnDocument.Before },
            ct);
        if (transitioned is null) return false;

        var recoveryKey = $"llmgw-upstream-recovered:{signal.Fingerprint}:{signal.RequestId}";
        await _mapDb.AdminNotifications.InsertOneAsync(new AdminNotification
        {
            Id = $"llmgw-recovered-{signal.Fingerprint}-{signal.RequestId}",
            Key = recoveryKey,
            Title = $"LLM Gateway 上游已恢复：{signal.ModelLabel}",
            Message = $"{signal.PlatformLabel} 上的 {signal.ModelLabel} 已出现成功请求，故障告警已自动关闭。请求编号：{signal.RequestId}。",
            Level = "success",
            Status = "open",
            Source = "gateway-alert",
            Section = AdminNotificationSections.Admin,
            ActionLabel = "查看恢复请求",
            ActionUrl = $"/logs?requestId={Uri.EscapeDataString(signal.RequestId)}",
            ActionKind = "llm-gateway",
            ExpiresAt = now.AddDays(7),
        }, cancellationToken: ct);

        _logger.LogInformation(
            "[LlmGatewayIncidentWatchdog] 上游恢复已通知: Platform={Platform}, Model={Model}, RequestId={RequestId}",
            signal.PlatformLabel, signal.ModelLabel, signal.RequestId);
        return true;
    }
}

internal static class LlmGatewayIncidentPolicy
{
    internal static IReadOnlyList<LlmGatewayIncidentSignal> BuildSignals(IEnumerable<LlmRequestLog> logs)
    {
        return logs
            .Where(IsRelevant)
            .GroupBy(BuildFingerprint)
            .Select(group =>
            {
                var ordered = group.OrderBy(x => x.StartedAt).ToList();
                var latest = ordered[^1];

                var isFailure = IsFailure(latest);
                var failureCount = ordered.Count(IsFailure);
                return new LlmGatewayIncidentSignal(
                    group.Key,
                    isFailure,
                    latest.RequestId,
                    Display(latest.AppCallerCodeDisplayName, latest.AppCallerTitle, latest.AppCallerCode, "未登记调用方"),
                    Display(latest.PlatformName, latest.Provider, "未知平台"),
                    Display(latest.Model, latest.ExpectedModel, latest.LogicalModelPublicId, "未知模型"),
                    isFailure ? SummarizeFailure(latest) : string.Empty,
                    failureCount);
            })
            .ToList();
    }

    internal static bool IsFailure(LlmRequestLog log)
        => string.Equals(log.Status, "failed", StringComparison.OrdinalIgnoreCase)
           && (log.StatusCode is >= 500
               || ContainsAny(log.Error, "timeout", "timed out", "connection", "HTTP 502", "HTTP 503", "HTTP 504", "不可用"));

    private static bool IsRelevant(LlmRequestLog log)
        => log.IsHealthProbe != true
           && !string.IsNullOrWhiteSpace(log.RequestId)
           && (string.Equals(log.Status, "succeeded", StringComparison.OrdinalIgnoreCase) || IsFailure(log));

    private static string BuildFingerprint(LlmRequestLog log)
    {
        var identity = string.Join("|",
            log.TenantId?.Trim().ToLowerInvariant(),
            First(log.PlatformId, log.PlatformName, log.Provider)?.ToLowerInvariant(),
            First(log.Model, log.ExpectedModel, log.LogicalModelPublicId)?.ToLowerInvariant(),
            log.RequestType?.Trim().ToLowerInvariant());
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant()[..24];
    }

    private static string SummarizeFailure(LlmRequestLog log)
    {
        return log.StatusCode switch
        {
            502 => "上游返回 HTTP 502",
            503 => "上游返回 HTTP 503",
            504 => "上游响应超时（HTTP 504）",
            >= 500 => $"上游返回 HTTP {log.StatusCode}",
            _ when ContainsAny(log.Error, "timeout", "timed out") => "上游响应超时",
            _ when ContainsAny(log.Error, "connection") => "上游连接失败",
            _ => "上游请求失败",
        };
    }

    private static string Display(params string?[] values) => First(values) ?? string.Empty;

    private static string? First(params string?[] values)
        => values.Select(x => x?.Trim()).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));

    private static bool ContainsAny(string? value, params string[] needles)
        => !string.IsNullOrWhiteSpace(value)
           && needles.Any(needle => value.Contains(needle, StringComparison.OrdinalIgnoreCase));
}

internal sealed record LlmGatewayIncidentSignal(
    string Fingerprint,
    bool IsFailure,
    string RequestId,
    string AppCallerLabel,
    string PlatformLabel,
    string ModelLabel,
    string FailureSummary,
    int FailureCount);
