using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// API 请求日志 running 状态纠错守门犬。
/// 当服务器重启/部署时，长生命周期的 SSE 连接（如 messages/stream）会被强制断开，
/// middleware 的 finally 块来不及执行，导致 api_request_logs 中的 Status 永远停留在 "running"。
/// 此 Watchdog 定期扫描超时的 "running" 日志，将其标记为 "timeout" 并设置 EndedAt，
/// 使 TTL 索引能正常清理这些记录。
/// </summary>
public sealed class ApiRequestLogWatchdog : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<ApiRequestLogWatchdog> _logger;
    private readonly TimeSpan _interval;
    private readonly TimeSpan _timeout;

    public ApiRequestLogWatchdog(MongoDbContext db, ILogger<ApiRequestLogWatchdog> logger, IConfiguration config)
    {
        _db = db;
        _logger = logger;

        // 可配置：API_LOG_WATCHDOG_INTERVAL_SECONDS / API_LOG_WATCHDOG_TIMEOUT_SECONDS
        // 默认间隔 60 秒，超时 2 小时（SSE 长连接可能合法运行较长时间）
        var intervalSec = config.GetValue<int?>("API_LOG_WATCHDOG_INTERVAL_SECONDS") ?? 60;
        var timeoutSec = config.GetValue<int?>("API_LOG_WATCHDOG_TIMEOUT_SECONDS") ?? 7200;
        _interval = TimeSpan.FromSeconds(Math.Clamp(intervalSec, 10, 600));
        _timeout = TimeSpan.FromSeconds(Math.Clamp(timeoutSec, 300, 86400));
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
                _logger.LogWarning(ex, "API request log watchdog loop error");
            }
        }
    }

    private async Task SweepOnce(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var deadline = now - _timeout;

        var filter =
            Builders<ApiRequestLog>.Filter.Eq(x => x.Status, "running") &
            Builders<ApiRequestLog>.Filter.Lt(x => x.StartedAt, deadline) &
            Builders<ApiRequestLog>.Filter.Eq(x => x.EndedAt, null);

        var update = Builders<ApiRequestLog>.Update
            .Set(x => x.Status, "timeout")
            .Set(x => x.EndedAt, now);

        var res = await _db.ApiRequestLogs.UpdateManyAsync(filter, update, cancellationToken: ct);
        if (res.ModifiedCount > 0)
        {
            _logger.LogInformation(
                "API request log watchdog fixed {Count} stuck running logs (timeout {TimeoutSeconds}s)",
                res.ModifiedCount, (int)_timeout.TotalSeconds);
        }
    }
}
