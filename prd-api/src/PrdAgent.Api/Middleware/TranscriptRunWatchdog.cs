using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using PrdAgent.Api.Services;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// 转录任务超时守门犬。
/// TranscriptRun 可能因 Worker 崩溃、服务重启等原因永远停留在 "processing"。
/// 此 Watchdog 定期扫描超时的 "processing" 记录，将其标记为 "failed"。
/// </summary>
public sealed class TranscriptRunWatchdog : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<TranscriptRunWatchdog> _logger;
    private readonly TimeSpan _interval;
    private readonly TimeSpan _timeout;
    private readonly IReadOnlyList<string> _compatibleOwnerIds;
    private readonly string _instanceId;
    private readonly bool _canAdoptLegacyRuns;
    private readonly IReadOnlyList<string> _retiredLegacyOwnerIds;
    private readonly DateTime? _legacyOwnerCreatedBeforeUtc;

    public TranscriptRunWatchdog(
        IServiceScopeFactory scopeFactory,
        ILogger<TranscriptRunWatchdog> logger,
        IConfiguration config)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;

        var intervalSec = config.GetValue<int?>("TRANSCRIPT_WATCHDOG_INTERVAL_SECONDS") ?? 120;
        _interval = TimeSpan.FromSeconds(Math.Clamp(intervalSec, 30, 600));
        _timeout = TranscriptRunTimingPolicy.ResolveWatchdogTimeout(config);
        _compatibleOwnerIds = InstanceIdentity.GetCompatibleOwnerIds(config);
        _instanceId = InstanceIdentity.Get(config);
        _canAdoptLegacyRuns = DeploymentAuthority.CanAdoptLegacyTranscriptRuns(config);
        _retiredLegacyOwnerIds = DeploymentAuthority.GetRetiredLegacyBranchOwnerIds(config);
        _legacyOwnerCreatedBeforeUtc = DeploymentAuthority.GetLegacyTranscriptCreatedBeforeUtc(config);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_interval, stoppingToken);
                await SweepOnce();
            }
            catch (OperationCanceledException)
            {
                // shutdown
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[transcript-watchdog] Sweep error");
            }
        }
    }

    private async Task SweepOnce()
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        var deadline = DateTime.UtcNow - _timeout;

        var ownedProcessingRuns = Builders<TranscriptRun>.Filter.In(r => r.OwnerInstanceId, _compatibleOwnerIds);
        var ownerScope = _canAdoptLegacyRuns
            ? LegacyOwnerScope.Build<TranscriptRun>(
                nameof(TranscriptRun.OwnerInstanceId),
                _compatibleOwnerIds,
                includeUnowned: true,
                retiredLegacyOwnerIds: _retiredLegacyOwnerIds,
                legacyOwnerCreatedBeforeUtc: _legacyOwnerCreatedBeforeUtc)
            : ownedProcessingRuns;

        // 当前部署只处理自己的超时 run；历史无 owner 的 processing run 仅由显式获权的
        // 正式部署接管并标记失败，CDS 预览仍不能碰共享库中的历史任务。
        var filter =
            Builders<TranscriptRun>.Filter.Eq(r => r.Status, "processing") &
            ownerScope &
            Builders<TranscriptRun>.Filter.Lt(r => r.UpdatedAt, deadline);

        var update = Builders<TranscriptRun>.Update
            .Set(r => r.Status, "failed")
            .Set(r => r.Error, $"任务超时（超过 {(int)_timeout.TotalMinutes} 分钟未完成）")
            .Set(r => r.OwnerInstanceId, _instanceId)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        var res = await db.TranscriptRuns.UpdateManyAsync(filter, update, cancellationToken: CancellationToken.None);

        if (res.ModifiedCount > 0)
        {
            _logger.LogInformation(
                "[transcript-watchdog] Fixed {Count} stuck processing runs (timeout {TimeoutMin}m)",
                res.ModifiedCount, (int)_timeout.TotalMinutes);

            // 同步更新对应 Item 的转写状态
            var stuckRuns = await db.TranscriptRuns
                .Find(Builders<TranscriptRun>.Filter.Eq(r => r.Status, "failed") &
                      Builders<TranscriptRun>.Filter.Eq(r => r.Error, $"任务超时（超过 {(int)_timeout.TotalMinutes} 分钟未完成）") &
                      Builders<TranscriptRun>.Filter.In(r => r.OwnerInstanceId, _compatibleOwnerIds) &
                      Builders<TranscriptRun>.Filter.Eq(r => r.Type, "asr"))
                .Project(r => r.ItemId)
                .ToListAsync();

            if (stuckRuns.Count > 0)
            {
                await db.TranscriptItems.UpdateManyAsync(
                    Builders<TranscriptItem>.Filter.In(i => i.Id, stuckRuns) &
                    Builders<TranscriptItem>.Filter.Eq(i => i.TranscribeStatus, "processing"),
                    Builders<TranscriptItem>.Update
                        .Set(i => i.TranscribeStatus, "failed")
                        .Set(i => i.TranscribeError, "转写任务超时"),
                    cancellationToken: CancellationToken.None);
            }
        }
    }
}
