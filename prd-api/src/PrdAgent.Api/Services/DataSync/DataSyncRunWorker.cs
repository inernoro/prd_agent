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
        if (held.Count == 0) return;

        using var scope = _services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();

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
            foreach (var collectionName in run.Collections)
            {
                if (ct.IsCancellationRequested)
                {
                    // 直接 return 会把 Run 永久留在 running：重启后内存里的令牌没了，
                    // 没有任何 worker 能再认领它，历史页上就一直转着（server-authority #5）。
                    // 用 None 落终态——此刻 ct 已经取消，拿它去写库只会连这一步也被取消。
                    await FailAsync(db, run, "服务重启中断了这次同步，请重新授权后再跑一次", CancellationToken.None);
                    return;
                }
                if (!DataSyncScope.TryResolve(collectionName, out var collection))
                {
                    // Run 里固化的集合名不在白名单了：多半是两边版本不一致。跳过并留痕，
                    // 不中断整次同步——其它集合还是能拉回来的。
                    _logger.LogWarning("[data-sync] Run {RunId} 里的集合 {Collection} 不在本站白名单，跳过", run.Id, collectionName);
                    continue;
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

            var page = ReadPage(await response.Content.ReadAsStringAsync(ct));
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
                            var conflicts = ex.WriteErrors.Count(e => e.Category == ServerErrorCategory.DuplicateKey);
                            if (conflicts != ex.WriteErrors.Count) throw;
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

    internal static ExportPage ReadPage(string json)
    {
        var documents = new List<string>();
        string? nextCursor = null;
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("data", out var data))
        {
            throw new InvalidOperationException("源站返回的内容缺少 data 段");
        }
        if (data.TryGetProperty("nextCursor", out var cursor) && cursor.ValueKind == JsonValueKind.String)
        {
            nextCursor = cursor.GetString();
        }
        if (data.TryGetProperty("documents", out var docs) && docs.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in docs.EnumerateArray())
            {
                // 源站发的是「一串扩展 JSON 字符串」，不是嵌套对象——保留字符串原样交给
                // BsonDocument.Parse，中间不经过 System.Text.Json 的类型转换。
                if (element.ValueKind == JsonValueKind.String) documents.Add(element.GetString() ?? "");
            }
        }
        var cleared = new List<string>();
        if (data.TryGetProperty("clearedFields", out var fields) && fields.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in fields.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.String) cleared.Add(element.GetString() ?? "");
            }
        }
        return new ExportPage(documents, nextCursor, cleared);
    }
}
