using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ModelReferences;

/// <summary>仅写自身部署、进程的心跳；不删除其他实例，不创建索引，不发模型请求。</summary>
public sealed class ModelRuntimeReferenceSnapshotWorker(
    MongoDbContext database,
    ModelRuntimeReferenceSnapshotBuilder builder,
    ILogger<ModelRuntimeReferenceSnapshotWorker> logger) : BackgroundService
{
    public const string CollectionName = "model_runtime_reference_snapshots";
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await PublishOnceAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception)
            {
                // 连接串、配置对象和数据库异常正文均不能进入这条日志。
                logger.LogWarning("运行模型引用快照未能更新；过期快照不能证明部署已完成型号升级。");
            }
            try { await Task.Delay(HeartbeatInterval, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }

    public async Task PublishOnceAsync(CancellationToken ct)
    {
        ModelRuntimeDatabaseReferences references;
        try
        {
            var main = await database.LLMModels.Find(x => x.IsMain && x.Enabled)
                .Project(x => new { x.ModelName, x.PlatformId }).Limit(2).ToListAsync(ct);
            var active = await database.LLMConfigs.Find(x => x.IsActive)
                .Project(x => x.Model).Limit(2).ToListAsync(ct);
            references = new(true,
                main.Select(x => new ModelRuntimeStoredSelection(x.ModelName, x.PlatformId)).ToList(),
                active.Select(x => new ModelRuntimeStoredSelection(x)).ToList());
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception)
        {
            references = new(false, [], []);
        }
        var snapshot = builder.Capture(references, DateTime.UtcNow);
        await database.Database.GetCollection<ModelRuntimeReferenceSnapshot>(CollectionName)
            .ReplaceOneAsync(OwnRecordFilter(snapshot), snapshot, new ReplaceOptions { IsUpsert = true }, ct);
    }

    public static FilterDefinition<ModelRuntimeReferenceSnapshot> OwnRecordFilter(ModelRuntimeReferenceSnapshot snapshot)
    {
        var f = Builders<ModelRuntimeReferenceSnapshot>.Filter;
        return f.Eq(x => x.Id, snapshot.Id)
            & f.Eq(x => x.TenantId, snapshot.TenantId)
            & f.Eq(x => x.DeploymentIdentity, snapshot.DeploymentIdentity)
            & f.Eq(x => x.DeploymentScope, snapshot.DeploymentScope)
            & f.Eq(x => x.InstanceId, snapshot.InstanceId);
    }
}
