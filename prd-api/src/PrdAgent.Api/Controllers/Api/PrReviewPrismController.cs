using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// PR审查棱镜（独立于产品评审员 review-agent）。当前提供占位接口，供前端路由与权限挂载。
/// </summary>
[ApiController]
[Route("api/pr-review-prism")]
[Authorize]
[AdminController("pr-review-prism", AdminPermissionCatalog.PrReviewPrismUse)]
public sealed class PrReviewPrismController : ControllerBase
{
    private const string AppKey = "pr-review-prism";

    /// <summary>
    /// 健康检查 / 占位：确认具备 pr-review-prism.use 后可调用。
    /// </summary>
    [HttpGet("status")]
    public IActionResult GetStatus()
    {
        return Ok(ApiResponse<object>.Ok(new
        {
            appKey = AppKey,
            phase = "placeholder",
            message = "PR审查棱镜能力建设中，后续将在此接入 PR 审查流程。",
        }));
    }
}
