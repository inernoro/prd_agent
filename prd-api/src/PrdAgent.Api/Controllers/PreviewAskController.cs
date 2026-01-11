using System.Text.Json;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Json;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// PRD 预览页“本章提问”（SSE）
/// </summary>
[ApiController]
[Route("api/v1/sessions/{sessionId}/preview-ask")]
[Authorize]
public class PreviewAskController : ControllerBase
{
    private readonly IPreviewAskService _previewAskService;
    private readonly ISessionService _sessionService;
    private readonly MongoDbContext _db;
    private readonly ILogger<PreviewAskController> _logger;

    public PreviewAskController(
        IPreviewAskService previewAskService,
        ISessionService sessionService,
        MongoDbContext db,
        ILogger<PreviewAskController> logger)
    {
        _previewAskService = previewAskService;
        _sessionService = sessionService;
        _db = db;
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
            var userId = User.FindFirst("sub")?.Value ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            if (string.IsNullOrWhiteSpace(userId))
            {
                var errorEvent = new { type = "error", errorCode = ErrorCodes.UNAUTHORIZED, errorMessage = "未授权" };
                var errorData = JsonSerializer.Serialize(errorEvent);
                await Response.WriteAsync($"event: previewAsk\n", cancellationToken);
                await Response.WriteAsync($"data: {errorData}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
                return;
            }

            // 群会话：按成员身份决定回答机器人角色；个人会话则回退到 session.CurrentRole（兼容）
            UserRole? answerAsRole = null;
            var session = await _sessionService.GetByIdAsync(sessionId);
            if (session != null && !string.IsNullOrWhiteSpace(session.GroupId))
            {
                var gid = session.GroupId.Trim();
                var member = await _db.GroupMembers.Find(x => x.GroupId == gid && x.UserId == userId).FirstOrDefaultAsync(cancellationToken);
                if (member == null)
                {
                    var errorEvent = new { type = "error", errorCode = ErrorCodes.PERMISSION_DENIED, errorMessage = "您不是该群组成员" };
                    var errorData = JsonSerializer.Serialize(errorEvent);
                    await Response.WriteAsync($"event: previewAsk\n", cancellationToken);
                    await Response.WriteAsync($"data: {errorData}\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    return;
                }
                answerAsRole = member.MemberRole;
            }

            await foreach (var streamEvent in _previewAskService.AskInSectionAsync(
                               sessionId,
                               request.HeadingId,
                               request.HeadingTitle,
                               request.Question,
                               answerAsRole: answerAsRole,
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

