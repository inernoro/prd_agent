using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>一次性锁定用户授权的唯一存量待审批立项，并恢复本流程中断的需求同步；不接管其它旧申请。</summary>
public sealed class ProductInitiationAutoIssueWorker(
    IServiceProvider services, IConfiguration configuration, ILogger<ProductInitiationAutoIssueWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // CDS 各分支共库：预览不能抢跑存量补发，也不能让 standby/canary 改共享状态。
        if (!DeploymentAuthority.CanRunSharedScheduledWork(configuration))
        {
            logger.LogInformation("当前部署非共享后台任务权威，跳过待审批自动补发");
            return;
        }
        await Task.Yield();
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = services.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
                var targetId = await ProductInitiationIssuance.ResolveLegacyTargetAsync(db);
                var count = await ProductInitiationIssuance.BackfillAsync(db, targetId, stoppingToken);
                if (count > 0) logger.LogInformation("产品内部版本已自动发放 {Count} 条待审批记录", count);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
            catch (Exception ex) { logger.LogError(ex, "产品待审批自动发号未完成，将重试；原记录保留"); }
            try { await Task.Delay(TimeSpan.FromMinutes(1), stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { return; }
        }
    }
}
