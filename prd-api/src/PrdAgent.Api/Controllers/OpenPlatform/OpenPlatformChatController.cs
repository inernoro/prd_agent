using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.OpenPlatform;

/// <summary>
/// 开放平台 Chat Completion 控制器
/// 支持两种模式：
/// 1. model=prdagent -> PRD 问答（需要 groupId）
/// 2. model=其他 -> LLM 代理（直接转发到主模型）
/// </summary>
[ApiController]
[Route("api/v1/open-platform/v1")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class OpenPlatformChatController : ControllerBase
{
    private readonly IChatService _chatService;
    private readonly ISessionService _sessionService;
    private readonly IGroupService _groupService;
    private readonly IOpenPlatformService _openPlatformService;
    private readonly ILLMClient _llmClient;
    private readonly IIdGenerator _idGenerator;
    private readonly ILogger<OpenPlatformChatController> _logger;

    public OpenPlatformChatController(
        IChatService chatService,
        ISessionService sessionService,
        IGroupService groupService,
        IOpenPlatformService openPlatformService,
        ILLMClient llmClient,
        IIdGenerator idGenerator,
        ILogger<OpenPlatformChatController> logger)
    {
        _chatService = chatService;
        _sessionService = sessionService;
        _groupService = groupService;
        _openPlatformService = openPlatformService;
        _llmClient = llmClient;
        _idGenerator = idGenerator;
        _logger = logger;
    }

    /// <summary>
    /// 获取可用模型列表（兼容 OpenAI）
    /// </summary>
    [HttpGet("models")]
    [AllowAnonymous]
    public async Task<IActionResult> GetModels()
    {
        try
        {
            // 返回固定的模型列表（开放平台只支持 prdagent 模型）
            var models = new[]
            {
                new
                {
                    id = "prdagent",
                    @object = "model",
                    created = 1704067200, // 2024-01-01 00:00:00 UTC
                    owned_by = "prdagent",
                    permission = new object[] { },
                    root = "prdagent",
                    parent = (string?)null
                }
            };

            var response = new
            {
                @object = "list",
                data = models
            };

            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting models list");
            return StatusCode(500, new { error = new { message = "Internal server error", type = "internal_error" } });
        }
    }

    /// <summary>
    /// Chat Completion 接口（兼容 OpenAI）- POST 方式
    /// </summary>
    [HttpPost("chat/completions")]
    [Produces("text/event-stream")]
    public async Task ChatCompletionsPost(
        [FromBody] ChatCompletionRequest request,
        CancellationToken cancellationToken)
    {
        await ChatCompletionsInternal(request, cancellationToken);
    }

    /// <summary>
    /// Chat Completion 接口（兼容 OpenAI）- GET 方式
    /// 支持两种方式：
    /// 1. 查询参数: ?message=xxx&model=prdagent&groupId=xxx
    /// 2. Body (非标准但兼容): 与 POST 相同的 JSON body
    /// </summary>
    [HttpGet("chat/completions")]
    [Produces("text/event-stream")]
    public async Task ChatCompletionsGet(
        [FromQuery] string? model,
        [FromQuery] string? message,
        [FromQuery] string? groupId,
        [FromQuery] bool stream = true,
        CancellationToken cancellationToken = default)
    {
        ChatCompletionRequest request;
        
        // 尝试从 Body 读取（虽然不符合 HTTP 标准，但有些客户端会这样做）
        if (Request.ContentLength > 0 && Request.ContentType?.Contains("application/json") == true)
        {
            try
            {
                request = await JsonSerializer.DeserializeAsync<ChatCompletionRequest>(Request.Body, cancellationToken: cancellationToken)
                    ?? new ChatCompletionRequest();
            }
            catch
            {
                // Body 解析失败，回退到查询参数
                request = new ChatCompletionRequest
                {
                    Model = model,
                    GroupId = groupId,
                    Stream = stream,
                    Messages = string.IsNullOrWhiteSpace(message) 
                        ? new List<ChatMessage>() 
                        : new List<ChatMessage> 
                        { 
                            new ChatMessage { Role = "user", Content = message } 
                        }
                };
            }
        }
        else
        {
            // 从查询参数构建请求
            request = new ChatCompletionRequest
            {
                Model = model,
                GroupId = groupId,
                Stream = stream,
                Messages = string.IsNullOrWhiteSpace(message) 
                    ? new List<ChatMessage>() 
                    : new List<ChatMessage> 
                    { 
                        new ChatMessage { Role = "user", Content = message } 
                    }
            };
        }

        await ChatCompletionsInternal(request, cancellationToken);
    }

    /// <summary>
    /// Chat Completion 内部实现（POST 和 GET 共用）
    /// </summary>
    private async Task ChatCompletionsInternal(
        ChatCompletionRequest request,
        CancellationToken cancellationToken)
    {
        var sw = Stopwatch.StartNew();
        var requestId = Activity.Current?.Id ?? Guid.NewGuid().ToString("N")[..8];
        var startedAt = DateTime.UtcNow;

        // 从 Claims 获取应用信息
        var appId = User.FindFirst("appId")?.Value;
        var boundUserId = User.FindFirst("boundUserId")?.Value;
        var boundGroupId = User.FindFirst("boundGroupId")?.Value;

        if (string.IsNullOrWhiteSpace(appId) || string.IsNullOrWhiteSpace(boundUserId))
        {
            Response.StatusCode = 401;
            var errorResponse = JsonSerializer.Serialize(new { error = new { message = "Invalid API Key", type = "invalid_request_error" } });
            await Response.WriteAsync(errorResponse);
            await LogRequestAsync(appId ?? "unknown", requestId, startedAt, 401, "UNAUTHORIZED", boundUserId, null, null, sw.ElapsedMilliseconds, responseBody: errorResponse);
            return;
        }

        // 获取应用配置
        var app = await _openPlatformService.GetAppByIdAsync(appId);
        if (app == null || !app.IsActive)
        {
            Response.StatusCode = 401;
            var errorResponse = JsonSerializer.Serialize(new { error = new { message = "Invalid or inactive API Key", type = "invalid_request_error" } });
            await Response.WriteAsync(errorResponse);
            await LogRequestAsync(appId, requestId, startedAt, 401, "UNAUTHORIZED", boundUserId, null, null, sw.ElapsedMilliseconds, responseBody: errorResponse);
            return;
        }

        // 验证请求
        if (request.Messages == null || request.Messages.Count == 0)
        {
            Response.StatusCode = 400;
            var errorResponse = JsonSerializer.Serialize(new { error = new { message = "Messages cannot be empty", type = "invalid_request_error" } });
            await Response.WriteAsync(errorResponse);
            await LogRequestAsync(appId, requestId, startedAt, 400, "INVALID_FORMAT", boundUserId, null, null, sw.ElapsedMilliseconds, responseBody: errorResponse);
            return;
        }

        // 更新应用使用统计
        await _openPlatformService.UpdateAppUsageAsync(appId);

        // 根据 IgnoreUserSystemPrompt 配置过滤外部 system 消息
        if (app.IgnoreUserSystemPrompt && request.Messages != null)
        {
            request.Messages = request.Messages.Where(m => m.Role?.ToLowerInvariant() != "system").ToList();
        }

        // 根据 model 名称判断模式
        var modelName = (request.Model ?? "prdagent").ToLowerInvariant();
        var isPrdAgentMode = modelName == "prdagent";

        if (isPrdAgentMode)
        {
            // PRD 问答模式
            await HandlePrdAgentMode(request, appId, boundUserId, boundGroupId, requestId, startedAt, sw, cancellationToken);
        }
        else
        {
            // LLM 代理模式
            await HandleLlmProxyMode(request, appId, boundUserId, boundGroupId, requestId, startedAt, sw, cancellationToken);
        }
    }

    /// <summary>
    /// PRD 问答模式
    /// </summary>
    private async Task HandlePrdAgentMode(
        ChatCompletionRequest request,
        string appId,
        string boundUserId,
        string? boundGroupId,
        string requestId,
        DateTime startedAt,
        Stopwatch sw,
        CancellationToken cancellationToken)
    {
        // 确定使用的群组
        string? targetGroupId = null;
        if (!string.IsNullOrWhiteSpace(request.GroupId))
        {
            // 请求指定了群组
            if (!string.IsNullOrWhiteSpace(boundGroupId))
            {
                // 应用绑定了群组，必须匹配
                if (request.GroupId != boundGroupId)
                {
                    Response.StatusCode = 403;
                    var errorResponse = JsonSerializer.Serialize(new { error = new { message = "Access to this group is denied", type = "permission_denied" } });
                    await Response.WriteAsync(errorResponse);
                    await LogRequestAsync(appId, requestId, startedAt, 403, "PERMISSION_DENIED", boundUserId, request.GroupId, null, sw.ElapsedMilliseconds, responseBody: errorResponse);
                    return;
                }
                targetGroupId = boundGroupId;
            }
            else
            {
                // 应用未绑定群组，检查用户是否为群组成员
                var isMember = await _groupService.IsMemberAsync(request.GroupId, boundUserId);
                if (!isMember)
                {
                    Response.StatusCode = 403;
                    var errorResponse = JsonSerializer.Serialize(new { error = new { message = "User is not a member of this group", type = "permission_denied" } });
                    await Response.WriteAsync(errorResponse);
                    await LogRequestAsync(appId, requestId, startedAt, 403, "PERMISSION_DENIED", boundUserId, request.GroupId, null, sw.ElapsedMilliseconds, responseBody: errorResponse);
                    return;
                }
                targetGroupId = request.GroupId;
            }
        }
        else
        {
            // 请求未指定群组
            if (!string.IsNullOrWhiteSpace(boundGroupId))
            {
                // 应用绑定了群组，使用绑定的群组
                targetGroupId = boundGroupId;
            }
            else
            {
                // 应用未绑定群组，需要用户指定
                Response.StatusCode = 400;
                var errorResponse = JsonSerializer.Serialize(new { error = new { message = "groupId is required for prdagent model", type = "invalid_request_error" } });
                await Response.WriteAsync(errorResponse);
                await LogRequestAsync(appId, requestId, startedAt, 400, "INVALID_FORMAT", boundUserId, null, null, sw.ElapsedMilliseconds, responseBody: errorResponse);
                return;
            }
        }

        // 获取群组信息
        var group = await _groupService.GetByIdAsync(targetGroupId);
        if (group == null || string.IsNullOrWhiteSpace(group.PrdDocumentId))
        {
            Response.StatusCode = 404;
            var errorResponse = JsonSerializer.Serialize(new { error = new { message = "Group or PRD document not found", type = "not_found" } });
            await Response.WriteAsync(errorResponse);
            await LogRequestAsync(appId, requestId, startedAt, 404, "GROUP_NOT_FOUND", boundUserId, targetGroupId, null, sw.ElapsedMilliseconds, responseBody: errorResponse);
            return;
        }

        // 创建会话
        var session = await _sessionService.CreateAsync(group.PrdDocumentId, targetGroupId);
        var sessionId = session.SessionId;

        // 提取最后一条用户消息
        var lastUserMessage = request.Messages?.LastOrDefault(m => m.Role == "user");
        if (lastUserMessage == null || string.IsNullOrWhiteSpace(lastUserMessage.Content))
        {
            Response.StatusCode = 400;
            var errorResponse = JsonSerializer.Serialize(new { error = new { message = "No user message found", type = "invalid_request_error" } });
            await Response.WriteAsync(errorResponse);
            await LogRequestAsync(appId, requestId, startedAt, 400, "INVALID_FORMAT", boundUserId, targetGroupId, sessionId, sw.ElapsedMilliseconds, responseBody: errorResponse);
            return;
        }

        // 设置 SSE 响应头
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var chatId = $"chatcmpl-{Guid.NewGuid():N}";
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var modelName = "prdagent";

        int? inputTokens = null;
        int? outputTokens = null;
        string? errorCode = null;

        try
        {
            var isFirstChunk = true;

            await foreach (var ev in _chatService.SendMessageAsync(
                sessionId,
                lastUserMessage.Content,
                resendOfMessageId: null,
                promptKey: null,
                userId: boundUserId,
                attachmentIds: null,
                cancellationToken: cancellationToken))
            {
                if (ev.Type == "error")
                {
                    errorCode = ev.ErrorCode;
                    var errorChunk = new
                    {
                        id = chatId,
                        @object = "chat.completion.chunk",
                        created,
                        model = modelName,
                        choices = new[]
                        {
                            new
                            {
                                index = 0,
                                delta = new { },
                                finish_reason = "error"
                            }
                        },
                        error = new
                        {
                            code = ev.ErrorCode,
                            message = ev.ErrorMessage
                        }
                    };
                    await WriteSSEAsync(errorChunk, cancellationToken);
                    break;
                }

                if (ev.Type == "blockDelta" && !string.IsNullOrEmpty(ev.Content))
                {
                    if (isFirstChunk)
                    {
                        // 先发送 role
                        var roleChunk = new
                        {
                            id = chatId,
                            @object = "chat.completion.chunk",
                            created,
                            model = modelName,
                            choices = new[]
                            {
                                new
                                {
                                    index = 0,
                                    delta = new { role = "assistant" },
                                    finish_reason = (string?)null
                                }
                            }
                        };
                        await WriteSSEAsync(roleChunk, cancellationToken);
                        isFirstChunk = false;
                    }

                    // 发送内容
                    var contentChunk = new
                    {
                        id = chatId,
                        @object = "chat.completion.chunk",
                        created,
                        model = modelName,
                        choices = new[]
                        {
                            new
                            {
                                index = 0,
                                delta = new { content = ev.Content },
                                finish_reason = (string?)null
                            }
                        }
                    };
                    await WriteSSEAsync(contentChunk, cancellationToken);
                }

                if (ev.Type == "done")
                {
                    inputTokens = ev.TokenUsage?.Input;
                    outputTokens = ev.TokenUsage?.Output;

                    // 发送完成
                    var doneChunk = new
                    {
                        id = chatId,
                        @object = "chat.completion.chunk",
                        created,
                        model = modelName,
                        choices = new[]
                        {
                            new
                            {
                                index = 0,
                                delta = new { },
                                finish_reason = "stop"
                            }
                        },
                        usage = new
                        {
                            prompt_tokens = inputTokens ?? 0,
                            completion_tokens = outputTokens ?? 0,
                            total_tokens = (inputTokens ?? 0) + (outputTokens ?? 0)
                        }
                    };
                    await WriteSSEAsync(doneChunk, cancellationToken);
                    await Response.WriteAsync("data: [DONE]\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    break;
                }
            }

            // 记录日志
            await LogRequestAsync(appId, requestId, startedAt, 200, errorCode, boundUserId, targetGroupId, sessionId, sw.ElapsedMilliseconds, inputTokens, outputTokens);
        }
        catch (OperationCanceledException)
        {
            // 客户端取消
            await LogRequestAsync(appId, requestId, startedAt, 499, "CLIENT_CANCELLED", boundUserId, targetGroupId, sessionId, sw.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in OpenPlatform PRD Agent mode for appId={AppId}", appId);
            await LogRequestAsync(appId, requestId, startedAt, 500, "INTERNAL_ERROR", boundUserId, targetGroupId, sessionId, sw.ElapsedMilliseconds);
        }
    }

    /// <summary>
    /// LLM 代理模式 - 直接转发到主模型
    /// </summary>
    private async Task HandleLlmProxyMode(
        ChatCompletionRequest request,
        string appId,
        string boundUserId,
        string? boundGroupId,
        string requestId,
        DateTime startedAt,
        Stopwatch sw,
        CancellationToken cancellationToken)
    {
        // 设置 SSE 响应头
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var chatId = $"chatcmpl-{Guid.NewGuid():N}";
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var modelName = request.Model ?? "master";

        int? inputTokens = null;
        int? outputTokens = null;
        string? errorCode = null;

        try
        {
            // 转换消息格式
            var llmMessages = request.Messages?.Select(m => new LLMMessage
            {
                Role = m.Role,
                Content = m.Content
            }).ToList() ?? new List<LLMMessage>();

            // 使用简单的系统提示
            var systemPrompt = "You are a helpful AI assistant.";

            var isFirstChunk = true;

            // 调用主模型
            await foreach (var chunk in _llmClient.StreamGenerateAsync(
                systemPrompt,
                llmMessages,
                cancellationToken))
            {
                if (chunk.Type == "error")
                {
                    errorCode = "LLM_ERROR";
                    var errorChunk = new
                    {
                        id = chatId,
                        @object = "chat.completion.chunk",
                        created,
                        model = modelName,
                        choices = new[]
                        {
                            new
                            {
                                index = 0,
                                delta = new { },
                                finish_reason = "error"
                            }
                        },
                        error = new
                        {
                            code = "LLM_ERROR",
                            message = chunk.ErrorMessage ?? "LLM request failed"
                        }
                    };
                    await WriteSSEAsync(errorChunk, cancellationToken);
                    break;
                }

                if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (isFirstChunk)
                    {
                        // 先发送 role
                        var roleChunk = new
                        {
                            id = chatId,
                            @object = "chat.completion.chunk",
                            created,
                            model = modelName,
                            choices = new[]
                            {
                                new
                                {
                                    index = 0,
                                    delta = new { role = "assistant" },
                                    finish_reason = (string?)null
                                }
                            }
                        };
                        await WriteSSEAsync(roleChunk, cancellationToken);
                        isFirstChunk = false;
                    }

                    // 发送内容
                    var contentChunk = new
                    {
                        id = chatId,
                        @object = "chat.completion.chunk",
                        created,
                        model = modelName,
                        choices = new[]
                        {
                            new
                            {
                                index = 0,
                                delta = new { content = chunk.Content },
                                finish_reason = (string?)null
                            }
                        }
                    };
                    await WriteSSEAsync(contentChunk, cancellationToken);
                }

                if (chunk.Type == "done")
                {
                    inputTokens = chunk.InputTokens;
                    outputTokens = chunk.OutputTokens;

                    // 发送完成
                    var doneChunk = new
                    {
                        id = chatId,
                        @object = "chat.completion.chunk",
                        created,
                        model = modelName,
                        choices = new[]
                        {
                            new
                            {
                                index = 0,
                                delta = new { },
                                finish_reason = "stop"
                            }
                        },
                        usage = new
                        {
                            prompt_tokens = inputTokens ?? 0,
                            completion_tokens = outputTokens ?? 0,
                            total_tokens = (inputTokens ?? 0) + (outputTokens ?? 0)
                        }
                    };
                    await WriteSSEAsync(doneChunk, cancellationToken);
                    await Response.WriteAsync("data: [DONE]\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    break;
                }
            }

            // 记录日志
            await LogRequestAsync(appId, requestId, startedAt, 200, errorCode, boundUserId, boundGroupId, null, sw.ElapsedMilliseconds, inputTokens, outputTokens);
        }
        catch (OperationCanceledException)
        {
            // 客户端取消
            await LogRequestAsync(appId, requestId, startedAt, 499, "CLIENT_CANCELLED", boundUserId, boundGroupId, null, sw.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in OpenPlatform LLM Proxy mode for appId={AppId}", appId);
            await LogRequestAsync(appId, requestId, startedAt, 500, "INTERNAL_ERROR", boundUserId, boundGroupId, null, sw.ElapsedMilliseconds);
        }
    }

    private async Task WriteSSEAsync(object data, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower });
        await Response.WriteAsync($"data: {json}\n\n", cancellationToken);
        await Response.Body.FlushAsync(cancellationToken);
    }

    private async Task LogRequestAsync(
        string appId,
        string requestId,
        DateTime startedAt,
        int statusCode,
        string? errorCode,
        string? userId,
        string? groupId,
        string? sessionId,
        long durationMs,
        int? inputTokens = null,
        int? outputTokens = null,
        string? responseBody = null)
    {
        try
        {
            var path = Request.Path.Value ?? "";
            var query = Request.QueryString.HasValue ? Request.QueryString.Value : null;
            var clientIp = HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
            var userAgent = Request.Headers.UserAgent.ToString();
            var clientType = Request.Headers["X-Client"].ToString();
            if (string.IsNullOrWhiteSpace(clientType)) clientType = "unknown";
            var clientId = Request.Headers["X-Client-Id"].ToString();
            if (string.IsNullOrWhiteSpace(clientId)) clientId = null;
            
            var scheme = Request.Scheme;
            var host = Request.Host.HasValue ? Request.Host.Value : "";
            var absoluteUrl = !string.IsNullOrWhiteSpace(host) 
                ? $"{scheme}://{host}{path}{(query ?? "")}" 
                : path + (query ?? "");
            
            var log = new OpenPlatformRequestLog
            {
                Id = await _idGenerator.GenerateIdAsync("openplatformlog"),
                AppId = appId,
                RequestId = requestId,
                StartedAt = startedAt,
                EndedAt = DateTime.UtcNow,
                DurationMs = durationMs,
                Method = "POST",
                Path = path,
                Query = query,
                AbsoluteUrl = absoluteUrl,
                RequestBodyRedacted = "[redacted]",
                StatusCode = statusCode,
                ErrorCode = errorCode,
                UserId = userId,
                GroupId = groupId,
                SessionId = sessionId,
                InputTokens = inputTokens,
                OutputTokens = outputTokens,
                ClientIp = clientIp,
                UserAgent = string.IsNullOrWhiteSpace(userAgent) ? null : userAgent,
                ClientType = clientType,
                ClientId = clientId,
                ResponseBody = responseBody,
                ResponseBodyTruncated = !string.IsNullOrEmpty(responseBody) && responseBody.Length >= 64 * 1024
            };

            await _openPlatformService.LogRequestAsync(log);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to log OpenPlatform request");
        }
    }
}

/// <summary>
/// Chat Completion 请求
/// </summary>
public class ChatCompletionRequest
{
    public string? Model { get; set; }
    public List<ChatMessage>? Messages { get; set; }
    public bool Stream { get; set; } = true;
    public double? Temperature { get; set; }
    public string? GroupId { get; set; }
}

/// <summary>
/// Chat 消息
/// </summary>
public class ChatMessage
{
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
}
