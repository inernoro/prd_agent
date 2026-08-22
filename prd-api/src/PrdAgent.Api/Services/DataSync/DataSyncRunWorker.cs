using System.Text.Json;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services.DataSync;
using PrdAgent.Core.DataSync;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

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

    /// <summary>页内心跳间隔。远小于 OrphanHeartbeatTimeout，慢库上也留足余量。</summary>
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(30);

    /// <summary>票过期之后再留多久才删——留痕窗口，也让「票过期了」这句话说得出口。</summary>
    private static readonly TimeSpan RetiredGrantRetention = TimeSpan.FromHours(24);

    /// <summary>
    /// 票面过期之后再宽限多久，才允许把一条 pending Run 判死。
    ///
    /// 分支预览与生产共享同一个 Mongo（cross-project-isolation 通道 4），各容器的时钟
    /// 不保证对齐。判据取的是库里那个绝对时间戳，快几分钟的那台会先看到「过期」——
    /// 留一段宽限，免得它把另一台此刻正要合法启动的 Run 抢先判死。晚扫几分钟没有代价：
    /// 票一过期这条 Run 本来就跑不动了。
    /// </summary>
    private static readonly TimeSpan ExpiredPendingGrace = TimeSpan.FromMinutes(5);

    private DateTime _lastOrphanSweep = DateTime.MinValue;

    private readonly IServiceProvider _services;
    private readonly DataSyncTokenVault _vault;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<DataSyncRunWorker> _logger;

    public DataSyncRunWorker(
        IServiceProvider services,
        DataSyncTokenVault vault,
        IHttpClientFactory httpClientFactory,
        IAssetStorage assetStorage,
        ILogger<DataSyncRunWorker> logger)
    {
        _services = services;
        _vault = vault;
        _httpClientFactory = httpClientFactory;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    /// <summary>
    /// 把 key 拼成**本站**的资产地址。前缀怎么拼是存储实现自己的事，这里不另写一份。
    ///
    /// 存储实现抛异常时返回 null 而不是让整条同步炸掉：拼不出地址只是这一条附件
    /// 打不开，而调用方会把它算进「认不出」如实报出来；为此中断一次几千条的迁移不划算。
    /// </summary>
    private string? BuildLocalAssetUrl(string key)
    {
        try
        {
            var url = _assetStorage.BuildUrlForKey(key);
            return string.IsNullOrWhiteSpace(url) ? null : url;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[data-sync] 资产地址改写失败，保留源站地址：{Key}", key);
            return null;
        }
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
            await SweepExpiredPendingRunsAsync(db, ct);
            await SweepRetiredGrantsAsync(db, ct);
        }

        // 令牌在「Start 成功之后、这次轮询之前」过期的 Run：它不在 held 里，永远走不到
        // ExecuteRunAsync 那条「没令牌就判失败」的路，会在库里一直停在 running。
        // 这里替它落终态——只处理本进程握过的那些，不去碰别的部署的 Run。
        if (expired.Count > 0)
        {
            // pending 也要收。callback 建出 Run 之后，管理员一直没点开始，票就这么过期了——
            // 过期标记在这里被 drain 掉，而查询只认 running 的话，库里那行永远停在 pending：
            // 再打开它，Plan 每次都报「令牌已失效」，页面卡在加载态。
            //
            // 但这条路只覆盖「本进程一直活着」的那一半：候选集来自内存里的过期标记，
            // 进程一重启标记就没了。另一半（重启后遗留的 pending）由
            // SweepExpiredPendingRunsAsync 从库里的 ExportTokenExpiresAt 兜——我上一版
            // 在这里写了「进程重启也一样」，那句话当时不成立，别再照抄。
            var stale = await db.DataSyncRuns.Find(Builders<DataSyncRun>.Filter.And(
                Builders<DataSyncRun>.Filter.In(x => x.Status, new[] { "running", "pending" }),
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

        // 排在后面的那些，在前一条**执行期间**就要持续刷心跳。
        //
        // 这里是串行执行：第一条跑满 15 分钟，第二条一次心跳都没打过——而收尸判据只看
        // 「有没有心跳」，别的部署据此把它判成无人认领并落成 failed，尽管本进程手里正握着
        // 它有效的导出令牌。本进程自己的 `mine` 挡得住自己，挡不住兄弟部署。
        //
        // 台账 DS21 里我把排队的后果写成「只是等待，票过期时会给出清楚的原因」——
        // 那个判断漏了这一格：它不是在等，是被别人当死人收走。
        //
        // 修法取最小的那个：把「还在排队的是哪几条」记下来，正在执行的那条每次打心跳时
        // 顺手把它们也打一遍。不新增状态、不改语义，只是让「活着」这个信号如实反映事实。
        for (var i = 0; i < runs.Count; i++)
        {
            _queuedRunIds = runs.Skip(i + 1).Select(r => r.Id).ToList();
            try
            {
                await ExecuteRunAsync(db, runs[i], ct);
            }
            finally
            {
                _queuedRunIds = Array.Empty<string>();
            }
        }
    }

    /// <summary>
    /// 本轮里排在正在执行那条后面、还没轮到的 Run。它们同样归本进程所有，
    /// 心跳必须跟着一起打，否则会被别的部署当成无人认领收走。
    /// 每个 tick 单线程串行，不存在并发访问。
    /// </summary>
    private IReadOnlyList<string> _queuedRunIds = Array.Empty<string>();

    /// <summary>把排队中那几条的心跳一起刷了。</summary>
    private async Task BeatQueuedRunsAsync(MongoDbContext db, CancellationToken ct)
    {
        if (_queuedRunIds.Count == 0) return;
        await db.DataSyncRuns.UpdateManyAsync(
            Builders<DataSyncRun>.Filter.And(
                Builders<DataSyncRun>.Filter.In(x => x.Id, _queuedRunIds),
                Builders<DataSyncRun>.Filter.Eq(x => x.Status, "running")),
            Builders<DataSyncRun>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
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

                // 源站报的总条数补上。这个字段的文档写着「manifest 阶段拿到」，可从来没有
                // 任何一处给它赋过值——于是每次 GET 和 SSE 快照里 fetched 在涨、sourceTotal
                // 恒为 0，界面上算不出百分比，历史记录里也看不出这次到底该搬多少
                // （predicate-and-wiring-discipline 形状 2：字段建了一半，删掉不会红）。
                // 每轮都赋一次而不是只在新建时赋：续跑的 Run 带着旧的 0 进来，也要补上。
                if (run.PlannedManifest.TryGetValue(collectionName, out var plannedFacts))
                {
                    progress.SourceTotal = plannedFacts.SourceTotal;
                }

                // 从这里起下游一律拿两边脱敏契约的**并集**，投影 / 待补归属 / 接回三处
                // 就不会各自用一份（形状 3）。
                await PullCollectionAsync(db, run, DataSyncApply.MergeSourceRedactions(collection, run.PlannedManifest), progress, token, ct);
            }

            // 终态写入同样要带「它还是 running」。心跳和进度已经挡住了，唯独这一处漏了，
            // 而它恰恰是危害最大的那个方向：本进程只要暂停得够久被别的部署收了尸，
            // 醒来后这一句会把已经落好的 failed 改写成 succeeded——一次半截的同步
            // 在界面上显示为「成功」。
            var finished = await db.DataSyncRuns.UpdateOneAsync(
                StillRunning(run),
                Builders<DataSyncRun>.Update
                    .Set(x => x.Status, "succeeded")
                    .Set(x => x.FinishedAt, DateTime.UtcNow)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: ct);
            if (finished.ModifiedCount == 0)
            {
                // 结局已经被别人写过了，不覆盖。令牌照样交还——那张票该作废。
                _logger.LogWarning(
                    "[data-sync] Run {RunId} 跑完时发现终态已被其它部署写过（多半是被判成无心跳收了尸），保留先落的那个结局",
                    run.Id);
            }
            // 试跑成功之后**不作废这张票**：它还要留给「确认无误，开始真的搬」那一步。
            //
            // 原来试跑一跑完就交还，于是真搬必须让人再点一次源站的同意——而「看一眼
            // 会搬什么」本来就不写任何东西，把它算成一次消耗是当初没想清楚。
            // 2026-08-21 的两次真实迁移都卡死在这里：数据读得出来，写不进去。
            //
            // 留着的窗口不是新开的口子：它与「callback 建好 Run、管理员一直没点开始」
            // 完全同形，上界同样是票据自己的两小时硬过期，源站每次请求还会重对一遍
            // 允许名单。真跑（或试跑失败）照旧立刻交还。
            if (run.DryRun && finished.ModifiedCount > 0)
            {
                _logger.LogInformation(
                    "[data-sync] Run {RunId} 试跑完成，票据保留到转正或过期（{ExpiresAt:u}）",
                    run.Id, run.ExportTokenExpiresAt);
            }
            else
            {
                // 交还令牌一律用 None，和失败/丢租约那两条路径一致。
                // 用 ct 的话：宿主正在关停时 ct 已取消，这一句立刻失败并把取消咽掉，
                // 下一行又把本地唯一那份令牌忘了——界面显示「成功」，而源站那张票在剩下的
                // 两小时里仍然能导数据。作废是收尾动作，不该跟着请求生命周期一起死。
                await ReturnExportTokenAsync(run, token, CancellationToken.None);
                _vault.Forget(run.Id);
            }
            _logger.LogInformation("[data-sync] Run {RunId} 完成（dryRun={DryRun}）", run.Id, run.DryRun);
        }
        catch (RunLeaseLostException ex)
        {
            // 结局已经由收尸方写好了，这里只交还令牌、放手，不去覆盖它。
            _logger.LogWarning("[data-sync] {Message}", ex.Message);
            await ReturnExportTokenAsync(run, token, CancellationToken.None);
            _vault.Forget(run.Id);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[data-sync] Run {RunId} 执行失败", run.Id);
            // 收尾一律用 None：走到这里 ct 很可能已经取消，拿它去写库等于连「记下失败」
            // 这一步也做不成，Run 会卡在 running（server-authority #5）。
            await ReturnExportTokenAsync(run, token, CancellationToken.None);
            await FailAsync(db, run, DescribeFailure(ex, run.Id), CancellationToken.None);
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

            // 资产地址改写要在**入库之前**做：写进去再回头批量改，中间那一段时间
            // 界面上的图片全是指回源站的死链，而且一旦崩在中间就没人知道改到哪了。
            // 只改地址、不搬字节——两站不共用同一个桶时，改完是「指向自己家的空位」，
            // 所以下面把认不出的条数如实累进 Run 里，由界面照实说。
            var rebase = DataSyncAssetUrls.RebaseIncoming(documents, collection.Name, BuildLocalAssetUrl);
            progress.AssetUrlsRebased += rebase.Rebased;
            progress.AssetUrlsUnresolved += rebase.Unrecognized;

            if (documents.Count > 0)
            {
                // 查已有文档时，同一个逻辑 id 的**两种物理形态**都要带上。
                //
                // 本仓库历史数据的 _id 存成 ObjectId、新数据存成 24 位十六进制字符串
                // （StringOrObjectIdSerializer 让应用层看到的都是同一个字符串）。源站送来的
                // 是字符串，若只拿字符串去 $in，目标库里那条 ObjectId 记录根本匹配不上——
                // 于是判成「本地没有」，插进去变成同一条记录的第二份；覆盖模式也替不掉原来那条。
                var ids = new List<BsonValue>();
                foreach (var doc in documents)
                {
                    var id = doc["_id"];
                    ids.Add(id);
                    // 两个方向都要展开。上一轮我只写了「字符串 -> ObjectId」，
                    // 反过来那半（源站是 ObjectId、目标库存成字符串）照样匹配不上，
                    // 后果一模一样：重复插入 / 覆盖替不掉。修一个方向等于没修。
                    if (id.IsString && ObjectId.TryParse(id.AsString, out var asObjectId))
                    {
                        ids.Add(asObjectId);
                    }
                    else if (id.BsonType == BsonType.ObjectId)
                    {
                        ids.Add(id.AsObjectId.ToString());
                    }
                }
                // 只查这一批的 id，不是整表 —— 整表 id 在几十万条上会把内存吃光。
                var existing = await target
                    .Find(Builders<BsonDocument>.Filter.In("_id", ids))
                    .Project(BuildExistingProjection(collection))
                    .ToListAsync(ct);
                // 归一后的 id -> 目标库里真实的那个 _id。覆盖写要用真实那个去定位。
                var existingIdsByKey = new Dictionary<string, BsonValue>(StringComparer.Ordinal);
                foreach (var doc in existing)
                {
                    existingIdsByKey[DataSyncApply.NormalizeId(doc["_id"])] = doc["_id"];
                }

                var decision = DataSyncApply.Decide(documents, existingIdsByKey, run.OverwriteExisting);
                progress.Skipped += decision.SkippedIds.Count;

                // 覆盖写是整份替换，所以「目标站本地执行历史」这类字段必须在替换前接回来，
                // 否则源站那台机器跑过哪些迁移会变成本站的账：本站没跑过的被当成跑过而跳过，
                // 或者管理员手工回退过的被当成没跑过而重来一遍。源站出口已经把这些字段删掉了，
                // 这里补的是本站原有的那份。
                // 必须在接回**之前**取：接回会改写甚至删掉这些字段，之后就问不出
                // 「源站这条记录原本带没带它」了。
                // 两条路径问的是**不同的问题**，所以判据不同，这点值得写下来：
                //   接回问「送来的值是不是空的」——要防的是拿空值顶掉目标站的东西，
                //     所以不能依赖源站诚实上报，只看事实。
                //   待补问「脱敏**有没有真的拿走**什么」——那正是 clearedFields 的定义。
                //     源站从来没配过的空字段不算被拿走，报进清单等于告诉管理员
                //     「有个密钥被同步清掉了，去补」，而根本没有那回事。
                var cleared = page.ClearedFields.ToHashSet(StringComparer.Ordinal);
                // 归属也按**归一后**的 id 记。Decide 会把覆盖写的文档 _id 改写成目标库里
                // 那个真实形态（字符串 -> ObjectId），若这里still按原始 BsonValue 存，
                // 之后就对不上——一个真被清空的凭据不会出现在待补清单里。
                var sourceFieldOwners = collection.RedactFields
                    .Where(cleared.Contains)
                    .ToDictionary(
                        f => f,
                        f => documents.Where(d => d.Contains(f) && d.Contains("_id"))
                            .Select(d => DataSyncApply.NormalizeId(d["_id"]))
                            .ToHashSet(StringComparer.Ordinal),
                        StringComparer.Ordinal);

                DataSyncApply.CarryTargetLocalFields(decision.ToReplace, existing, collection);

                if (!run.DryRun)
                {
                    // 写之前先确认这条 Run 还归本进程。它同时充当心跳，所以不额外多一次写。
                    if (!await HeartbeatAsync(db, run, ct)) throw new RunLeaseLostException(run.Id);

                    // 整段写入包在一个**独立的**心跳里。
                    //
                    // 原来只在写之前查一次租约、然后在逐条替换的间隙按 30 秒补跳：
                    // 中间那一句 InsertManyAsync 是不定长的，库一慢它自己就能超过收尸判据的
                    // 15 分钟，而这期间一次心跳都打不出去——别的部署据此把这条**活着的** Run
                    // 判成无人认领落成 failed，本进程随后照样把这一批提交进目标库；
                    // 单条 ReplaceOneAsync 卡住也是同一回事，那个 30 秒节流要等它返回才有机会跳。
                    // concurrency-gate-discipline 第 4 条的反向义务：活着的长静默阶段必须打心跳。
                    await WriteWithHeartbeatAsync(db, run, async () =>
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

                                // 只有撞 `_id` 才算「这条已经有了，跳过」。撞**业务唯一索引**
                                // 意味着目标站已有同一个业务实体、但它的 _id 与源站不同——
                                // 跳过它之后，后面引用这个实体的记录照样带着源站 id 被导进去，
                                // 留下一堆指向不存在记录的引用，而整条同步还报成功。
                                // 真正的解法是跨实例身份归并（DS18，独立工程）；在那之前，
                                // 正确行为是当场失败，不是悄悄产出损坏数据。
                                var unmergeable = ex.WriteErrors
                                    .Where(e => !DataSyncApply.IsSkippableIdDuplicate(e.Message))
                                    .ToList();
                                if (unmergeable.Count > 0)
                                {
                                    throw new InvalidOperationException(
                                        $"集合 {collection.Name} 有 {unmergeable.Count} 条撞在**业务唯一索引**上："
                                        + "目标站已经存在同一个业务实体，但它的 _id 与源站不同。"
                                        + "跳过这些记录会让后面引用它们的数据指向不存在的对象，"
                                        + "所以这里停下而不是继续。需要先做跨实例身份归并（见台账 DS18），"
                                        + "或者先清空目标站这个集合再同步。");
                                }

                                // 勾了「以源站为准覆盖」时，撞 `_id` 不能算「跳过」。
                                //
                                // ToInsert 里只放了**查目标库时不存在**的那些 id，所以这里撞上
                                // 只有一个解释：查完到写下去这段时间里，有别的写手插了同一个 id
                                //（共享 Mongo 上两条同步并行时会遇到）。此时按「跳过」处理，
                                // 目标库留下的是那个并发写进去的值，而操作者勾的是「源站为准」——
                                // 一条没被覆盖的记录，却报成功。
                                //
                                // 不在这里就地改成替换：那批文档的目标侧本地字段（PreserveFields）
                                // 从没读过，盲替会把它们抹掉，正是前面几轮专门修过的那个洞。
                                // 要做得对得回查那几条再走一遍 carry——那是另一件事。
                                // 所以当场失败：重跑一次即可（下一轮查目标库就能看见它们，
                                // 正常走替换路径、本地字段照常保留）。
                                if (run.OverwriteExisting)
                                {
                                    throw new InvalidOperationException(
                                        $"集合 {collection.Name} 有 {conflicts} 条在本次同步进行中被别处写入了同一个 _id。"
                                        + "这次勾的是「以源站为准覆盖」，把它们按跳过处理会留下没被覆盖的记录、"
                                        + "却报同步成功，所以这里停下。重新跑一次即可——"
                                        + "下一轮就能查到它们并正常覆盖。");
                                }

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
                        // 一页最多 200 条逐条替换。心跳由外面那个独立的 beater 负责——
                        // 它按墙钟跳，不依赖这个循环转到下一圈，所以单条替换卡住也照样跳。
                        foreach (var doc in decision.ToReplace)
                        {
                            var replaced = await target.ReplaceOneAsync(
                                Builders<BsonDocument>.Filter.Eq("_id", doc["_id"]), doc, cancellationToken: ct);

                            // 没匹配上就是**什么都没写**——upsert 是关着的。
                            //
                            // 能走到这里说明批量查目标库时它还在，是查完到写下去这段时间里
                            // 被别处删掉了。不看返回值的话：这一条静默丢失，而下面照样
                            // `progress.Updated += ToReplace.Count`、整条 Run 报成功，
                            // 操作者勾的却是「以源站为准覆盖」。
                            //
                            // 不就地改成插入：那等于把别人刚刚删掉的记录悄悄复活，
                            // 而删除同样可能是一次有意的操作。当场失败、重跑一次即可——
                            // 下一轮查目标库看不见它，自然走插入路径。
                            // 与「插入时撞 _id」那一格同一套处置，两边不各说一套。
                            if (replaced.MatchedCount == 0)
                            {
                                throw new InvalidOperationException(
                                    $"集合 {collection.Name} 里 _id={doc["_id"]} 的记录在本次同步进行中被别处删除了，"
                                    + "这一条没有写成。本次勾的是「以源站为准覆盖」，"
                                    + "静默略过它会让同步报成功却少一条记录，所以这里停下。"
                                    + "重新跑一次即可——下一轮它会走插入路径。");
                            }
                        }
                    }, ct);
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
                RecordPendingSecrets(run, collection.Name, sourceFieldOwners,
                    decision.ToInsert.Concat(decision.ToReplace));
            }

            progress.Cursor = page.NextCursor;
            progress.Done = string.IsNullOrEmpty(page.NextCursor);
            run.Progress[collection.Name] = progress;
            await SaveProgressAsync(db, run, ct);
            // 排队那几条的心跳要在这里打，不能只挂在 HeartbeatAsync 上。
            //
            // 上一轮我把队列心跳挂进了 HeartbeatAsync，而它的调用点全在 `if (!run.DryRun)`
            // 里面——于是第一条要是**试跑**且跑过 15 分钟，它自己靠 SaveProgressAsync
            // 活着，排在它后面那几条却一次都没被刷到，照样被别的部署当无人认领收走。
            // 修一半的典型：我只顺着「真跑」那条路径检查了自己的改动。
            // 这里在每页收尾处无条件打一次，试跑真跑都走得到。
            await BeatQueuedRunsAsync(db, ct);

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
        // 和 CarryTargetLocalFields 取同一个来源。少投影一个字段，接回时就会把
        // 目标站那份当成「不存在」而删掉——判据分裂成两处的经典后果。
        foreach (var field in collection.FieldsCarriedFromTarget)
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
    /// <summary>
    /// 删掉早就没用的授权票。
    ///
    /// 票是只增不减的：一次授权留一行，导出令牌两小时后失效，之后这一行再也匹配不上
    /// 任何请求，却仍然躺在表里被每一次匿名协议请求扫到。攒下去两件事一起变糟——
    /// 查询越来越慢，而且慢的是**鉴权之前**那一段，等于谁都能让源站白干活。
    ///
    /// 留一段窗口再删，不删刚过期的：过期后紧接着来的请求要能查到这张票，
    /// 才说得出「票过期了，请重新授权」，而不是含糊的「没这张票」。
    /// 也因此不用 TTL 索引——TTL 到点即删，给不出这句话，窗口也改不动。
    /// </summary>
    private async Task SweepRetiredGrantsAsync(MongoDbContext db, CancellationToken ct)
    {
        var cutoff = DateTime.UtcNow - RetiredGrantRetention;
        // 两类都要收，只看导出令牌会漏掉一整类：人在同意页点了同意、却再也没回来换票，
        // 这种票的 ExportTokenExpiresAt 一直是 null，跟任何时间比较都不成立，于是永远
        // 留在表里。它们的授权码 60 秒就过期了，留着只会把索引撑大。
        var deleted = await db.DataSyncGrants.DeleteManyAsync(
            Builders<BsonDocument>.Filter.Or(
                Builders<BsonDocument>.Filter.Lt("ExportTokenExpiresAt", cutoff),
                Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Or(
                        Builders<BsonDocument>.Filter.Exists("ExportTokenExpiresAt", false),
                        Builders<BsonDocument>.Filter.Eq("ExportTokenExpiresAt", BsonNull.Value)),
                    Builders<BsonDocument>.Filter.Lt("ExpiresAt", cutoff))),
            ct);
        if (deleted.DeletedCount > 0)
        {
            _logger.LogInformation("[data-sync] 清理了 {Count} 张过期超过 {Hours} 小时的授权票",
                deleted.DeletedCount, RetiredGrantRetention.TotalHours);
        }
    }

    /// <summary>
    /// 收「票已经过期、却还停在 pending」的 Run —— 判据取库里的 ExportTokenExpiresAt，
    /// 不看内存。
    ///
    /// 为什么单独有这一条：TickAsync 里那段 expired 收敛的**候选集**来自
    /// <c>_vault.DrainExpiredRunIds()</c>，那是进程内的。callback 建出 pending Run 之后、
    /// 管理员点开始之前进程重启（发版、崩溃、CDS 重建容器），令牌和这个标记一起蒸发，
    /// 而孤儿清扫只看 running——于是库里那行 pending 永远留着，历史列表里挂一条永远
    /// 「进行中」的记录，点进去 Plan 每次都报「令牌已失效」。加 pending 到那段查询的
    /// 状态过滤是不够的，得换一个不依赖内存的判据。
    ///
    /// 不跳过 mine：票面过期是绝对事实，本进程握着的那份同样已经用不了了
    /// （DataSyncTokenVault 的 HeldRunIds 本来也会把它清掉）。
    /// 条件更新只在「仍然 pending」时落笔——Start 若已把它翻成 running，这里不许覆盖。
    /// </summary>
    private async Task SweepExpiredPendingRunsAsync(MongoDbContext db, CancellationToken ct)
    {
        var cutoff = DateTime.UtcNow - ExpiredPendingGrace;
        var stale = await db.DataSyncRuns.Find(Builders<DataSyncRun>.Filter.And(
            Builders<DataSyncRun>.Filter.Eq(x => x.Status, "pending"),
            Builders<DataSyncRun>.Filter.Lt(x => x.ExportTokenExpiresAt, cutoff))).ToListAsync(ct);

        foreach (var run in stale)
        {
            var terminalized = await db.DataSyncRuns.UpdateOneAsync(
                Builders<DataSyncRun>.Filter.And(
                    Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
                    Builders<DataSyncRun>.Filter.Eq(x => x.Status, "pending"),
                    Builders<DataSyncRun>.Filter.Lt(x => x.ExportTokenExpiresAt, cutoff)),
                Builders<DataSyncRun>.Update
                    .Set(x => x.Status, "failed")
                    .Set(x => x.Error, "导出令牌在同步开始前就过期了，请重新授权后再跑一次")
                    .Set(x => x.FinishedAt, DateTime.UtcNow)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);

            if (terminalized.ModifiedCount > 0)
            {
                _logger.LogWarning(
                    "[data-sync] Run {RunId} 的导出令牌已于 {ExpiresAt:o} 过期而始终没有开始，落终态",
                    run.Id, run.ExportTokenExpiresAt);
            }
        }
    }

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
    /// <summary>
    /// 记「管理员还要手工补哪些凭据」。
    ///
    /// 判据同样不能挂在源站自报的 clearedFields 上（源站那份本来就是空的时候它不上报），
    /// 也不能只看「字段在不在」——接回会把目标站没有的那个字段整个删掉，于是最需要提醒的
    /// 那一种反而一声不吭。所以两个输入都要：
    ///
    /// - <paramref name="sourceFieldOwners"/>：**接回之前**，这一页里哪些文档带着这个字段
    ///   （按归一后的 id 记——覆盖写会把文档的 _id 改写成目标库里那个真实形态）。
    ///   没带的文档不该替它操心（源站那类记录根本没有这个字段）。
    /// - 落地文档的**最终值**：空（缺失 / null / 空串）才要补。目标站原有的能用凭据被接回来了，
    ///   最终值非空，就不该出现在清单里——报了的话管理员照着补，反而把能用的配置改坏。
    /// </summary>
    internal static void RecordPendingSecrets(
        DataSyncRun run,
        string collection,
        IReadOnlyDictionary<string, HashSet<string>> sourceFieldOwners,
        IEnumerable<BsonDocument> writtenDocs)
    {
        if (sourceFieldOwners.Count == 0) return;
        var docs = writtenDocs as IList<BsonDocument> ?? writtenDocs.ToList();
        if (docs.Count == 0) return;

        static bool Empty(BsonDocument doc, string field) =>
            !doc.TryGetValue(field, out var v)
            || v.IsBsonNull
            || (v.IsString && v.AsString.Length == 0);

        var already = run.PendingSecretFields.TryGetValue(collection, out var prior)
            ? new List<string>(prior)
            : new List<string>();
        foreach (var (field, owners) in sourceFieldOwners)
        {
            if (owners.Count == 0) continue;
            if (already.Contains(field, StringComparer.Ordinal)) continue;
            var pending = docs.Any(d =>
                d.TryGetValue("_id", out var id)
                && owners.Contains(DataSyncApply.NormalizeId(id))
                && Empty(d, field));
            if (pending) already.Add(field);
        }
        if (already.Count > 0) run.PendingSecretFields[collection] = already;
    }

    /// <summary>
    /// 落进 Run.Error 的文案。这一条会通过 Run 接口和 SSE 原样显示给管理员。
    ///
    /// 自己抛的协议错（源站返回的内容不合约）是**写给人看**的，逐字保留——它能指出
    /// 是哪个集合、哪一页、哪个字段不对，管理员照着能去源站查。
    ///
    /// 其余异常（Mongo 驱动、TLS、JSON、Socket）一律不落原文：驱动消息里带着服务器
    /// 地址、库名、索引名、协议细节，而对管理员又给不出任何可执行的下一步。原文进
    /// 结构化日志，界面上给固定文案 + 一个能对上日志的短诊断号。
    /// </summary>
    private static string DescribeFailure(Exception ex, string runId) =>
        ex is InvalidOperationException
            ? ex.Message
            : $"同步中断于一次未预期的错误（诊断号 {runId[..Math.Min(8, runId.Length)]}），"
              + "详情已记入服务日志。已写入的部分保留，可以重新授权后再跑一次。";

    private static async Task SaveProgressAsync(MongoDbContext db, DataSyncRun run, CancellationToken ct)
    {
        await db.DataSyncRuns.UpdateOneAsync(
            StillRunning(run),
            Builders<DataSyncRun>.Update
                .Set(x => x.Progress, run.Progress)
                .Set(x => x.PendingSecretFields, run.PendingSecretFields)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
    }

    /// <summary>
    /// 在一段可能很久的目标库写入期间，用一个**独立的**任务持续打心跳。
    ///
    /// 为什么不能沿用「写完一批再跳」：那种跳法的节奏由写入自己决定，而正是写入卡住的时候
    /// 最需要心跳。一次 InsertManyAsync 或一条 ReplaceOneAsync 卡满 15 分钟，收尸判据就会
    /// 把这条活着的 Run 判成无人认领——它握不住本进程内存里的令牌，`mine` 挡不住它。
    ///
    /// 心跳任务**永不抛出**：它抛的话会在 finally 的 await 里盖掉写入本身的异常，
    /// 把「写失败」变成「心跳失败」，排障时看到的就是错的那个原因。心跳失败本身不致命
    /// （下一拍还会再试），但若它明确回报**租约已经不是我的**，写完之后必须停手——
    /// 已经提交的那批收不回来，能做的是不再继续写。
    /// </summary>
    private async Task WriteWithHeartbeatAsync(
        MongoDbContext db, DataSyncRun run, Func<Task> write, CancellationToken ct)
    {
        using var finished = new CancellationTokenSource();
        var leaseLost = false;

        var beating = Task.Run(async () =>
        {
            try
            {
                while (true)
                {
                    await Task.Delay(HeartbeatInterval, finished.Token);
                    try
                    {
                        if (!await HeartbeatAsync(db, run, ct))
                        {
                            // 这一条是**明确的答复**：这条 Run 已经不归我了。停止心跳。
                            leaseLost = true;
                            return;
                        }
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // 一次心跳打不出去只是抖动，不等于租约没了——**继续跳**。
                        // 上一版在这里退出整个循环：此后整段写入再无心跳，而 leaseLost
                        // 还是 false，于是别的部署把这条活着的 Run 收走、本进程写完照样
                        // 被当成成功接受。一次网络抖动就能触发，比它要防的那个场景还常见。
                        _logger.LogWarning(ex, "[data-sync] Run {RunId} 写入期间的一次心跳失败，继续重试", run.Id);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // 写完了（finished）或整个 worker 在收摊（ct），都是正常结束。
            }
            catch (Exception ex)
            {
                // 兜底：这个任务**绝不能**抛，否则会在下面 finally 的 await 里
                // 盖掉写入本身的异常，把「写失败」变成「心跳失败」。
                _logger.LogWarning(ex, "[data-sync] Run {RunId} 的写入期心跳异常退出", run.Id);
            }
        }, CancellationToken.None);

        try
        {
            await write();
        }
        finally
        {
            finished.Cancel();
            await beating;   // 上面保证它不抛，这里不会掩盖 write 的异常
        }

        // 写完**必须**再确认一次租约才认这批写入，不能只看 leaseLost。
        //
        // leaseLost 只在心跳拿到「明确的否定答复」时才为真。心跳一路打不出去（库抖、
        // 连接池耗尽）时它始终是 false，而这恰恰是最危险的一种：没有心跳 → 别的部署
        // 把这条 Run 收走 → 本进程写完却以为一切正常。所以这里补一次同步确认，
        // 让「没能确认」和「确认还在」区分开——前者照样停手。
        //
        // 用 CancellationToken.None：worker 收摊时这一次确认仍要做完，
        // 否则关机那一刻的写入永远处于「不知道算不算数」（server-authority #5）。
        if (leaseLost || !await HeartbeatAsync(db, run, CancellationToken.None))
        {
            throw new RunLeaseLostException(run.Id);
        }
    }

    /// <summary>
    /// 刷心跳，并回答「这条 Run 还归我吗」。
    ///
    /// 看 MatchedCount 而不是 ModifiedCount：同一毫秒内把 UpdatedAt 设成同一个值时
    /// ModifiedCount 会是 0，那不代表租约没了（形状 6：取错了那个值）。
    /// </summary>
    private async Task<bool> HeartbeatAsync(MongoDbContext db, DataSyncRun run, CancellationToken ct)
    {
        var result = await db.DataSyncRuns.UpdateOneAsync(
            StillRunning(run),
            Builders<DataSyncRun>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        // 正在跑的这条每打一次心跳，排队等它的那几条也跟着打一次——
        // 它们同样活着，同样归本进程握着。
        await BeatQueuedRunsAsync(db, ct);
        return result.MatchedCount > 0;
    }

    /// <summary>
    /// 租约没了就别再往目标库里写。
    ///
    /// 心跳和终态已经带了 StillRunning，但那只保护 Run 这一行**自己**的字段；
    /// 真正往业务集合写的那些 Insert/Replace 一直没看过租约。于是本进程卡够 15 分钟
    /// 被别的部署收尸之后，它醒来照样继续改目标站的数据——界面上这条 Run 已经是
    /// failed，人可能已经重跑了一次，两个写手同时改同一批集合。
    /// 所以每批写之前先确认租约还在，不在就当场停手。
    /// </summary>
    private sealed class RunLeaseLostException : Exception
    {
        public RunLeaseLostException(string runId)
            : base($"同步 {runId} 的执行权已被其它部署接管（多半是本进程停顿过久被判成无心跳），已停止写入") { }
    }

    /// <summary>
    /// 本进程对这条 Run 的所有写入都带上「它还是 running」。
    ///
    /// 收尸那条路径已经是条件更新，不会覆盖别人写好的结局；缺的是反过来那一半：
    /// 一条 Run 被判成无心跳收走之后，原来的 worker 如果还活着（只是慢），
    /// 它后面的进度回写和终态回写会把已经落好的 failed 顶掉，甚至改写成 succeeded。
    /// 加上这个谓词，被收尸之后本进程的写入一律匹配 0 条，结局只由先落的那一方决定。
    /// </summary>
    private static FilterDefinition<DataSyncRun> StillRunning(DataSyncRun run) =>
        Builders<DataSyncRun>.Filter.And(
            Builders<DataSyncRun>.Filter.Eq(x => x.Id, run.Id),
            Builders<DataSyncRun>.Filter.Eq(x => x.Status, "running"));

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
