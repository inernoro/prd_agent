using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// MAP 基础设施 Agent 工作台会话接口。
/// P1 只提供 MAP 侧会话骨架，CDS 容器生命周期后续接入。
/// </summary>
[ApiController]
[Route("api/infra-agent-sessions")]
[Authorize]
public class InfraAgentSessionsController : ControllerBase
{
    private readonly IInfraAgentSessionService _service;

    public InfraAgentSessionsController(IInfraAgentSessionService service)
    {
        _service = service;
    }

    [HttpGet]
    public async Task<IActionResult> List([FromQuery] int limit, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var items = await _service.ListAsync(userId, limit, ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateInfraAgentSessionRequest req, CancellationToken ct)
    {
        if (req == null)
        {
            return BadRequest(ApiResponse<object>.Fail(
                InfraAgentSessionErrorCodes.ConnectionIdRequired,
                "请求体不能为空"));
        }

        var userId = this.GetRequiredUserId();
        try
        {
            var item = await _service.CreateAsync(userId, req, ct);
            return StatusCode(StatusCodes.Status201Created, ApiResponse<object>.Ok(new { item }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _service.GetAsync(userId, id, ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                InfraAgentSessionErrorCodes.SessionNotFound,
                "会话不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { item }));
    }

    [HttpPost("{id}/stop")]
    public async Task<IActionResult> Stop(string id, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        var item = await _service.StopAsync(userId, id, ct);
        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                InfraAgentSessionErrorCodes.SessionNotFound,
                "会话不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { item }));
    }

    [HttpGet("{id}/events")]
    public async Task<IActionResult> ListEvents(
        string id,
        [FromQuery] long afterSeq,
        [FromQuery] int limit,
        CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var items = await _service.ListEventsAsync(userId, id, afterSeq, limit, ct);
            return Ok(ApiResponse<object>.Ok(new { items }));
        }
        catch (InfraAgentSessionException ex)
        {
            return StatusCode(ex.HttpStatus, ApiResponse<object>.Fail(ex.ErrorCode, ex.Message));
        }
    }
}
