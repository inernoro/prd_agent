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
        // [Authorize] 已过但 AgentApiKey 行查不到（鉴权后被删/撤销）→ 401，禁止无 Key 走限流/配额旁路（Bugbot High）。
        if (key == null) { await WriteJsonErrorAsync(401, "invalid_request_error", "无效或已过期的 API Key", "invalid_api_key"); return; }

        var (body, bodyTooLarge) = await ReadBodyAsync(httpAborted);
        if (bodyTooLarge)
        {
            await LogAsync(key, requestId, "chat", null, null, null, false, 413, "input_too_large", null, null, sw);
            await WriteJsonErrorAsync(413, "invalid_request_error", $"请求体过大（原始上限 {MaxBodyChars} 字符）", "input_too_large"); return;
        }
        if (body == null) { await WriteJsonErrorAsync(400, "invalid_request_error", "请求体必须是合法 JSON"); return; }

        var requestedModel = ReadString(body, "model");
        var stream = ReadBool(body, "stream");

        // 模型白名单选择（client 可在白名单内自选；越界 400）
        var (chosen, modelErr) = ResolveModelChoice(key?.OpenApiChatModels, requestedModel);
        if (modelErr != null)
        {
            await LogAsync(key, requestId, "chat", requestedModel, null, null, false, 400, "model_not_allowed", null, null, sw);
            await WriteJsonErrorAsync(400, "invalid_request_error", modelErr, "model_not_allowed"); return;
        }

        // 输入大小上限（先于占额，坏请求不消耗配额）
        if (CountInputChars(body) > MaxInputChars)
        {
            await LogAsync(key, requestId, "chat", requestedModel, null, null, false, 400, "input_too_large", null, null, sw);
            await WriteJsonErrorAsync(400, "invalid_request_error", $"输入过大（上限 {MaxInputChars} 字符）", "input_too_large"); return;
        }

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
        var doneSent = false;

        async Task SendDoneAsync()
        {
            if (doneSent) return;
            doneSent = true;
            await Response.WriteAsync("data: [DONE]\n\n");
            await Response.Body.FlushAsync();
        }

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    resolution = chunk.Resolution;
                    if (!string.IsNullOrWhiteSpace(resolution.ActualModel)) resolvedModel = resolution.ActualModel;
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content) && !doneSent)
                {
                    if (isFirst) { await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { role = "assistant" }, null)); isFirst = false; }
                    await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { content = chunk.Content }, null));
                }
                else if (chunk.Type == GatewayChunkType.ToolCall && chunk.ToolCallDelta != null && !doneSent)
                {
                    // 协议保真：函数调用增量按 OpenAI SSE delta.tool_calls 透出（此前流式完全无函数调用）。
                    if (isFirst) { await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { role = "assistant" }, null)); isFirst = false; }
                    await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { tool_calls = chunk.ToolCallDelta }, null));
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    errorCode = "LLM_ERROR";
                    if (!Response.HasStarted)
                    {
                        // 流还没开始（解析/上游在吐第一个 token 前就失败，如无默认池 / 上游 401/429）
                        // → 返回真正的非 2xx + JSON 错误，不要伪装成成功的 200 SSE 流
                        //   （OpenAI 客户端会把 200 + 空流当成功，只有内部日志记录了失败）。
                        Response.StatusCode = 502;
                        Response.ContentType = "application/json";
                        await Response.WriteAsync(JsonSerializer.Serialize(new { error = new { message = chunk.Error ?? "上游错误", type = "api_error", code = "upstream_error" } }));
                        await Response.Body.FlushAsync();
                        doneSent = true; // 已发 JSON 错误体，禁止后续再写 SSE / [DONE]
                        // 流开始前就失败、零输出 → 退回准入占用的每日请求额度（与非流式一致，不空烧配额）。
                        if (key != null) await _usage.RefundDailyRequestAsync(key, CancellationToken.None);
                        break;
                    }
                    // 流已开始：只能在 SSE 流内发错误事件 + 终止符
                    await WriteSseAsync(BuildChunk(chatId, created, resolvedModel, new { }, "error", chunk.Error));
                    await SendDoneAsync();
                    break;
                }
                else if (chunk.Type == GatewayChunkType.Done && !doneSent)
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
                    await SendDoneAsync();
                    // 不 break：继续把上游迭代器读完，让 LlmGateway 在 `yield Done` 之后的 FinishStreamLogAsync 执行完。
                    // 否则成功的流式请求会把 LLM 请求日志留在 running，直到 watchdog 误判超时——破坏本端点的 requestId 可回溯性（Codex PR#732 P2）。
                    // doneSent 已置位：后续若再来 chunk（正常不会）不会重复写 [DONE]/usage 或客户端内容。
                }
            }

            // 上游正常结束但没吐 Done chunk（极少数适配器）也补一个终止符
            await SendDoneAsync();

            // 日志状态码取客户端实际收到的：成功/流内错误=200，pre-stream 错误=已设的 502，保持与客户端一致便于按 requestId 排障
            await LogAsync(key, requestId, "chat", requestedModel, chosen, resolution, true, Response.StatusCode, errorCode, promptTokens, completionTokens, sw);
            await RecordUsageAsync(key, bound, resolution, promptTokens, completionTokens);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApi] chat 流式失败 keyId={KeyId}", key?.Id);
            // 必须在写错误体之前快照"流是否已开始"——下面写 JSON 会把 HasStarted 翻成 true，
            // 若之后再判 HasStarted 退额条件永远不成立（Codex P2）。
            var startedBeforeCatch = Response.HasStarted;
            // 已开始流式则补终止符让客户端收尾（HTTP 已 200）；未开始则回 500 + OpenAI 形状 JSON 错误体
            // （此前只设状态码、Content-Type 仍是 event-stream，客户端拿到空响应——与 pre-stream 502 路径不一致，Bugbot）。
            if (startedBeforeCatch) { try { await SendDoneAsync(); } catch { /* 连接已断，忽略 */ } }
            else
            {
                Response.StatusCode = 500;
                Response.ContentType = "application/json";
                try
                {
                    await Response.WriteAsync(JsonSerializer.Serialize(new { error = new { message = "内部错误", type = "api_error", code = "internal_error" } }));
                    await Response.Body.FlushAsync();
                }
                catch { /* 连接已断，忽略 */ }
            }
            // 进到本方法说明准入已占额；异常且零输出（流未开始）→ 退回每日请求额度。有部分输出则不退（已产生工作）。
            if (key != null && !startedBeforeCatch) await _usage.RefundDailyRequestAsync(key, CancellationToken.None);
            await LogAsync(key, requestId, "chat", requestedModel, chosen, resolution, true, Response.StatusCode, "INTERNAL_ERROR", promptTokens, completionTokens, sw);
            // 即使中途失败，已产生的 token 也要计入配额、并跑绑定/降级预警（与成功路径一致，否则用量/预警会漏，Bugbot）。
            await RecordUsageAsync(key, bound, resolution, promptTokens, completionTokens);
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
                // 未产生可计费完成（解析失败/上游错误）→ 退回准入时占用的每日请求额度，不空烧客户配额（Bugbot）。
                if (key != null) await _usage.RefundDailyRequestAsync(key, CancellationToken.None);
                await LogAsync(key, requestId, "chat", requestedModel, chosen, resp.Resolution, false, resp.StatusCode > 0 ? resp.StatusCode : 502, resp.ErrorCode ?? "LLM_ERROR", null, null, sw);
                await WriteJsonErrorAsync(resp.StatusCode > 0 ? resp.StatusCode : 502, "api_error", resp.ErrorMessage ?? "上游模型调用失败", resp.ErrorCode);
                return;
            }

            var promptTokens = resp.TokenUsage?.InputTokens;
            var completionTokens = resp.TokenUsage?.OutputTokens;
            // 协议保真：上游若返回函数调用，网关已归一为 OpenAI 形状 tool_calls，这里回吐给客户端，
            // 而非只回纯文本（此前 tool_calls 被静默丢，函数调用对外是哑的）。
            var hasTools = resp.ToolCalls != null && resp.ToolCalls.Count > 0;
            var usage = new { prompt_tokens = promptTokens ?? 0, completion_tokens = completionTokens ?? 0, total_tokens = (promptTokens ?? 0) + (completionTokens ?? 0) };
            var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

            string completionJson;
            if (hasTools)
            {
                // OpenAI 约定：有 tool_calls 时 content 为 null、finish_reason 为 "tool_calls"。
                var completion = new
                {
                    id = $"chatcmpl-{requestId}",
                    @object = "chat.completion",
                    created,
                    model = resolvedModel,
                    choices = new[] { new { index = 0, message = new { role = "assistant", content = (string?)null, tool_calls = resp.ToolCalls }, finish_reason = "tool_calls" } },
                    usage
                };
                completionJson = JsonSerializer.Serialize(completion, SnakeCase);
            }
            else
            {
                var completion = new
                {
                    id = $"chatcmpl-{requestId}",
                    @object = "chat.completion",
                    created,
                    model = resolvedModel,
                    choices = new[] { new { index = 0, message = new { role = "assistant", content = resp.Content ?? string.Empty }, finish_reason = "stop" } },
                    usage
                };
                completionJson = JsonSerializer.Serialize(completion, SnakeCase);
            }

            Response.ContentType = "application/json";
            await Response.WriteAsync(completionJson);
            await LogAsync(key, requestId, "chat", requestedModel, chosen, resp.Resolution, false, 200, null, promptTokens, completionTokens, sw);
            await RecordUsageAsync(key, bound, resp.Resolution, promptTokens, completionTokens);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApi] chat 非流式失败 keyId={KeyId}", key?.Id);
            // 进到本方法说明准入已占额；异常零输出 → 退回每日请求额度，不空烧配额（Bugbot）。
            if (key != null) await _usage.RefundDailyRequestAsync(key, CancellationToken.None);
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
        // [Authorize] 已过但 AgentApiKey 行查不到（鉴权后被删/撤销）→ 401，禁止无 Key 走限流/配额旁路（Bugbot High）。
        if (key == null) { await WriteJsonErrorAsync(401, "invalid_request_error", "无效或已过期的 API Key", "invalid_api_key"); return; }

        var (body, bodyTooLarge) = await ReadBodyAsync(httpAborted);
        if (bodyTooLarge)
        {
            await LogAsync(key, requestId, "image", null, null, null, false, 413, "input_too_large", null, null, sw);
            await WriteJsonErrorAsync(413, "invalid_request_error", $"请求体过大（原始上限 {MaxBodyChars} 字符）", "input_too_large"); return;
        }
        if (body == null) { await WriteJsonErrorAsync(400, "invalid_request_error", "请求体必须是合法 JSON"); return; }

        var requestedModel = ReadString(body, "model");
        var (chosen, modelErr) = ResolveModelChoice(key?.OpenApiImageModels, requestedModel);
        if (modelErr != null)
        {
            await LogAsync(key, requestId, "image", requestedModel, null, null, false, 400, "model_not_allowed", null, null, sw);
            await WriteJsonErrorAsync(400, "invalid_request_error", modelErr, "model_not_allowed"); return;
        }
        if (CountInputChars(body) > MaxInputChars)
        {
            await LogAsync(key, requestId, "image", requestedModel, null, null, false, 400, "input_too_large", null, null, sw);
            await WriteJsonErrorAsync(400, "invalid_request_error", $"输入过大（上限 {MaxInputChars} 字符）", "input_too_large"); return;
        }
        body.Remove("model");

        using var _scope = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: requestId, GroupId: null, SessionId: null, UserId: key?.OwnerUserId,
            ViewRole: null, DocumentChars: null, DocumentHash: null, SystemPromptRedacted: null,
            RequestType: "generation", AppCallerCode: AppCallerRegistry.OpenApi.Proxy.Generation));

        var bound = (key?.OpenApiImageModels?.Count ?? 0) > 0;
        var reserved = false; // 标记本请求是否已通过 PassUsageGateAsync 占用每日额度（解析阶段异常时尚未占，不可误退）。
        try
        {
            // 先解析模型（廉价、不占额）。解析失败时不消耗配额/限速槽——避免错配绑定（模型/池被删）空烧客户每日额度（Bugbot）。
            var resolution = await _gateway.ResolveModelAsync(
                AppCallerRegistry.OpenApi.Proxy.Generation, ModelTypes.ImageGen,
                expectedModel: string.IsNullOrWhiteSpace(chosen) ? null : chosen, CancellationToken.None);

            if (!resolution.Success)
            {
                await LogAsync(key, requestId, "image", requestedModel, chosen, resolution, false, 502, "MODEL_NOT_FOUND", null, null, sw);
                await WriteJsonErrorAsync(502, "api_error", resolution.ErrorMessage ?? "未找到可用生图模型");
                return;
            }

            // 解析成功才占用限流/每日配额（429 时 PassUsageGateAsync 已写响应，直接返回）。
            if (!await PassUsageGateAsync(key, requestId, "image", requestedModel, chosen, sw)) return;
            reserved = true;

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

            // 上游失败、未出图 → 退回已占用的每日请求额度（与 chat 一致，不空烧配额，Bugbot）。
            if (!resp.Success && key != null) await _usage.RefundDailyRequestAsync(key, CancellationToken.None);

            Response.ContentType = "application/json";
            Response.StatusCode = resp.Success ? 200 : (resp.StatusCode > 0 ? resp.StatusCode : 502);
            await Response.WriteAsync(resp.Content ?? JsonSerializer.Serialize(new { error = new { message = resp.ErrorMessage ?? "上游生图失败", type = "api_error", code = resp.ErrorCode } }));

            await LogAsync(key, requestId, "image", requestedModel, chosen, resolution, false, Response.StatusCode, resp.Success ? null : (resp.ErrorCode ?? "LLM_ERROR"), null, null, sw);
            await RecordUsageAsync(key, bound, resolution, null, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[OpenApi] image 生成失败 keyId={KeyId}", key?.Id);
            // 已占额才退（解析阶段异常 reserved=false，未占额不退，避免误减并发请求的计数）。
            if (reserved && key != null) await _usage.RefundDailyRequestAsync(key, CancellationToken.None);
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

        // 带了 sk- 凭据但解析不出有效 Key（错/过期/撤销）→ 401，避免错 key 看似有效。
        // 完全匿名（无凭据）才返回默认池清单用于发现。
        if (key == null && HasApiKeyCredential())
            return new ContentResult
            {
                StatusCode = 401, ContentType = "application/json",
                Content = JsonSerializer.Serialize(new { error = new { message = "无效或已过期的 API Key", type = "invalid_request_error", code = "invalid_api_key" } })
            };

        // 有效 Key 但没有 open-api:call scope（如只授了 marketplace 的 Key）→ 403，
        // 与 chat/image 端点的 [RequireScope] 一致，避免越权用 Key 发现开放接口模型绑定。
        if (key != null && !key.Scopes.Contains(ScopeCall))
            return new ContentResult
            {
                StatusCode = 403, ContentType = "application/json",
                Content = JsonSerializer.Serialize(new { error = new { message = $"该 Key 缺少 {ScopeCall} scope", type = "invalid_request_error", code = "insufficient_scope" } })
            };

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
                    {
                        if (part is not JsonObject po) continue;
                        // 文本部分
                        if (po.TryGetPropertyValue("text", out var t) && t is JsonValue tv && tv.TryGetValue<string>(out var ts)) n += ts.Length;
                        // 多模态图片：image_url 可能是 {url:"data:image/...;base64,..."} 或直接字符串，
                        // base64 体量必须计入上限，否则大图绕过 MaxInputChars 直打上游。
                        if (po.TryGetPropertyValue("image_url", out var iu))
                        {
                            if (iu is JsonObject iuo && iuo.TryGetPropertyValue("url", out var u) && u is JsonValue uv && uv.TryGetValue<string>(out var us)) n += us.Length;
                            else if (iu is JsonValue iuv && iuv.TryGetValue<string>(out var ius)) n += ius.Length;
                        }
                    }
            }
        }
        if (body.TryGetPropertyValue("prompt", out var p) && p is JsonValue pv && pv.TryGetValue<string>(out var ps)) n += ps.Length;
        // 工具/函数定义也计入上限：大 schema 同样消耗上游 context/成本，否则绕过 MaxInputChars（Codex PR#732 P2）。
        foreach (var field in new[] { "tools", "functions" })
            if (body.TryGetPropertyValue(field, out var tn) && tn is JsonArray ta && ta.Count > 0)
                n += ta.ToJsonString().Length;
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

        if (!bound || resolution == null) return;

        // 显式降级（池→legacy 回落）直接发预警。
        if (resolution.IsFallback)
        {
            _ = _usage.NotifyFallbackAsync(key, resolution.ActualModel, resolution.OriginalPoolName, resolution.FallbackReason, CancellationToken.None);
            return;
        }

        // 绑定失效检测（Codex PR#732 P2）：绑定的 Key，若 expectedModel 既没匹配到模型 id（精确/前缀容差），
        // 也没匹配到池 code，说明绑定的模型/池被删/改名，ModelResolver 静默走了默认调度（不算 IsFallback）。
        // 此时该客户其实跑在共享默认池上却毫无察觉 → 补发降级预警，让管理员看见。
        // 策略决定（用户 2026-06-04 PR#732）：ModelResolver 的「版本容差」前缀匹配视为「已遵守」，不报警
        // （贴合其设计意图，避免版本容差绑定刷屏）；仅当连容差都不沾边、彻底回落默认时才报警。
        var exp = resolution.ExpectedModel;
        if (!string.IsNullOrWhiteSpace(exp))
        {
            var act = resolution.ActualModel ?? string.Empty;
            // 严格镜像 ModelResolver 的匹配档：精确 id / 池模型是 expected 前缀（tier-2 版本容差）/ 池 code。
            // 不含反向 act.StartsWith(exp)——那不是 ModelResolver 的匹配档，会把"绑定被删、回落到恰好更长的默认模型"
            // 误判为已遵守而吞掉降级预警（Codex PR#732 P2）。
            var honored =
                string.Equals(exp, act, StringComparison.OrdinalIgnoreCase)                       // 精确模型 id
                || exp.StartsWith(act, StringComparison.OrdinalIgnoreCase)                         // 前缀容差（池模型是 expected 前缀，= ModelResolver tier-2）
                || string.Equals(exp, resolution.ModelGroupCode, StringComparison.OrdinalIgnoreCase); // 池 code 绑定
            if (!honored)
                _ = _usage.NotifyFallbackAsync(key, act, exp, $"绑定的模型/池 '{exp}' 未匹配，已回落默认调度", CancellationToken.None);
        }
    }

    private async Task<AgentApiKey?> LoadKeyAsync(CancellationToken ct)
    {
        var keyId = User.FindFirst("agentApiKeyId")?.Value ?? User.FindFirst("appId")?.Value;
        if (string.IsNullOrWhiteSpace(keyId)) return null;
        return await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// 请求是否携带了 open-api 专用 sk-ak-* 密钥（用于 /v1/models 区分"无效 key→401"与"匿名→发现清单"）。
    /// 只认 sk-ak-* 前缀：平台 AI_ACCESS_KEY（X-AI-Access-Key 头，非 sk-ak-*）与旧版 sk-{32} App key
    /// 做模型发现不应被 401（Bugbot），JWT 会话也不算。
    /// </summary>
    private bool HasApiKeyCredential()
    {
        if (Request.Headers.TryGetValue("Authorization", out var auth))
        {
            var v = auth.ToString();
            var token = v.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? v["Bearer ".Length..].Trim() : v.Trim();
            if (token.StartsWith("sk-ak-", StringComparison.Ordinal)) return true;
        }
        return Request.Headers.TryGetValue("X-AI-Access-Key", out var xak)
            && xak.ToString().Trim().StartsWith("sk-ak-", StringComparison.Ordinal);
    }

    /// <summary>用于 [AllowAnonymous] 端点：手动触发 ApiKey 认证，带 Key 时取回 Key，无则返回 null。</summary>
    private async Task<AgentApiKey?> TryLoadKeyFromAuthAsync(CancellationToken ct)
    {
        // 当前主体已带 agentApiKeyId（ApiKey scheme 已认证）→ 直接取。
        if (User?.Identity?.IsAuthenticated == true)
        {
            var k = await LoadKeyAsync(ct);
            if (k != null) return k;
            // JWT 会话也算 authenticated，但没有 agentApiKeyId；若同时带了有效 sk-ak-* bearer，
            // 不能就此返回 null（否则 /v1/models 会把"会话 cookie + 有效 open-api key"误判为无效 key→401）。
            // 继续往下显式跑一次 ApiKey 认证，取回 sk-ak-* 绑定的 key。
        }
        var auth = await HttpContext.AuthenticateAsync("ApiKey");
        var keyId = auth.Principal?.FindFirst("agentApiKeyId")?.Value ?? auth.Principal?.FindFirst("appId")?.Value;
        if (string.IsNullOrWhiteSpace(keyId)) return null;
        return await _db.AgentApiKeys.Find(k => k.Id == keyId).FirstOrDefaultAsync(ct);
    }

    private static string? ReadString(JsonObject body, string key)
        => body.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static bool ReadBool(JsonObject body, string key)
        => body.TryGetPropertyValue(key, out var n) && n is JsonValue v && v.TryGetValue<bool>(out var b) && b;

    /// <summary>原始请求体硬上限（字节/字符近似）。防超大 body 在 ReadToEnd/Parse 阶段爆内存/CPU；
    /// 逻辑输入上限仍由 MaxInputChars 管（含多模态 base64）。给足余量让正常请求 + 合理图片通过。</summary>
    private const int MaxBodyChars = 8 * 1024 * 1024;

    /// <summary>读取请求体。返回 (body, tooLarge)：tooLarge=true 表示超原始上限（应回 413 input_too_large，
    /// 与"格式非法"区分，Bugbot）；body=null 且 tooLarge=false 表示解析失败/非对象（应回 400 invalid JSON）。</summary>
    private async Task<(JsonObject? body, bool tooLarge)> ReadBodyAsync(CancellationToken ct)
    {
        try
        {
            // 早拒：Content-Length 已超上限，连读都不读（Bugbot）
            if (Request.ContentLength is long cl && cl > MaxBodyChars) return (null, true);
            using var reader = new StreamReader(Request.Body, Encoding.UTF8);
            var buffer = new char[16384];
            var sb = new StringBuilder();
            int n;
            while ((n = await reader.ReadAsync(buffer, ct)) > 0)
            {
                sb.Append(buffer, 0, n);
                if (sb.Length > MaxBodyChars) return (null, true); // 无 Content-Length（分块）也有界，超界即拒，不无限读
            }
            if (sb.Length == 0) return (new JsonObject(), false);
            var raw = sb.ToString();
            if (string.IsNullOrWhiteSpace(raw)) return (new JsonObject(), false);
            return (JsonNode.Parse(raw) as JsonObject, false);
        }
        catch { return (null, false); }
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
