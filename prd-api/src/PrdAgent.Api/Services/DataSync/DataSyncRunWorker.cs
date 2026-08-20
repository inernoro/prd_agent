using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services.DataSync;
using PrdAgent.Core.DataSync;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.DataSync;

/// <summary>
/// 跨实例同步的执行者。
///
/// 认领条件是「Run 处于 running **且本进程内存里握着它的导出令牌**」。这一条同时
/// 解决了两件事：没有令牌本来就拉不动数据；以及共享 Mongo 上别的部署（含跑着旧构建的
/// 分支预览）不会来抢这条 Run —— 后者在本仓库出过事故，裸 Status 认领是明确的反面教材。
/// </summary>
public sealed class DataSyncRunWorker : BackgroundService
{
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    private const int PageSize = 200;

    /// <summary>多久扫一次没人认领的 running Run。</summary>
    private static readonly TimeSpan OrphanSweepInterval = TimeSpan.FromMinutes(1);

    /// <summary>
    /// 多久没有心跳就判定这条 running Run 已经死了。
    ///
    /// 活着的 Run 每写完一页就落一次进度（<see cref="SaveProgressAsync"/> 会刷 UpdatedAt），
    /// 单页耗时受 HttpClient 超时封顶，所以正常情况下心跳间隔远小于这个阈值；
    /// 反过来它又远小于导出令牌的两小时寿命，不会把「还能救」的 Run 提前判死。
    /// </summary>
    private static readonly TimeSpan OrphanHeartbeatTimeout = TimeSpan.FromMinutes(15);

    private DateTime _lastOrphanSweep = DateTime.MinValue;

    private readonly IServiceProvider _services;
    private readonly DataSyncTokenVault _vault;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<DataSyncRunWorker> _logger;

    public DataSyncRunWorker(
        IServiceProvider services,
        DataSyncTokenVault vault,
        IHttpClientFactory httpClientFactory,
        ILogger<DataSyncRunWorker> logger)
    {
        _services = services;
        _vault = vault;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // 单次 tick 出错不该让整个 worker 退出，否则一次网络抖动就要重启进程才能同步。
                _logger.LogError(ex, "[data-sync] worker tick 失败");
            }
            await Task.Delay(PollInterval, stoppingToken);
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        var held = _vault.HeldRunIds;
        // 先取过期的：HeldRunIds 会把过期条目清掉，取的顺序反了就再也拿不到了。
        var expired = _vault.DrainExpiredRunIds();
        var sweepDue = DateTime.UtcNow - _lastOrphanSweep >= OrphanSweepInterval;
        if (held.Count == 0 && expired.Count == 0 && !sweepDue) return;

        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

        if (sweepDue)
        {
            _lastOrphanSweep = DateTime.UtcNow;
            await SweepOrphanedRunsAsync(db, ct);
        }

        // 令牌在「Start 成功之后、这次轮询之前」过期的 Run：它不在 held 里，永远走不到
        // ExecuteRunAsync 那条「没令牌就判失败」的路，会在库里一直停在 running。
        // 这里替它落终态——只处理本进程握过的那些，不去碰别的部署的 Run。
        if (expired.Count > 0)
        {
            var stale = await db.DataSyncRuns.Find(Builders<DataSyncRun>.Filter.And(
                Builders<DataSyncRun>.Filter.Eq(x => x.Status, "running"),
                Builders<DataSyncRun>.Filter.In(x => x.Id, expired))).ToListAsync(ct);
            foreach (var run in stale)
            {
                _logger.LogWarning("[data-sync] Run {RunId} 的导出令牌已过期，落终态", run.Id);
                await FailAsync(db, run, "导出令牌在同步开始前就过期了，请重新授权后再跑一次", CancellationToken.None);
            }
        }

        if (held.Count == 0) return;

        var runs = await db.DataSyncRuns.Find(Builders<DataSyncRun>.Filter.And(
            Builders<DataSyncRun>.Filter.Eq(x => x.Status, "running"),
            Builders<DataSyncRun>.Filter.In(x => x.Id, held))).ToListAsync(ct);

        foreach (var run in runs)
        {
            await ExecuteRunAsync(db, run, ct);
        }
    }

    private async Task ExecuteRunAsync(MongoDbContext db, DataSyncRun run, CancellationToken ct)
    {
        var token = _vault.GetExportToken(run.Id);
        if (token is null)
        {
            await FailAsync(db, run, "导出令牌已过期，需要重新授权后再跑一次", ct);
            return;
        }

        try
        {
            // 只跑对照表上展示过的那一份（Plan 落的 PlannedCollections）。
            // 用 run.Collections 会把「源站没报告、屏幕上写着不会同步」的集合也写进去。
            var toRun = run.PlannedCollections.Count > 0 ? run.PlannedCollections : run.Collections;
            foreach (var collectionName in toRun)
            {
                if (ct.IsCancellationRequested)
                {
                    // 直接 return 会把 Run 永久留在 running：重启后内存里的令牌没了，
                    // 没有任何 worker 能再认领它，历史页上就一直转着（server-authority #5）。
                    // 用 None 落终态——此刻 ct 已经取消，拿它去写库只会连这一步也被取消。
                    //
                    // 也必须在这里交还导出令牌。这是第三条终态路径，之前只顾了成功与异常
                    // 两条：本地令牌被 FailAsync 顺手忘掉，源站那边的票却照样能再用近两小时，
                    // 而且重启后已经没有人记得它、再也不会有人去作废它。
                    await ReturnExportTokenAsync(run, token, CancellationToken.None);
                    await FailAsync(db, run, "服务重启中断了这次同步，请重新授权后再跑一次", CancellationToken.None);
                    return;
                }
                if (!DataSyncScope.TryResolve(collectionName, out var collection))
                {
                    // 走到这里说明「人确认过的清单里有它，本站却跑不了」。Plan 已经把
                    // 本站不认识的集合挡在执行清单之外了，所以这是不该发生的状态。
                    //
                    // 原来这里是「跳过 + 留一条日志」，于是整条 Run 照样报成功——
                    // 对照表上列着它、终态写着成功、数据一条没搬。少搬东西可以接受，
                    // 「少搬了还说成功」不行。宁可失败，让人看得见。
                    await ReturnExportTokenAsync(run, token, CancellationToken.None);
                    await FailAsync(db, run,
                        $"计划里的集合 {collectionName} 不在本站白名单——两边版本多半不一致，请升级本站后重新授权",
                        CancellationToken.None);
                    return;
                }
                var progress = run.Progress.TryGetValue(collectionName, out var existing)
                    ? existing
                    : new DataSyncCollectionProgress();
                if (progress.Done) continue;

                await PullCollectionAsync(db, run, collection, progress, token, ct);
            }

            await db.DataSyncRuns.UpdateOneAsync(
                Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
                Builders<DataSyncRun>.Update
                    .Set(x => x.Status, "succeeded")
                    .Set(x => x.FinishedAt, DateTime.UtcNow)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            await ReturnExportTokenAsync(run, token, ct);
            _vault.Forget(run.Id);
            _logger.LogInformation("[data-sync] Run {RunId} 完成（dryRun={DryRun}）", run.Id, run.DryRun);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[data-sync] Run {RunId} 执行失败", run.Id);
            // 收尾一律用 None：走到这里 ct 很可能已经取消，拿它去写库等于连「记下失败」
            // 这一步也做不成，Run 会卡在 running（server-authority #5）。
            await ReturnExportTokenAsync(run, token, CancellationToken.None);
            await FailAsync(db, run, ex.Message, CancellationToken.None);
        }
    }

    private async Task PullCollectionAsync(
        MongoDbContext db,
        DataSyncRun run,
        DataSyncCollection collection,
        DataSyncCollectionProgress progress,
        string token,
        CancellationToken ct)
    {
        // 源站地址是管理员填进来的，必须走 SafeOutbound：它禁自动重定向、并在建连时把
        // 解析出的每个地址过一遍内网/保留段校验。默认客户端会让「https://127.0.0.1」
        // 或者一个公网地址 302 跳内网，把 API 服务器变成打自己内网的跳板。
        var client = _httpClientFactory.CreateClient("SafeOutbound");
        client.Timeout = TimeSpan.FromSeconds(120);
        client.DefaultRequestHeaders.Add("X-Data-Sync-Token", token);
        var target = db.Database.GetCollection<BsonDocument>(collection.Name);

        while (!ct.IsCancellationRequested)
        {
            var url = $"{run.SourceOrigin}/api/instance-sync/export?collection={Uri.EscapeDataString(collection.Name)}&limit={PageSize}";
            if (!string.IsNullOrEmpty(progress.Cursor)) url += $"&after={Uri.EscapeDataString(progress.Cursor)}";

            using var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException(
                    $"拉取 {collection.Name} 失败（HTTP {(int)response.StatusCode}）");
            }

            var page = ReadPage(await response.Content.ReadAsStringAsync(ct), collection.Name);
            var documents = DataSyncApply.ParseDocuments(page.Documents);
            progress.Fetched += documents.Count;

            if (documents.Count > 0)
            {
                var ids = documents.Select(d => d["_id"]).ToList();
                // 只查这一批的 id，不是整表 —— 整表 id 在几十万条上会把内存吃光。
                var existing = await target
                    .Find(Builders<BsonDocument>.Filter.In("_id", ids))
                    .Project(BuildExistingProjection(collection))
                    .ToListAsync(ct);
                var existingIds = existing.Select(d => d["_id"]).ToHashSet();

                var decision = DataSyncApply.Decide(documents, existingIds, run.OverwriteExisting);
                progress.Skipped += decision.SkippedIds.Count;

                // 覆盖写是整份替换，所以「目标站本地执行历史」这类字段必须在替换前接回来，
                // 否则源站那台机器跑过哪些迁移会变成本站的账：本站没跑过的被当成跑过而跳过，
                // 或者管理员手工回退过的被当成没跑过而重来一遍。源站出口已经把这些字段删掉了，
                // 这里补的是本站原有的那份。
                DataSyncApply.CarryTargetLocalFields(decision.ToReplace, existing, collection);

                if (!run.DryRun)
                {
                    if (decision.ToInsert.Count > 0)
                    {
                        // IsOrdered=false 让这一批剩下的继续写，但**只要有一条失败它仍然抛**。
                        // 不接住的话：已经写进去的那部分不计数、后面的集合全被放弃、整次同步判失败——
                        // 而真实原因往往只是几条撞了业务唯一索引（同一条记录在两边各有一个 _id）。
                        // 这类冲突按「跳过」处理并记进 Skipped，其余错误照旧上抛。
                        try
                        {
                            await target.InsertManyAsync(decision.ToInsert,
                                new InsertManyOptions { IsOrdered = false }, ct);
                        }
                        catch (MongoBulkWriteException<BsonDocument> ex)
                        {
                            // 写关注失败（副本集确认超时之类）不带任何 WriteError，于是
                            // 「全部错误都是重复键」这句在 0 == 0 上恒真——一次持久性未知
                            // 的写入会被当成「几条撞索引」咽下去。必须先把它挡在外面。
                            if (ex.WriteConcernError is not null) throw;
                            var conflicts = ex.WriteErrors.Count(e => e.Category == ServerErrorCategory.DuplicateKey);
                            if (conflicts == 0 || conflicts != ex.WriteErrors.Count) throw;
                            progress.Skipped += conflicts;
                            _logger.LogWarning(
                                "[data-sync] {Collection} 有 {Count} 条撞唯一索引，已跳过；其余 {Written} 条已写入",
                                collection.Name, conflicts, decision.ToInsert.Count - conflicts);
                            // 按**失败的下标**剔除，不是砍掉末尾 N 条：IsOrdered=false 时
                            // 冲突可以落在任意位置。判据抽在 DataSyncApply.SurvivingInserts。
                            decision = decision with
                            {
                                ToInsert = DataSyncApply
                                    .SurvivingInserts(decision.ToInsert, ex.WriteErrors.Select(e => e.Index))
                                    .ToList(),
                            };
                        }
                    }
                    foreach (var doc in decision.ToReplace)
                    {
                        await target.ReplaceOneAsync(
                            Builders<BsonDocument>.Filter.Eq("_id", doc["_id"]), doc, cancellationToken: ct);
                    }
                    progress.Inserted += decision.ToInsert.Count;
                    progress.Updated += decision.ToReplace.Count;
                }
                // 无论真跑还是试跑都记「打算写多少」，但只有真跑才记「写了多少」。
                progress.PlannedInsert += decision.ToInsert.Count;
                progress.PlannedUpdate += decision.ToReplace.Count;

                // 待补清单只能从**真的落到本站的那些文档**上取。
                //
                // 两层都要卡。第一层用源站报的「我清空了哪些」而不是自己看哪个字段是空的，
                // 否则源站从来没配过的密钥也会被算成「被清空、待补」。第二层是这里：
                // 不覆盖模式下同 _id 的文档会被跳过，本站原有的那份凭据**原封不动还在**，
                // 若照样把该字段记进待补清单，就等于告诉管理员「一个还好好的凭据被同步空了，
                // 去补一遍」——他照做反而会把本来能用的配置改坏。所以按写入/将写入的文档
                // 逐条看字段在不在，一条都没落地的页面不产生任何待补项。
                // 试跑同样记：它要回答的正是「真跑之后我得补哪些」。
                RecordPendingSecrets(run, collection.Name, page.ClearedFields,
                    decision.ToInsert.Concat(decision.ToReplace));
            }

            progress.Cursor = page.NextCursor;
            progress.Done = string.IsNullOrEmpty(page.NextCursor);
            run.Progress[collection.Name] = progress;
            await SaveProgressAsync(db, run, ct);

            if (progress.Done) return;
        }
    }

    /// <summary>
    /// 查已存在文档时要带上哪些字段。默认只要 _id（整表 id 都拉回来会吃光内存，
    /// 所以能少拿一列是一列）；有「目标站本地执行历史」的集合额外拿那几个字段，
    /// 覆盖写之前要把它们接回替换文档上。
    /// </summary>
    private static ProjectionDefinition<BsonDocument> BuildExistingProjection(DataSyncCollection collection)
    {
        var projection = Builders<BsonDocument>.Projection.Include("_id");
        foreach (var field in collection.PreserveFields)
        {
            projection = projection.Include(field);
        }
        return projection;
    }

    /// <summary>
    /// 收掉没人认领的 running Run。
    ///
    /// 认领条件是「running 且**本进程内存里握着导出令牌**」，这挡住了共享 Mongo 上别的
    /// 部署来抢单，但也留下一个洞：Start 已经把 Run 落成 running，进程紧接着被硬杀
    /// （OOM、容器重建、kill -9），令牌随内存一起没了。重启后新进程的 vault 是空的，
    /// 这条 Run 永远选不中，也就永远停在 running——界面上是一条永不结束的进度。
    /// 优雅退出那条路已经会落终态，这里补的是不优雅的那种。
    ///
    /// 判据只用「有没有心跳」，不用部署身份：活着的 Run 每页都会刷 UpdatedAt，无论它
    /// 属于哪个部署；死了的谁都刷不动。所以任何一个部署都能安全地替它收尸，不需要在
    /// Run 上再加一个部署作用域字段，也不会误杀兄弟部署正在跑的 Run
    /// （对照 cross-project-isolation 通道 8：那里裸 Status 认领会抢活单，这里的谓词
    /// 多了「15 分钟没动静」，活单不满足）。
    /// </summary>
    private async Task SweepOrphanedRunsAsync(MongoDbContext db, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow - OrphanHeartbeatTimeout;
        var mine = _vault.HeldRunIds;
        var orphans = await db.DataSyncRuns.Find(Builders<DataSyncRun>.Filter.And(
            Builders<DataSyncRun>.Filter.Eq(x => x.Status, "running"),
            Builders<DataSyncRun>.Filter.Lt(x => x.UpdatedAt, deadline))).ToListAsync(ct);

        foreach (var run in orphans)
        {
            // 本进程正握着的不碰：它要么在跑（心跳会刷新），要么会走 ExecuteRunAsync
            // 自己的失败路径，那条路径给得出真实原因，比这里的兜底文案有用。
            if (mine.Contains(run.Id)) continue;

            // 条件更新：读到现在这段时间里它可能已经被别人收走或自己跑完了。
            // 只在「仍然 running 且仍然没心跳」时才落终态，谁都不许覆盖已经写好的结局。
            var terminalized = await db.DataSyncRuns.UpdateOneAsync(
                Builders<DataSyncRun>.Filter.And(
                    Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
                    Builders<DataSyncRun>.Filter.Eq(x => x.Status, "running"),
                    Builders<DataSyncRun>.Filter.Lt(x => x.UpdatedAt, deadline)),
                Builders<DataSyncRun>.Update
                    .Set(x => x.Status, "failed")
                    .Set(x => x.Error, "同步在执行途中被中断（服务异常退出），已写入的部分保留，请重新授权后再跑一次")
                    .Set(x => x.FinishedAt, DateTime.UtcNow)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            if (terminalized.ModifiedCount > 0)
            {
                _logger.LogWarning(
                    "[data-sync] Run {RunId} 自 {UpdatedAt:o} 起没有心跳，判定为进程异常退出遗留，已落终态",
                    run.Id, run.UpdatedAt);
            }
        }
    }

    /// <summary>
    /// 把「源站清空了、本站需要手工补」的字段记进 Run。只认真的落地（或试跑里将要落地）
    /// 的那些文档：被跳过的文档在本站的原值没有被动过，报进待补清单是误报。
    /// </summary>
    internal static void RecordPendingSecrets(
        DataSyncRun run, string collection, IReadOnlyList<string> clearedFields, IEnumerable<BsonDocument> writtenDocs)
    {
        if (clearedFields.Count == 0) return;
        var docs = writtenDocs as IList<BsonDocument> ?? writtenDocs.ToList();
        if (docs.Count == 0) return;

        var already = run.PendingSecretFields.TryGetValue(collection, out var prior)
            ? new List<string>(prior)
            : new List<string>();
        foreach (var field in clearedFields)
        {
            if (already.Contains(field, StringComparer.Ordinal)) continue;
            // 源站是按集合报的脱敏字段，这一页里未必每条都带它。
            if (!docs.Any(d => d.Contains(field))) continue;
            already.Add(field);
        }
        if (already.Count > 0) run.PendingSecretFields[collection] = already;
    }

    private static async Task SaveProgressAsync(MongoDbContext db, DataSyncRun run, CancellationToken ct)
    {
        await db.DataSyncRuns.UpdateOneAsync(
            Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
            Builders<DataSyncRun>.Update
                .Set(x => x.Progress, run.Progress)
                .Set(x => x.PendingSecretFields, run.PendingSecretFields)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }

    /// <summary>
    /// 跑到终态就把导出令牌交还源站作废。只删本地那份（<c>_vault.Forget</c>）不够——
    /// 源站眼里那张票还能用满两小时，「一次性」就成了空话。
    /// 交还失败不改变 Run 的结局：票据本来就有硬过期，为它把一次成功的同步判成失败
    /// 是本末倒置；但要留一条日志，别让它静默。
    /// </summary>
    private async Task ReturnExportTokenAsync(DataSyncRun run, string token, CancellationToken ct)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("SafeOutbound");
            client.Timeout = TimeSpan.FromSeconds(15);
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{run.SourceOrigin}/api/instance-sync/revoke");
            request.Headers.TryAddWithoutValidation("X-Data-Sync-Token", token);
            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("[data-sync] Run {RunId} 交还导出令牌失败 HTTP {Status}，票据将等待自然过期",
                    run.Id, (int)response.StatusCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[data-sync] Run {RunId} 交还导出令牌异常，票据将等待自然过期", run.Id);
        }
    }

    private async Task FailAsync(MongoDbContext db, DataSyncRun run, string error, CancellationToken ct)
    {
        await db.DataSyncRuns.UpdateOneAsync(
            Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
            Builders<DataSyncRun>.Update
                .Set(x => x.Status, "failed")
                .Set(x => x.Error, error)
                .Set(x => x.FinishedAt, DateTime.UtcNow)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        _vault.Forget(run.Id);
    }

    /// <param name="ClearedFields">
/// 源站在出口**真正清空过**的字段。它与「目标站看到这个字段是空的」不是一回事：
/// 源站压根没配过的密钥本来就是空的，不该出现在待补清单里——否则会让管理员
/// 照着一份包含空气的清单去编造值。这个判定只有源站做得准，所以原样带过来。
/// </param>
internal sealed record ExportPage(List<string> Documents, string? NextCursor, List<string> ClearedFields);

    internal static ExportPage ReadPage(string json, string? expectedCollection = null)
    {
        var documents = new List<string>();
        string? nextCursor = null;
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("data", out var data))
        {
            throw new InvalidOperationException("源站返回的内容缺少 data 段");
        }
        // 校验这一页确实是「我要的那个集合」。缓存或版本错位时，源站/中间层可能返回
        // 另一个集合的内容——不核对的话，那些文档会被原样写进当前正在处理的集合。
        if (expectedCollection is not null)
        {
            var actual = data.TryGetProperty("collection", out var c) && c.ValueKind == JsonValueKind.String
                ? c.GetString()
                : null;
            if (!string.Equals(actual, expectedCollection, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"源站返回的是 {actual ?? "(未标注)"} 的数据，而这一页要的是 {expectedCollection}");
            }
        }
        if (data.TryGetProperty("nextCursor", out var cursor))
        {
            // 只有「字符串」和「null / 不存在」两种是合法的，其余一律失败。
            // 类型不对时当成 null 的后果不是少一页：PullCollectionAsync 会据此判定
            // 这个集合拉完了、置 Done=true，后面所有页一条不落地，而 Run 报成功。
            // 和上面 documents 那两处是同一条纪律——不许把协议故障翻译成正常收尾。
            if (cursor.ValueKind == JsonValueKind.String)
            {
                nextCursor = cursor.GetString();
            }
            else if (cursor.ValueKind != JsonValueKind.Null)
            {
                throw new InvalidOperationException(
                    $"源站返回的 nextCursor 是 {cursor.ValueKind}，只接受字符串或 null——两边版本多半不一致");
            }
        }
        // documents 缺失或类型不对时不能当成「这一页是空的」：那会让 nextCursor 为空的
        // 情形被判成正常收尾，整个集合报成功却一条都没同步。
        if (!data.TryGetProperty("documents", out var docs) || docs.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("源站返回的内容缺少 documents 数组");
        }
        {
            var index = 0;
            foreach (var element in docs.EnumerateArray())
            {
                // 源站发的是「一串扩展 JSON 字符串」，不是嵌套对象——保留字符串原样交给
                // BsonDocument.Parse，中间不经过 System.Text.Json 的类型转换。
                //
                // 类型不对不能跳过。上面刚拦住「documents 整个不是数组」，如果这里再把
                // 数组里的异类静默丢掉，同一个洞就只是往下挪了一层：`documents: [{}]`
                // 照样通过校验、游标照样前进、集合照样报成功，而那一页一条都没落地。
                if (element.ValueKind != JsonValueKind.String)
                {
                    throw new InvalidOperationException(
                        $"源站返回的 documents[{index}] 是 {element.ValueKind}，不是扩展 JSON 字符串——两边版本多半不一致");
                }
                documents.Add(element.GetString() ?? string.Empty);
                index++;
            }
        }
        var cleared = new List<string>();
        if (data.TryGetProperty("clearedFields", out var fields) && fields.ValueKind != JsonValueKind.Null)
        {
            // 这一格决定「待补密钥清单」有哪些条目。它 fail open 的后果不是少一行提示：
            // 脱敏过的文档照样入库、Run 照样成功，而管理员**不知道**哪些凭据需要补，
            // 相关集成就那么静默地不能用。所以和这一页别的字段一样，形状不对即失败。
            if (fields.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException(
                    $"源站返回的 clearedFields 是 {fields.ValueKind}，只接受字符串数组或 null——两边版本多半不一致");
            }
            var index = 0;
            foreach (var element in fields.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.String)
                {
                    throw new InvalidOperationException(
                        $"源站返回的 clearedFields[{index}] 是 {element.ValueKind}，不是字段名字符串");
                }
                cleared.Add(element.GetString() ?? string.Empty);
                index++;
            }
        }
        return new ExportPage(documents, nextCursor, cleared);
    }
}
