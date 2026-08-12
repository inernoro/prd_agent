using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
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
        var actionUrl = $"/logs?transaction={Uri.EscapeDataString(signal.RequestId)}";
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
            ActionUrl = $"/logs?transaction={Uri.EscapeDataString(signal.RequestId)}",
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
