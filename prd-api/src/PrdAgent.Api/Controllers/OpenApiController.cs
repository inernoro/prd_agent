using System.Diagnostics;
using System.Linq;
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

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 开放接口（OpenAI 兼容）对外网关。
///
/// 外部调用方用标准 OpenAI 兼容请求方式接入（base_url 指到本服务即可）：
///   - POST /api/v1/chat/completions （流式 SSE + 非流式）
///   - POST /api/v1/images/generations
///   - GET  /api/v1/models       （该 Key 可用模型清单）
///   - GET  /api/v1/key          （密钥自省：白名单/配额/今日用量/有效期，不打模型）
///
/// 鉴权：`sk-ak-*` AgentApiKey（scheme=ApiKey）+ scope `open-api:call`。
///
/// 模型选择（白名单语义，见 doc/guide.open-api.md）：
/// - Key 配了模型白名单：client 的 model 命中白名单→用之；不填→用白名单第一个（默认）；
///   填了白名单外的→400 model_not_allowed。
/// - Key 未配白名单：回落 default:chat / default:image 默认池（client model 被忽略）。
/// 韧性：按 Key 限流桶 + 每日配额（429 + Retry-After + X-RateLimit-*）；输入大小上限；
/// LLM 调用 CancellationToken.None（客户端断开不取消上游，server-authority）。
/// </summary>
[ApiController]
public class OpenApiController : ControllerBase
{
    /// <summary>调用开放接口网关所需 scope。</summary>
    public const string ScopeCall = "open-api:call";

    /// <summary>单请求输入字符上限（约 50k token）；超限 400，防成本爆炸。</summary>
    private const int MaxInputChars = 200_000;

    private static readonly JsonSerializerOptions SnakeCase = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly MongoDbContext _db;
    private readonly IOpenApiUsageService _usage;
    private readonly ILogger<OpenApiController> _logger;

    public OpenApiController(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        MongoDbContext db,
        IOpenApiUsageService usage,
        ILogger<OpenApiController> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _db = db;
        _usage = usage;
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
        if (body == null) { await WriteJsonErrorAsync(400, "invalid_request_error", "请求体必须是合法 JSON"); return; }

        var requestedModel = ReadString(body, "model");
        var stream = ReadBool(body, "stream");

        // 模型白名单选择（client 可在白名单内自选；越界 400）
        var (chosen, modelErr) = ResolveModelChoice(key?.OpenApiChatModels, requestedModel);
        if (modelErr != null) { await WriteJsonErrorAsync(400, "invalid_request_error", modelErr, "model_not_allowed"); return; }

        // 输入大小上限（先于占额，坏请求不消耗配额）
        if (CountInputChars(body) > MaxInputChars) { await WriteJsonErrorAsync(400, "invalid_request_error", $"输入过大（上限 {MaxInputChars} 字符）", "input_too_large"); return; }

        body.Remove("model"); // 由 Gateway 注入解析模型

        if (!await PassUsageGateAsync(key, requestId, "chat", requestedModel, chosen, sw)) return;

        var request = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.OpenApi.Proxy.Chat,
            ModelType = ModelTypes.Chat,
            ExpectedModel = string.IsNullOrWhiteSpace(chosen) ? null : chosen,
            RequestBody = body,
            Stream = stream,
            IncludeThinking = false,
            TimeoutSeconds = 300
        };

        using var _scope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId, GroupId: null, SessionId: null, UserId: key?.OwnerUserId,
            ViewRole: null, DocumentChars: null, DocumentHash: null, SystemPromptRedacted: null,
            RequestType: "chat", AppCallerCode: AppCallerRegistry.OpenApi.Proxy.Chat));

        var bound = (key?.OpenApiChatModels?.Count ?? 0) > 0;
        if (stream) await StreamChatAsync(request, key, requestId, requestedModel, chosen, bound, sw);
        else await NonStreamChatAsync(request, key, requestId, requestedModel, chosen, bound, sw);
    }

    private async Task StreamChatAsync(
        GatewayRequest request, AgentApiKey? key, string requestId,
        string? requestedModel, string? chosen, bool bound, Stopwatch sw)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        var chatId = $"chatcmpl-{requestId}"; // 与日志 requestId 同源，可回溯
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var resolvedModel = chosen ?? requestedModel ?? "auto";
        GatewayModelResolution? resolution = null;
        int? promptTokens = null, completionTokens = null;
        string? errorCode = null;
        var isFirst = true;

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    resolution = chunk.Resolution;
                    if (!string.IsNullOrWhiteSpace(resolution.ActualModel)) resolvedModel = resolution.ActualModel;
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (isFirst) { await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { role = "assistant" }, null)); isFirst = false; }
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
                        usage = new { prompt_tokens = promptTokens ?? 0, completion_tokens = completionTokens ?? 0, total_tokens = (promptTokens ?? 0) + (completionTokens ?? 0) }
                    };
                    await WriteSseAsync(done);
                    await Response.WriteAsync("data: [DONE]\n\n");
                    await Response.Body.FlushAsync();
                    break;
                }
            }

            await LogAsync(key, requestId, "chat", requestedModel, chosen, resolution, true, errorCode == null ? 200 : 500, errorCode, promptTokens, completionTokens, sw);
            await RecordUsageAsync(key, bound, resolution, promptTokens, completionTokens);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApi] chat 流式失败 keyId={KeyId}", key?.Id);
            await LogAsync(key, requestId, "chat", requestedModel, chosen, resolution, true, 500, "INTERNAL_ERROR", promptTokens, completionTokens, sw);
        }
    }

    private async Task NonStreamChatAsync(
        GatewayRequest request, AgentApiKey? key, string requestId,
        string? requestedModel, string? chosen, bool bound, Stopwatch sw)
    {
        try
        {
            var resp = await _gateway.SendAsync(request, CancellationToken.None);
            var resolvedModel = resp.Resolution?.ActualModel ?? chosen ?? requestedModel ?? "auto";

            if (!resp.Success)
            {
                await LogAsync(key, requestId, "chat", requestedModel, chosen, resp.Resolution, false, resp.StatusCode > 0 ? resp.StatusCode : 502, resp.ErrorCode ?? "LLM_ERROR", null, null, sw);
                await WriteJsonErrorAsync(resp.StatusCode > 0 ? resp.StatusCode : 502, "api_error", resp.ErrorMessage ?? "上游模型调用失败", resp.ErrorCode);
                return;
            }

            var promptTokens = resp.TokenUsage?.InputTokens;
            var completionTokens = resp.TokenUsage?.OutputTokens;
            var completion = new
            {
                id = $"chatcmpl-{requestId}",
                @object = "chat.completion",
                created = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                model = resolvedModel,
                choices = new[] { new { index = 0, message = new { role = "assistant", content = resp.Content ?? string.Empty }, finish_reason = "stop" } },
                usage = new { prompt_tokens = promptTokens ?? 0, completion_tokens = completionTokens ?? 0, total_tokens = (promptTokens ?? 0) + (completionTokens ?? 0) }
            };

            Response.ContentType = "application/json";
            await Response.WriteAsync(JsonSerializer.Serialize(completion, SnakeCase));
            await LogAsync(key, requestId, "chat", requestedModel, chosen, resp.Resolution, false, 200, null, promptTokens, completionTokens, sw);
            await RecordUsageAsync(key, bound, resp.Resolution, promptTokens, completionTokens);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApi] chat 非流式失败 keyId={KeyId}", key?.Id);
            await LogAsync(key, requestId, "chat", requestedModel, chosen, null, false, 500, "INTERNAL_ERROR", null, null, sw);
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
        if (body == null) { await WriteJsonErrorAsync(400, "invalid_request_error", "请求体必须是合法 JSON"); return; }

        var requestedModel = ReadString(body, "model");
        var (chosen, modelErr) = ResolveModelChoice(key?.OpenApiImageModels, requestedModel);
        if (modelErr != null) { await WriteJsonErrorAsync(400, "invalid_request_error", modelErr, "model_not_allowed"); return; }
        if (CountInputChars(body) > MaxInputChars) { await WriteJsonErrorAsync(400, "invalid_request_error", $"输入过大（上限 {MaxInputChars} 字符）", "input_too_large"); return; }
        body.Remove("model");

        if (!await PassUsageGateAsync(key, requestId, "image", requestedModel, chosen, sw)) return;

        using var _scope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId, GroupId: null, SessionId: null, UserId: key?.OwnerUserId,
            ViewRole: null, DocumentChars: null, DocumentHash: null, SystemPromptRedacted: null,
            RequestType: "generation", AppCallerCode: AppCallerRegistry.OpenApi.Proxy.Generation));

        var bound = (key?.OpenApiImageModels?.Count ?? 0) > 0;
        try
        {
            var resolution = await _gateway.ResolveModelAsync(
                AppCallerRegistry.OpenApi.Proxy.Generation, ModelTypes.ImageGen,
                expectedModel: string.IsNullOrWhiteSpace(chosen) ? null : chosen, CancellationToken.None);

            if (!resolution.Success)
            {
                await LogAsync(key, requestId, "image", requestedModel, chosen, resolution, false, 502, "MODEL_NOT_FOUND", null, null, sw);
                await WriteJsonErrorAsync(502, "api_error", resolution.ErrorMessage ?? "未找到可用生图模型");
                return;
            }

            var raw = new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.OpenApi.Proxy.Generation,
                ModelType = ModelTypes.ImageGen,
                EndpointPath = "/v1/images/generations",
                ExpectedModel = resolution.ActualModel,
                RequestBody = body,
                TimeoutSeconds = 600
            };

            var resp = await _gateway.SendRawWithResolutionAsync(raw, resolution, CancellationToken.None);

            Response.ContentType = "application/json";
            Response.StatusCode = resp.Success ? 200 : (resp.StatusCode > 0 ? resp.StatusCode : 502);
            await Response.WriteAsync(resp.Content ?? JsonSerializer.Serialize(new { error = new { message = resp.ErrorMessage ?? "上游生图失败", type = "api_error", code = resp.ErrorCode } }));

            await LogAsync(key, requestId, "image", requestedModel, chosen, resolution, false, Response.StatusCode, resp.Success ? null : (resp.ErrorCode ?? "LLM_ERROR"), null, null, sw);
            await RecordUsageAsync(key, bound, resolution, null, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApi] image 生成失败 keyId={KeyId}", key?.Id);
            await LogAsync(key, requestId, "image", requestedModel, chosen, null, false, 500, "INTERNAL_ERROR", null, null, sw);
            await WriteJsonErrorAsync(500, "api_error", "内部错误");
        }
    }

    // ─────────────────────────── Models ───────────────────────────

    [HttpGet("~/api/v1/models")]
    [AllowAnonymous]
    public async Task<IActionResult> GetModels(CancellationToken httpAborted)
    {
        var key = await TryLoadKeyFromAuthAsync(httpAborted);
        var models = new List<object>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void AddModel(string id, string? owner)
        {
            if (!string.IsNullOrWhiteSpace(id) && seen.Add(id))
                models.Add(new { id, @object = "model", created = 1704067200, owned_by = owner ?? "prd-agent" });
        }

        async Task AddForAsync(string code, string modelType, List<string>? whitelist)
        {
            // 有白名单：直接列白名单（client 可填的就是这些）
            if (whitelist is { Count: > 0 }) { foreach (var m in whitelist) AddModel(m, "open-api"); return; }
            // 无白名单：列默认池解析出的模型
            try
            {
                var res = await _gateway.ResolveModelAsync(code, modelType, expectedModel: null, CancellationToken.None);
                if (res.Success) AddModel(res.ActualModel, res.ActualPlatformName);
            }
            catch (Exception ex) { _logger.LogWarning(ex, "[OpenApi] /v1/models 解析 {Code} 失败", code); }
        }

        await AddForAsync(AppCallerRegistry.OpenApi.Proxy.Chat, ModelTypes.Chat, key?.OpenApiChatModels);
        await AddForAsync(AppCallerRegistry.OpenApi.Proxy.Generation, ModelTypes.ImageGen, key?.OpenApiImageModels);

        return new ContentResult { Content = JsonSerializer.Serialize(new { @object = "list", data = models }, SnakeCase), ContentType = "application/json", StatusCode = 200 };
    }

    // ─────────────────────────── Key 自省 ───────────────────────────

    /// <summary>密钥自省：返回白名单/配额/今日用量/有效期，不消耗模型额度。客户可一条 curl 快速鉴定 Key。</summary>
    [HttpGet("~/api/v1/key")]
    [Authorize(AuthenticationSchemes = "ApiKey")]
    [RequireScope(ScopeCall)]
    public async Task<IActionResult> GetKeyInfo(CancellationToken ct)
    {
        var key = await LoadKeyAsync(ct);
        if (key == null) return Unauthorized();
        var usage = await _usage.GetUsageAsync(key.Id, ct);
        var info = new
        {
            name = key.Name,
            is_active = key.IsActive,
            scopes = key.Scopes,
            chat_models = key.OpenApiChatModels,
            image_models = key.OpenApiImageModels,
            default_chat_model = key.OpenApiChatModels.FirstOrDefault(),
            default_image_model = key.OpenApiImageModels.FirstOrDefault(),
            limits = new
            {
                rate_per_min = key.OpenApiRateLimitPerMin,
                daily_requests = key.OpenApiDailyRequestQuota,
                daily_tokens = key.OpenApiDailyTokenQuota
            },
            usage_today = new { requests = usage.TodayRequests, tokens = usage.TodayTokens },
            expires_at = key.ExpiresAt
        };
        return new ContentResult { Content = JsonSerializer.Serialize(info, SnakeCase), ContentType = "application/json", StatusCode = 200 };
    }

    // ─────────────────────────── Helpers ───────────────────────────

    /// <summary>白名单选择：返回 (选中模型, 错误)。空白名单→(null,null) 走默认池；越界→报错。</summary>
    private static (string? chosen, string? error) ResolveModelChoice(List<string>? whitelist, string? requestedModel)
    {
        if (whitelist == null || whitelist.Count == 0) return (null, null); // 未绑定→默认池
        if (string.IsNullOrWhiteSpace(requestedModel)) return (whitelist[0], null); // 不填→默认（第一个）
        var hit = whitelist.FirstOrDefault(m => string.Equals(m, requestedModel.Trim(), StringComparison.OrdinalIgnoreCase));
        if (hit != null) return (hit, null);
        return (null, $"model '{requestedModel}' 不在该 Key 的允许列表内。允许的模型：{string.Join(", ", whitelist)}");
    }

    /// <summary>统计输入字符数（chat messages[].content 字符串或多模态 text + image prompt）。</summary>
    private static int CountInputChars(JsonObject body)
    {
        var n = 0;
        if (body.TryGetPropertyValue("messages", out var m) && m is JsonArray arr)
        {
            foreach (var item in arr)
            {
                if (item is not JsonObject o || !o.TryGetPropertyValue("content", out var c)) continue;
                if (c is JsonValue cv && cv.TryGetValue<string>(out var s)) n += s.Length;
                else if (c is JsonArray ca)
                    foreach (var part in ca)
                        if (part is JsonObject po && po.TryGetPropertyValue("text", out var t) && t is JsonValue tv && tv.TryGetValue<string>(out var ts)) n += ts.Length;
            }
        }
        if (body.TryGetPropertyValue("prompt", out var p) && p is JsonValue pv && pv.TryGetValue<string>(out var ps)) n += ps.Length;
        return n;
    }

    /// <summary>限流/配额准入：回写 X-RateLimit-*（成功/失败均写）；拒绝时 429 + Retry-After + 日志，返回 false。</summary>
    private async Task<bool> PassUsageGateAsync(AgentApiKey? key, string requestId, string endpoint, string? requestedModel, string? chosen, Stopwatch sw)
    {
        if (key == null) return true;
        var decision = await _usage.CheckAndReserveAsync(key, CancellationToken.None);
        if (decision.RateLimit > 0)
        {
            Response.Headers["X-RateLimit-Limit"] = decision.RateLimit.ToString();
            Response.Headers["X-RateLimit-Remaining"] = decision.RateRemaining.ToString();
            Response.Headers["X-RateLimit-Reset"] = decision.RateResetSeconds.ToString();
        }
        if (decision.Allowed) return true;
        if (decision.RetryAfterSeconds is int ra) Response.Headers["Retry-After"] = ra.ToString();
        await LogAsync(key, requestId, endpoint, requestedModel, chosen, null, false, 429, decision.Code, null, null, sw);
        await WriteJsonErrorAsync(429, "rate_limit_error", decision.Message ?? "请求过于频繁或已超配额", decision.Code);
        return false;
    }

    /// <summary>请求完成后：累加 token 用量（触发配额预警）；已绑定 Key 降级时发预警。</summary>
    private async Task RecordUsageAsync(AgentApiKey? key, bool bound, GatewayModelResolution? resolution, int? promptTokens, int? completionTokens)
    {
        if (key == null) return;
        var total = (promptTokens ?? 0) + (completionTokens ?? 0);
        if (total > 0) await _usage.RecordTokensAsync(key, total, CancellationToken.None);
        if (bound && resolution?.IsFallback == true)
            _ = _usage.NotifyFallbackAsync(key, resolution.ActualModel, resolution.OriginalPoolName, resolution.FallbackReason, CancellationToken.None);
    }

    private async Task<AgentApiKey?> LoadKeyAsync(CancellationToken ct)
    {
        var keyId = User.FindFirst("agentApiKeyId")?.Value ?? User.FindFirst("appId")?.Value;
        if (string.IsNullOrWhiteSpace(keyId)) return null;
        return await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
    }

    /// <summary>用于 [AllowAnonymous] 端点：手动触发 ApiKey 认证，带 Key 时取回 Key，无则返回 null。</summary>
    private async Task<AgentApiKey?> TryLoadKeyFromAuthAsync(CancellationToken ct)
    {
        if (User?.Identity?.IsAuthenticated == true) return await LoadKeyAsync(ct);
        var auth = await HttpContext.AuthenticateAsync("ApiKey");
        var keyId = auth.Principal?.FindFirst("agentApiKeyId")?.Value ?? auth.Principal?.FindFirst("appId")?.Value;
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
        catch { return null; }
    }

    private object BuildChunk(string id, long created, string model, object delta, string? finishReason, string? errorMessage = null)
    {
        if (errorMessage != null)
            return new { id, @object = "chat.completion.chunk", created, model, choices = new[] { new { index = 0, delta, finish_reason = finishReason } }, error = new { code = "LLM_ERROR", message = errorMessage } };
        return new { id, @object = "chat.completion.chunk", created, model, choices = new[] { new { index = 0, delta, finish_reason = finishReason } } };
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
        AgentApiKey? key, string requestId, string endpoint, string? requestedModel, string? chosen,
        GatewayModelResolution? resolution, bool stream, int statusCode, string? errorCode,
        int? promptTokens, int? completionTokens, Stopwatch sw)
    {
        try
        {
            var log = new OpenApiRequestLog
            {
                KeyId = key?.Id ?? "unknown",
                OwnerUserId = key?.OwnerUserId,
                RequestId = requestId,
                Endpoint = endpoint,
                RequestedModel = requestedModel,
                Binding = chosen,
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
            await _db.OpenApiRequestLogs.InsertOneAsync(log, cancellationToken: CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogError(ex, "[OpenApi] 写请求日志失败"); }
    }
}
