using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.ModelLeaderboard;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 模型排行榜（只读）。数据由 <see cref="ModelLeaderboardSyncWorker"/> 每天同步进本地库，
/// 这里只读库，不打外站——外站抖动不会传导到用户。
///
/// 全员可见（只要求登录）：榜单是公开数据，不含本站调用量或成本这类经营信息。
/// </summary>
[ApiController]
[Route("api/model-leaderboard")]
[Authorize]
public class ModelLeaderboardController : ControllerBase
{
    /// <summary>
    /// 超过这个天数就认为快照是陈的，响应里把 <c>stale</c> 标为 true。
    ///
    /// 同步是每天一轮，容忍两轮失败（48 小时）再报陈旧：偶发的一次外站超时不该让
    /// 用户看到警告，但连着两天拉不到就该说实话了。
    /// </summary>
    private const int StaleAfterDays = 2;

    private readonly MongoDbContext _db;

    public ModelLeaderboardController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 读一个分榜。<paramref name="board"/> 取值见 <see cref="ModelLeaderboardCatalog.Boards"/>。
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string board = "agent",
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
    {
        // 先把榜名归一到目录里那个写法，再拿去查库。
        //
        // Contains / Find 是 OrdinalIgnoreCase 的，而 Mongo 的等值过滤默认区分大小写：
        // `?board=Text` 会通过校验、然后一条都匹配不上，于是一个存在的榜被报成
        // ready=false。校验与查询必须用同一个口径，取归一后的 Key
        // （Codex 在 PR #1538 指出；同一形状的第二例见本 PR 的手动同步入口——
        // 那边的目标过滤本来就是忽略大小写取回目录值，所以没这个毛病）。
        var info = ModelLeaderboardCatalog.Find(board);
        if (info is null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                $"未知的榜单 {board}，可选：{string.Join(" / ", ModelLeaderboardCatalog.Keys)}"));
        }
        board = info.Key;

        // 文本榜实测 402 行，上限放到 500 才不会把「共 402 个」截成一句谎话
        limit = Math.Clamp(limit, 1, 500);

        // 取「本部署该看的那一份」：自己的优先、其次最新。
        //
        // 两件事叠在这一句里：
        // ① 同一个榜可能有多条文档——首次写的并发窗口（本 PR 已修掉成因）留下过孤儿，
        //    同步只更新其中一条、从不删另一条。不排序的话可能拿到那条永远不再更新的：
        //    页面显示几天前的名次，而自检看的是最新那份、判绿——面板说健康、用户看到旧数据。
        // ② 分支预览与权威部署各写各的文档（ModelLeaderboardScope），本部署没自己同步过
        //    时兜底显示权威那份。
        // 排序口径只有 PickVisible 一个入口，不在四个读取点各抄一遍。
        var snapshot = await LoadVisibleSnapshotAsync(board, ct);

        if (snapshot is null)
        {
            // 还没同步过。如实说没有，不返回空数组假装榜单是空的——前端据此给出
            // 「首次同步还没跑」的提示，而不是画一张空表。
            return Ok(ApiResponse<object>.Ok(new
            {
                board,
                ready = false,
                entries = Array.Empty<object>(),
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            board = snapshot.Board,
            ready = true,
            fetchedAt = snapshot.FetchedAt,
            sourceUrl = snapshot.SourceUrl,
            kind = string.IsNullOrEmpty(snapshot.Kind) ? BoardKind.Agent : snapshot.Kind,
            stale = IsStale(snapshot.FetchedAt),
            total = snapshot.Entries.Count,
            totalSessions = snapshot.TotalSessions,
            totalVotes = snapshot.TotalVotes,
            entries = snapshot.Entries.Take(limit).Select(Project),
        }));
    }

    /// <summary>
    /// 分榜目录：有哪些榜、中文叫什么、归哪一组、是什么形状。
    ///
    /// 单开一个端点而不是把中文名硬编码在前端：榜名与分组是业务数据，
    /// 前端不许另存一份映射表（.claude/rules/frontend-architecture.md「单一数据源原则」）。
    /// 页面加载时它和默认榜的数据并行拉，不多一跳等待。
    ///
    /// <c>ready</c> 表示这个榜在库里已经有快照——首次同步还没轮到的榜，切换器上会标出来，
    /// 而不是让用户点进去看一张空表。
    /// </summary>
    [HttpGet("boards")]
    public async Task<IActionResult> BoardCatalog(CancellationToken ct = default)
    {
        var existing = await _db.ModelLeaderboardSnapshots
            .Find(ModelLeaderboardScope.VisibleFilter())
            .Project(x => new { x.Board, x.FetchedAt, x.DeploymentSlug, EntryCount = x.Entries.Count })
            .ToListAsync(ct);

        // 用 GroupBy 而不是 ToDictionary：库里同一个榜理论上只有一条文档，但「理论上」不该
        // 让一个只读端点在数据意外重复时整个 500（历史上确实有过并发首写留下两条的窗口，
        // 见 ModelLeaderboardScope.DocumentId）。
        //
        // 重复时取**最新那条**，不是条目最多那条（Codex 在 PR #1538 指出，这是同一疏漏的
        // 第四处：Get / Top、自检、同步基线都已改成看最新）。取最多的话，某个榜缩短之后
        // 切换器会永远显示那个更大的旧数字——同步只更新最新那条，孤儿的条目数冻在原处。
        var counts = existing
            .GroupBy(x => x.Board, StringComparer.OrdinalIgnoreCase)
            // 与 Get / Top / 自检同一个函数：自己的优先、其次最新。
            .Select(g => new
            {
                Board = g.Key,
                Visible = ModelLeaderboardScope.PickVisible(
                    g.ToList(), x => x.DeploymentSlug, x => x.FetchedAt),
            })
            // 挑不出来（本部署一条都看不见）就当这个榜还没同步，标 ready=false。
            // 不写 `!` 断言非空：粗筛在 Mongo、判据在 PickVisible，两者理论上等价，
            // 但把「等价」写成一个会 NRE 的断言，等于让一次口径漂移变成 500。
            .Where(x => x.Visible is not null)
            .ToDictionary(
                x => x.Board,
                x => x.Visible!.EntryCount,
                StringComparer.OrdinalIgnoreCase);

        return Ok(ApiResponse<object>.Ok(new
        {
            defaultBoard = ModelLeaderboardCatalog.DefaultBoard,
            boards = ModelLeaderboardCatalog.Boards.Select(b => new
            {
                key = b.Key,
                label = b.Label,
                group = b.Group,
                kind = b.Kind,
                hint = b.Hint,
                ready = counts.ContainsKey(b.Key),
                total = counts.TryGetValue(b.Key, out var c) ? c : 0,
            }),
        }));
    }

    /// <summary>
    /// 首页挂件用的轻量端点：只取前几名。
    ///
    /// 单独开一个是因为首页每次加载都会打它，没必要为了显示三行而传回整个榜。
    /// </summary>
    [HttpGet("top")]
    public async Task<IActionResult> Top(
        [FromQuery] string board = "agent",
        [FromQuery] int limit = 3,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 10);

        // 同 Get：先归一榜名再查库，否则 `?board=Agent` 会静默变成「首页挂件空着」。
        // 这里查不到就当成还没同步（挂件本来就不报错），不必回 400。
        board = ModelLeaderboardCatalog.Find(board)?.Key ?? board;

        // 同上：自己的优先、其次最新，别让首页挂件显示孤儿快照或兄弟分支的数据
        var snapshot = await LoadVisibleSnapshotAsync(board, ct);

        if (snapshot is null)
        {
            return Ok(ApiResponse<object>.Ok(new { board, ready = false, entries = Array.Empty<object>() }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            board = snapshot.Board,
            ready = true,
            fetchedAt = snapshot.FetchedAt,
            kind = string.IsNullOrEmpty(snapshot.Kind) ? BoardKind.Agent : snapshot.Kind,
            stale = IsStale(snapshot.FetchedAt),
            entries = snapshot.Entries.Take(limit).Select(Project),
        }));
    }

    /// <summary>
    /// 读一个榜里「本部署该看的那一份」快照。
    ///
    /// Get 与 Top 共用这一个：两边各写一遍「按榜过滤 + 作用域过滤 + 挑选」的话，
    /// 下次只改一边就又是一次判据分裂（predicate-and-wiring-discipline 形状 3——
    /// 这个榜单的读取口径已经因为这个形状被 review 抓过四轮了）。
    /// </summary>
    private async Task<ModelLeaderboardSnapshot?> LoadVisibleSnapshotAsync(
        string board, CancellationToken ct)
    {
        var candidates = await _db.ModelLeaderboardSnapshots
            .Find(Builders<ModelLeaderboardSnapshot>.Filter.And(
                Builders<ModelLeaderboardSnapshot>.Filter.Eq(x => x.Board, board),
                ModelLeaderboardScope.VisibleFilter()))
            .ToListAsync(ct);

        return ModelLeaderboardScope.PickVisible(
            candidates, x => x.DeploymentSlug, x => x.FetchedAt);
    }

    private static bool IsStale(DateTime fetchedAt)
        => DateTime.UtcNow - fetchedAt > TimeSpan.FromDays(StaleAfterDays);

    private static object Project(ModelLeaderboardEntry e) => new
    {
        rank = e.Rank,
        rankLow = e.RankLow,
        rankHigh = e.RankHigh,
        name = e.Name,
        organization = e.Organization,
        license = e.License,
        // 授权归类由后端给（frontend-architecture「单一数据源原则」：业务映射表不进前端）。
        // 原来前端自己判 `!/proprietary/i`，把非商用与仅研究的许可全标成了开源，
        // 见 ModelLicenseClassifier 的注释。
        licenseKind = ModelLicenseClassifier.Classify(e.License),
        // 六个指标，值自带正负号（页面上的方向箭头 已经解析进符号）
        netImprovement = Metric(e.NetImprovement),
        confirmedSuccess = Metric(e.ConfirmedSuccess),
        praiseVsComplaint = Metric(e.PraiseVsComplaint),
        steerability = Metric(e.Steerability),
        bashRecovery = Metric(e.BashRecovery),
        toolHallucination = Metric(e.ToolHallucination),
        // 分数榜字段（agent 榜上全为 null，前端按 kind 选列）
        score = e.Score,
        scoreMarginUp = e.ScoreMarginUp,
        scoreMarginDown = e.ScoreMarginDown,
        votes = e.Votes,
        contextWindow = e.ContextWindow,
        preliminary = e.Preliminary,
        sessions = e.Sessions,
        costPerTask = e.CostPerTask,
        outputTokens = e.OutputTokens,
        priceInput = e.PriceInput,
        priceOutput = e.PriceOutput,
        previousRank = e.PreviousRank,
        // 名次升降：没有上一份快照时为 null，前端据此不显示箭头，而不是画一个「持平」
        rankDelta = e.PreviousRank is null ? (int?)null : e.PreviousRank - e.Rank,
    };

    private static object? Metric(ModelLeaderboardMetric? m)
        => m is null ? null : new { value = m.Value, margin = m.Margin };
}
