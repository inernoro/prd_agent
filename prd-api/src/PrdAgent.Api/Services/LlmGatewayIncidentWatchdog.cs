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
/// 将独立 LLM Gateway 的入口和上游故障投影为 MAP 管理员通知。
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
            .Find(x => (x.EndedAt >= since || (x.EndedAt == null && x.StartedAt >= since))
                       && x.TenantId == _internalTenantId
                       && x.IsHealthProbe != true
                       && (x.Status == "failed" || x.Status == "succeeded" || x.Status == "running" || x.Status == "cancelled"))
            .SortByDescending(x => x.StartedAt)
            .Limit(5000)
            .ToListAsync(ct);

        var signals = LlmGatewayIncidentPolicy.BuildTimelineSignals(logs);
        var changed = false;
        foreach (var signal in signals)
        {
            changed |= signal.IsFailure
                ? await UpsertFailureAsync(signal, ct)
                : await CloseFailureAndNotifyRecoveryAsync(signal, ct);
        }

        await MarkLegacyRouteScopeUnknownAsync(ct);
        changed |= await NotifyConsumptionAlertsAsync(ct);
        if (changed)
        {
            _pushSignal.NotifyPending();
        }
    }

    private async Task MarkLegacyRouteScopeUnknownAsync(CancellationToken ct)
    {
        // Old pipe-separated route hashes omitted team/deployment/environment. They cannot
        // safely be assigned to one new scope, nor recovered by a success in that scope.
        // Keep the original visible record and evidence; this is migration, not a new event.
        var filter = Builders<AdminNotification>.Filter.Eq(x => x.Source, "gateway-alert")
            & Builders<AdminNotification>.Filter.Regex(x => x.Key, new BsonRegularExpression("^llmgw-upstream:[0-9a-f]{24}$"))
            & Builders<AdminNotification>.Filter.Eq(x => x.IncidentId, null)
            & Builders<AdminNotification>.Filter.Eq(x => x.IncidentState, null)
            & Builders<AdminNotification>.Filter.Eq(x => x.Status, "open");
        var legacy = await _mapDb.AdminNotifications.Find(filter).ToListAsync(ct);
        foreach (var row in legacy)
        {
            await _mapDb.AdminNotifications.UpdateOneAsync(filter
                    & Builders<AdminNotification>.Filter.Eq(x => x.Id, row.Id)
                    & Builders<AdminNotification>.Filter.Eq(x => x.UpdatedAt, row.UpdatedAt)
                    & Builders<AdminNotification>.Filter.Eq(x => x.Title, row.Title)
                    & Builders<AdminNotification>.Filter.Eq(x => x.Message, row.Message),
                Builders<AdminNotification>.Update.Set(x => x.IncidentState, "unknown")
                    .Set(x => x.RequestOutcome, "unknown")
                    .Set(x => x.Title, $"历史范围待核对 · {row.Title}")
                    .Set(x => x.Message, "旧版通知未保存完整故障范围，当前状态与请求结果尚未确认。新范围的故障和恢复记录不代表此历史记录已恢复或已处理，请查看原始日志核对。\n" + row.Message),
                cancellationToken: ct);
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
        var dynamicRate = alert.GetValue("Metric", "requests").AsString == "request_rate_baseline";
        var caller = alert.GetValue("AppCallerCode", "unknown").AsString;
        var origin = alert.GetValue("Origin", "general").AsString == "automatic" ? "自动任务" : "一般调用";
        var requestId = alert.GetValue("RequestId", "").AsString;
        return new AdminNotification
        {
            Id = $"llmgw-consumption-{id}", Key = $"llmgw-consumption:{id}",
            Title = dynamicRate ? "模型调用量相对历史基线异常增长" : blocked ? "模型调用频率超限，平台已拦截" : "模型调用接近频率上限",
            Message = (dynamicRate
                ? $"{caller} 的{origin}在 {alert.GetValue("WindowSeconds", 60)} 秒窗口内达到 {alert.GetValue("Count", 0)} 次，"
                  + $"动态触发线 {alert.GetValue("Limit", 0)} 次；历史均值 {alert.GetValue("BaselineAverage", 0)}，"
                  + $"样本为 {alert.GetValue("BaselineSamples", 0)} 个已结束窗口。请检查任务范围；此预警不修改现有限额。"
                : $"{caller} 的{origin}在 {alert.GetValue("WindowSeconds", 60)} 秒窗口内达到 "
                      + $"{alert.GetValue("Count", 0)}/{alert.GetValue("Limit", 0)} 次。"
                      + (blocked ? "超额请求已在发送上游之前拒绝。" : "已达到预警阈值，请检查是否存在异常自动触发。")
                      ) + $"来源部署：{alert.GetValue("SourceDeployment", "未标记")}；请求编号：{requestId}。",
            Level = blocked ? "error" : "warning", Source = "gateway-alert",
            Section = AdminNotificationSections.Admin,
            ActionLabel = "查看消费预警", ActionUrl = $"/logs?requestId={Uri.EscapeDataString(requestId)}",
            ActionKind = "llm-gateway",
        };
    }

    private async Task<bool> UpsertFailureAsync(LlmGatewayIncidentSignal signal, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var changed = await UpsertFailureOnceAsync(signal, ct);
            if (changed.HasValue) return changed.Value;
        }
        return false;
    }

    private async Task<bool?> UpsertFailureOnceAsync(LlmGatewayIncidentSignal signal, CancellationToken ct)
    {
        var key = $"llmgw-upstream:{signal.Fingerprint}";
        var existing = await FindCurrentFailureAsync(key, ct);
        var now = DateTime.UtcNow;
        var actionUrl = $"/logs?requestId={Uri.EscapeDataString(signal.RequestId)}";
        var title = BuildIncidentTitle(signal);
        var message = BuildIncidentMessage(signal);
        var level = signal.RequestOutcome is "fallback_succeeded" or "unknown" ? "warning" : "error";

        if (existing is not null)
        {
            var order = string.CompareOrdinal(existing.GatewaySignalVersion, signal.SignalVersion);
            var confirmsPendingOutcome = order == 0 && existing.EvidenceRequestId == signal.RequestId
                && existing.RequestOutcome == "unknown" && signal.RequestOutcome != "unknown";
            if (order > 0 || (order == 0 && !confirmsPendingOutcome)) return false;
            var shouldReopen = string.Equals(existing.IncidentState, "recovered", StringComparison.Ordinal);
            var impactEscalated = !shouldReopen && IsImpactEscalation(existing.RequestOutcome, signal.RequestOutcome);
            var newFailures = signal.FailureObservations
                .Where(x => string.CompareOrdinal(x.Version, existing.GatewaySignalVersion) > 0).ToList();

            var update = Builders<AdminNotification>.Update
                .Set(x => x.Title, title)
                .Set(x => x.Message, message)
                .Set(x => x.Level, level)
                .Set(x => x.ActionLabel, "查看网关日志")
                .Set(x => x.ActionUrl, actionUrl)
                .Set(x => x.ActionKind, "llm-gateway")
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.GatewaySignalVersion, signal.SignalVersion)
                .Set(x => x.IncidentId, signal.Fingerprint)
                .Set(x => x.IncidentState, "active")
                .Set(x => x.RequestOutcome, signal.RequestOutcome)
                .Set(x => x.EvidenceRequestId, signal.RequestId)
                .Set(x => x.FirstOccurredAt, existing.FirstOccurredAt ?? signal.FailureObservations.Min(x => x.At))
                .Set(x => x.LastOccurredAt, signal.ObservedAt)
                .Set(x => x.RecoveredAt, null)
                .Set(x => x.OccurrenceCount, existing.FirstOccurredAt.HasValue
                    ? existing.OccurrenceCount + newFailures.Count : Math.Max(1, signal.FailureCount));
            var transitionFilter = CurrentFailureFilter(existing, signal, confirmsPendingOutcome);
            if (shouldReopen || impactEscalated)
            {
                // 只有一个扫描者能从所观察到的关闭代次切换为新代次。
                // 缺字段的存量记录按第 0 代处理，不清理任何历史投递回执。
                update = update
                    .Set(x => x.Status, "open")
                    .Inc(x => x.PushEpisode, 1)
                    .Set(x => x.PushEpisodeStartedAtUtcTicks, now.Ticks)
                    .Unset(x => x.HandledAt);
            }
            var transitioned = await _mapDb.AdminNotifications.UpdateOneAsync(transitionFilter, update,
                new UpdateOptions { Collation = new Collation("simple") }, ct);
            if (transitioned.MatchedCount != 1) return null;
            return (shouldReopen || impactEscalated) && transitioned.ModifiedCount == 1;
        }

        try
        {
            await _mapDb.AdminNotifications.InsertOneAsync(new AdminNotification
            {
                Id = $"llmgw-upstream-{signal.Fingerprint}",
                Key = key,
                Title = title,
                Message = message,
                Level = level,
                Status = "open",
                PushEpisodeStartedAtUtcTicks = now.Ticks,
                GatewaySignalVersion = signal.SignalVersion,
                IncidentId = signal.Fingerprint,
                IncidentState = "active",
                RequestOutcome = signal.RequestOutcome,
                EvidenceRequestId = signal.RequestId,
                OccurrenceCount = signal.FailureCount,
                FirstOccurredAt = signal.FailureObservations.Min(x => x.At),
                LastOccurredAt = signal.ObservedAt,
                Source = "gateway-alert",
                Section = AdminNotificationSections.Admin,
                ActionLabel = "查看网关日志",
                ActionUrl = actionUrl,
                ActionKind = "llm-gateway",
                ExpiresAt = null,
            }, cancellationToken: ct);
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            // 同一轮故障在多实例下只有一个确定的记录身份。
            return null;
        }

        _logger.LogWarning(
            "[LlmGatewayIncidentWatchdog] 上游故障已通知: Platform={Platform}, Model={Model}, RequestId={RequestId}",
            signal.PlatformLabel, signal.ModelLabel, signal.RequestId);
        return true;
    }

    private async Task<bool> CloseFailureAndNotifyRecoveryAsync(LlmGatewayIncidentSignal signal, CancellationToken ct)
    {
        // A successful observation can recover only the exact route boundary, but it may
        // resolve several independently tracked failure reasons on that route. Include
        // failures outside this sweep's rolling log window by querying persisted identities.
        var prefix = $"llmgw-upstream:{signal.RouteFingerprint}";
        var matches = await _mapDb.AdminNotifications.Find(
                Builders<AdminNotification>.Filter.Regex(x => x.Key,
                    "^" + System.Text.RegularExpressions.Regex.Escape(prefix) + "(?::|$)"))
            .ToListAsync(ct);
        var changed = false;
        foreach (var current in matches.GroupBy(x => x.Key)
                     .Select(g => g.OrderByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id).First()))
        {
            var exactSignal = signal with { Fingerprint = current.Key!["llmgw-upstream:".Length..] };
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var result = await CloseFailureAndNotifyRecoveryOnceAsync(exactSignal, ct);
                if (!result.HasValue) continue;
                changed |= result.Value;
                break;
            }
        }
        return changed;
    }

    private async Task<bool?> CloseFailureAndNotifyRecoveryOnceAsync(LlmGatewayIncidentSignal signal, CancellationToken ct)
    {
        var failureKey = $"llmgw-upstream:{signal.Fingerprint}";
        var existing = await FindCurrentFailureAsync(failureKey, ct);
        if (existing is null || string.CompareOrdinal(existing.GatewaySignalVersion, signal.SignalVersion) >= 0)
            return false;
        var now = DateTime.UtcNow;
        var transitionFilter = CurrentFailureFilter(existing, signal);
        if (string.Equals(existing.IncidentState, "recovered", StringComparison.Ordinal))
        {
            // 成功/失败必须更新同一当前行；不能把水位写到更旧的同 Key 历史行。
            var advanced = await _mapDb.AdminNotifications.UpdateOneAsync(
                transitionFilter,
                Builders<AdminNotification>.Update.Set(x => x.GatewaySignalVersion, signal.SignalVersion),
                new UpdateOptions { Collation = new Collation("simple") }, ct);
            return advanced.MatchedCount == 1 ? false : null;
        }
        var transitionUpdate = Builders<AdminNotification>.Update
                .Set(x => x.Status, "closed")
                .Set(x => x.HandledAt, now)
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.GatewaySignalVersion, signal.SignalVersion)
                .Set(x => x.IncidentState, "recovered")
                .Set(x => x.RecoveredAt, signal.ObservedAt)
                .Set(x => x.EvidenceRequestId, signal.RequestId);
        var transitioned = await _mapDb.AdminNotifications.FindOneAndUpdateAsync(
            transitionFilter,
            transitionUpdate,
            new FindOneAndUpdateOptions<AdminNotification, AdminNotification> {
                ReturnDocument = ReturnDocument.Before, Collation = new Collation("simple")
            },
            ct);
        if (transitioned is null)
        {
            return null;
        }

        var recoveryKey = $"llmgw-upstream-recovered:{signal.Fingerprint}:{signal.RequestId}";
        await _mapDb.AdminNotifications.InsertOneAsync(new AdminNotification
        {
            Id = $"llmgw-recovered-{signal.Fingerprint}-{signal.RequestId}",
            Key = recoveryKey,
            Title = signal.IsGatewayEntry ? $"{signal.AppCallerLabel} 请求入口已恢复" : $"{signal.PlatformLabel} · {signal.ModelLabel} 线路已恢复",
            Message = $"{(signal.IsGatewayEntry ? signal.AppCallerLabel + " 的同一入口" : signal.PlatformLabel + " 的 " + signal.ModelLabel + " 线路")}已在 {signal.ObservedAt.ToUniversalTime():yyyy-MM-dd HH:mm:ss} UTC 完成一次成功调用，已关闭该线路对应故障。可查看恢复请求；历史失败请求不会自动重做。",
            IncidentId = signal.Fingerprint,
            IncidentState = "recovered",
            RequestOutcome = "request_succeeded",
            OccurrenceCount = transitioned.OccurrenceCount,
            FirstOccurredAt = transitioned.FirstOccurredAt,
            LastOccurredAt = transitioned.LastOccurredAt,
            RecoveredAt = signal.ObservedAt,
            EvidenceRequestId = signal.RequestId,
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

    internal static string BuildIncidentTitle(LlmGatewayIncidentSignal signal)
        => signal.IsGatewayEntry ? $"{signal.AppCallerLabel} 请求未能进入处理"
            : $"{signal.PlatformLabel} · {signal.ModelLabel}：{FailureLabel(signal.FailureCategory)}";

    internal static string BuildIncidentMessage(LlmGatewayIncidentSignal signal)
    {
        var impact = signal.RequestOutcome switch
        {
            "fallback_succeeded" => "本次请求已由备用线路成功完成，无需重试；故障线路尚无恢复证据。",
            "all_failed" when signal.AttemptedRouteCount > 0 => $"本次已尝试的 {signal.AttemptedRouteCount} 条线路均失败，请查看请求结果后重试或切换可用模型。",
            "all_failed" => "本次请求没有可用线路，任务未能启动。请切换可用模型或等待管理员恢复配置。",
            "request_failed" => "本次请求失败。请查看请求结果，再重试或切换可用模型；不能据此认定其他请求均失败。",
            _ => "这条线路返回异常，整次请求结果尚未确认。请查看请求最新状态，避免重复提交。",
        };
        var next = signal.IsGatewayEntry ? "管理员请检查该入口的模型授权和路由配置。"
            : signal.FailureCategory == "quota" ? "管理员请补足该供应商账户额度或配置可用线路，再查看后续真实调用结果。"
            : signal.FailureCategory == "access" ? "管理员请核对该线路访问权限与配置，再查看后续真实调用结果。"
            : "管理员请查看该线路诊断与后续真实调用结果。";
        return $"{signal.AppCallerLabel}：{impact}\n{next}";
    }

    private static string FailureLabel(string category) => category switch
    {
        "quota" => "上游账户余额或额度不足",
        "access" => "上游拒绝访问",
        "timeout" => "上游响应超时",
        "connection" => "上游连接失败",
        _ => "调用服务异常",
    };

    private static bool IsImpactEscalation(string? previous, string current)
        => (previous is "fallback_succeeded" or "unknown") && (current is "request_failed" or "all_failed");

    private static FilterDefinition<AdminNotification> NewerSignalFilter(LlmGatewayIncidentSignal signal)
        => Builders<AdminNotification>.Filter.Eq(x => x.GatewaySignalVersion, null)
           | Builders<AdminNotification>.Filter.Lt(x => x.GatewaySignalVersion, signal.SignalVersion);

    private async Task<AdminNotification?> FindCurrentFailureAsync(string key, CancellationToken ct)
        => await _mapDb.AdminNotifications.Find(x => x.Key == key)
            .SortByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id)
            .FirstOrDefaultAsync(ct);

    private static FilterDefinition<AdminNotification> CurrentFailureFilter(
        AdminNotification existing, LlmGatewayIncidentSignal signal, bool sameObservation = false)
    {
        var filter = Builders<AdminNotification>.Filter.Eq(x => x.Id, existing.Id)
            & Builders<AdminNotification>.Filter.Eq(x => x.Status, existing.Status)
            & Builders<AdminNotification>.Filter.Eq(x => x.GatewaySignalVersion, existing.GatewaySignalVersion)
            & (sameObservation
                ? Builders<AdminNotification>.Filter.Eq(x => x.GatewaySignalVersion, signal.SignalVersion)
                : NewerSignalFilter(signal));
        return filter & (existing.PushEpisode == 0
            ? Builders<AdminNotification>.Filter.Eq(x => x.PushEpisode, 0)
                | Builders<AdminNotification>.Filter.Exists(x => x.PushEpisode, false)
            : Builders<AdminNotification>.Filter.Eq(x => x.PushEpisode, existing.PushEpisode));
    }
}

internal static class LlmGatewayIncidentPolicy
{
    // A terminal request is not the same thing as every provider attempt. Keep route failures
    // even when a different route ultimately completed the request.
    internal static IReadOnlyList<LlmGatewayIncidentSignal> BuildSignals(IEnumerable<LlmRequestLog> logs)
        => BuildTimelineSignals(logs).GroupBy(x => x.Fingerprint)
            .Select(group => group.Last() with
            {
                FailureCount = group.Sum(x => x.FailureCount),
                FailureObservations = group.SelectMany(x => x.FailureObservations).ToList(),
            }).ToList();

    internal static IReadOnlyList<LlmGatewayIncidentSignal> BuildTimelineSignals(IEnumerable<LlmRequestLog> logs)
    {
        var observations = logs.Where(x => x.IsHealthProbe != true && !string.IsNullOrWhiteSpace(x.RequestId))
            .SelectMany(Observe).ToList();
        var result = new List<LlmGatewayIncidentSignal>();
        foreach (var route in observations.GroupBy(x => x.RouteFingerprint))
        {
            var categories = route.Where(x => x.Failure).Select(x => x.Category).Distinct().ToList();
            if (categories.Count == 0) categories.Add("availability");
            foreach (var category in categories)
            {
                var ordered = route.Where(x => !x.Failure || x.Category == category)
                    .DistinctBy(x => x.Version).OrderBy(x => x.Version, StringComparer.Ordinal).ToList();
                // Coalesce only continuous observations of the same state. Retain recovery and
                // recurrence transitions even if both first appear during one watchdog sweep.
                var run = new List<Observation>();
                foreach (var item in ordered)
                {
                    if (run.Count > 0 && run[^1].Failure != item.Failure)
                    {
                        result.Add(Signal(run, category));
                        run.Clear();
                    }
                    run.Add(item);
                }
                if (run.Count > 0) result.Add(Signal(run, category));
            }
        }
        return result.OrderBy(x => x.SignalVersion, StringComparer.Ordinal).ToList();
    }

    private static LlmGatewayIncidentSignal Signal(List<Observation> run, string category)
    {
        var latest = run[^1];
        var log = latest.Log;
        return new LlmGatewayIncidentSignal(
            latest.Entry ? latest.RouteFingerprint : $"{latest.RouteFingerprint}:{category}",
            latest.Failure, log.RequestId,
            Display(log.AppCallerCodeDisplayName, log.AppCallerTitle, "AI 创作"),
            Display(log.PlatformName, log.Provider, "调用入口"),
            Display(log.Model, log.ExpectedModel, log.LogicalModelPublicId, "未进入模型调用"),
            latest.Failure ? SummarizeFailure(log) : string.Empty,
            // Append the fact-policy revision after the full observation identity. It can
            // correct that same observation once while preserving chronological ordering,
            // and older workers cannot overwrite it with the unsuffixed version. Apply it
            // to successes too, so pending outcomes can still be genuinely confirmed.
            run.Count(x => x.Failure), latest.Version + ":facts-0002", latest.Entry, latest.At)
        {
            RouteFingerprint = latest.RouteFingerprint,
            FailureCategory = category,
            RequestOutcome = latest.Outcome,
            AttemptedRouteCount = latest.AttemptedRoutes,
            // Counts use raw observation versions: upgrading the interpretation is not
            // another failure occurrence, nor does it start a new delivery episode.
            FailureObservations = run.Where(x => x.Failure)
                .Select(x => new LlmGatewayFailureObservation(x.Version, x.At)).ToList(),
        };
    }

    private static IEnumerable<Observation> Observe(LlmRequestLog log)
    {
        if (IsGatewayEntry(log))
        {
            if (IsFailure(log) && HasEntryIdentity(log))
                yield return ObservationFor(log, true, true, "entry", -1, Outcome(log), 0);
            yield break;
        }

        if (IsSuccess(log) && HasEntryIdentity(log))
            yield return ObservationFor(log, true, false, "entry", -1, "request_succeeded", 0);

        var sends = log.ProviderAttempts?.Where(x => x.Stage == "send").ToList() ?? [];
        var completed = sends.Where(x => x.Status is "failed" or "succeeded").ToList();
        var attemptedRoutes = completed.Where(x => x.ReachedProvider != false)
            .Select(x => $"{x.PlatformId}|{x.Model}").Distinct().Count();
        var outcome = Outcome(log);
        if (completed.Count > 0)
        {
            foreach (var attempt in completed)
            {
                // A selected/skipped candidate or local capability rejection is not evidence
                // that the upstream accepted (or rejected) an actual request.
                if (attempt.ReachedProvider == false) continue;
                var projected = ProjectAttempt(log, attempt);
                var failed = IsFailure(projected);
                var succeeded = IsSuccess(log) && IsSuccess(projected) && attempt.StatusCode is >= 200 and < 300;
                if (failed || succeeded)
                    yield return ObservationFor(projected, false, failed, Category(projected), attempt.Order, outcome, attemptedRoutes);
            }
            // A log may have a partially persisted attempt chain. A terminal failure of its
            // final route must not disappear, but incomplete chains cannot prove all routes failed.
            if (IsFailure(log) && !completed.Any(x => x.PlatformId == log.PlatformId && x.Model == log.Model && x.Status == "failed"))
                yield return ObservationFor(log, false, true, Category(log), int.MaxValue, outcome, attemptedRoutes);
            yield break;
        }
        if (IsFailure(log) || IsSuccess(log))
            yield return ObservationFor(log, false, IsFailure(log), Category(log), -1, outcome, attemptedRoutes);
    }

    private static string Outcome(LlmRequestLog log)
    {
        var sends = log.ProviderAttempts?.Where(x => x.Stage == "send").ToList() ?? [];
        if (IsSuccess(log))
            return sends.Any(x => x.Status == "failed" && x.ReachedProvider != false) ? "fallback_succeeded" : "request_succeeded";
        if (!string.Equals(log.Status, "failed", StringComparison.OrdinalIgnoreCase)) return "unknown";
        // The producer records a failed transport exchange separately from the business
        // outcome: the provider may already have executed it. Consume only its explicit
        // code/prefix, never infer a completed rejection from Status=failed alone.
        if (HasUnknownOutcomeCode(log.Error) || sends.Any(x => x.Status == "failed" && x.ReachedProvider != false
                && (HasUnknownOutcomeCode(x.Error) || x.ReachedProvider == true
                    && x.Reason?.StartsWith("outcome_unknown; recovery=", StringComparison.Ordinal) == true)))
            return "unknown";
        // Only call the observed attempt set exhausted. Never claim that every configured
        // provider failed when the snapshot contains selected or unfinished candidates.
        return sends.Count > 1 && sends.All(x => x.Status == "failed" && x.ReachedProvider == true)
            ? "all_failed" : "request_failed";
    }

    private static bool HasUnknownOutcomeCode(string? error)
        => string.Equals(error, "UPSTREAM_OUTCOME_UNKNOWN", StringComparison.Ordinal)
           || error?.StartsWith("UPSTREAM_OUTCOME_UNKNOWN:", StringComparison.Ordinal) == true;

    private static LlmRequestLog ProjectAttempt(LlmRequestLog request, LlmProviderAttempt attempt) => new()
    {
        Id = request.Id, RequestId = request.RequestId, TenantId = request.TenantId, TeamId = request.TeamId,
        SourceDeployment = request.SourceDeployment, Environment = request.Environment,
        AppCallerCode = request.AppCallerCode, AppCallerCodeDisplayName = request.AppCallerCodeDisplayName,
        AppCallerTitle = request.AppCallerTitle, Path = request.Path, RequestType = request.RequestType,
        Provider = attempt.Provider ?? "", PlatformId = attempt.PlatformId, PlatformName = attempt.PlatformName,
        Model = attempt.Model ?? "", ModelGroupId = attempt.ModelGroupId,
        Status = attempt.Status, StatusCode = attempt.StatusCode, Error = attempt.Error,
        StartedAt = request.StartedAt, EndedAt = attempt.EndedAt ?? request.EndedAt,
    };

    private static Observation ObservationFor(LlmRequestLog log, bool entry, bool failure, string category,
        int order, string outcome, int attemptedRoutes)
    {
        var at = log.EndedAt ?? log.StartedAt;
        var utc = at.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(at, DateTimeKind.Utc) : at.ToUniversalTime();
        var ticks = utc.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond;
        var identity = order == -1
            ? System.Text.Json.JsonSerializer.Serialize(new[] { log.RequestId, log.Id })
            : System.Text.Json.JsonSerializer.Serialize(new[] { log.RequestId, log.Id, order.ToString(System.Globalization.CultureInfo.InvariantCulture) });
        var version = $"{ticks.ToString("D19", System.Globalization.CultureInfo.InvariantCulture)}:{(failure ? "1" : "0")}:"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
        return new(log, entry ? BuildEntryFingerprint(log) : BuildFingerprint(log), entry, failure, category,
            version, at, outcome, attemptedRoutes);
    }

    internal static bool IsFailure(LlmRequestLog log)
        => string.Equals(log.Status, "failed", StringComparison.OrdinalIgnoreCase)
           && (IsGatewayEntry(log)
               ? HasEntryIdentity(log) && (log.StatusCode is 401 or 403 or 404 or >= 500
                   || GatewayRouteFailure.All.Contains(log.Error ?? string.Empty))
               : IsQuota(log) || log.StatusCode is 401 or 403 or >= 500
                 || ContainsAny(log.Error, "timeout", "timed out", "connection", "HTTP 502", "HTTP 503", "HTTP 504", "不可用"));

    private static bool IsQuota(LlmRequestLog log)
        => PrdAgent.GatewayTransport.UpstreamQuotaPolicy.IsExceeded(log.StatusCode ?? 0, log.Error);

    private static string Category(LlmRequestLog log)
        => IsQuota(log) ? "quota" : log.StatusCode is 401 or 403 ? "access"
            : log.StatusCode is 504 || ContainsAny(log.Error, "timeout", "timed out") ? "timeout"
            : ContainsAny(log.Error, "connection") ? "connection" : "availability";

    private static bool IsGatewayEntry(LlmRequestLog log)
        => string.Equals(log.Provider, "gateway-auth", StringComparison.OrdinalIgnoreCase);
    private static bool HasEntryIdentity(LlmRequestLog log)
        => !string.IsNullOrWhiteSpace(log.TenantId) && !string.IsNullOrWhiteSpace(log.AppCallerCode) && !string.IsNullOrWhiteSpace(log.Path);
    private static bool IsSuccess(LlmRequestLog log)
        => string.Equals(log.Status, "succeeded", StringComparison.OrdinalIgnoreCase);

    private static string BuildEntryFingerprint(LlmRequestLog log)
    {
        var identity = string.Join("|", "gateway-entry", log.TenantId?.Trim().ToLowerInvariant(),
            log.AppCallerCode?.Trim().ToLowerInvariant(), log.Path?.Trim());
        if (!string.IsNullOrWhiteSpace(log.TeamId) || !string.IsNullOrWhiteSpace(log.SourceDeployment)
            || !string.IsNullOrWhiteSpace(log.Environment))
            identity += System.Text.Json.JsonSerializer.Serialize(new[] { log.TeamId, log.SourceDeployment, log.Environment });
        return Hash(identity);
    }
    private static string BuildFingerprint(LlmRequestLog log)
    {
        // IDs are identities, not case-insensitive labels. Include the deployment/team boundary
        // so a test route success cannot close production or another team's incident.
        var identity = System.Text.Json.JsonSerializer.Serialize(new[] {
            log.TenantId, log.TeamId, log.SourceDeployment, log.Environment,
            First(log.PlatformId, log.PlatformName, log.Provider),
            First(log.Model, log.ExpectedModel, log.LogicalModelPublicId), log.RequestType,
        });
        return Hash(identity);
    }
    private static string Hash(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant()[..24];

    private static string SummarizeFailure(LlmRequestLog log)
    {
        if (IsGatewayEntry(log))
        {
            if (GatewayRouteFailure.All.Contains(log.Error ?? string.Empty)) return GatewayRouteFailure.UserMessage(log.Error);
            return log.StatusCode == 404 ? "网关未找到可用的处理目标，任务未能启动" : "网关未接受请求，生成任务未能启动";
        }
        if (IsQuota(log)) return "上游账户余额或额度不足";
        return log.StatusCode switch
        {
            401 or 403 => "上游拒绝访问，请核对服务凭据、访问权限及服务器 IP 白名单",
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
        => !string.IsNullOrWhiteSpace(value) && needles.Any(needle => value.Contains(needle, StringComparison.OrdinalIgnoreCase));
    private sealed record Observation(LlmRequestLog Log, string RouteFingerprint, bool Entry, bool Failure,
        string Category, string Version, DateTime At, string Outcome, int AttemptedRoutes);
}

internal sealed record LlmGatewayFailureObservation(string Version, DateTime At);

internal sealed record LlmGatewayIncidentSignal(
    string Fingerprint, bool IsFailure, string RequestId, string AppCallerLabel, string PlatformLabel,
    string ModelLabel, string FailureSummary, int FailureCount, string SignalVersion,
    bool IsGatewayEntry = false, DateTime ObservedAt = default)
{
    public string RouteFingerprint { get; init; } = string.Empty;
    public string FailureCategory { get; init; } = "availability";
    public string RequestOutcome { get; init; } = "unknown";
    public int AttemptedRouteCount { get; init; }
    public IReadOnlyList<LlmGatewayFailureObservation> FailureObservations { get; init; } = [];
}
