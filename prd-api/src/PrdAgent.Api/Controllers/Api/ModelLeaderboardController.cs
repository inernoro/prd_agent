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
    private readonly ModelLeaderboardSyncService _sync;
    private readonly ILogger<ModelLeaderboardController> _logger;

    public ModelLeaderboardController(
        MongoDbContext db,
        ModelLeaderboardSyncService sync,
        ILogger<ModelLeaderboardController> logger)
    {
        _db = db;
        _sync = sync;
        _logger = logger;
    }

    /// <summary>
    /// 读一个分榜。<paramref name="board"/> 取值见 <see cref="ModelLeaderboardSyncWorker.Boards"/>。
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> Get(
        [FromQuery] string board = "agent",
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
    {
        if (!ModelLeaderboardSyncWorker.Boards.Contains(board, StringComparer.OrdinalIgnoreCase))
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                $"未知的榜单 {board}，可选：{string.Join(" / ", ModelLeaderboardSyncWorker.Boards)}"));
        }

        limit = Math.Clamp(limit, 1, 200);

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
            stale = IsStale(snapshot.FetchedAt),
            total = snapshot.Entries.Count,
            entries = snapshot.Entries.Take(limit).Select(Project),
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
            stale = IsStale(snapshot.FetchedAt),
            entries = snapshot.Entries.Take(limit).Select(Project),
        }));
    }

    /// <summary>
    /// 手动触发一次同步。
    ///
    /// 为什么需要它：周期同步刻意只在权威部署跑（共享库里一个榜单只有一条文档，
    /// N 个分支预览同时写会互相覆盖）。但这样一来，任何分支预览上的库都是空的，
    /// 功能没法在预览域名上验收——而验收必须走真实访问路径。
    /// 所以留一个手动入口：谁要看效果，谁自己点一次。
    ///
    /// 与 CdsReportImportWorker 是同一个模式：周期任务保持克制，手动入口补上可操作性。
    ///
    /// 限管理员：它会对外站发五次请求并覆盖共享库里的快照，不是普通用户该随手点的。
    /// </summary>
    [HttpPost("sync")]
    [Authorize(Roles = "ADMIN")]
    public async Task<IActionResult> Sync(CancellationToken ct)
    {
        _logger.LogInformation("模型榜同步：管理员手动触发。");
        var results = await _sync.SyncAllAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            total = results.Count,
            succeeded = results.Count(r => r.Ok),
            boards = results.Select(r => new { board = r.Board, ok = r.Ok, count = r.Count, error = r.Error }),
        }));
    }

    private static bool IsStale(DateTime fetchedAt)
        => DateTime.UtcNow - fetchedAt > TimeSpan.FromDays(StaleAfterDays);

    private static object Project(ModelLeaderboardEntry e) => new
    {
        rank = e.Rank,
        name = e.Name,
        organization = e.Organization,
        license = e.License,
        score = e.Score,
        margin = e.Margin,
        previousRank = e.PreviousRank,
        // 名次升降：没有上一份快照时为 null，前端据此不显示箭头，而不是画一个「持平」
        rankDelta = e.PreviousRank is null ? (int?)null : e.PreviousRank - e.Rank,
    };
}
