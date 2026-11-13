using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// 租约只证明写入进程失去联络，不能证明上游失败或免费。迟到的真实完成回执仍可覆盖 unknown。
/// 老日志无租约不做猜测，不改 EndedAt，不填供应商状态、用量或费用。
/// </summary>
public sealed class GatewayLogLifecycleWorker(LlmGatewayDataContext data, LlmLogOwner owner,
    ILogger<GatewayLogLifecycleWorker> logger) : BackgroundService
{
    public static readonly TimeSpan LeaseWindow = TimeSpan.FromMinutes(3);

    public static FilterDefinition<LlmRequestLog> OrphanFilter(string instanceId, DateTime observedThrough)
    {
        var f = Builders<LlmRequestLog>.Filter;
        return f.Eq(x => x.WriterInstanceId, instanceId) & f.Eq(x => x.Status, "running")
            & f.Lte(x => x.StartedAt, observedThrough) & f.Eq(x => x.EndedAt, null);
    }

    public async Task TickAsync(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var leases = data.Database.GetCollection<BsonDocument>("llmgw_log_writer_leases");
        await leases.UpdateOneAsync(new BsonDocument("_id", owner.InstanceId),
            Builders<BsonDocument>.Update.Set("LastSeenAt", now).Set("ExpiresAt", now + LeaseWindow),
            new UpdateOptions { IsUpsert = true }, ct);
        var expired = await leases.Find(Builders<BsonDocument>.Filter.Lt("ExpiresAt", now))
            .Sort(Builders<BsonDocument>.Sort.Ascending("LastScannedAt").Ascending("ExpiresAt")).Limit(100).ToListAsync(ct);
        foreach (var lease in expired)
        {
            var id = lease["_id"].AsString;
            // 心跳中断后仍可能写入请求，随后进程崩溃。不能以旧租约到期时间截掉这批记录；
            // 只处理本轮观察时已经开始的请求，仍以 running + 无结束回执作条件更新。
            var observedThrough = now;
            // 重读确认，避免扫描后已经恢复心跳的实例被按旧快照收口。
            if (await leases.Find(new BsonDocument { { "_id", id }, { "ExpiresAt", new BsonDocument("$lt", DateTime.UtcNow) } }).AnyAsync(ct))
            {
                var changed = await data.LlmRequestLogs.UpdateManyAsync(OrphanFilter(id, observedThrough),
                    Builders<LlmRequestLog>.Update.Set(x => x.Status, "unknown")
                        .Set(x => x.LifecycleReason, "WRITER_LEASE_EXPIRED: 写入实例心跳租约已过期；上游结果、用量及费用未确认")
                        .Set(x => x.LifecycleReconciledAt, now), cancellationToken: ct);
                if (changed.ModifiedCount > 0) logger.LogWarning("网关调用日志按实例租约收口为未知: {InstanceId}, {Count}", id, changed.ModifiedCount);
            }
            // 不删除租约：恢复中的旧请求仍可能晚于当前扫描写入 running。
            // 更新扫描时间保证批量实例轮转，避免前 100 个旧实例长期占满扫描名额。
            await leases.UpdateOneAsync(new BsonDocument("_id", id), Builders<BsonDocument>.Update.Set("LastScannedAt", now), cancellationToken: ct);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(20));
        do
        {
            try { await TickAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { logger.LogError(error, "网关日志租约维护失败，将在下个周期重试"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
