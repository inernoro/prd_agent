using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 托管站点访客痕迹 —— 记录登录用户访问站点 + 向 owner/共享团队回放访客列表。
/// 仅需登录（任何访客都能埋点），不挂 [AdminController]；
/// 访客列表的可见性在 Service 层按 owner / 团队成员判定。
///
/// 路由前缀刻意走 `api/web-page-analytics` 而非 `api/web-pages`：
/// AdminPermissionMiddleware 用前缀匹配把 `api/web-pages/*` 都判给 [AdminController("web-pages", WritePermission=web-pages.write)]
/// 的 WebPagesController，导致 POST record-view 在 middleware 阶段就被拦截，
/// 访客如果没有 web-pages.write 权限（普通用户/团队 viewer）会被静默挡掉，丢失浏览埋点。
/// 改前缀后不再被 admin middleware 抓走。codex-bot 2026-05-28 P2 修复。
/// </summary>
[ApiController]
[Route("api/web-page-analytics")]
[Authorize]
public class WebPageAnalyticsController : ControllerBase
{
    private readonly ISiteViewEventService _views;

    public WebPageAnalyticsController(ISiteViewEventService views)
    {
        _views = views;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>记录一次站点访问（进入站点时调用，30 分钟内同一访客去重）</summary>
    [HttpPost("{id}/record-view")]
    public async Task<IActionResult> RecordView(string id)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点 ID 不能为空"));

        var ip = HttpContext.GetRealClientIp();
        var ua = Request.Headers.UserAgent.ToString();
        await _views.RecordAsync(id, GetUserId(), ip, ua);

        return Ok(ApiResponse<object>.Ok(new { recorded = true }));
    }

    /// <summary>查看某站点的访客痕迹（仅 owner 或共享团队成员可见）</summary>
    [HttpGet("{id}/viewers")]
    public async Task<IActionResult> Viewers(string id, [FromQuery] int skip = 0, [FromQuery] int limit = 100)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点 ID 不能为空"));

        var result = await _views.ListViewersAsync(id, GetUserId(), skip, limit);
        return Ok(ApiResponse<object>.Ok(result));
    }
}
