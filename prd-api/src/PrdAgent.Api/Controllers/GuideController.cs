using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Json;
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
    private readonly IGuideProgressRepository _progressRepository;
    private readonly ISessionService _sessionService;
    private readonly ILogger<GuideController> _logger;

    public GuideController(
        IGuideService guideService,
        IGuideProgressRepository progressRepository,
        ISessionService sessionService,
        ILogger<GuideController> logger)
    {
        _guideService = guideService;
        _progressRepository = progressRepository;
        _sessionService = sessionService;
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

        var userId = User.FindFirst("sub")?.Value ?? "anonymous";

        try
        {
            // 初始化进度记录
            var session = await _sessionService.GetByIdAsync(sessionId);
            if (session != null)
            {
                var progress = new GuideProgress
                {
                    SessionId = sessionId,
                    UserId = userId,
                    DocumentId = session.DocumentId,
                    Role = request.Role,
                    CurrentStep = 1,
                    TotalSteps = 6,
                    StartedAt = DateTime.UtcNow
                };
                await _progressRepository.SaveProgressAsync(progress);
            }

            await foreach (var streamEvent in _guideService.StartGuideAsync(
                sessionId,
                request.Role,
                cancellationToken))
            {
                var eventData = JsonSerializer.Serialize(streamEvent, AppJsonContext.Default.GuideStreamEvent);

                await Response.WriteAsync($"event: guide\n", cancellationToken);
                await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);

                // 更新进度
                if (streamEvent.Type == "stepDone" && streamEvent.Step.HasValue)
                {
                    var progress = await _progressRepository.GetProgressAsync(sessionId);
                    if (progress != null)
                    {
                        if (!progress.CompletedSteps.Contains(streamEvent.Step.Value))
                        {
                            progress.CompletedSteps.Add(streamEvent.Step.Value);
                        }
                        progress.CurrentStep = streamEvent.Step.Value;
                        await _progressRepository.SaveProgressAsync(progress);
                    }
                }

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
    /// 恢复引导进度
    /// </summary>
    [HttpPost("resume")]
    [ProducesResponseType(typeof(ApiResponse<GuideProgressResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> ResumeGuide(string sessionId)
    {
        var progress = await _progressRepository.GetProgressAsync(sessionId);
        
        if (progress == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                "PROGRESS_NOT_FOUND",
                "未找到引导进度，请重新开始"));
        }

        // 恢复会话状态
        try
        {
            await _sessionService.SwitchModeAsync(sessionId, InteractionMode.Guided);
            await _sessionService.SwitchRoleAsync(sessionId, progress.Role);
        }
        catch (KeyNotFoundException)
        {
            // 会话已过期，但进度存在
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.SESSION_EXPIRED,
                "会话已过期，请重新上传文档"));
        }

        var response = new GuideProgressResponse
        {
            SessionId = progress.SessionId,
            Role = progress.Role,
            CurrentStep = progress.CurrentStep,
            TotalSteps = progress.TotalSteps,
            CompletedSteps = progress.CompletedSteps,
            StartedAt = progress.StartedAt,
            LastUpdatedAt = progress.LastUpdatedAt,
            IsCompleted = progress.IsCompleted
        };

        return Ok(ApiResponse<GuideProgressResponse>.Ok(response));
    }

    /// <summary>
    /// 获取当前进度
    /// </summary>
    [HttpGet("progress")]
    [ProducesResponseType(typeof(ApiResponse<GuideProgressResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetProgress(string sessionId)
    {
        var progress = await _progressRepository.GetProgressAsync(sessionId);
        
        if (progress == null)
        {
            return NotFound(ApiResponse<object>.Fail(
                "PROGRESS_NOT_FOUND",
                "未找到引导进度"));
        }

        var response = new GuideProgressResponse
        {
            SessionId = progress.SessionId,
            Role = progress.Role,
            CurrentStep = progress.CurrentStep,
            TotalSteps = progress.TotalSteps,
            CompletedSteps = progress.CompletedSteps,
            StartedAt = progress.StartedAt,
            LastUpdatedAt = progress.LastUpdatedAt,
            IsCompleted = progress.IsCompleted
        };

        return Ok(ApiResponse<GuideProgressResponse>.Ok(response));
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
            
            // 更新进度
            var progress = await _progressRepository.GetProgressAsync(sessionId);
            if (progress != null)
            {
                progress.CurrentStep = result.CurrentStep;
                progress.IsCompleted = result.Status == GuideStatus.Completed;
                await _progressRepository.SaveProgressAsync(progress);
            }

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
            var eventData = JsonSerializer.Serialize(streamEvent, AppJsonContext.Default.GuideStreamEvent);

            await Response.WriteAsync($"event: guide\n", cancellationToken);
            await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);

            // 更新进度
            if (streamEvent.Type == "stepDone" && streamEvent.Step.HasValue)
            {
                var progress = await _progressRepository.GetProgressAsync(sessionId);
                if (progress != null)
                {
                    if (!progress.CompletedSteps.Contains(streamEvent.Step.Value))
                    {
                        progress.CompletedSteps.Add(streamEvent.Step.Value);
                    }
                    progress.CurrentStep = streamEvent.Step.Value;
                    await _progressRepository.SaveProgressAsync(progress);
                }
            }

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

/// <summary>
/// 引导进度响应
/// </summary>
public class GuideProgressResponse
{
    public string SessionId { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public int CurrentStep { get; set; }
    public int TotalSteps { get; set; }
    public List<int> CompletedSteps { get; set; } = new();
    public DateTime StartedAt { get; set; }
    public DateTime LastUpdatedAt { get; set; }
    public bool IsCompleted { get; set; }
}
