using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 引导讲解控制器
/// </summary>
[ApiController]
[Route("api/v1/sessions/{sessionId}/guide")]
public class GuideController : ControllerBase
{
    private readonly IGuideService _guideService;
    private readonly ILogger<GuideController> _logger;

    public GuideController(
        IGuideService guideService,
        ILogger<GuideController> logger)
    {
        _guideService = guideService;
        _logger = logger;
    }

    /// <summary>
    /// 启动引导讲解（SSE流式响应）
    /// </summary>
    [HttpPost("start")]
    [Produces("text/event-stream")]
    public async Task StartGuide(
        string sessionId,
        [FromBody] StartGuideRequest request,
        CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        try
        {
            await foreach (var streamEvent in _guideService.StartGuideAsync(
                sessionId,
                request.Role,
                cancellationToken))
            {
                var eventData = JsonSerializer.Serialize(streamEvent, new JsonSerializerOptions
                {
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
                });

                await Response.WriteAsync($"event: guide\n", cancellationToken);
                await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);

                if (streamEvent.Type is "error" or "stepDone")
                {
                    break;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in guide stream for session {SessionId}", sessionId);
        }
    }

    /// <summary>
    /// 控制引导进度
    /// </summary>
    [HttpPost("control")]
    [ProducesResponseType(typeof(ApiResponse<GuideControlResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Control(
        string sessionId,
        [FromBody] GuideControlRequest request)
    {
        try
        {
            var result = await _guideService.ControlAsync(sessionId, request.Action, request.Step);
            
            var response = new GuideControlResponse
            {
                CurrentStep = result.CurrentStep,
                TotalSteps = result.TotalSteps,
                Status = result.Status
            };

            return Ok(ApiResponse<GuideControlResponse>.Ok(response));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.SESSION_NOT_FOUND,
                "会话不存在或已过期"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(
                "INVALID_MODE",
                ex.Message));
        }
    }

    /// <summary>
    /// 获取指定步骤内容（SSE流式响应）
    /// </summary>
    [HttpGet("step/{step}")]
    [Produces("text/event-stream")]
    public async Task GetStepContent(
        string sessionId,
        int step,
        CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        await foreach (var streamEvent in _guideService.GetStepContentAsync(
            sessionId,
            step,
            cancellationToken))
        {
            var eventData = JsonSerializer.Serialize(streamEvent, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });

            await Response.WriteAsync($"event: guide\n", cancellationToken);
            await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);

            if (streamEvent.Type is "error" or "stepDone")
            {
                break;
            }
        }
    }

    /// <summary>
    /// 获取引导大纲
    /// </summary>
    [HttpGet("outline")]
    [ProducesResponseType(typeof(ApiResponse<List<OutlineItemResponse>>), StatusCodes.Status200OK)]
    public IActionResult GetOutline([FromQuery] UserRole role = UserRole.PM)
    {
        var outline = _guideService.GetOutline(role);
        
        var response = outline.Select(o => new OutlineItemResponse
        {
            Step = o.Step,
            Title = o.Title
        }).ToList();

        return Ok(ApiResponse<List<OutlineItemResponse>>.Ok(response));
    }
}

/// <summary>
/// 大纲项响应
/// </summary>
public class OutlineItemResponse
{
    public int Step { get; set; }
    public string Title { get; set; } = string.Empty;
}

