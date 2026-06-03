using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authorization;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using AppCallerRegistry = PrdAgent.Core.Models.AppCallerRegistry;

namespace PrdAgent.Api.Controllers.OpenRouter;

/// <summary>
/// OpenRouter 式对外开放网关。
///
/// 外部调用方用标准 OpenAI/OpenRouter 请求方式接入（base_url 指到本服务即可）：
///   - POST /api/v1/chat/completions （流式 SSE + 非流式）
///   - POST /api/v1/images/generations
///   - GET  /api/v1/models
///
/// 鉴权：`sk-ak-*` AgentApiKey（scheme=ApiKey）+ scope `open-router:call`。
///
/// 稳定性核心（见 doc/debt.open-router.md、.claude/rules/compute-then-send + server-authority）：
/// - 每个 Key 的「固定模型 / 小模型池」绑定走 ModelResolver 的 expectedModel 通道。
///   客户端 body 里的 model 字段【不】用于调度（避免外部任意挑模型），仅记录。
/// - 未绑定的 Key → expectedModel=null → 回落到 default:chat / default:image 默认池。
/// - LLM 调用使用 CancellationToken.None：客户端断开不取消服务器任务。
/// </summary>
[ApiController]
public class OpenRouterController : ControllerBase
{
    /// <summary>调用 OpenRouter 网关所需 scope。</summary>
    public const string ScopeCall = "open-router:call";

    private static readonly JsonSerializerOptions SnakeCase = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly MongoDbContext _db;
    private readonly ILogger<OpenRouterController> _logger;

    public OpenRouterController(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        MongoDbContext db,
        ILogger<OpenRouterController> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _db = db;
        _logger = logger;
    }

    // ─────────────────────────── Chat ───────────────────────────

    [HttpPost("~/api/v1/chat/completions")]
    [Authorize(AuthenticationSchemes = "ApiKey")]
    [RequireScope(ScopeCall)]
    public async Task ChatCompletions(CancellationToken httpAborted)
    {
        var sw = Stopwatch.StartNew();
        var requestId = Guid.NewGuid().ToString("N");
        var key = await LoadKeyAsync(httpAborted);

        var body = await ReadBodyAsync(httpAborted);
        if (body == null)
        {
            await WriteJsonErrorAsync(400, "invalid_request_error", "请求体必须是合法 JSON");
            return;
        }

        var requestedModel = ReadString(body, "model");
        var stream = ReadBool(body, "stream");
        var binding = key?.OpenRouterChatBinding;

        // 客户端 model 不参与调度：移除后由 Gateway 注入解析模型，调度只看 Key 绑定。
        body.Remove("model");

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.OpenRouter.Proxy.Chat,
            ModelType = ModelTypes.Chat,
            ExpectedModel = string.IsNullOrWhiteSpace(binding) ? null : binding,
            RequestBody = body,
            Stream = stream,
            IncludeThinking = false,
            TimeoutSeconds = 300
        };

        using var _scope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: key?.OwnerUserId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.OpenRouter.Proxy.Chat));

        if (stream)
            await StreamChatAsync(request, key, requestId, requestedModel, binding, sw);
        else
            await NonStreamChatAsync(request, key, requestId, requestedModel, binding, sw);
    }

    private async Task StreamChatAsync(
        GatewayRequest request, AgentApiKey? key, string requestId,
        string? requestedModel, string? binding, Stopwatch sw)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        var chatId = $"chatcmpl-{Guid.NewGuid():N}";
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var resolvedModel = requestedModel ?? "auto";
        GatewayModelResolution? resolution = null;
        int? promptTokens = null, completionTokens = null;
        string? errorCode = null;
        var isFirst = true;

        try
        {
            // server-authority：用 CancellationToken.None，客户端断开不取消上游
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    resolution = chunk.Resolution;
                    if (!string.IsNullOrWhiteSpace(resolution.ActualModel))
                        resolvedModel = resolution.ActualModel;
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (isFirst)
                    {
                        await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { role = "assistant" }, null));
                        isFirst = false;
                    }
                    await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { content = chunk.Content }, null));
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    errorCode = "LLM_ERROR";
                    await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { }, "error", chunk.Error));
                    break;
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    promptTokens = chunk.TokenUsage?.InputTokens;
                    completionTokens = chunk.TokenUsage?.OutputTokens;
                    var done = new
                    {
                        id = chatId,
                        @object = "chat.completion.chunk",
                        created,
                        model = resolvedModel,
                        choices = new[] { new { index = 0, delta = new { }, finish_reason = chunk.FinishReason ?? "stop" } },
                        usage = new
                        {
                            prompt_tokens = promptTokens ?? 0,
                            completion_tokens = completionTokens ?? 0,
                            total_tokens = (promptTokens ?? 0) + (completionTokens ?? 0)
                        }
                    };
                    await WriteSseAsync(done);
                    await Response.WriteAsync("data: [DONE]\n\n");
                    await Response.Body.FlushAsync();
                    break;
                }
            }

            await LogAsync(key, requestId, "chat", requestedModel, binding, resolution, true,
                errorCode == null ? 200 : 500, errorCode, promptTokens, completionTokens, sw);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenRouter] chat 流式失败 keyId={KeyId}", key?.Id);
            await LogAsync(key, requestId, "chat", requestedModel, binding, resolution, true, 500, "INTERNAL_ERROR", promptTokens, completionTokens, sw);
        }
    }

    private async Task NonStreamChatAsync(
        GatewayRequest request, AgentApiKey? key, string requestId,
        string? requestedModel, string? binding, Stopwatch sw)
    {
        try
        {
            var resp = await _gateway.SendAsync(request, CancellationToken.None);
            var resolvedModel = resp.Resolution?.ActualModel ?? requestedModel ?? "auto";

            if (!resp.Success)
            {
                await LogAsync(key, requestId, "chat", requestedModel, binding, resp.Resolution, false,
                    resp.StatusCode > 0 ? resp.StatusCode : 502, resp.ErrorCode ?? "LLM_ERROR", null, null, sw);
                await WriteJsonErrorAsync(resp.StatusCode > 0 ? resp.StatusCode : 502, "api_error",
                    resp.ErrorMessage ?? "上游模型调用失败", resp.ErrorCode);
                return;
            }

            var promptTokens = resp.TokenUsage?.InputTokens;
            var completionTokens = resp.TokenUsage?.OutputTokens;
            var completion = new
            {
                id = $"chatcmpl-{Guid.NewGuid():N}",
                @object = "chat.completion",
                created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                model = resolvedModel,
                choices = new[]
                {
                    new
                    {
                        index = 0,
                        message = new { role = "assistant", content = resp.Content ?? string.Empty },
                        finish_reason = "stop"
                    }
                },
                usage = new
                {
                    prompt_tokens = promptTokens ?? 0,
                    completion_tokens = completionTokens ?? 0,
                    total_tokens = (promptTokens ?? 0) + (completionTokens ?? 0)
                }
            };

            Response.ContentType = "application/json";
            await Response.WriteAsync(JsonSerializer.Serialize(completion, SnakeCase));
            await LogAsync(key, requestId, "chat", requestedModel, binding, resp.Resolution, false, 200, null, promptTokens, completionTokens, sw);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenRouter] chat 非流式失败 keyId={KeyId}", key?.Id);
            await LogAsync(key, requestId, "chat", requestedModel, binding, null, false, 500, "INTERNAL_ERROR", null, null, sw);
            await WriteJsonErrorAsync(500, "api_error", "内部错误");
        }
    }

    // ─────────────────────────── Images ───────────────────────────

    [HttpPost("~/api/v1/images/generations")]
    [Authorize(AuthenticationSchemes = "ApiKey")]
    [RequireScope(ScopeCall)]
    public async Task ImageGenerations(CancellationToken httpAborted)
    {
        var sw = Stopwatch.StartNew();
        var requestId = Guid.NewGuid().ToString("N");
        var key = await LoadKeyAsync(httpAborted);

        var body = await ReadBodyAsync(httpAborted);
        if (body == null)
        {
            await WriteJsonErrorAsync(400, "invalid_request_error", "请求体必须是合法 JSON");
            return;
        }

        var requestedModel = ReadString(body, "model");
        var binding = key?.OpenRouterImageBinding;
        body.Remove("model");

        using var _scope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId,
            GroupId: null,
            SessionId: null,
            UserId: key?.OwnerUserId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "generation",
            AppCallerCode: AppCallerRegistry.OpenRouter.Proxy.Generation));

        try
        {
            // compute-then-send：先解析一次，再用 resolution 直发，发送阶段不二次 resolve
            var resolution = await _gateway.ResolveModelAsync(
                AppCallerRegistry.OpenRouter.Proxy.Generation,
                ModelTypes.ImageGen,
                expectedModel: string.IsNullOrWhiteSpace(binding) ? null : binding,
                CancellationToken.None);

            if (!resolution.Success)
            {
                await LogAsync(key, requestId, "image", requestedModel, binding, resolution, false, 502, "MODEL_NOT_FOUND", null, null, sw);
                await WriteJsonErrorAsync(502, "api_error", resolution.ErrorMessage ?? "未找到可用生图模型");
                return;
            }

            var raw = new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.OpenRouter.Proxy.Generation,
                ModelType = ModelTypes.ImageGen,
                EndpointPath = "/v1/images/generations",
                ExpectedModel = resolution.ActualModel,
                RequestBody = body,
                TimeoutSeconds = 600
            };

            var resp = await _gateway.SendRawWithResolutionAsync(raw, resolution, CancellationToken.None);

            Response.ContentType = "application/json";
            Response.StatusCode = resp.Success ? 200 : (resp.StatusCode > 0 ? resp.StatusCode : 502);
            await Response.WriteAsync(resp.Content ?? JsonSerializer.Serialize(new
            {
                error = new { message = resp.ErrorMessage ?? "上游生图失败", type = "api_error", code = resp.ErrorCode }
            }));

            await LogAsync(key, requestId, "image", requestedModel, binding, resolution, false,
                Response.StatusCode, resp.Success ? null : (resp.ErrorCode ?? "LLM_ERROR"), null, null, sw);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenRouter] image 生成失败 keyId={KeyId}", key?.Id);
            await LogAsync(key, requestId, "image", requestedModel, binding, null, false, 500, "INTERNAL_ERROR", null, null, sw);
            await WriteJsonErrorAsync(500, "api_error", "内部错误");
        }
    }

    // ─────────────────────────── Models ───────────────────────────

    [HttpGet("~/api/v1/models")]
    [AllowAnonymous]
    public async Task<IActionResult> GetModels(CancellationToken httpAborted)
    {
        // 匿名可访问：带有效 OpenRouter Key 时返回该 Key 的真实解析模型；
        // 否则返回默认池可用模型（贴近 OpenRouter，比历史 stub 更有用）。
        var key = await TryLoadKeyFromAuthAsync(httpAborted);
        var models = new List<object>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        async Task AddResolvedAsync(string code, string modelType, string? binding)
        {
            try
            {
                var res = await _gateway.ResolveModelAsync(code, modelType,
                    expectedModel: string.IsNullOrWhiteSpace(binding) ? null : binding, CancellationToken.None);
                if (res.Success && !string.IsNullOrWhiteSpace(res.ActualModel) && seen.Add(res.ActualModel))
                {
                    models.Add(new
                    {
                        id = res.ActualModel,
                        @object = "model",
                        created = 1704067200,
                        owned_by = res.ActualPlatformName ?? "prd-agent"
                    });
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[OpenRouter] /v1/models 解析 {Code} 失败", code);
            }
        }

        await AddResolvedAsync(AppCallerRegistry.OpenRouter.Proxy.Chat, ModelTypes.Chat, key?.OpenRouterChatBinding);
        await AddResolvedAsync(AppCallerRegistry.OpenRouter.Proxy.Generation, ModelTypes.ImageGen, key?.OpenRouterImageBinding);

        return Ok(new { @object = "list", data = models });
    }

    // ─────────────────────────── Helpers ───────────────────────────

    private async Task<AgentApiKey?> LoadKeyAsync(CancellationToken ct)
    {
        var keyId = User.FindFirst("agentApiKeyId")?.Value ?? User.FindFirst("appId")?.Value;
        if (string.IsNullOrWhiteSpace(keyId)) return null;
        return await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
    }

    /// <summary>用于 [AllowAnonymous] 端点：手动触发 ApiKey 认证，带 Key 时取回 Key，无则返回 null。</summary>
    private async Task<AgentApiKey?> TryLoadKeyFromAuthAsync(CancellationToken ct)
    {
        if (User?.Identity?.IsAuthenticated == true)
            return await LoadKeyAsync(ct);

        var auth = await HttpContext.AuthenticateAsync("ApiKey");
        var keyId = auth.Principal?.FindFirst("agentApiKeyId")?.Value
            ?? auth.Principal?.FindFirst("appId")?.Value;
        if (string.IsNullOrWhiteSpace(keyId)) return null;
        return await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
    }

    private static string? ReadString(JsonObject body, string key)
        => body.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static bool ReadBool(JsonObject body, string key)
        => body.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    private async Task<JsonObject?> ReadBodyAsync(CancellationToken ct)
    {
        try
        {
            using var reader = new StreamReader(Request.Body, Encoding.UTF8);
            var raw = await reader.ReadToEndAsync(ct);
            if (string.IsNullOrWhiteSpace(raw)) return new JsonObject();
            return JsonNode.Parse(raw) as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    private object BuildChunk(string id, long created, string model, object delta, string? finishReason, string? errorMessage = null)
    {
        if (errorMessage != null)
        {
            return new
            {
                id,
                @object = "chat.completion.chunk",
                created,
                model,
                choices = new[] { new { index = 0, delta, finish_reason = finishReason } },
                error = new { code = "LLM_ERROR", message = errorMessage }
            };
        }
        return new
        {
            id,
            @object = "chat.completion.chunk",
            created,
            model,
            choices = new[] { new { index = 0, delta, finish_reason = finishReason } }
        };
    }

    private async Task WriteSseAsync(object data)
    {
        await Response.WriteAsync($"data: {JsonSerializer.Serialize(data, SnakeCase)}\n\n");
        await Response.Body.FlushAsync();
    }

    private async Task WriteJsonErrorAsync(int status, string type, string message, string? code = null)
    {
        if (!Response.HasStarted)
        {
            Response.StatusCode = status;
            Response.ContentType = "application/json";
            await Response.WriteAsync(JsonSerializer.Serialize(new { error = new { message, type, code } }));
        }
    }

    private async Task LogAsync(
        AgentApiKey? key, string requestId, string endpoint, string? requestedModel, string? binding,
        GatewayModelResolution? resolution, bool stream, int statusCode, string? errorCode,
        int? promptTokens, int? completionTokens, Stopwatch sw)
    {
        try
        {
            var log = new OpenRouterRequestLog
            {
                KeyId = key?.Id ?? "unknown",
                OwnerUserId = key?.OwnerUserId,
                RequestId = requestId,
                Endpoint = endpoint,
                RequestedModel = requestedModel,
                Binding = binding,
                ResolvedModel = resolution?.ActualModel,
                ResolvedPool = resolution?.ModelGroupName,
                ResolutionType = resolution?.ResolutionType,
                IsFallback = resolution?.IsFallback ?? false,
                Stream = stream,
                PromptTokens = promptTokens,
                CompletionTokens = completionTokens,
                StatusCode = statusCode,
                ErrorCode = errorCode,
                DurationMs = sw.ElapsedMilliseconds,
                ClientIp = HttpContext.Connection.RemoteIpAddress?.ToString(),
                UserAgent = Request.Headers.UserAgent.ToString(),
                CreatedAt = DateTime.UtcNow
            };
            await _db.OpenRouterRequestLogs.InsertOneAsync(log, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenRouter] 写请求日志失败");
        }
    }
}
</content>
