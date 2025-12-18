using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Json;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// PRD 预览页“本章提问”（SSE）
/// </summary>
[ApiController]
[Route("api/v1/sessions/{sessionId}/preview-ask")]
public class PreviewAskController : ControllerBase
{
    private readonly IPreviewAskService _previewAskService;
    private readonly ILogger<PreviewAskController> _logger;

    public PreviewAskController(IPreviewAskService previewAskService, ILogger<PreviewAskController> logger)
    {
        _previewAskService = previewAskService;
        _logger = logger;
    }

    [HttpPost]
    [Produces("text/event-stream")]
    public async Task Ask(
        string sessionId,
        [FromBody] PreviewAskRequest request,
        CancellationToken cancellationToken)
    {
        var (ok, err) = request.Validate();
        if (!ok)
        {
            Response.ContentType = "text/event-stream";
            var errorEvent = new { type = "error", errorCode = "INVALID_FORMAT", errorMessage = err };
            var errorData = JsonSerializer.Serialize(errorEvent);
            await Response.WriteAsync($"event: previewAsk\n", cancellationToken);
            await Response.WriteAsync($"data: {errorData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
            return;
        }

        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        try
        {
            await foreach (var streamEvent in _previewAskService.AskInSectionAsync(
                               sessionId,
                               request.HeadingId,
                               request.HeadingTitle,
                               request.Question,
                               cancellationToken))
            {
                var eventData = JsonSerializer.Serialize(streamEvent, AppJsonContext.Default.PreviewAskStreamEvent);
                await Response.WriteAsync($"event: previewAsk\n", cancellationToken);
                await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);

                if (streamEvent.Type is "error" or "done")
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // 客户端取消：不视为异常
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in preview-ask SSE stream for session {SessionId}", sessionId);
        }
    }
}

