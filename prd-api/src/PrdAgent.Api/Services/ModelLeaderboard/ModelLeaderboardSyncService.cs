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

    /// <summary>
    /// 由榜名派生的文档 Id。同一个榜永远算出同一个 Id，首次写的并发因此收敛到一条文档。
    ///
    /// 用榜名的哈希而不是榜名本身：榜名带连字符（`text-to-image`），而库里其它集合的 Id
    /// 一律是 32 位十六进制（见 AGENTS.md 规则 7 的 Id 约定），保持同一个形状。
    /// </summary>
    internal static string DeterministicId(string board)
    {
        var bytes = System.Security.Cryptography.MD5.HashData(
            System.Text.Encoding.UTF8.GetBytes("model-leaderboard:" + board.ToLowerInvariant()));
        return Convert.ToHexString(bytes).ToLowerInvariant();
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
        var parsed = await fetcher.FetchAsync(board, ct);
        var entries = parsed.Entries;

        // 比对上一份快照填升降。上一份不存在时全部留 null，前端不显示箭头。
        //
        // 按 FetchedAt 倒序：存量重复文档里挑到孤儿的话，升降就是拿「某个任意的更旧排名」
        // 算出来的，而 Get / Top / 自检都已经改成看最新那份——四处口径必须一致，
        // 否则页面上的箭头讲的是另一个故事（Codex 在 PR #1538 指出，同一个疏漏的第三处）。
        var previous = await _db.ModelLeaderboardSnapshots
            .Find(Builders<ModelLeaderboardSnapshot>.Filter.Eq(x => x.Board, board))
            .SortByDescending(x => x.FetchedAt)
            .FirstOrDefaultAsync(ct);

        // 写用 _id 过滤，不用 Board。
        //
        // 上一轮给首次写换了确定性 Id，但过滤条件还是 Board——这只是把「插出两条文档」
        // 换成了「其中一条撞 _id 报 E11000」（Codex 在 PR #1538 第二次指出同一处）：
        // 两个并发的首次同步都发现 Board 无匹配，于是都走插入，而它们算出的 _id 是同一个。
        // 按 _id 过滤之后，后到的那个会匹配上先到的那条并替换它，两边都成功收敛。
        // 存量文档的随机 Id 由 previous?.Id 继续沿用，不会多出一条。
        var documentId = previous?.Id ?? DeterministicId(board);
        var filter = Builders<ModelLeaderboardSnapshot>.Filter.Eq(x => x.Id, documentId);
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
            FetchedAt = DateTime.UtcNow,
            SourceUrl = ArenaLeaderboardFetcher.BuildUrl(board),
            SourceLabel = sourceLabel,
            TotalSessions = parsed.TotalSessions,
            TotalVotes = parsed.TotalVotes,
            Entries = entries,
        };

        await _db.ModelLeaderboardSnapshots.ReplaceOneAsync(
            filter, snapshot, new ReplaceOptions { IsUpsert = true }, ct);

        _logger.LogInformation("模型榜同步：分榜 {Board} 已更新，{Count} 个模型。", board, entries.Count);
        return entries.Count;
    }
}
