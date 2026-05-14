using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 统一短链解析（公开）— 把 /s/{seq} 数字 ID 解析到具体分享系统。
/// 前端 SPA 路由 /s/:slug 通过本端点拿到 (targetType, token) 后再调对应业务端点。
/// 不暴露作者等敏感信息（防止 /s/1..N 遍历当通讯录用）。
/// </summary>
[ApiController]
[Route("api/short-links")]
[AllowAnonymous]
public class ShortLinksController : ControllerBase
{
    private readonly IShortLinkService _shortLinks;

    public ShortLinksController(IShortLinkService shortLinks)
    {
        _shortLinks = shortLinks;
    }

    /// <summary>按数字 Seq 解析短链，返回目标分享系统类型 + 原始 Token。</summary>
    [HttpGet("{seq:long}")]
    public async Task<IActionResult> Resolve(long seq, CancellationToken ct)
    {
        if (seq <= 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "短链不存在"));

        var link = await _shortLinks.ResolveAsync(seq, ct);
        if (link == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "短链不存在"));

        return Ok(ApiResponse<object>.Ok(new
        {
            seq = link.Seq,
            targetType = link.TargetType,
            token = link.TargetId,
            createdAt = link.CreatedAt,
        }));
    }
}
