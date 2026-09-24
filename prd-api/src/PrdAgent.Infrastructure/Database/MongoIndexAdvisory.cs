using Microsoft.Extensions.Logging;
using MongoDB.Bson;
using MongoDB.Driver;

namespace PrdAgent.Infrastructure.Database;

/// <summary>
/// 一条「缺了会出事」的人工维护索引：在哪个集合、叫什么、缺了会怎样。
/// </summary>
/// <param name="Collection">集合名，与 MongoDbContext 与 scripts/mongodb-indexes.js 一致。</param>
/// <param name="Name">索引名，必须与 scripts/mongodb-indexes.js 里声明的名字逐字相同（有守卫）。</param>
/// <param name="Consequence">缺席期间会退化成什么样。写给运维读的第一句话，不写索引结构。</param>
public sealed record RequiredMongoIndex(string Collection, string Name, string Consequence)
{
    public string QualifiedName => $"{Collection}.{Name}";
}

/// <summary>
/// 启动巡检要查的索引清单。这是**数据**：新增一条就是加一行，不许在检查逻辑里写 if。
///
/// 只收「缺了会让周期任务整表扫描」或「缺了会让并发正确性失守」的那几条，
/// 不是全量索引目录——全量目录的唯一事实源是 scripts/mongodb-indexes.js，这里只挑出
/// 值得在启动日志里点名的子集。每个名字都必须在那份脚本里出现（MongoIndexAdvisoryCatalogTests 守着）。
/// </summary>
public static class RequiredMongoIndexCatalog
{
    public const string GuidePath = "doc/guide.platform.mongodb-indexes.md";
    public const string ScriptPath = "scripts/mongodb-indexes.js";

    public static IReadOnlyList<RequiredMongoIndex> All { get; } =
    [
        new(
            "hosted_sites",
            "idx_hosted_sites_asset_cleanup_due",
            "网页托管对象清理每分钟一轮认领待清理站点时，会全表扫描 hosted_sites 并在内存里排序，站点越多越拖慢数据库"),
        new(
            "hosted_site_deletion_tasks",
            "idx_hosted_site_deletion_due",
            "网页托管删除清理每分钟一轮认领到期删除任务时，会全表扫描 hosted_site_deletion_tasks 并在内存里排序，任务积压时拖慢数据库"),
        new(
            "hosted_site_revisions",
            "uniq_hosted_site_revision_rollback_idempotency",
            "同一次网页版本回退请求被并发重放时两次都会写入，同一站点会多出重复的回退版本（回退幂等失效）"),
        new(
            "infra_agent_sessions",
            "uniq_infra_agent_sessions_prewarm_key",
            "多个 API 副本同时收到同一用户同一风格的 PPT 预热请求时会各自起一个远端会话（跨副本 single-flight 失效），重复占用运行时"),
        new(
            "activity_logs",
            "uniq_activity_logs_deduplication_key",
            "同一条领域动态（如生成站点发布）在重试或多副本并发写入时会记成两条，动态时间线出现重复（幂等键失效）"),
    ];
}

/// <summary>一次巡检的结论。Missing = 确认不存在；Unverified = 列索引失败、结论未知。</summary>
public sealed record MongoIndexAdvisoryReport(
    DateTime CheckedAt,
    IReadOnlyList<string> Missing,
    IReadOnlyList<string> Unverified);

/// <summary>
/// 启动时**查**上面那张表里的索引在不在，不建。
///
/// 为什么不建：no-auto-index 禁的是启动路径上建索引这件事本身——大集合上建索引会阻塞写入，
/// 多副本滚动重启时各建各的，建失败还可能让进程起不来。建索引归 DBA 跑可执行清单。
///
/// 为什么还要查：这些索引缺席时不报错、不变红，只是周期任务悄悄整表扫描、或并发窗口悄悄敞开
/// （degradation-must-alarm：降级要响铃）。所以缺了写 Warning，第一句写后果，第二句写谁去做什么。
///
/// 检查本身失败（没有 listIndexes 权限、连不上）也只写日志、不抛：一次巡检不该让 API 起不来。
/// 结论只是启动那一刻的快照，DBA 补建之后要等下一次启动才会刷新（就绪端点把检查时间一并给出）。
/// </summary>
public sealed class MongoIndexAdvisory
{
    private MongoIndexAdvisoryReport? _lastReport;

    /// <summary>最近一次巡检的结论；还没跑过时为 null。</summary>
    public MongoIndexAdvisoryReport? LastReport => Volatile.Read(ref _lastReport);

    private readonly object _refreshGate = new();
    private Task<MongoIndexAdvisoryReport>? _inFlightRefresh;

    /// <summary>
    /// 快照超过 <paramref name="maxAge"/> 才刷新，并且同一时刻只允许一次刷新在跑（single-flight）：
    /// 深度自检会被 CDS 的多条监控并发探测，缓存过期那一刻若各自重扫，会重复打 Mongo、重复写告警，
    /// 慢的那次超时还会把快的那次的正常结论覆盖成「未核实」。刷新只受 <paramref name="budget"/> 约束，
    /// 不绑任何一个调用方的取消令牌——否则第一个断开的请求会连累其余等待者。
    /// </summary>
    public Task<MongoIndexAdvisoryReport> RefreshIfStaleAsync(
        IMongoDatabase database,
        ILogger logger,
        TimeSpan maxAge,
        TimeSpan budget)
        => RefreshIfStaleAsync(
            RequiredMongoIndexCatalog.All,
            (collection, token) => ListIndexNamesAsync(database, collection, token),
            logger,
            maxAge,
            budget,
            () => DateTime.UtcNow);

    /// <summary><see cref="RefreshIfStaleAsync(IMongoDatabase, ILogger, TimeSpan, TimeSpan)"/> 的可注入版本。</summary>
    public Task<MongoIndexAdvisoryReport> RefreshIfStaleAsync(
        IReadOnlyList<RequiredMongoIndex> required,
        Func<string, CancellationToken, Task<IReadOnlyCollection<string>>> listIndexNames,
        ILogger logger,
        TimeSpan maxAge,
        TimeSpan budget,
        Func<DateTime> clock)
    {
        var last = LastReport;
        if (last is not null && clock() - last.CheckedAt <= maxAge)
            return Task.FromResult(last);

        lock (_refreshGate)
        {
            if (_inFlightRefresh is { IsCompleted: false })
                return _inFlightRefresh;
            _inFlightRefresh = RunBoundedAsync(required, listIndexNames, logger, budget, clock());
            return _inFlightRefresh;
        }
    }

    private async Task<MongoIndexAdvisoryReport> RunBoundedAsync(
        IReadOnlyList<RequiredMongoIndex> required,
        Func<string, CancellationToken, Task<IReadOnlyCollection<string>>> listIndexNames,
        ILogger logger,
        TimeSpan budget,
        DateTime now)
    {
        using var timeout = new CancellationTokenSource(budget);
        try
        {
            return await CheckAsync(required, listIndexNames, logger, now, timeout.Token);
        }
        catch (OperationCanceledException)
        {
            // 超时：CheckAsync 已把没查完的几条记成「未核实」写进快照
            return LastReport!;
        }
    }

    /// <summary>对真实库执行巡检。</summary>
    public Task<MongoIndexAdvisoryReport> CheckAsync(
        IMongoDatabase database,
        ILogger logger,
        CancellationToken ct = default)
        => CheckAsync(
            RequiredMongoIndexCatalog.All,
            (collection, token) => ListIndexNamesAsync(database, collection, token),
            logger,
            DateTime.UtcNow,
            ct);

    /// <summary>
    /// 巡检主体。列索引的方式由调用方注入，便于在没有 Mongo 的环境里验证判定。
    /// </summary>
    public async Task<MongoIndexAdvisoryReport> CheckAsync(
        IReadOnlyList<RequiredMongoIndex> required,
        Func<string, CancellationToken, Task<IReadOnlyCollection<string>>> listIndexNames,
        ILogger logger,
        DateTime now,
        CancellationToken ct = default)
    {
        var missing = new List<string>();
        var unverified = new List<string>();
        var groups = required.GroupBy(index => index.Collection, StringComparer.Ordinal).ToList();

        for (var groupIndex = 0; groupIndex < groups.Count; groupIndex++)
        {
            var group = groups[groupIndex];
            IReadOnlyCollection<string> present;
            try
            {
                present = await listIndexNames(group.Key, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                // 超时或停机：没查完的那几条落成「未核实」再往外抛。不留快照的话，
                // 就绪端点会一直显示 null，和「巡检还在跑」分不开。
                unverified.AddRange(groups.Skip(groupIndex).SelectMany(g => g).Select(i => i.QualifiedName));
                Volatile.Write(ref _lastReport, new MongoIndexAdvisoryReport(now, missing, unverified));
                throw;
            }
            catch (Exception ex)
            {
                foreach (var index in group)
                {
                    unverified.Add(index.QualifiedName);
                    logger.LogWarning(
                        "无法确认索引 {IndexName} 是否存在，所以下面这件事现在是未知的：{Consequence}。"
                        + "API 启动照常，不受影响；请确认 API 使用的数据库账号有 {Collection} 的 listIndexes 权限，"
                        + "再按 {GuidePath} 核对这条索引。技术细节：{ExceptionType}: {ExceptionMessage}",
                        index.Name,
                        index.Consequence,
                        index.Collection,
                        RequiredMongoIndexCatalog.GuidePath,
                        ex.GetType().Name,
                        ex.Message);
                }
                continue;
            }

            var names = present.ToHashSet(StringComparer.Ordinal);
            foreach (var index in group)
            {
                if (names.Contains(index.Name)) continue;
                missing.Add(index.QualifiedName);
                logger.LogWarning(
                    "缺少 MongoDB 索引 {IndexName}（集合 {Collection}），于是：{Consequence}。"
                    + "应用启动不会自动建索引（no-auto-index），请 DBA 按 {GuidePath} 执行 {ScriptPath} 补建。",
                    index.Name,
                    index.Collection,
                    index.Consequence,
                    RequiredMongoIndexCatalog.GuidePath,
                    RequiredMongoIndexCatalog.ScriptPath);
            }
        }

        var report = new MongoIndexAdvisoryReport(now, missing, unverified);
        Volatile.Write(ref _lastReport, report);

        if (missing.Count == 0 && unverified.Count == 0)
        {
            logger.LogInformation(
                "MongoDB 索引巡检：{Count} 条需要人工维护的关键索引都已存在",
                required.Count);
        }

        return report;
    }

    private static async Task<IReadOnlyCollection<string>> ListIndexNamesAsync(
        IMongoDatabase database,
        string collection,
        CancellationToken ct)
    {
        // 集合还不存在时驱动返回空列表，于是这些索引按「缺失」报出：
        // 空库上首批写入同样没有唯一约束兜底，报出来是对的。
        var cursor = await database.GetCollection<BsonDocument>(collection).Indexes.ListAsync(ct);
        var documents = await cursor.ToListAsync(ct);
        return documents
            .Select(document => document.GetValue("name", BsonNull.Value))
            .Where(value => value.IsString)
            .Select(value => value.AsString)
            .ToList();
    }
}
