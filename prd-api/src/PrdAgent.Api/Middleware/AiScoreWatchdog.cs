using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// AI 评分任务超时守门犬。
/// DefectShareLink 的 AiScoreStatus 可能因 SSE 断连、服务重启等原因永远停留在 "scoring"。
/// 此 Watchdog 定期扫描超时的 "scoring" 记录，将其标记为 "failed"。
/// </summary>
public sealed class AiScoreWatchdog : BackgroundService
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AiScoreWatchdog> _logger;
    private readonly TimeSpan _interval;
    private readonly TimeSpan _timeout;

    public AiScoreWatchdog(MongoDbContext db, ILogger<AiScoreWatchdog> logger, IConfiguration config)
    {
        _db = db;
        _logger = logger;

        // 默认间隔 120 秒，超时 30 分钟
        var intervalSec = config.GetValue<int?>("AI_SCORE_WATCHDOG_INTERVAL_SECONDS") ?? 120;
        var timeoutSec = config.GetValue<int?>("AI_SCORE_WATCHDOG_TIMEOUT_SECONDS") ?? 1800;
        _interval = TimeSpan.FromSeconds(Math.Clamp(intervalSec, 30, 600));
        _timeout = TimeSpan.FromSeconds(Math.Clamp(timeoutSec, 300, 7200));
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
                _logger.LogWarning(ex, "AI score watchdog loop error");
            }
        }
    }

    private async Task SweepOnce(CancellationToken ct)
    {
        var deadline = DateTime.UtcNow - _timeout;

        // 查找卡在 "scoring" 且评分开始时间超过阈值的记录
        var filter =
            Builders<DefectShareLink>.Filter.Eq(x => x.AiScoreStatus, AiScoreStatusType.Scoring) &
            (
                // 有 AiScoreStartedAt 且超时
                (Builders<DefectShareLink>.Filter.Lt(x => x.AiScoreStartedAt, deadline) &
                 Builders<DefectShareLink>.Filter.Ne(x => x.AiScoreStartedAt, null))
                |
                // 没有 AiScoreStartedAt（历史数据兜底），用 CreatedAt 判断
                (Builders<DefectShareLink>.Filter.Eq(x => x.AiScoreStartedAt, null) &
                 Builders<DefectShareLink>.Filter.Lt(x => x.CreatedAt, deadline))
            );

        var update = Builders<DefectShareLink>.Update
            .Set(x => x.AiScoreStatus, AiScoreStatusType.Failed);

        var res = await _db.DefectShareLinks.UpdateManyAsync(filter, update, cancellationToken: ct);
        if (res.ModifiedCount > 0)
        {
            _logger.LogInformation(
                "AI score watchdog fixed {Count} stuck scoring tasks (timeout {TimeoutSeconds}s)",
                res.ModifiedCount, (int)_timeout.TotalSeconds);
        }
    }
}
