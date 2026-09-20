using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 活动任务面板 —— 匿名只读视图。
///
/// 默认脱敏：访客看得到「谁在忙 / 谁卡住 / 谁没活 / 今天投入多久」，
/// 看不到任务标题正文、备注、在等谁 —— 任务标题常带项目代号和缺陷细节。
/// 管理员可在面板设置里逐档放开（masked / full / headline），或整个关掉。
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/public/active-tasks")]
public class PublicActiveTasksController : ControllerBase
{
    private readonly MongoDbContext _db;

    public PublicActiveTasksController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>匿名团队看板。关闭时返回 404，不泄露「这里本来有个面板」。</summary>
    [HttpGet("board")]
    public async Task<IActionResult> Board(CancellationToken ct = default)
    {
        var settings = await ActiveTaskShared.LoadSettingsAsync(_db, ct);
        if (!settings.AnonymousEnabled)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "面板未开放"));

        var now = DateTime.UtcNow;
        var masked = settings.AnonymousMode != AnonymousVisibility.Full;
        var board = await ActiveTaskShared.BuildTeamBoardAsync(_db, settings, now, masked, ct);

        // headline 档：只给那句判断和统计数字，连人名都不列
        if (settings.AnonymousMode == AnonymousVisibility.Headline)
        {
            var t = board.GetType();
            return Ok(ApiResponse<object>.Ok(new
            {
                mode = settings.AnonymousMode,
                headline = t.GetProperty("headline")?.GetValue(board),
                kpis = t.GetProperty("kpis")?.GetValue(board),
                serverNow = now,
            }));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            mode = settings.AnonymousMode,
            board,
        }));
    }
}
