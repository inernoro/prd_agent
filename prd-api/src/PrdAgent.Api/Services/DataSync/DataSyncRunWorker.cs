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
        if (held.Count == 0 && expired.Count == 0) return;

        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

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
        var client = _httpClientFactory.CreateClient();
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

            // 待补清单直接用源站报的「我清空了哪些」，不再自己看哪个字段是空的：
            // 后者会把源站从来没配过的密钥也算成「被清空、待补」（Codex 指出）。
            if (page.ClearedFields.Count > 0)
            {
                var already = run.PendingSecretFields.TryGetValue(collection.Name, out var prior)
                    ? new List<string>(prior)
                    : new List<string>();
                foreach (var field in page.ClearedFields)
                {
                    if (!already.Contains(field, StringComparer.Ordinal)) already.Add(field);
                }
                run.PendingSecretFields[collection.Name] = already;
            }

            if (documents.Count > 0)
            {
                var ids = documents.Select(d => d["_id"]).ToList();
                // 只查这一批的 id，不是整表 —— 整表 id 在几十万条上会把内存吃光。
                var existing = await target
                    .Find(Builders<BsonDocument>.Filter.In("_id", ids))
                    .Project(Builders<BsonDocument>.Projection.Include("_id"))
                    .ToListAsync(ct);
                var existingIds = existing.Select(d => d["_id"]).ToHashSet();

                var decision = DataSyncApply.Decide(documents, existingIds, run.OverwriteExisting);
                progress.Skipped += decision.SkippedIds.Count;

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
                            // 撞索引的那几条没写进去，计数要扣掉，否则「新增 N 条」对不上账。
                            decision = decision with { ToInsert = decision.ToInsert.Take(decision.ToInsert.Count - conflicts).ToList() };
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
            }

            progress.Cursor = page.NextCursor;
            progress.Done = string.IsNullOrEmpty(page.NextCursor);
            run.Progress[collection.Name] = progress;
            await SaveProgressAsync(db, run, ct);

            if (progress.Done) return;
        }
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
            var client = _httpClientFactory.CreateClient();
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
