using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>超级管理员处理无法由任务 owner 正常收口的停滞视频任务。</summary>
[ApiController]
[Route("api/admin/video-runs")]
[Authorize]
[AdminController("video-agent", AdminPermissionCatalog.Super, WritePermission = AdminPermissionCatalog.Super)]
public sealed class AdminVideoRunsController : ControllerBase
{
    private readonly IVideoGenService _videoGenService;

    public AdminVideoRunsController(IVideoGenService videoGenService)
    {
        _videoGenService = videoGenService;
    }

    /// <summary>
    /// 终止停滞且不再由 worker 持有的任务。当前仅允许 Editing，并拒绝仍有活跃镜头或导出工作的任务。
    /// </summary>
    [HttpPost("{runId}/terminate-stalled")]
    [ProducesResponseType(typeof(ApiResponse<AdminTerminateStalledVideoRunResult>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status409Conflict)]
    public async Task<IActionResult> TerminateStalled(string runId, CancellationToken ct)
    {
        try
        {
            var result = await _videoGenService.TerminateStalledRunAsAdminAsync(
                runId,
                this.GetRequiredUserId(),
                ct);
            return result == null
                ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频任务不存在"))
                : Ok(ApiResponse<AdminTerminateStalledVideoRunResult>.Ok(result));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(ApiResponse<object>.Fail("VIDEO_RUN_NOT_STALLED", ex.Message));
        }
    }
}
