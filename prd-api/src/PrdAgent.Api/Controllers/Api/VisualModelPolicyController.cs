using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Authorize]
[Route("api/visual-agent/model-policy")]
[AdminController("visual-agent", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public sealed class VisualModelPolicyController(IVisualModelPolicyService policy) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
        => Ok(ApiResponse<VisualModelPolicy>.Ok(await policy.ReadAsync(ct)));

    [HttpGet("catalog")]
    public async Task<IActionResult> Catalog(CancellationToken ct)
    {
        try { return Ok(ApiResponse<object>.Ok(await policy.DiscoverAsync(null, ct))); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
        {
            return StatusCode(503, ApiResponse<object>.Fail("LLM_GATEWAY_UNAVAILABLE", "模型目录暂时无法读取，请稍后刷新。"));
        }
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] VisualModelPolicy request, CancellationToken ct)
    {
        try
        {
            var error = await policy.SaveAsync(request, this.GetRequiredUserId(), ct);
            return error is null
                ? Ok(ApiResponse<VisualModelPolicy>.Ok(request))
                : BadRequest(ApiResponse<object>.Fail("VISUAL_MODEL_POLICY_INVALID", error));
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
        {
            return StatusCode(503, ApiResponse<object>.Fail("LLM_GATEWAY_UNAVAILABLE", "暂时无法核验模型配置，未保存任何修改。请稍后重试。"));
        }
    }
}
