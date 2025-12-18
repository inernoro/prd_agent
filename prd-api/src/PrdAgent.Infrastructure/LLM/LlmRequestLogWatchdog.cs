using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// running 状态纠错：避免因异常/丢写导致日志长期 running
/// </summary>
public sealed class LlmRequestLogWatchdog : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<LlmRequestLogWatchdog> _logger;
    private readonly TimeSpan _interval;
    private readonly TimeSpan _timeout;

    public LlmRequestLogWatchdog(MongoDbContext db, ILogger<LlmRequestLogWatchdog> logger, IConfiguration config)
    {
        _db = db;
        _logger = logger;

        // 可配置：LLM_LOG_WATCHDOG_INTERVAL_SECONDS / LLM_LOG_WATCHDOG_TIMEOUT_SECONDS
        var intervalSec = config.GetValue<int?>("LLM_LOG_WATCHDOG_INTERVAL_SECONDS") ?? 30;
        var timeoutSec = config.GetValue<int?>("LLM_LOG_WATCHDOG_TIMEOUT_SECONDS") ?? 300;
        _interval = TimeSpan.FromSeconds(Math.Clamp(intervalSec, 5, 300));
        _timeout = TimeSpan.FromSeconds(Math.Clamp(timeoutSec, 30, 3600));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_interval, stoppingToken);
                await SweepOnce(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                // stop
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "LLM log watchdog loop error");
            }
        }
    }

    private async Task SweepOnce(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var deadline = now - _timeout;

        var filter =
            Builders<LlmRequestLog>.Filter.Eq(x => x.Status, "running") &
            Builders<LlmRequestLog>.Filter.Lt(x => x.StartedAt, deadline) &
            Builders<LlmRequestLog>.Filter.Eq(x => x.EndedAt, null);

        var update = Builders<LlmRequestLog>.Update
            .Set(x => x.Status, "failed")
            .Set(x => x.Error, "TIMEOUT")
            .Set(x => x.EndedAt, now)
            .Set(x => x.DurationMs, (long)_timeout.TotalMilliseconds);

        var res = await _db.LlmRequestLogs.UpdateManyAsync(filter, update, cancellationToken: ct);
        if (res.ModifiedCount > 0)
        {
            _logger.LogInformation("LLM log watchdog fixed {Count} running logs (timeout {TimeoutSeconds}s)", res.ModifiedCount, (int)_timeout.TotalSeconds);
        }
    }
}

