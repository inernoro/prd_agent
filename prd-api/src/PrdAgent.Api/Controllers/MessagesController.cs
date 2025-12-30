using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Json;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 消息控制器（SSE流式响应）
/// </summary>
[ApiController]
[Route("api/v1/sessions/{sessionId}/messages")]
public class MessagesController : ControllerBase
{
    private readonly IChatService _chatService;
    private readonly IMessageRepository _messageRepository;
    private readonly ILogger<MessagesController> _logger;

    public MessagesController(
        IChatService chatService,
        IMessageRepository messageRepository,
        ILogger<MessagesController> logger)
    {
        _chatService = chatService;
        _messageRepository = messageRepository;
        _logger = logger;
    }

    /// <summary>
    /// 发送消息（SSE流式响应）
    /// </summary>
    [HttpPost]
    [Produces("text/event-stream")]
    public async Task SendMessage(
        string sessionId,
        [FromBody] SendMessageRequest request,
        CancellationToken cancellationToken)
    {
        // 验证请求参数
        var (isValid, errorMessage) = request.Validate();
        if (!isValid)
        {
            Response.ContentType = "text/event-stream";
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INVALID_FORMAT,
                ErrorMessage = errorMessage!
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);
            await Response.WriteAsync($"event: error\ndata: {errorData}\n\n", cancellationToken);
            return;
        }

        // 设置SSE响应头
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        // 获取用户ID（如果已认证）
        var userId = User.FindFirst("sub")?.Value;

        try
        {
            await foreach (var streamEvent in _chatService.SendMessageAsync(
                sessionId,
                request.Content,
                request.PromptKey,
                userId,
                request.AttachmentIds,
                cancellationToken))
            {
                var eventData = JsonSerializer.Serialize(streamEvent, AppJsonContext.Default.ChatStreamEvent);

                await Response.WriteAsync($"event: message\n", cancellationToken);
                await Response.WriteAsync($"data: {eventData}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);

                // 如果是错误或完成，结束流
                if (streamEvent.Type is "error" or "done")
                {
                    break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("SSE connection cancelled for session {SessionId}", sessionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in SSE stream for session {SessionId}", sessionId);
            
            var errorEvent = new StreamErrorEvent
            {
                Type = "error",
                ErrorCode = ErrorCodes.INTERNAL_ERROR,
                ErrorMessage = "服务器内部错误"
            };
            var errorData = JsonSerializer.Serialize(errorEvent, AppJsonContext.Default.StreamErrorEvent);

            await Response.WriteAsync($"event: error\n", cancellationToken);
            await Response.WriteAsync($"data: {errorData}\n\n", cancellationToken);
            await Response.Body.FlushAsync(cancellationToken);
        }
    }

    /// <summary>
    /// 获取消息历史
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<List<MessageResponse>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetHistory(
        string sessionId,
        [FromQuery] int limit = 50,
        [FromQuery] DateTime? before = null)
    {
        // 历史回放：走 MongoDB 分页（持久化），而不是 cache（cache 仅用于 LLM 上下文拼接）
        var messages = await _messageRepository.FindBySessionAsync(sessionId, before, limit);
        
        var response = messages.Select(m => new MessageResponse
        {
            Id = m.Id,
            Role = m.Role,
            Content = m.Content,
            ViewRole = m.ViewRole,
            Timestamp = m.Timestamp,
            TokenUsage = m.TokenUsage
        }).ToList();

        return Ok(ApiResponse<List<MessageResponse>>.Ok(response));
    }
}

/// <summary>
/// 消息响应
/// </summary>
public class MessageResponse
{
    public string Id { get; set; } = string.Empty;
    public MessageRole Role { get; set; }
    public string Content { get; set; } = string.Empty;
    public UserRole? ViewRole { get; set; }
    public DateTime Timestamp { get; set; }
    public TokenUsage? TokenUsage { get; set; }
}




