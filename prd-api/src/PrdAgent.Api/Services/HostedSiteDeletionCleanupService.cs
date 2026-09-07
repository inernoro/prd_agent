using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Services;

/// <summary>
/// 恢复网页托管未完成的对象清理。单次最多处理 20 条，失败任务由持久账本退避后重试；
/// 多副本通过账本租约竞争，不会同时清理同一站点。
/// </summary>
public sealed class HostedSiteDeletionCleanupService : BackgroundService
{
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMinutes(1);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<HostedSiteDeletionCleanupService> _logger;

    public HostedSiteDeletionCleanupService(
        IServiceScopeFactory scopeFactory,
        ILogger<HostedSiteDeletionCleanupService> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                for (var handled = 0; handled < 20; handled++)
                {
                    using var scope = _scopeFactory.CreateScope();
                    var sites = scope.ServiceProvider.GetRequiredService<HostedSiteService>();
                    var handledDeletion = await sites.ResumeNextPendingDeletionAsync(ct: stoppingToken);
                    var handledAssets = await sites.ResumeNextPendingAssetCleanupAsync(ct: stoppingToken);
                    if (!handledDeletion && !handledAssets) break;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "网页托管删除恢复周期失败");
            }

            try
            {
                await Task.Delay(ScanInterval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }
}
