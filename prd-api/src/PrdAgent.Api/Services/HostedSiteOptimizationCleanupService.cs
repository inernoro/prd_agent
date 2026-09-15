using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Services;

/// <summary>处理网页托管 ZIP 后台检查，并清理过期临时文件。失败只记日志，下轮继续。</summary>
public sealed class HostedSiteOptimizationCleanupService : BackgroundService
{
    private static readonly TimeSpan QueueInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan HealthInterval = TimeSpan.FromMinutes(1);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<HostedSiteOptimizationCleanupService> _logger;

    public HostedSiteOptimizationCleanupService(
        IServiceScopeFactory scopeFactory,
        ILogger<HostedSiteOptimizationCleanupService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        => await Task.WhenAll(
            ProcessQueueAsync(stoppingToken),
            CleanupExpiredAsync(stoppingToken),
            WatchQueueHealthAsync(stoppingToken));

    private async Task ProcessQueueAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(QueueInterval);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var service = scope.ServiceProvider.GetRequiredService<IHostedSiteOptimizationService>();
                await service.ProcessNextQueuedAsync(CancellationToken.None);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "清理过期网页托管优化任务失败，下轮继续");
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken)) break;
        }
    }

    private async Task CleanupExpiredAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(CleanupInterval);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var total = 0;
                while (!stoppingToken.IsCancellationRequested)
                {
                    using var scope = _scopeFactory.CreateScope();
                    var service = scope.ServiceProvider.GetRequiredService<IHostedSiteOptimizationService>();
                    var result = await service.CleanupExpiredAsync(CancellationToken.None);
                    total += result.Deleted;
                    if (result.Selected < 20) break;
                }
                if (total > 0)
                    _logger.LogInformation("清理了 {Count} 个过期网页托管优化任务", total);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "清理过期网页托管优化任务失败，下轮继续");
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken)) break;
        }
    }

    private async Task WatchQueueHealthAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(HealthInterval);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var service = scope.ServiceProvider.GetRequiredService<IHostedSiteOptimizationService>();
                var health = await service.GetQueueHealthAsync(CancellationToken.None);
                if (!health.Healthy)
                {
                    _logger.LogError(
                        "网页托管优化队列退化: {Message}; queued={QueuedCount}; active={ActiveCount}; expired={ExpiredHolderCount}; holders={HolderSessionIds}",
                        health.Message,
                        health.QueuedCount,
                        health.ActiveCount,
                        health.ExpiredHolderCount,
                        health.HolderSessionIds);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "网页托管优化队列健康检查失败，下轮继续");
            }

            if (!await timer.WaitForNextTickAsync(stoppingToken)) break;
        }
    }
}
