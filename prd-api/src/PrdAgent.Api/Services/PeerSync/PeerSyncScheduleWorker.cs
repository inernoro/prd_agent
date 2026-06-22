using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Sync;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.PeerSync;

/// <summary>
/// 知识库后台自动同步 worker：把「双向同步」从「点一次才跑一次」变成「定期自动保持两端一致」。
///
/// 复用 IPeerSyncTransferService.SyncItemAsync（与手动同步同一条路径，SSOT）。每个开启了自动同步、
/// 且到期的知识库，按它最近一次同步留下的对端 + 方向，自动跑 push/pull/both。
///
/// 防风暴五层（重点应对「共享 Mongo 多预览容器」场景，见 .claude/rules/cross-project-isolation.md）：
///   1) 每库 Mongo 租约：同一个库同一时刻只有一个容器能拿到租约去同步，杜绝 N 个容器各发一遍；
///   2) 全局并发上限 SemaphoreSlim：无论多少库到期，同时在途的对端 HTTP 不超过 MaxConcurrent；
///   3) 每轮批量上限 + 最久未同步优先：逐步排空，不搞惊群；
///   4) 到期闸 + 周期下限：只捞到期的库，周期被 PeerSyncSchedule 夹到 ≥5 分钟；
///   5) 启动抖动 + 崩溃租约自动过期自愈：多容器不在同一秒齐刷，owner 崩了别的容器能接管。
/// </summary>
public sealed class PeerSyncScheduleWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<PeerSyncScheduleWorker> _logger;

    /// <summary>扫描周期（到期判定本身另有 5 分钟下限，扫得勤只是为了让「刚开启」尽快首跑）。</summary>
    private static readonly TimeSpan ScanInterval = TimeSpan.FromMinutes(1);

    /// <summary>租约时长：owner 崩溃后超过这个时间，其它容器可接管。需大于单库同步的最坏耗时（HTTP 120s * 两阶段）。</summary>
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(10);

    /// <summary>全局并发上限：同时在途的对端 HTTP 同步数。</summary>
    private const int MaxConcurrent = 2;

    /// <summary>每轮最多处理多少个库（剩余的下一轮继续，逐步排空）。</summary>
    private const int PerCycleCap = 20;

    private readonly string _instanceId = $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid():N}";

    public PeerSyncScheduleWorker(IServiceScopeFactory scopeFactory, ILogger<PeerSyncScheduleWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("[PeerSyncScheduleWorker] Started on {InstanceId}, scan every {Interval}", _instanceId, ScanInterval);

        // 启动抖动：避免多容器同时启动时第一轮齐刷同一批到期库。
        try { await Task.Delay(TimeSpan.FromSeconds(Random.Shared.Next(3, 30)), stoppingToken); }
        catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(ScanInterval);
        do
        {
            try { await RunCycleAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { _logger.LogError(ex, "[PeerSyncScheduleWorker] cycle failed"); }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task RunCycleAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var now = DateTime.UtcNow;

        // 候选：开启了自动同步的库（按最久未自动同步优先）。到期判定在内存里做（含「上一轮未结束」过滤）。
        var candidates = await db.DocumentStores
            .Find(s => s.PeerSyncAutoEnabled == true)
            .SortBy(s => s.PeerSyncAutoLastAt)
            .Limit(PerCycleCap * 3)
            .ToListAsync(ct);

        var due = candidates.Where(s => PeerSyncSchedule.IsDue(s, now)).Take(PerCycleCap).ToList();
        if (due.Count == 0) return;

        _logger.LogInformation("[PeerSyncScheduleWorker] {Due} store(s) due for auto-sync", due.Count);

        using var gate = new SemaphoreSlim(MaxConcurrent, MaxConcurrent);
        var tasks = due.Select(store => SyncOneGuardedAsync(store.Id, gate, ct)).ToList();
        await Task.WhenAll(tasks);
    }

    private async Task SyncOneGuardedAsync(string storeId, SemaphoreSlim gate, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            // 每个库自己开 scope（MongoDbContext 是 scoped；并发跑必须各用各的，不能共享同一实例）。
            using var scope = _scopeFactory.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            var registry = scope.ServiceProvider.GetRequiredService<ISyncResourceRegistry>();
            var transfer = scope.ServiceProvider.GetRequiredService<IPeerSyncTransferService>();
            await SyncOneAsync(db, registry, transfer, storeId, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[PeerSyncScheduleWorker] auto-sync store {StoreId} failed", storeId);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task SyncOneAsync(
        MongoDbContext db, ISyncResourceRegistry registry, IPeerSyncTransferService transfer,
        string storeId, CancellationToken ct)
    {
        // ① 抢租约（防风暴第一层）：条件更新——未被占用 / 租约已过期 / owner 是自己 才抢得到。
        if (!await TryAcquireLeaseAsync(db, storeId, ct))
        {
            _logger.LogDebug("[PeerSyncScheduleWorker] lease busy for {StoreId}, skip on {InstanceId}", storeId, _instanceId);
            return;
        }

        // 是否真正消费了本次同步周期：只有过了「到期双检」才算（node 缺失也算消费，避免每分钟空打）。
        // 若因「不到期/已关/正被手动同步」提前返回，则不推进 AutoLastAt —— 否则会把一次没真跑的尝试
        // 记成满周期，把下一次后台同步推迟最多一个 interval（Bugbot: Skipped auto sync advances timer）。
        var attempted = false;
        try
        {
            // 抢到租约后重新读最新状态（可能刚被别人同步过 / 关掉了自动同步）。
            var store = await db.DocumentStores.Find(s => s.Id == storeId).FirstOrDefaultAsync(ct);
            if (store == null || !store.PeerSyncAutoEnabled) return;
            if (!PeerSyncSchedule.IsDue(store, DateTime.UtcNow)) return; // double-check：避免和刚结束的手动/别的容器叠跑
            attempted = true; // 过了双检 = 本周期确实由我处理，无论 node 在不在都推进 AutoLastAt

            var node = await db.PeerNodes
                .Find(n => n.RemoteNodeId == store.PeerSyncNodeId && n.Status == PeerNodeStatus.Connected)
                .FirstOrDefaultAsync(ct);
            if (node == null)
            {
                _logger.LogInformation("[PeerSyncScheduleWorker] store {StoreId} peer node {NodeId} not connected, skip",
                    storeId, store.PeerSyncNodeId);
                return; // 释放租约时会更新 AutoLastAt，下个周期再试（不至于每分钟空打）
            }

            var resource = registry.Resolve("document-store");
            if (resource == null) return;

            // 自动同步永远走非破坏性方向：push/pull/both（Overwrite，绝不 Mirror 删条目）。
            // 强制对齐（删除）是数据破坏路径，只能在 UI 二次确认后手动触发，自动同步不碰。
            var direction = NormalizeAutoDirection(store.PeerSyncDirection);
            var actor = await transfer.BuildActorAsync(store.OwnerId, isRoot: false, ct);
            var selfBaseUrl = Environment.GetEnvironmentVariable("PEER_SELF_BASE_URL")?.Trim().TrimEnd('/');

            var result = await transfer.SyncItemAsync(
                node, resource, store.Id, store.Name,
                direction, direction, SyncApplyMode.Overwrite, actor,
                preserveTimestamps: true, rewriteAssetLinks: true, sourceBaseUrl: selfBaseUrl, ct);

            _logger.LogInformation(
                "[PeerSyncScheduleWorker] auto-synced store {StoreId} dir={Dir} ok={Ok} created={C} updated={U} skipped={S}",
                storeId, direction, result.Ok, result.Created, result.Updated, result.Skipped);
        }
        finally
        {
            // ② 释放租约（必落库，CancellationToken.None）。AutoLastAt 仅在「本周期确实由我处理」时推进：
            //    不到期/已关的提前返回只还租约、不推进，下个周期立即可被重新评估。
            var update = Builders<DocumentStore>.Update
                .Unset(s => s.PeerSyncLeaseOwner)
                .Unset(s => s.PeerSyncLeaseExpiresAt);
            if (attempted)
                update = update.Set(s => s.PeerSyncAutoLastAt, DateTime.UtcNow);
            await db.DocumentStores.UpdateOneAsync(
                s => s.Id == storeId, update, cancellationToken: CancellationToken.None);
        }
    }

    private async Task<bool> TryAcquireLeaseAsync(MongoDbContext db, string storeId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var filter = Builders<DocumentStore>.Filter.And(
            Builders<DocumentStore>.Filter.Eq(s => s.Id, storeId),
            Builders<DocumentStore>.Filter.Eq(s => s.PeerSyncAutoEnabled, true),
            Builders<DocumentStore>.Filter.Or(
                Builders<DocumentStore>.Filter.Eq(s => s.PeerSyncLeaseOwner, null),
                Builders<DocumentStore>.Filter.Lt(s => s.PeerSyncLeaseExpiresAt, now),
                Builders<DocumentStore>.Filter.Eq(s => s.PeerSyncLeaseOwner, _instanceId)));
        var update = Builders<DocumentStore>.Update
            .Set(s => s.PeerSyncLeaseOwner, _instanceId)
            .Set(s => s.PeerSyncLeaseExpiresAt, now.Add(LeaseDuration));
        var result = await db.DocumentStores.UpdateOneAsync(filter, update, cancellationToken: ct);
        return result.ModifiedCount > 0 || result.MatchedCount > 0;
    }

    /// <summary>把库上记录的方向归一成自动同步要跑的方向：push/pull 保留，其余（both/received/align-*）一律 both。</summary>
    private static string NormalizeAutoDirection(string? direction) => direction switch
    {
        "push" => "push",
        "pull" => "pull",
        _ => "both",
    };
}
