using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
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

        if (changed)
        {
            _pushSignal.NotifyPending();
        }
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
        var title = signal.IsGatewayEntry ? $"{signal.AppCallerLabel} 请求未能进入处理" : $"{signal.AppCallerLabel} 调用服务异常";
        var message = $"{signal.AppCallerLabel} 请求失败：{signal.FailureSummary}。"
                      + $"\n平台：{signal.PlatformLabel}；最近窗口失败 {signal.FailureCount} 次；请求编号：{signal.RequestId}。"
                      + (signal.IsGatewayEntry
                          ? "\n请检查模型可用性及网关路由；同一业务入口出现成功请求后自动关闭故障。"
                          : "\n请查看失败请求，核对上游服务的访问权限和可用性；同一上游出现成功请求后自动关闭故障。");

        if (existing is not null)
        {
            if (string.CompareOrdinal(existing.GatewaySignalVersion, signal.SignalVersion) >= 0) return false;
            var shouldReopen = string.Equals(existing.Status, "closed", StringComparison.OrdinalIgnoreCase);

            var update = Builders<AdminNotification>.Update
                .Set(x => x.Title, title)
                .Set(x => x.Message, message)
                .Set(x => x.Level, "error")
                .Set(x => x.ActionLabel, "查看网关日志")
                .Set(x => x.ActionUrl, actionUrl)
                .Set(x => x.ActionKind, "llm-gateway")
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.GatewaySignalVersion, signal.SignalVersion);
            var transitionFilter = Builders<AdminNotification>.Filter.Eq(x => x.Id, existing.Id)
                & Builders<AdminNotification>.Filter.Eq(x => x.Status, existing.Status)
                & NewerSignalFilter(signal);
            transitionFilter &= existing.PushEpisode == 0
                ? Builders<AdminNotification>.Filter.Eq(x => x.PushEpisode, 0)
                    | Builders<AdminNotification>.Filter.Exists(x => x.PushEpisode, false)
                : Builders<AdminNotification>.Filter.Eq(x => x.PushEpisode, existing.PushEpisode);
            if (shouldReopen)
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
            return shouldReopen && transitioned.ModifiedCount == 1;
        }

        try
        {
            await _mapDb.AdminNotifications.InsertOneAsync(new AdminNotification
            {
                Id = $"llmgw-upstream-{signal.Fingerprint}",
                Key = key,
                Title = title,
                Message = message,
                Level = "error",
                Status = "open",
                PushEpisodeStartedAtUtcTicks = now.Ticks,
                GatewaySignalVersion = signal.SignalVersion,
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
            return false;
        }

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
            Builders<AdminNotification>.Filter.Ne(x => x.Status, "closed"),
            NewerSignalFilter(signal));
        var transitionUpdate = Builders<AdminNotification>.Update
                .Set(x => x.Status, "closed")
                .Set(x => x.HandledAt, now)
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.GatewaySignalVersion, signal.SignalVersion);
        var transitioned = await _mapDb.AdminNotifications.FindOneAndUpdateAsync(
            transitionFilter,
            transitionUpdate,
            new FindOneAndUpdateOptions<AdminNotification, AdminNotification> {
                ReturnDocument = ReturnDocument.Before, Collation = new Collation("simple")
            },
            ct);
        if (transitioned is null)
        {
            // 已关闭时也推进成功水位，防止两次成功之间的滞后失败重新打开它。
            await _mapDb.AdminNotifications.UpdateOneAsync(
                Builders<AdminNotification>.Filter.Eq(x => x.Key, failureKey)
                    & Builders<AdminNotification>.Filter.Eq(x => x.Status, "closed") & NewerSignalFilter(signal),
                Builders<AdminNotification>.Update.Set(x => x.GatewaySignalVersion, signal.SignalVersion),
                new UpdateOptions { Collation = new Collation("simple") }, ct);
            return false;
        }

        var recoveryKey = $"llmgw-upstream-recovered:{signal.Fingerprint}:{signal.RequestId}";
        await _mapDb.AdminNotifications.InsertOneAsync(new AdminNotification
        {
            Id = $"llmgw-recovered-{signal.Fingerprint}-{signal.RequestId}",
            Key = recoveryKey,
            Title = $"{signal.AppCallerLabel} 调用已恢复",
            Message = $"{signal.AppCallerLabel} 的{(signal.IsGatewayEntry ? "同一请求入口" : "同一上游服务")}已出现成功请求，故障告警已自动关闭。请求编号：{signal.RequestId}。",
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

    private static FilterDefinition<AdminNotification> NewerSignalFilter(LlmGatewayIncidentSignal signal)
        => Builders<AdminNotification>.Filter.Eq(x => x.GatewaySignalVersion, null)
           | Builders<AdminNotification>.Filter.Lt(x => x.GatewaySignalVersion, signal.SignalVersion);
}

internal static class LlmGatewayIncidentPolicy
{
    internal static IReadOnlyList<LlmGatewayIncidentSignal> BuildSignals(IEnumerable<LlmRequestLog> logs)
    {
        // 成功请求同时可证明业务入口和上游恢复；入口拒绝没有模型，不能混入上游分组。
        var entries = logs.Where(IsRelevant).SelectMany(log =>
        {
            var scopes = new List<(LlmRequestLog Log, bool Entry)>();
            if (!IsGatewayEntry(log)) scopes.Add((log, false));
            if (HasEntryIdentity(log) && (IsGatewayEntry(log) || IsSuccess(log))) scopes.Add((log, true));
            return scopes;
        });
        return entries
            .GroupBy(x => x.Entry ? BuildEntryFingerprint(x.Log) : BuildFingerprint(x.Log))
            .Select(group =>
            {
                var ordered = group.OrderBy(x => BuildSignalVersion(x.Log), StringComparer.Ordinal).ToList();
                var (latest, entry) = ordered[^1];
                var isFailure = IsFailure(latest);
                return new LlmGatewayIncidentSignal(
                    group.Key,
                    isFailure,
                    latest.RequestId,
                    Display(latest.AppCallerCodeDisplayName, latest.AppCallerTitle, "AI 创作"),
                    Display(latest.PlatformName, latest.Provider, "调用入口"),
                    Display(latest.Model, latest.ExpectedModel, latest.LogicalModelPublicId, "未进入模型调用"),
                    isFailure ? SummarizeFailure(latest) : string.Empty,
                    ordered.Count(x => IsFailure(x.Log)),
                    BuildSignalVersion(latest),
                    entry);
            })
            .ToList();
    }

    internal static bool IsFailure(LlmRequestLog log)
        => string.Equals(log.Status, "failed", StringComparison.OrdinalIgnoreCase)
           && (IsGatewayEntry(log)
               ? HasEntryIdentity(log) && (log.StatusCode is 401 or 403 or 404 or >= 500
                   || GatewayRouteFailure.All.Contains(log.Error ?? string.Empty))
               : log.StatusCode is 401 or 403 or >= 500
                 || ContainsAny(log.Error, "timeout", "timed out", "connection", "HTTP 502", "HTTP 503", "HTTP 504", "不可用"));

    private static string BuildSignalVersion(LlmRequestLog log)
    {
        // Mongo 日志只有毫秒精度。同毫秒没有真实先后证据，保守地让失败胜出；
        // 最后用稳定身份摘要打破同类信号平局，所有字符为 ASCII，与 simple collation 一致。
        var utc = log.StartedAt.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(log.StartedAt, DateTimeKind.Utc) : log.StartedAt.ToUniversalTime();
        var ticks = utc.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond;
        var identity = System.Text.Json.JsonSerializer.Serialize(new[] { log.RequestId, log.Id });
        return $"{ticks.ToString("D19", System.Globalization.CultureInfo.InvariantCulture)}:{(IsFailure(log) ? "1" : "0")}:"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
    }

    private static bool IsGatewayEntry(LlmRequestLog log)
        => string.Equals(log.Provider, "gateway-auth", StringComparison.OrdinalIgnoreCase);

    private static bool HasEntryIdentity(LlmRequestLog log)
        => !string.IsNullOrWhiteSpace(log.TenantId)
           && !string.IsNullOrWhiteSpace(log.AppCallerCode)
           && !string.IsNullOrWhiteSpace(log.Path);

    private static bool IsSuccess(LlmRequestLog log)
        => string.Equals(log.Status, "succeeded", StringComparison.OrdinalIgnoreCase);

    private static bool IsRelevant(LlmRequestLog log)
        => log.IsHealthProbe != true
           && !string.IsNullOrWhiteSpace(log.RequestId)
           && (IsSuccess(log) || IsFailure(log));

    private static string BuildEntryFingerprint(LlmRequestLog log)
    {
        // 使用稳定业务入口，重试、请求编号和缺失的模型字段不生成新事故。
        // 不并入上游指纹，避免另一业务或另一入口的成功误报恢复。
        var identity = string.Join("|", "gateway-entry", log.TenantId?.Trim().ToLowerInvariant(),
            log.AppCallerCode?.Trim().ToLowerInvariant(), log.Path?.Trim());
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant()[..24];
    }

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
        if (IsGatewayEntry(log))
        {
            if (GatewayRouteFailure.All.Contains(log.Error ?? string.Empty))
                return GatewayRouteFailure.UserMessage(log.Error);
            return log.StatusCode == 404 ? "网关未找到可用的处理目标，任务未能启动" : "网关未接受请求，生成任务未能启动";
        }
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
    int FailureCount,
    string SignalVersion,
    bool IsGatewayEntry = false);
