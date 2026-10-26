using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.ProductAgent;

public sealed class ProductAnnouncementSyncWorker(IServiceScopeFactory scopes, IConfiguration configuration,
    ILogger<ProductAnnouncementSyncWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // CDS预览与生产共享数据，只允许原有共享任务权威执行或接管队列。
        if (!DeploymentAuthority.CanRunSharedScheduledWork(configuration)) return;
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<ProductAnnouncementSyncService>().TickAsync(DateTime.UtcNow, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception ex) { logger.LogError(ex, "公告后台任务暂不可执行，将自动重试"); }
            try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        }
    }
}
