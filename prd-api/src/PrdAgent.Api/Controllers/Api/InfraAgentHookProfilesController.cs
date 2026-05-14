using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/infra-agent-hook-profiles")]
[Authorize]
public class InfraAgentHookProfilesController : ControllerBase
{
    private readonly IInfraAgentHookProfileService _service;

    public InfraAgentHookProfilesController(IInfraAgentHookProfileService service)
    {
        _service = service;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var items = await _service.ListAsync(userId, ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertInfraAgentHookProfileRequest req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.CreateAsync(userId, req, ct);
            return StatusCode(StatusCodes.Status201Created, ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentHookProfileException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }
}
