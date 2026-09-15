using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services.ModelLeaderboard;

/// <summary>
/// 榜单同步的唯一实现。
///
/// 抽出来是因为有两个调用方：每天跑一轮的 <see cref="ModelLeaderboardSyncWorker"/>，
/// 和管理员手动触发的 <c>POST /api/model-leaderboard/sync</c>。同一件事写两遍，
/// 迟早在「失败要不要写库」「升降怎么算」这类细节上各自漂移
/// （见 .claude/rules/predicate-and-wiring-discipline.md 形状 3）。
/// </summary>
public class ModelLeaderboardSyncService
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<ModelLeaderboardSyncService> _logger;

    public ModelLeaderboardSyncService(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<ModelLeaderboardSyncService> logger)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _configuration = configuration;
        _logger = logger;
    }

    /// <summary>抓完一个榜歇多久再抓下一个。</summary>
    private static readonly TimeSpan BoardInterval = TimeSpan.FromSeconds(1);

    /// <summary>
    /// 一个分榜的同步结果，给手动触发的调用方回显用。
    ///
    /// <paramref name="ErrorCode"/> 是稳定枚举，<paramref name="Error"/> 是给人看的一句话
    /// （含下一步）。两者都不含异常原文：原来这里直接放 <c>ex.Message</c>，而调用方把它
    /// 插进 toast，于是 HTTP 地址、Mongo 的 E11000、内部端点会原样弹到用户脸上，
    /// 而且没有任何稳定契约可供前端分支（Codex 在 PR #1538 指出）。异常只进服务端日志。
    /// </summary>
    public record BoardResult(string Board, bool Ok, int Count, string? ErrorCode, string? Error);

    /// <summary>同步失败的稳定错误码。新增分类时前端可按码分支，不必去匹配文案。</summary>
    public static class SyncErrorCodes
    {
        /// <summary>抓不到对方的页面：网络不通、超时、非 2xx。</summary>
        public const string Unreachable = "arena_unreachable";

        /// <summary>抓到了但解析不出来：条目太少或表格形状与目录声明的不符。</summary>
        public const string MarkupChanged = "arena_markup_changed";

        /// <summary>解析成功但写库失败。</summary>
        public const string StoreFailed = "store_failed";

        /// <summary>其它。原因只在服务端日志里。</summary>
        public const string Unknown = "unknown";
    }

    /// <summary>
    /// 把异常翻译成「稳定码 + 给人看的一句话」。
    ///
    /// 措辞守 external-cause-first：先说这次是什么原因、要不要紧、下一步做什么，
    /// 技术细节留在日志里（日志那行带 ex，排障够用）。
    /// </summary>
    private static (string Code, string Message) ClassifyFailure(Exception ex) => ex switch
    {
        HttpRequestException or TaskCanceledException or TimeoutException => (
            SyncErrorCodes.Unreachable,
            "抓不到 arena.ai 的页面（对方暂时不可达或超时）。上一份快照仍在用，稍后重试或等下一轮自动同步。"),
        InvalidOperationException => (
            SyncErrorCodes.MarkupChanged,
            "arena.ai 的页面结构与解析器对不上，本次没有写库、保留了上一份快照。需要更新解析器，详见服务端日志。"),
        MongoException => (
            SyncErrorCodes.StoreFailed,
            "数据抓到了但写库失败，本次未更新。请查看服务端日志。"),
        _ => (
            SyncErrorCodes.Unknown,
            "同步失败，本次未更新，上一份快照仍在用。原因已记入服务端日志。"),
    };

    /// <summary>
    /// 同步分榜。每个榜独立处理，一个失败不影响其他榜。
    /// </summary>
    /// <param name="onlyBoard">只同步这一个榜；null 表示全部。</param>
    public async Task<List<BoardResult>> SyncAllAsync(CancellationToken ct, string? onlyBoard = null)
    {
        var http = _httpClientFactory.CreateClient(ModelLeaderboardSyncWorker.HttpClientName);
        var fetcher = new ArenaLeaderboardFetcher(http);
        var sourceLabel = DeploymentAuthority.DescribeSource(_configuration);

        var targets = string.IsNullOrWhiteSpace(onlyBoard)
            ? ModelLeaderboardSyncWorker.Boards
            : ModelLeaderboardSyncWorker.Boards
                .Where(b => string.Equals(b, onlyBoard, StringComparison.OrdinalIgnoreCase))
                .ToArray();

        var results = new List<BoardResult>();
        foreach (var board in targets)
        {
            ct.ThrowIfCancellationRequested();

            // 十一个榜串行抓，每个之间歇一秒。对方是一个免费的公开站点，
            // 我们没有理由在同一秒里把十一个几兆的页面一起拽下来。
            if (results.Count > 0) await Task.Delay(BoardInterval, ct);

            try
            {
                var count = await SyncBoardAsync(fetcher, board, sourceLabel, ct);
                results.Add(new BoardResult(board, true, count, null, null));
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                // 保留旧快照：这里刻意不写库。页面继续显示上一份，并如实标出它的日期。
                _logger.LogWarning(ex,
                    "模型榜同步：分榜 {Board} 失败，保留上一份快照（页面会显示旧数据的日期）。", board);
                var (code, message) = ClassifyFailure(ex);
                results.Add(new BoardResult(board, false, 0, code, message));
            }
        }

        return results;
    }

    /// <summary>同步一个分榜，返回写入的条目数。失败直接抛，由调用方决定怎么记。</summary>
    public async Task<int> SyncBoardAsync(
        ArenaLeaderboardFetcher fetcher,
        string board,
        string sourceLabel,
        CancellationToken ct)
    {
        // 抓取时刻在**抓之前**取，不在写库时取。
        //
        // 模型上的注释写着「抓取成功的时刻，不许拿当前时间冒充」，而原来这里是在构造
        // 快照对象时才 DateTime.UtcNow——十一个榜串行抓、每个之间还歇一秒，写库时刻
        // 与抓取时刻能差出一分钟。更要紧的是它让并发写没法排序：两个同步撞在一起时，
        // **后写的总是拿到更大的时间戳**，哪怕它抓到的是更旧的数据（Codex 在 PR #1538 指出）。
        var fetchedAt = DateTime.UtcNow;
        var parsed = await fetcher.FetchAsync(board, ct);
        var entries = parsed.Entries;

        // 取一次、贯穿整个写入：过滤、挑基线、算 Id、盖戳都得是同一个作用域值
        var scope = ModelLeaderboardScope.Current;

        // 候选文档：本榜里「本部署看得见」的那些（自己的 + 权威部署的）。
        // 读一把列表而不是 FirstOrDefault，因为下面要分别取两样东西——比对基线与写入目标。
        var candidates = await _db.ModelLeaderboardSnapshots
            .Find(Builders<ModelLeaderboardSnapshot>.Filter.And(
                Builders<ModelLeaderboardSnapshot>.Filter.Eq(x => x.Board, board),
                ModelLeaderboardScope.VisibleFilter(scope)))
            .ToListAsync(ct);

        // 比对上一份快照填升降。上一份不存在时全部留 null，前端不显示箭头。
        //
        // 口径与页面读取**同一个函数**：自己的优先、其次最新。四处各写一遍排序是上一轮
        // 连着四轮 review 的来源（predicate-and-wiring-discipline 形状 3），现在只有
        // ModelLeaderboardScope.PickVisible 这一个入口。
        //
        // 基线允许落到权威那份：一条刚建的预览第一次同步时，拿权威快照当基线算出来的升降
        // 是有意义的（「相对线上那份，谁升了」）；没有基线才是真的什么都显示不了。
        var previous = ModelLeaderboardScope.PickVisible(
            candidates, x => x.DeploymentSlug, x => x.FetchedAt, scope);

        // 写用 _id 过滤，不用 Board。
        //
        // 上一轮给首次写换了确定性 Id，但过滤条件还是 Board——这只是把「插出两条文档」
        // 换成了「其中一条撞 _id 报 E11000」（Codex 在 PR #1538 第二次指出同一处）：
        // 两个并发的首次同步都发现 Board 无匹配，于是都走插入，而它们算出的 _id 是同一个。
        // 按 _id 过滤之后，后到的那个会匹配上先到的那条并替换它，两边都成功收敛。
        //
        // **目标文档只能是本作用域自己那条**，不能顺手用 previous 的 Id：预览上 previous
        // 往往就是权威那份（见上），拿它的 Id 去 Replace 等于把兄弟分支正在读的文档
        // 覆盖掉——这一条正是本轮要修的洞（Codex 在 PR #1538 指出）。
        // 存量文档（DeploymentSlug 缺失 = null）在权威部署上仍由自己的随机 Id 沿用，
        // 不会多出一条。
        // 不用 candidates.FirstOrDefault(自己的)——那是**任意一条**自己的。存量重复文档
        // （权威部署上两条都是 DeploymentSlug=null）会让它随机挑中那条更旧的孤儿，于是
        // 同步一直写旧的、而页面按「取最新」读另一条永远不更新的——正好把前几轮修掉的
        // 那个 bug 原样装回来。
        //
        // previous 已经是 PickVisible 按「自己的优先、其次最新」挑出来的，所以它只要是
        // 自己的，就一定是**自己那条里最新的**；它不是自己的（预览兜底到了权威那份）
        // 就说明本作用域还没有文档，该用确定性 Id 新建一条。
        // 严重缩水就拒绝（判据与守卫都在 ArenaLeaderboardFetcher，与另外几条写库前判据同处）
        ArenaLeaderboardFetcher.EnsureNotTruncated(board, entries.Count, previous?.Entries.Count ?? 0);

        var own = previous is not null
                  && ModelLeaderboardScope.IsOwnDocument(previous.DeploymentSlug, scope)
            ? previous
            : null;
        var documentId = own?.Id ?? ModelLeaderboardScope.DocumentId(board, scope);

        // 条件写：只有当库里那条**不比我这次抓得新**时才替换。
        //
        // 周期 worker 与手动触发（或两个副本、两个管理员）同时同步同一个榜时，两边都先抓、
        // 后写。原来的无条件 Replace 让**后写的赢**，哪怕它抓到的是更旧的数据——于是新数据
        // 被旧数据覆盖，而且升降还是拿更新的那份当基线倒着算的（Codex 在 PR #1538 指出）。
        //
        // 加一条 FetchedAt 的判据之后，晚到的旧抓取匹配不上、写 0 条，新快照原地不动。
        // 不用分布式锁：这是一次幂等的整份替换，「谁抓得新谁赢」就是正确语义，
        // 而锁要额外一张表加上它自己的过期与收割（concurrency-gate-discipline 那一整套）。
        // 首次写（库里还没有这条）由 Lt 之外的 upsert 兜住：过滤匹配不上就插入。
        var filter = Builders<ModelLeaderboardSnapshot>.Filter.And(
            Builders<ModelLeaderboardSnapshot>.Filter.Eq(x => x.Id, documentId),
            Builders<ModelLeaderboardSnapshot>.Filter.Lt(x => x.FetchedAt, fetchedAt));
        if (previous is not null)
        {
            var previousRanks = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in previous.Entries)
                previousRanks.TryAdd(entry.Name, entry.Rank);

            foreach (var entry in entries)
            {
                if (previousRanks.TryGetValue(entry.Name, out var rank))
                    entry.PreviousRank = rank;
            }
        }

        var snapshot = new ModelLeaderboardSnapshot
        {
            // 覆盖写时沿用旧文档的 Id；首次写用**由榜名派生的确定性 Id**，不是随机 Guid。
            //
            // 随机 Guid 在首次同步上有竞态（Codex 在 PR #1538 指出）：周期 worker 与手动触发
            // 同时跑时，两边都看到 previous == null、各自生成一个 Id，而 upsert 的过滤条件
            // 是 Board 而非 _id、库里也没有唯一索引（禁止自动建索引，见 no-auto-index.md），
            // 于是同一个榜会插出两条文档——/boards 的 ToDictionary 当场抛，普通读取则随机
            // 拿到其中一条。确定性 Id 让两边写同一个 _id，后到的覆盖先到的，天然收敛。
            Id = documentId,
            Board = board,
            // 形状以**页面实际解析出来的**为准，不是照目录抄一份（FetchAsync 已校验两者一致）
            Kind = parsed.Kind,
            FetchedAt = fetchedAt,
            SourceUrl = ArenaLeaderboardFetcher.BuildUrl(board),
            SourceLabel = sourceLabel,
            // 盖上本部署的作用域，兄弟分支据此不会读到（也不会被覆盖）这一份
            DeploymentSlug = scope,
            TotalSessions = parsed.TotalSessions,
            TotalVotes = parsed.TotalVotes,
            Entries = entries,
        };

        // upsert 的三条出路：
        // 1. 文档不存在 → 插入（UpsertedId 有值）；
        // 2. 存在且比我旧 → 匹配上、替换（MatchedCount=1）；
        // 3. 存在但不比我旧 → 过滤匹配不上，于是 upsert 去**插入**，而 _id 已被占用，
        //    撞 E11000。这是并发下的正常结果，不是错误：捕获它，当成「有人比我新，让给他」。
        // 下面那个 MatchedCount/UpsertedId 都空的分支按上面三条走不到，留着是兜底，
        // 免得驱动哪天换了语义就变成静默覆盖。
        try
        {
            var result = await _db.ModelLeaderboardSnapshots.ReplaceOneAsync(
                filter, snapshot, new ReplaceOptions { IsUpsert = true }, ct);

            if (result.MatchedCount == 0 && result.UpsertedId is null)
            {
                _logger.LogInformation(
                    "模型榜同步：分榜 {Board} 本次抓取（{FetchedAt:O}）不比库里那份新，已让位，不覆盖。",
                    board, fetchedAt);
                return entries.Count;
            }
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 并发下的正常结果：另一次同步先写进去了，而且它比我新。
            _logger.LogInformation(
                "模型榜同步：分榜 {Board} 撞上并发写入且对方更新，已让位，不覆盖。", board);
            return entries.Count;
        }

        _logger.LogInformation("模型榜同步：分榜 {Board} 已更新，{Count} 个模型。", board, entries.Count);
        return entries.Count;
    }
}
