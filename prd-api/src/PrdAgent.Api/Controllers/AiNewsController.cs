using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 首页「AI 大事早知道」资讯雷达。
/// 公共资讯（无敏感数据），允许匿名访问；底层走 IAiNewsService 的内存缓存 + stale 保底。
/// </summary>
[ApiController]
[Route("api/ai-news")]
[AllowAnonymous]
public class AiNewsController : ControllerBase
{
    private readonly IAiNewsService _service;

    public AiNewsController(IAiNewsService service)
    {
        _service = service;
    }

    /// <summary>最近 24 小时 AI 资讯流（已裁剪 + 缓存）。</summary>
    [HttpGet("latest")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetLatest(CancellationToken ct)
    {
        var feed = await _service.GetLatestAsync(ct);
        return Ok(ApiResponse<AiNewsFeed>.Ok(feed));
    }
}
