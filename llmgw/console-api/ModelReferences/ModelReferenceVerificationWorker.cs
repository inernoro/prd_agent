using MongoDB.Driver;
using PrdAgent.LlmGw.ModelUpgrades;

namespace PrdAgent.LlmGw.ModelReferences;

/// <summary>Detect references saved again after a completed upgrade; never rewrite new user edits.</summary>
public sealed class ModelReferenceVerificationWorker(IMongoDatabase gateway, ModelReferenceEngine engine,
    IConfiguration configuration, ILogger<ModelReferenceVerificationWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (ModelUpgradeDeploymentAuthority.BlockReason(configuration) is not null) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
        do
        {
            try
            {
                var plans = gateway.GetCollection<ReferenceMigrationPlan>(MongoModelReferenceStore.JournalCollection);
                using var cursor = await plans.Find(x => x.Status == "completed").ToCursorAsync(stoppingToken);
                while (await cursor.MoveNextAsync(stoppingToken))
                foreach (var plan in cursor.Current)
                {
                    try
                    {
                        var checkedPlan = await engine.VerifyPlanAsync(plan.Id, plan.TenantId, plan.Revision, stoppingToken);
                        if (!checkedPlan.Coverage.Verified)
                            logger.LogWarning("模型引用复核发现遗漏，迁移 {IntentId} 已标记为阻塞；未改写业务配置。", plan.Id);
                    }
                    catch (ModelReferenceException)
                    {
                        // A concurrent explicit plan execution owns its journal. The next cycle will re-read it.
                        logger.LogWarning("模型引用计划 {IntentId} 正在变化，未覆盖其执行状态。", plan.Id);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception)
            {
                logger.LogError("模型引用复核无法完成；控制台需重新执行完整检查后确认升级状态。");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
