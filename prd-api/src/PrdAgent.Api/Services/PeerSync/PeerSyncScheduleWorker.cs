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

    /// <summary>
    /// 租约时长：必须 &gt; 单库同步最坏耗时，否则大库同步超时后租约被另一发起方抢走 → 同库并发同步
    /// （Bugbot High: Lease expiry allows concurrent sync）。单库最坏 ≈ 两阶段 HTTP(各 120s) + 资源重传，
    /// 取 30min 留足余量；同时也是 owner 崩溃后的接管延迟。若未来出现 &gt;30min 的超大库，应改为「同步期间
    /// 心跳续租」（见 doc/debt.peer-sync.md，本 PR 未做）。
    /// </summary>
    public static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(30);

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
            var peer = scope.ServiceProvider.GetRequiredService<PrdAgent.Core.Interfaces.IPeerNodeService>();
            var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();
            await SyncOneAsync(db, registry, transfer, peer, config, storeId, ct);
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
        PrdAgent.Core.Interfaces.IPeerNodeService peer, IConfiguration config, string storeId, CancellationToken ct)
    {
        // 每次尝试用「实例 id + 唯一后缀」做租约持有者：绝不能用裸 _instanceId —— 否则下一个扫描周期
        // （1 分钟后）会因「同 owner 可重入」子句重新抢到自己上一轮仍在跑的租约，在同一实例上叠开两个
        // SyncItemAsync，击穿库级互斥（Bugbot High: Auto sync overlaps same store）。唯一后缀后，
        // 上一轮未结束（租约未过期、owner 不同）→ 本轮抢不到 → 跳过。
        var leaseOwner = $"{_instanceId}:{Guid.NewGuid():N}";
        // ① 抢租约（防风暴第一层）：与手动 transfer 共用同一把锁（TryAcquireStoreSyncLeaseAsync），
        //    手动同步 / 本实例上一轮仍在跑时都抢不到 → 不叠跑。
        if (!await transfer.TryAcquireStoreSyncLeaseAsync(storeId, leaseOwner, LeaseDuration, ct))
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

            // 防自指（与 POST /transfer 同口径）：共享 Mongo 预览部署里对端 RemoteNodeId 可能等于本节点
            // selfNodeId，自动同步若不挡会跑「自己同步自己」的无效流量（Bugbot: Auto worker skips self-node guard）。
            var selfNodeId = await peer.GetSelfNodeIdAsync(ct);
            if (string.Equals(node.RemoteNodeId, selfNodeId, StringComparison.Ordinal))
            {
                _logger.LogInformation("[PeerSyncScheduleWorker] store {StoreId} peer points to self ({NodeId}), skip", storeId, selfNodeId);
                return;
            }

            var resource = registry.Resolve("document-store");
            if (resource == null) return;

            // 自动同步永远走非破坏性方向：push/pull/both（Overwrite，绝不 Mirror 删条目）。
            // 强制对齐（删除）是数据破坏路径，只能在 UI 二次确认后手动触发，自动同步不碰。
            var direction = NormalizeAutoDirection(store.PeerSyncDirection);
            var actor = await transfer.BuildActorAsync(store.OwnerId, isRoot: false, ct);
            // 本节点对外地址：worker 无 Request，按与 ResolveServerUrl 一致的「无请求」来源取——
            // 先 PEER_SELF_BASE_URL，再 config["ServerUrl"]。反代部署只要配了其一，自动 push 的图片本地化
            // 就与手动同步一致；都没配才退化为 null（Bugbot: Auto sync missing push base URL）。
            var selfBaseUrl = Environment.GetEnvironmentVariable("PEER_SELF_BASE_URL")?.Trim().TrimEnd('/')
                ?? config["ServerUrl"]?.Trim().TrimEnd('/');

            var result = await transfer.SyncItemAsync(
                node, resource, store.Id, store.Name,
                direction, direction, SyncApplyMode.Overwrite, actor,
                preserveTimestamps: true, rewriteAssetLinks: true, sourceBaseUrl: selfBaseUrl, ct);

            _logger.LogInformation(
                "[PeerSyncScheduleWorker] auto-synced store {StoreId} dir={Dir} ok={Ok} created={C} updated={U} skipped={S}",
                storeId, direction, result.Ok, result.Created, result.Updated, result.Skipped);

            // 与手动 transfer 同口径：真正与对端成功通信过才 bump LastContactAt，否则 admin「最近通信」会因
            // 仅靠后台自动同步的部署而长期陈旧（Bugbot）。
            if (result.AnyPeerContact)
                await db.PeerNodes.UpdateOneAsync(n => n.Id == node.Id,
                    Builders<PeerNode>.Update.Set(n => n.LastContactAt, DateTime.UtcNow).Set(n => n.UpdatedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);
        }
        finally
        {
            // ② 释放租约（必落库，CancellationToken.None）。AutoLastAt 仅在「本周期确实由我处理」时推进：
            //    不到期/已关的提前返回只还租约、不推进，下个周期立即可被重新评估。
            // 关键：收尾必须按本次尝试的 leaseOwner 限定。若本次同步耗时超过租约、期间被另一尝试/实例接管，
            // 则我已不是持有者，绝不能按 storeId 盲清——否则会抹掉新持有者的租约、放行同库并发同步
            // （Bugbot High: Lease cleared without owner check）。
            var releaseFilter = Builders<DocumentStore>.Filter.And(
                Builders<DocumentStore>.Filter.Eq(s => s.Id, storeId),
                Builders<DocumentStore>.Filter.Eq(s => s.PeerSyncLeaseOwner, leaseOwner));
            var update = Builders<DocumentStore>.Update
                .Unset(s => s.PeerSyncLeaseOwner)
                .Unset(s => s.PeerSyncLeaseExpiresAt);
            if (attempted)
                update = update.Set(s => s.PeerSyncAutoLastAt, DateTime.UtcNow);
            await db.DocumentStores.UpdateOneAsync(releaseFilter, update, cancellationToken: CancellationToken.None);
        }
    }

    /// <summary>把库上记录的方向归一成自动同步要跑的方向：push/pull 保留，其余（both/received/align-*）一律 both。</summary>
    private static string NormalizeAutoDirection(string? direction) => direction switch
    {
        "push" => "push",
        "pull" => "pull",
        _ => "both",
    };
}
