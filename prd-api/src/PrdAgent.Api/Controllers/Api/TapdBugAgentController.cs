using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

[ApiController]
[Route("api/tapd-bug-agent")]
[Authorize]
[AdminController(TapdBugAgentService.AppKey, AdminPermissionCatalog.TapdBugAgentUse)]
public class TapdBugAgentController : ControllerBase
{
    private readonly TapdBugAgentService _service;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<TapdBugAgentController> _logger;

    public TapdBugAgentController(
        TapdBugAgentService service,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<TapdBugAgentController> logger)
    {
        _service = service;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    [HttpPost("preview/stream")]
    public async Task PreviewStream([FromBody] TapdBugPreviewRequest request)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";

        var userId = this.GetRequiredUserId();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: request.NaturalText?.Length,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.TapdBugAgent.Extract.Chat));

        try
        {
            await WriteSseEvent("stage", new { stage = "started", message = "已开始整理 TAPD 缺陷草稿" });
            await _service.StreamPreviewAsync(request, WriteSseEvent, CancellationToken.None);
            await WriteSseEvent("done", new { });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[tapd-bug-agent] preview stream failed");
            await WriteSseEvent("error", new { message = ex.Message });
            await WriteSseEvent("done", new { });
        }
    }

    [HttpPost("submit")]
    public async Task<IActionResult> Submit([FromBody] TapdBugSubmitRequest request)
    {
        try
        {
            this.GetRequiredUserId();
            var result = await _service.SubmitAsync(request);
            if (!result.Success)
            {
                return BadRequest(ApiResponse<object>.Fail("TAPD_SUBMIT_FAILED", result.Error ?? "TAPD 提交失败"));
            }

            return Ok(ApiResponse<object>.Ok(new { result }));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail("TAPD_AUTH_INVALID", ex.Message));
        }
    }

    private async Task WriteSseEvent(string eventName, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            await Response.WriteAsync($"event: {eventName}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }
}
