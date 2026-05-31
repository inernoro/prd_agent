using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 首页「AI 大事早知道」资讯雷达。
/// 资讯流本身是公共数据（无敏感信息），允许匿名访问；AI 一句话解读因要调 LLM（需用户上下文）要求登录。
/// </summary>
[ApiController]
[Route("api/ai-news")]
public class AiNewsController : ControllerBase
{
    private readonly IAiNewsService _service;

    public AiNewsController(IAiNewsService service)
    {
        _service = service;
    }

    /// <summary>最近 24 小时 AI 资讯流（已裁剪 + 缓存）。</summary>
    [HttpGet("latest")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetLatest(CancellationToken ct)
    {
        var feed = await _service.GetLatestAsync(ct);
        return Ok(ApiResponse<AiNewsFeed>.Ok(feed));
    }

    /// <summary>
    /// 为指定资讯生成 / 读取「一句话 AI 解读」。命中缓存直接返回，未命中批量调 LLM 生成。
    /// 需登录（LLM 调用要求用户上下文）。前端按可见条目分批请求，结果渐进填充。
    /// </summary>
    [HttpPost("commentary")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> Commentary([FromBody] AiNewsCommentaryRequest body, CancellationToken ct)
    {
        var ids = body?.Ids ?? new List<string>();
        if (ids.Count == 0)
        {
            return Ok(ApiResponse<Dictionary<string, string>>.Ok(new()));
        }
        var userId = this.GetRequiredUserId();
        var map = await _service.EnrichCommentaryAsync(ids, userId, ct);
        return Ok(ApiResponse<Dictionary<string, string>>.Ok(map));
    }
}

/// <summary>「一句话解读」请求体：要解读的资讯 id 列表（取自当前 feed）。</summary>
public class AiNewsCommentaryRequest
{
    public List<string> Ids { get; set; } = new();
}
