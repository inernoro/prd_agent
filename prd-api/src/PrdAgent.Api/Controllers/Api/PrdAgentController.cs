using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// PRD Agent 占位 Controller
/// 用于菜单权限扫描，使 prd-agent appKey 能被发现。
/// 实际的 PRD Agent 功能通过普通用户 API（/api/v1/sessions、/api/v1/documents 等）实现。
/// </summary>
[ApiController]
[Route("api/prd-agent")]
[Authorize]
[AdminController("prd-agent", AdminPermissionCatalog.PrdAgentUse)]
public sealed class PrdAgentController : ControllerBase
{
    /// <summary>
    /// 健康检查端点（占位用）
    /// </summary>
    [HttpGet("health")]
    public IActionResult Health()
    {
        return Ok(ApiResponse<object>.Ok(new { status = "ok", message = "PRD Agent 功能可用" }));
    }
}
