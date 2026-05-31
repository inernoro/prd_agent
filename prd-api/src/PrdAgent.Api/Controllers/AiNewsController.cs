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

    // 单次请求最多处理多少个 id：防止超大 ids 列表造成大 $in 查询 / 抓取压力（前端按可见条目分批,远小于此）
    private const int MaxIdsPerRequest = 60;

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
        var ids = (body?.Ids ?? new List<string>()).Take(MaxIdsPerRequest).ToList();
        if (ids.Count == 0)
        {
            return Ok(ApiResponse<Dictionary<string, string>>.Ok(new()));
        }
        var userId = this.GetRequiredUserId();
        var map = await _service.EnrichCommentaryAsync(ids, userId, ct);
        return Ok(ApiResponse<Dictionary<string, string>>.Ok(map));
    }

    /// <summary>
    /// 为指定资讯抓取 / 读取文章摘要片段（默认展示的「部分内容」）。
    /// 公共数据，允许匿名；只抓 feed 内已知 URL（无 SSRF 风险）。前端按可见条目分批请求。
    /// </summary>
    [HttpPost("excerpt")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> Excerpt([FromBody] AiNewsCommentaryRequest body, CancellationToken ct)
    {
        var ids = (body?.Ids ?? new List<string>()).Take(MaxIdsPerRequest).ToList();
        if (ids.Count == 0)
        {
            return Ok(ApiResponse<Dictionary<string, string>>.Ok(new()));
        }
        var map = await _service.EnrichExcerptAsync(ids, ct);
        return Ok(ApiResponse<Dictionary<string, string>>.Ok(map));
    }
}

/// <summary>资讯增强请求体：要处理的资讯 id 列表（取自当前 feed）。</summary>
public class AiNewsCommentaryRequest
{
    public List<string> Ids { get; set; } = new();
}
