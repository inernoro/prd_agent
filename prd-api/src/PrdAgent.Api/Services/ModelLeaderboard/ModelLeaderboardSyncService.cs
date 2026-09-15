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

    /// <summary>一个分榜的同步结果，给手动触发的调用方回显用。</summary>
    public record BoardResult(string Board, bool Ok, int Count, string? Error);

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
                results.Add(new BoardResult(board, true, count, null));
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
                results.Add(new BoardResult(board, false, 0, ex.Message));
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
        var filter = Builders<ModelLeaderboardSnapshot>.Filter.Eq(x => x.Board, board);
        var previous = await _db.ModelLeaderboardSnapshots.Find(filter).FirstOrDefaultAsync(ct);
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
            Id = previous?.Id ?? DeterministicId(board),
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
