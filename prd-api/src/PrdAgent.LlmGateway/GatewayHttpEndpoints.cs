using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// serving 网关的 HTTP 端点装配（SSOT）。
/// 命名空间用 PrdAgent.LlmGatewayHost（非 PrdAgent.LlmGateway）——后者会与
/// PrdAgent.Infrastructure.LlmGateway.LlmGateway 类型的非限定引用在引用方撞车（CS0118）。Program.cs 与集成自测共用同一份端点映射，
/// 避免端点逻辑在测试里复制一份导致漂移。设计见 doc/design.llm-gateway-physical-isolation.md。
/// </summary>
public static class GatewayHttpEndpoints
{
    private static readonly JsonSerializerOptions SnakeJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// 装配 X-Gateway-Key 密钥门 + /gw/v1/* 全部 serving 端点。
    /// </summary>
    /// <param name="app">已 build 的 WebApplication。</param>
    /// <param name="jsonOpts">PascalCase JSON 口径（SSE 手动序列化复用）。</param>
    /// <param name="gatewayApiKey">内部 M2M 共享密钥（X-Gateway-Key）。</param>
    /// <param name="gitCommit">healthz 回显的构建 commit。</param>
    public static void MapGatewayServingEndpoints(
        this WebApplication app,
        JsonSerializerOptions jsonOpts,
        string gatewayApiKey,
        string gitCommit)
    {
        // 共享密钥门（内部 M2M，不走 JWT）：
        // - /gw/v1/* 除 healthz 外必须带 X-Gateway-Key。
        // - /v1/chat/completions 是给 sidecar / OpenAI-compatible M2M 客户端用的兼容入口，
        //   同样只接受 gateway key；为兼容 OpenAI SDK，允许 Authorization: Bearer <key>。
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path.Value ?? string.Empty;
            var protectedGatewayPath = path.StartsWith("/gw/v1", StringComparison.OrdinalIgnoreCase)
                                       && !path.StartsWith("/gw/v1/healthz", StringComparison.OrdinalIgnoreCase);
            var protectedOpenAiCompatPath = path.Equals("/v1/chat/completions", StringComparison.OrdinalIgnoreCase);
            if (protectedGatewayPath || protectedOpenAiCompatPath)
            {
                if (!HasGatewayKey(context, gatewayApiKey))
                {
                    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                    await context.Response.WriteAsync("unauthorized");
                    return;
                }
            }
            await next();
        });

        app.MapGet("/gw/v1/healthz", () => Results.Content(JsonSerializer.Serialize(new
        {
            status = "ok",
            commit = gitCommit,
            time = DateTime.UtcNow.ToString("o"),
        }, jsonOpts), "application/json"));

        // OpenAI-compatible M2M 入口。用于 claude-sdk-sidecar 的 legacy/openai-compatible
        // 工具循环：sidecar 继续负责多轮 tool calls，模型请求统一穿过 llmgw-serve。
        app.MapPost("/v1/chat/completions", async (
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            var requestId = ResolveHeader(http, "X-Request-Id") ?? Guid.NewGuid().ToString("N");
            var appCallerCode = ResolveHeader(http, "X-Gateway-App-Caller")
                                ?? AppCallerRegistry.PageAgent.Generate;
            var userId = ResolveHeader(http, "X-Gateway-User-Id");

            var body = await ReadJsonBodyAsync(http.Request, CancellationToken.None);
            if (body == null)
            {
                http.Response.StatusCode = StatusCodes.Status400BadRequest;
                http.Response.ContentType = "application/json";
                await http.Response.WriteAsync(JsonSerializer.Serialize(new
                {
                    error = new { message = "请求体必须是合法 JSON object", type = "invalid_request_error", code = "invalid_json" }
                }, SnakeJson));
                return;
            }

            var requestedModel = ReadString(body, "model");
            var stream = ReadBool(body, "stream");
            body.Remove("model");

            var gatewayRequest = new GatewayRequest
            {
                AppCallerCode = appCallerCode,
                ModelType = ModelTypes.Chat,
                ExpectedModel = string.IsNullOrWhiteSpace(requestedModel) ? null : requestedModel,
                RequestBody = body,
                Stream = stream,
                IncludeThinking = true,
                TimeoutSeconds = 600,
                Context = new GatewayRequestContext
                {
                    RequestId = requestId,
                    UserId = userId,
                    QuestionText = ExtractQuestionText(body),
                    GatewayTransport = GatewayTransports.Http,
                }
            };

            using var _ = OpenContextScope(accessor, gatewayRequest.Context, gatewayRequest.ModelType, gatewayRequest.AppCallerCode);
            if (stream)
            {
                await StreamOpenAiCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
            }
            else
            {
                await SendOpenAiCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
            }
        });

        // 预解析模型调度结果（不发送请求）。
        app.MapPost("/gw/v1/resolve", async (
            ResolveRequestDto body,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway) =>
        {
            var resolution = await gateway.ResolveModelAsync(
                body.AppCallerCode, body.ModelType, body.ExpectedModel, body.PinnedPlatformId, body.PinnedModelId, CancellationToken.None);
            return Results.Json(resolution, jsonOpts);
        });

        // 非流式发送。
        app.MapPost("/gw/v1/send", async (
            GatewayRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            using var _ = OpenContextScope(accessor, request.Context, request.ModelType, request.AppCallerCode);
            var response = await gateway.SendAsync(request, CancellationToken.None);
            return Results.Json(response, jsonOpts);
        });

        // 流式发送（SSE）。server-authority：客户端断开不取消网关任务，向网关传 CancellationToken.None，
        // 仅在写失败时静默 break。
        app.MapPost("/gw/v1/stream", async (
            HttpContext http,
            GatewayRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            http.Response.Headers.ContentType = "text/event-stream";
            http.Response.Headers.CacheControl = "no-cache";
            http.Response.Headers["X-Accel-Buffering"] = "no";

            using var _ = OpenContextScope(accessor, request.Context, request.ModelType, request.AppCallerCode);
            try
            {
                await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
                {
                    var data = "data: " + JsonSerializer.Serialize(chunk, jsonOpts) + "\n\n";
                    await http.Response.WriteAsync(data);
                    await http.Response.Body.FlushAsync();
                }
            }
            catch (OperationCanceledException)
            {
                // 客户端断开或写中断：静默停止写循环（不向网关传递取消）。
            }
            catch (ObjectDisposedException)
            {
                // 响应已释放：静默停止。
            }
        });

        // 服务端解析后发原始 HTTP（API Key 解析保留在服务端）。
        app.MapPost("/gw/v1/raw", async (
            GatewayRawRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            IServiceProvider services) =>
        {
            using var _ = OpenContextScope(accessor, request.Context, request.ModelType, request.AppCallerCode);
            var rehydrated = await RehydrateMultipartFileRefsAsync(request, services.GetService<IAssetStorage>(), CancellationToken.None);
            if (!rehydrated.Success)
            {
                return JsonContentResult(rehydrated.Error, jsonOpts);
            }

            request = rehydrated.Request ?? request;
            var res = await gateway.ResolveModelAsync(
                request.AppCallerCode, request.ModelType, request.ExpectedModel, request.PinnedPlatformId, request.PinnedModelId, CancellationToken.None);
            var raw = await gateway.SendRawWithResolutionAsync(request, res, CancellationToken.None);
            return JsonContentResult(raw, jsonOpts);
        });

        // 用户保存的 Infra Agent runtime profile 连通性测试。
        // 该端点只接受内部 M2M 调用（受 X-Gateway-Key 保护），上游 API key 只用于本次测试发送，
        // 不向 MAP 进程暴露任何网关发送细节。
        app.MapPost("/gw/v1/profile-test", async (
            GatewayUpstreamProfileTestRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway) =>
        {
            var raw = await gateway.TestUpstreamProfileAsync(request, CancellationToken.None);
            return JsonContentResult(raw, jsonOpts);
        });

        // 可用模型池列表。
        app.MapGet("/gw/v1/pools", async (
            string appCallerCode,
            string modelType,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway) =>
        {
            var pools = await gateway.GetAvailablePoolsAsync(appCallerCode, modelType, CancellationToken.None);
            return Results.Json(pools, jsonOpts);
        });

        // ILLMClient 流式生成（SSE）。供 MAP 侧 HttpLlmClient（CreateClient 路径）跨进程调用。
        // MAP 侧把当前 LlmRequestContext 经 body.Context 透传过来，本端点据此开作用域，
        // 让 serving 端日志关联（RequestId/SessionId/GroupId/UserId）与用户归属与 send/stream 端点一致。
        // server-authority：客户端断开不取消网关任务，向网关传 CancellationToken.None，仅写失败时静默 break。
        app.MapPost("/gw/v1/client-stream", async (
            HttpContext http,
            ClientStreamRequestDto body,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor) =>
        {
            http.Response.Headers.ContentType = "text/event-stream";
            http.Response.Headers.CacheControl = "no-cache";
            http.Response.Headers["X-Accel-Buffering"] = "no";

            using var _ = OpenContextScope(accessor, body.Context, body.ModelType, body.AppCallerCode);
            var client = gateway.CreateClient(
                body.AppCallerCode,
                body.ModelType,
                body.MaxTokens,
                body.Temperature,
                body.IncludeThinking,
                body.ExpectedModel,
                body.PinnedPlatformId,
                body.PinnedModelId);

            try
            {
                await foreach (var chunk in client.StreamGenerateAsync(body.SystemPrompt, body.Messages, body.EnablePromptCache, CancellationToken.None))
                {
                    var data = "data: " + JsonSerializer.Serialize(chunk, jsonOpts) + "\n\n";
                    await http.Response.WriteAsync(data);
                    await http.Response.Body.FlushAsync();
                }
            }
            catch (OperationCanceledException)
            {
                // 客户端断开或写中断：静默停止写循环（不向网关传递取消）。
            }
            catch (ObjectDisposedException)
            {
                // 响应已释放：静默停止。
            }
        });

        // 影子比对读端点（观测）：X-Gateway-Key 门内，读 llm_gateway.llmshadow_comparisons 给汇总 + 最近 N 条。
        // 灰度翻 http 前看「inproc vs http 逐字段一致性」的窗口（去黑盒）。
        app.MapGet("/gw/v1/shadow-comparisons", async (
            // [FromServices] 必填：GET 端点不允许「推断 body」参数，IServiceProvider 若被推断为 body，
            // RequestDelegateFactory 在首个请求构建 endpoint matcher 时会抛
            // InvalidOperationException（"Body was inferred but the method does not allow inferred body
            // parameters"），进而拖垮整张路由表（含 healthz / 全部 /gw/v1/*）。见 GatewayKeyGateContractTests。
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services,
            int? limit,
            int? failureLimit,
            string? appCallerCode,
            string? kind,
            string? releaseCommit,
            double? sinceHours) =>
        {
            var n = Math.Clamp(limit ?? 50, 1, 500);
            var db = services.GetService<LlmGatewayDataContext>()?.Context
                ?? services.GetRequiredService<MongoDbContext>();
            var col = db.LlmShadowComparisons;
            var filters = new List<FilterDefinition<LlmShadowComparison>>();
            if (!string.IsNullOrWhiteSpace(appCallerCode))
                filters.Add(Builders<LlmShadowComparison>.Filter.Eq(x => x.AppCallerCode, appCallerCode.Trim()));
            if (!string.IsNullOrWhiteSpace(kind))
                filters.Add(Builders<LlmShadowComparison>.Filter.Eq(x => x.Kind, kind.Trim()));
            var normalizedReleaseCommit = NormalizeCommitFilter(releaseCommit);
            if (normalizedReleaseCommit is not null)
                filters.Add(Builders<LlmShadowComparison>.Filter.Eq(x => x.ReleaseCommit, normalizedReleaseCommit));
            var since = sinceHours is > 0 ? DateTime.UtcNow.AddHours(-sinceHours.Value) : (DateTime?)null;
            if (since is not null)
                filters.Add(Builders<LlmShadowComparison>.Filter.Gte(x => x.ComparedAt, since.Value));
            var filter = filters.Count == 0
                ? FilterDefinition<LlmShadowComparison>.Empty
                : Builders<LlmShadowComparison>.Filter.And(filters);

            var total = await col.CountDocumentsAsync(filter);
            var allMatch = await col.CountDocumentsAsync(filter & Builders<LlmShadowComparison>.Filter.Eq(x => x.AllMatch, true));
            var critical = await col.CountDocumentsAsync(filter & Builders<LlmShadowComparison>.Filter.Eq(x => x.HasCritical, true));
            var httpFail = await col.CountDocumentsAsync(filter & Builders<LlmShadowComparison>.Filter.Eq(x => x.HttpOk, false));
            var first = total > 0
                ? (await col.Find(filter).SortBy(x => x.ComparedAt).Limit(1).FirstOrDefaultAsync())?.ComparedAt
                : null;
            var last = total > 0
                ? (await col.Find(filter).SortByDescending(x => x.ComparedAt).Limit(1).FirstOrDefaultAsync())?.ComparedAt
                : null;
            var coverageHours = first is not null && last is not null
                ? Math.Max(0, (last.Value - first.Value).TotalHours)
                : 0;
            var recent = await col.Find(filter).SortByDescending(x => x.ComparedAt).Limit(n).ToListAsync();
            var failureN = Math.Clamp(failureLimit ?? 10, 0, 100);
            var failureRecent = failureN == 0
                ? new List<LlmShadowComparison>()
                : await col.Find(filter & (Builders<LlmShadowComparison>.Filter.Eq(x => x.HttpOk, false)
                                           | Builders<LlmShadowComparison>.Filter.Eq(x => x.HasCritical, true)))
                    .SortByDescending(x => x.ComparedAt)
                    .Limit(failureN)
                    .ToListAsync();

            return Results.Json(new
            {
                summary = new { total, allMatch, critical, httpFail, sinceHours, since, releaseCommit = normalizedReleaseCommit, firstComparedAt = first, lastComparedAt = last, coverageHours },
                recent,
                failureRecent,
            }, jsonOpts);
        });
    }

    static string? NormalizeCommitFilter(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.StartsWith("sha-", StringComparison.OrdinalIgnoreCase))
            trimmed = trimmed[4..];
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed.ToLowerInvariant();
    }

    private static bool HasGatewayKey(HttpContext context, string gatewayApiKey)
    {
        var provided = context.Request.Headers["X-Gateway-Key"].FirstOrDefault();
        if (string.Equals(provided, gatewayApiKey, StringComparison.Ordinal))
            return true;

        var auth = context.Request.Headers.Authorization.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(auth)
            && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            && string.Equals(auth["Bearer ".Length..].Trim(), gatewayApiKey, StringComparison.Ordinal))
            return true;

        return false;
    }

    private static async Task<JsonObject?> ReadJsonBodyAsync(HttpRequest request, CancellationToken ct)
    {
        try
        {
            var body = await JsonNode.ParseAsync(request.Body, cancellationToken: ct);
            return body as JsonObject;
        }
        catch
        {
            return null;
        }
    }

    private static string? ResolveHeader(HttpContext http, string name)
    {
        var value = http.Request.Headers[name].FirstOrDefault();
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    private static string? ReadString(JsonObject body, string key)
        => body.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<string>(out var s)
            ? s
            : null;

    private static bool ReadBool(JsonObject body, string key)
        => body.TryGetPropertyValue(key, out var node) && node is JsonValue value && value.TryGetValue<bool>(out var b) && b;

    private static string? ExtractQuestionText(JsonObject body)
    {
        if (body.TryGetPropertyValue("messages", out var messagesNode) && messagesNode is JsonArray messages)
        {
            for (var i = messages.Count - 1; i >= 0; i--)
            {
                if (messages[i] is not JsonObject message) continue;
                if (!string.Equals(ReadString(message, "role"), "user", StringComparison.OrdinalIgnoreCase)) continue;
                var content = message["content"];
                if (content is JsonValue v && v.TryGetValue<string>(out var s)) return s;
                if (content is JsonArray arr) return arr.ToJsonString();
            }
        }
        return null;
    }

    private static async Task SendOpenAiCompatibleAsync(
        HttpContext http,
        PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
        GatewayRequest request,
        string requestId,
        string? requestedModel)
    {
        var response = await gateway.SendAsync(request, CancellationToken.None);
        var model = response.Resolution?.ActualModel ?? requestedModel ?? "auto";
        if (!response.Success)
        {
            http.Response.StatusCode = response.StatusCode > 0 ? response.StatusCode : StatusCodes.Status502BadGateway;
            http.Response.ContentType = "application/json";
            await http.Response.WriteAsync(JsonSerializer.Serialize(new
            {
                error = new { message = response.ErrorMessage ?? "上游模型调用失败", type = "api_error", code = response.ErrorCode }
            }, SnakeJson));
            return;
        }

        var usage = new
        {
            promptTokens = response.TokenUsage?.InputTokens ?? 0,
            completionTokens = response.TokenUsage?.OutputTokens ?? 0,
            totalTokens = (response.TokenUsage?.InputTokens ?? 0) + (response.TokenUsage?.OutputTokens ?? 0),
        };
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        http.Response.ContentType = "application/json";
        if (response.ToolCalls is { Count: > 0 })
        {
            var toolCompletion = new
            {
                id = $"chatcmpl-{requestId}",
                @object = "chat.completion",
                created,
                model,
                choices = new[] { new { index = 0, message = new { role = "assistant", content = (string?)null, toolCalls = response.ToolCalls }, finishReason = "tool_calls" } },
                usage,
            };
            await http.Response.WriteAsync(JsonSerializer.Serialize(toolCompletion, SnakeJson));
            return;
        }

        var textCompletion = new
        {
            id = $"chatcmpl-{requestId}",
            @object = "chat.completion",
            created,
            model,
            choices = new[] { new { index = 0, message = new { role = "assistant", content = response.Content ?? string.Empty, toolCalls = (JsonArray?)null }, finishReason = "stop" } },
            usage,
        };
        await http.Response.WriteAsync(JsonSerializer.Serialize(textCompletion, SnakeJson));
    }

    private static async Task StreamOpenAiCompatibleAsync(
        HttpContext http,
        PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
        GatewayRequest request,
        string requestId,
        string? requestedModel)
    {
        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no";

        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var model = requestedModel ?? "auto";
        var sentRole = false;
        var doneSent = false;

        async Task WriteSseAsync(object data)
        {
            await http.Response.WriteAsync("data: " + JsonSerializer.Serialize(data, SnakeJson) + "\n\n");
            await http.Response.Body.FlushAsync();
        }

        async Task SendDoneAsync()
        {
            if (doneSent) return;
            doneSent = true;
            await http.Response.WriteAsync("data: [DONE]\n\n");
            await http.Response.Body.FlushAsync();
        }

        try
        {
            await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    model = chunk.Resolution.ActualModel ?? model;
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (!sentRole)
                    {
                        await WriteSseAsync(BuildOpenAiChunk(requestId, created, model, new { role = "assistant" }, null));
                        sentRole = true;
                    }
                    await WriteSseAsync(BuildOpenAiChunk(requestId, created, model, new { content = chunk.Content }, null));
                }
                else if (chunk.Type == GatewayChunkType.Thinking && !string.IsNullOrEmpty(chunk.Content))
                {
                    await WriteSseAsync(BuildOpenAiChunk(requestId, created, model, new { reasoning = chunk.Content, reasoningContent = chunk.Content }, null));
                }
                else if (chunk.Type == GatewayChunkType.ToolCall && chunk.ToolCallDelta != null)
                {
                    if (!sentRole)
                    {
                        await WriteSseAsync(BuildOpenAiChunk(requestId, created, model, new { role = "assistant" }, null));
                        sentRole = true;
                    }
                    await WriteSseAsync(BuildOpenAiChunk(requestId, created, model, new { toolCalls = chunk.ToolCallDelta }, null));
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteSseAsync(new
                    {
                        id = $"chatcmpl-{requestId}",
                        @object = "chat.completion.chunk",
                        created,
                        model,
                        choices = new[] { new { index = 0, delta = new { }, finishReason = "error" } },
                        error = new { message = chunk.Error ?? "上游模型调用失败", type = "api_error", code = "upstream_error" },
                    });
                    await SendDoneAsync();
                    return;
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    var promptTokens = chunk.TokenUsage?.InputTokens ?? 0;
                    var completionTokens = chunk.TokenUsage?.OutputTokens ?? 0;
                    await WriteSseAsync(new
                    {
                        id = $"chatcmpl-{requestId}",
                        @object = "chat.completion.chunk",
                        created,
                        model,
                        choices = new[] { new { index = 0, delta = new { }, finishReason = chunk.FinishReason ?? "stop" } },
                        usage = new { promptTokens, completionTokens, totalTokens = promptTokens + completionTokens },
                    });
                    await SendDoneAsync();
                }
            }

            await SendDoneAsync();
        }
        catch (OperationCanceledException)
        {
            // 客户端断开或写中断：保持 server-authority，不向网关传递取消。
        }
        catch (ObjectDisposedException)
        {
            // 响应已释放：静默停止。
        }
    }

    private static object BuildOpenAiChunk(string requestId, long created, string model, object delta, string? finishReason)
        => new
        {
            id = $"chatcmpl-{requestId}",
            @object = "chat.completion.chunk",
            created,
            model,
            choices = new[] { new { index = 0, delta, finishReason } },
        };

    // 把 GatewayRequestContext 转成 LlmRequestContext 并打开作用域。
    // LlmRequestContext 必填位置参数：RequestId / GroupId / SessionId / UserId / ViewRole /
    //   DocumentChars / DocumentHash / SystemPromptRedacted，随后是可选 RequestType / AppCallerCode。
    private static IDisposable OpenContextScope(
        ILLMRequestContextAccessor accessor,
        GatewayRequestContext? ctx,
        string requestType,
        string appCallerCode)
    {
        return accessor.BeginScope(new LlmRequestContext(
            RequestId: ctx?.RequestId ?? Guid.NewGuid().ToString("N"),
            GroupId: ctx?.GroupId,
            SessionId: ctx?.SessionId,
            UserId: ctx?.UserId,
            ViewRole: ctx?.ViewRole,
            DocumentChars: ctx?.DocumentChars,
            DocumentHash: ctx?.DocumentHash,
            SystemPromptRedacted: null,
            RequestType: requestType,
            AppCallerCode: appCallerCode,
            // S2：MAP 侧 http 模式已把传输标记随 body.Context 过线，透传进作用域，
            // 供 serving 端直连客户端（若有）读取；网关日志由 LlmGateway 直接读 request.Context 标注。
            GatewayTransport: ctx?.GatewayTransport));
    }

    private static IResult JsonContentResult<T>(T value, JsonSerializerOptions jsonOpts)
        => Results.Content(JsonSerializer.Serialize(value, jsonOpts), "application/json");

    private static async Task<RehydrateResult> RehydrateMultipartFileRefsAsync(
        GatewayRawRequest request,
        IAssetStorage? storage,
        CancellationToken ct)
    {
        if (!request.IsMultipart
            || request.MultipartFileRefs is not { Count: > 0 }
            || request.MultipartFiles is { Count: > 0 })
        {
            return RehydrateResult.Ok(request);
        }

        if (storage == null)
        {
            return RehydrateResult.Fail(
                "MULTIPART_STORAGE_UNAVAILABLE",
                "serving 未注册 IAssetStorage，无法按 MultipartFileRefs rehydrate 文件。");
        }

        var files = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>(StringComparer.Ordinal);
        foreach (var (fieldName, fileRef) in request.MultipartFileRefs)
        {
            if (string.IsNullOrWhiteSpace(fileRef.RefKey))
            {
                return RehydrateResult.Fail("MULTIPART_REF_INVALID", $"multipart 字段 {fieldName} 缺少 RefKey。", 400);
            }

            var bytes = await storage.TryDownloadBytesAsync(fileRef.RefKey, ct);
            if (bytes == null)
            {
                return RehydrateResult.Fail("MULTIPART_REF_NOT_FOUND", $"multipart 字段 {fieldName} 引用的对象不存在。", 404);
            }

            if (fileRef.SizeBytes > 0 && bytes.LongLength != fileRef.SizeBytes)
            {
                return RehydrateResult.Fail(
                    "MULTIPART_REF_SIZE_MISMATCH",
                    $"multipart 字段 {fieldName} 文件大小不一致：ref={fileRef.SizeBytes}, actual={bytes.LongLength}。",
                    400);
            }

            var actualSha = Sha256Hex(bytes);
            if (!string.IsNullOrWhiteSpace(fileRef.Sha256)
                && !string.Equals(actualSha, fileRef.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                return RehydrateResult.Fail(
                    "MULTIPART_REF_HASH_MISMATCH",
                    $"multipart 字段 {fieldName} 文件 hash 不一致。",
                    400);
            }

            var fileName = string.IsNullOrWhiteSpace(fileRef.FileName)
                ? $"{fieldName}.bin"
                : Path.GetFileName(fileRef.FileName);
            var mime = string.IsNullOrWhiteSpace(fileRef.MimeType)
                ? "application/octet-stream"
                : fileRef.MimeType;
            files[fieldName] = (fileName, bytes, mime);
        }

        var hydrated = new GatewayRawRequest
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = request.ModelType,
            EndpointPath = request.EndpointPath,
            ExpectedModel = request.ExpectedModel,
            PinnedPlatformId = request.PinnedPlatformId,
            PinnedModelId = request.PinnedModelId,
            RequestBody = request.RequestBody,
            IsMultipart = request.IsMultipart,
            MultipartFields = request.MultipartFields,
            MultipartFiles = files,
            MultipartFileRefs = request.MultipartFileRefs,
            HttpMethod = request.HttpMethod,
            ExtraHeaders = request.ExtraHeaders,
            TimeoutSeconds = request.TimeoutSeconds,
            ExpectBinaryResponse = request.ExpectBinaryResponse,
            Context = request.Context,
        };

        return RehydrateResult.Ok(hydrated);
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(bytes)).ToLowerInvariant();
    }

    private sealed record RehydrateResult(
        bool Success,
        GatewayRawRequest? Request,
        GatewayRawResponse? Error)
    {
        public static RehydrateResult Ok(GatewayRawRequest request) => new(true, request, null);

        public static RehydrateResult Fail(string code, string message, int statusCode = 500)
            => new(false, null, GatewayRawResponse.Fail(code, message, statusCode));
    }
}

// /gw/v1/resolve 的请求体 DTO（PascalCase）。
public sealed record ResolveRequestDto(
    string AppCallerCode,
    string ModelType,
    string? ExpectedModel,
    string? PinnedPlatformId,
    string? PinnedModelId);

// /gw/v1/client-stream 的请求体 DTO（PascalCase）。Messages 用 Core 的 LLMMessage，
// 与 MAP 侧 HttpLlmClient 序列化口径一致。
public sealed record ClientStreamRequestDto(
    string AppCallerCode,
    string ModelType,
    int MaxTokens,
    double Temperature,
    bool IncludeThinking,
    string? ExpectedModel,
    string? PinnedPlatformId,
    string? PinnedModelId,
    string SystemPrompt,
    List<PrdAgent.Core.Interfaces.LLMMessage> Messages,
    bool EnablePromptCache,
    GatewayRequestContext? Context = null);
