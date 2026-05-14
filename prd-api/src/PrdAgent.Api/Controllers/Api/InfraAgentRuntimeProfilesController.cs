using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/infra-agent-runtime-profiles")]
[Authorize]
public class InfraAgentRuntimeProfilesController : ControllerBase
{
    private readonly IInfraAgentRuntimeProfileService _service;

    public InfraAgentRuntimeProfilesController(IInfraAgentRuntimeProfileService service)
    {
        _service = service;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var items = await _service.ListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] UpsertInfraAgentRuntimeProfileRequest req, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.CreateAsync(userId, req, ct);
            return StatusCode(StatusCodes.Status201Created, ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentRuntimeProfileException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpPost("import-default-model")]
    public async Task<IActionResult> ImportDefaultModel(CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.ImportDefaultModelAsync(userId, ct);
            return Ok(ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentRuntimeProfileException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var deleted = await _service.DeleteAsync(id, ct);
        if (!deleted)
        {
            return NotFound(ApiResponse<object>.Fail(
                InfraAgentRuntimeProfileErrorCodes.ProfileNotFound,
                "运行配置不存在"));
        }
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    [HttpPost("{id}/test")]
    public async Task<IActionResult> Test(string id, CancellationToken ct)
    {
        try
        {
            var result = await _service.TestAsync(id, ct);
            return Ok(ApiResponse<object>.Ok(new { result }));
        }
        catch (InfraAgentRuntimeProfileException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }
}
