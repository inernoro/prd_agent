using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Services;

/// <summary>清理用户未确认的网页托管优化临时文件。失败只记日志，下轮继续。</summary>
public sealed class HostedSiteOptimizationCleanupService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);
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
    {
        using var timer = new PeriodicTimer(Interval);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var service = scope.ServiceProvider.GetRequiredService<IHostedSiteOptimizationService>();
                var cleaned = await service.CleanupExpiredAsync(stoppingToken);
                if (cleaned > 0)
                    _logger.LogInformation("清理了 {Count} 个过期网页托管优化任务", cleaned);
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
}
