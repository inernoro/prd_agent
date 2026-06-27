using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 统一短链解析（公开）— 把 /s/{seq} 数字 ID 解析到具体分享系统。
/// 前端 SPA 路由 /s/:slug 通过本端点拿到 (targetType, token) 后再调对应业务端点。
///
/// 设计选择：Seq 是全局自增数字，因此 /api/short-links/1..N 是可枚举的。
/// 这是 2026-05-13 与产品确认的明确设计决策（详见 doc/spec.platform.short-links.md）：
///   - "公开分享" = 内容本就该任意人可见，URL 短而易传播比不可猜测更重要
///   - "敏感场景" = 创建时必须勾选密码保护；本端点不暴露作者/标题/任何内容，
///     攻击者枚举到 token 后调 view 端点仍会被 401 拦截
///   - 仍想要不可猜测 capability URL 的用户继续用旧版 /s/wp/{随机12字符token}，
///     该路径完全保留
/// 因此本端点不做 rate limit、不做权限校验、不返回敏感字段（仅 seq+type+token+时间）。
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

    /// <summary>
    /// 按数字 Seq 解析短链，返回目标分享系统类型 + 原始 Token。
    /// 注意：此端点公开且可枚举（见类注释的设计说明），所有真正的访问控制
    /// 都在下游 view 端点（如 /api/web-pages/shares/view/{token}）中执行。
    /// </summary>
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

    /// <summary>
    /// P1 URL 统一：按任意 slug（纯数字 = Seq；其它 = Token）解析短链。
    /// 前端 ShortLinkRouter `/s/:slug` 用本端点替代纯数字版，支持字母 token 的统一路径。
    /// </summary>
    [HttpGet("resolve/{slug}")]
    public async Task<IActionResult> ResolveSlug(string slug, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(slug))
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "短链不存在"));

        ShortLink? link;
        if (long.TryParse(slug, out var seq))
            link = await _shortLinks.ResolveAsync(seq, ct);
        else
            link = await _shortLinks.ResolveByTokenAsync(slug, ct);

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
