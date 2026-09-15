using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Services.ModelLeaderboard;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 模型排行榜的管理操作（写侧）。
///
/// ## 为什么单独一个 Controller，而且路由前缀也必须不同
///
/// <see cref="ModelLeaderboardController"/> 是全员可见的只读榜单，只要求登录；
/// 而手动同步会去打外站并覆盖共享库里的快照，得限权限。
/// <see cref="AdminControllerAttribute"/> 是 <b>Controller 级</b>的——挂上去会连同 GET
/// 一起要求读权限，所以写操作得单独拆出来。
///
/// 但只拆 Controller 不够：<c>AdminControllerScanner.GetRequiredPermission</c> 是按
/// <b>路由前缀</b>查权限的，同前缀下有多个 Controller 时「取第一个的权限」。两个 Controller
/// 当初都挂在 <c>api/model-leaderboard</c> 上，于是只读端点照样被要求 <c>mds.read</c>——
/// 拆了等于没拆，全员可见根本没生效（用管理员账号测是发现不了的，他本来就有这个权限）。
/// 所以这里改用 <c>api/admin/model-leaderboard</c>（项目里 admin 接口的惯例前缀），
/// 让两边在权限映射表里彻底分开。
/// </summary>
[ApiController]
[Route("api/admin/model-leaderboard")]
[Authorize]
[AdminController("model-leaderboard", AdminPermissionCatalog.ModelsRead,
    WritePermission = AdminPermissionCatalog.ModelsWrite)]
public class ModelLeaderboardAdminController : ControllerBase
{
    private readonly ModelLeaderboardSyncService _sync;
    private readonly ILogger<ModelLeaderboardAdminController> _logger;

    public ModelLeaderboardAdminController(
        ModelLeaderboardSyncService sync,
        ILogger<ModelLeaderboardAdminController> logger)
    {
        _sync = sync;
        _logger = logger;
    }

    /// <summary>
    /// 手动触发一次同步（走「模型管理-写」权限）。
    ///
    /// 为什么需要它：周期同步刻意只在权威部署跑（共享库里一个榜单只有一条文档，
    /// N 个分支预览同时写会互相覆盖，也是对 arena.ai 的自我 DDoS）。但这样一来，
    /// 任何分支预览上的库都是空的，功能没法在预览域名上验收——而验收必须走真实访问路径。
    /// 所以留一个手动入口：谁要看效果，谁自己点一次。
    ///
    /// 与 CdsReportImportWorker 同一个模式：周期任务保持克制，手动入口补上可操作性。
    /// </summary>
    /// <param name="board">
    /// 只同步这一个榜。不传就同步全部十一个——那要跑一分钟左右，而用户通常只是想看
    /// 眼前这一个榜的数据。页面上的「立即同步」按钮传的是当前正在看的那个榜。
    /// </param>
    [HttpPost("sync")]
    public async Task<IActionResult> Sync([FromQuery] string? board)
    {
        if (!string.IsNullOrWhiteSpace(board) && !ModelLeaderboardCatalog.Contains(board))
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                $"未知的榜单 {board}，可选：{string.Join(" / ", ModelLeaderboardCatalog.Keys)}"));
        }

        _logger.LogInformation("模型榜同步：手动触发（{Board}）。", board ?? "全部");

        // 刻意不把 ct（= RequestAborted）传下去：浏览器离开、连接断掉、代理掐断这条长请求时，
        // 同步不该半途而废——它要写的是共享库里的快照，停在一半会留下「抓了三个榜就没了」的
        // 状态，而调用方根本不知道（server-authority.md：客户端被动断开不得取消服务器任务）。
        // 取消只允许来自进程关闭，而不是某个浏览器标签页。
        var results = await _sync.SyncAllAsync(CancellationToken.None, board);

        return Ok(ApiResponse<object>.Ok(new
        {
            total = results.Count,
            succeeded = results.Count(r => r.Ok),
            boards = results.Select(r => new { board = r.Board, ok = r.Ok, count = r.Count, error = r.Error }),
        }));
    }
}
