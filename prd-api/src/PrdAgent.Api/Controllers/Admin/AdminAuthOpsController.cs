using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理端认证运维接口（用于测试/运维：踢下线等）
/// </summary>
[ApiController]
[Route("api/v1/admin/users")]
[Authorize]
[AdminController("admin-users", AdminPermissionCatalog.UsersWrite)]
public class AdminAuthOpsController : ControllerBase
{
    private readonly IAuthSessionService _authSessionService;

    public AdminAuthOpsController(IAuthSessionService authSessionService)
    {
        _authSessionService = authSessionService;
    }

    /// <summary>
    /// 强制过期（踢下线）：可选踢 admin / desktop / 两端
    /// </summary>
    [HttpPost("{userId}/force-expire")]
    [ProducesResponseType(typeof(ApiResponse<ForceExpireResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ForceExpire(string userId, [FromBody] ForceExpireRequest request)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "userId 不能为空"));
        }

        var targets = (request?.Targets ?? Array.Empty<string>())
            .Select(t => (t ?? string.Empty).Trim().ToLowerInvariant())
            .Where(t => t is "admin" or "desktop")
            .Distinct()
            .ToArray();

        if (targets.Length == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "targets 不能为空（admin/desktop）"));
        }

        foreach (var ct in targets)
        {
            // 1) 删除 refresh 会话（阻断后续 refresh）
            await _authSessionService.RemoveAllRefreshSessionsAsync(uid, ct);
            // 2) 提升 tokenVersion（使当前端所有 access token 立即失效）
            await _authSessionService.BumpTokenVersionAsync(uid, ct);
        }

        return Ok(ApiResponse<ForceExpireResponse>.Ok(new ForceExpireResponse
        {
            UserId = uid,
            Targets = targets
        }));
    }
}

public class ForceExpireRequest
{
    /// <summary>admin/desktop</summary>
    public string[] Targets { get; set; } = Array.Empty<string>();
}

public class ForceExpireResponse
{
    public string UserId { get; set; } = string.Empty;
    public string[] Targets { get; set; } = Array.Empty<string>();
}


