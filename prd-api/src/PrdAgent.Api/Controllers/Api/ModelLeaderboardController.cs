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
        if (!ModelLeaderboardCatalog.Contains(board))
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                $"未知的榜单 {board}，可选：{string.Join(" / ", ModelLeaderboardCatalog.Keys)}"));
        }

        // 文本榜实测 402 行，上限放到 500 才不会把「共 402 个」截成一句谎话
        limit = Math.Clamp(limit, 1, 500);

        var snapshot = await _db.ModelLeaderboardSnapshots
            .Find(x => x.Board == board)
            .FirstOrDefaultAsync(ct);

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
            .Find(Builders<ModelLeaderboardSnapshot>.Filter.Empty)
            .Project(x => new { x.Board, x.Entries })
            .ToListAsync(ct);

        // 用 GroupBy 而不是 ToDictionary：库里同一个榜理论上只有一条文档，但「理论上」不该
        // 让一个只读端点在数据意外重复时整个 500（历史上确实有过并发首写留下两条的窗口，
        // 见 ModelLeaderboardSyncService.DeterministicId）。重复时取条目多的那条。
        var counts = existing
            .GroupBy(x => x.Board, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(g => g.Key, g => g.Max(x => x.Entries.Count), StringComparer.OrdinalIgnoreCase);

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

        var snapshot = await _db.ModelLeaderboardSnapshots
            .Find(x => x.Board == board)
            .FirstOrDefaultAsync(ct);

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
        // 六个指标，值自带正负号（页面上的 ▲/▼ 已经解析进符号）
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
