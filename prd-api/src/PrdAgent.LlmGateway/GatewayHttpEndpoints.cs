using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
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
            var protectedCompatPath =
                IsOpenAiCompatibleProtectedPath(path)
                || path.Equals("/v1/messages", StringComparison.OrdinalIgnoreCase)
                || path.StartsWith("/v1beta/models/", StringComparison.OrdinalIgnoreCase)
                || path.StartsWith("/gemini/v1beta/models/", StringComparison.OrdinalIgnoreCase);
            if (protectedGatewayPath || protectedCompatPath)
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

        // 协议路由 dry-run 自检：不访问上游、不写 appCaller 注册表、不递增限流窗口。
        // 用于维护窗口第一步确认四类入口协议能落到同一套 IR 与路由元数据。
        app.MapGet("/gw/v1/route-self-test", () =>
        {
            var cases = BuildRouteSelfTestCases();
            var passed = cases.Count(x => x.Passed);
            return Results.Json(new RouteSelfTestResponse(
                Status: passed == cases.Count ? "ok" : "failed",
                Mode: "dry-run",
                UpstreamCalled: false,
                Total: cases.Count,
                Passed: passed,
                Cases: cases), jsonOpts);
        });

        // OpenAI Responses 兼容入口。外部仍按 OpenAI 心智传 input / instructions，
        // 内部统一转成 chat-style GatewayRequest，router、日志、appCaller registry 不分叉。
        app.MapPost("/v1/responses", async (
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            IServiceProvider services) =>
        {
            var body = await ReadJsonBodyAsync(http.Request, CancellationToken.None);
            if (body == null)
            {
                await WriteCompatErrorAsync(http, "请求体必须是合法 JSON object", "invalid_request_error", "invalid_json", 400);
                return;
            }

            var requestId = ResolveHeader(http, "X-Request-Id") ?? Guid.NewGuid().ToString("N");
            var runId = ResolveCompatRunId(http, body);
            var requestedModel = ReadString(body, "model");
            var modelPoolId = ResolveCompatModelPoolId(http, body);
            var (pinnedPlatformId, pinnedModelId) = ResolveCompatPinnedTarget(http, body);
            var modelPolicy = ResolveCompatModelPolicy(http, body, requestedModel, pinnedPlatformId, pinnedModelId);
            var stream = ReadBool(body, "stream");
            StripGatewayRoutingFields(body);
            var droppedParameters = FindDroppedParameters(
                body,
                "model", "input", "instructions", "max_output_tokens", "temperature", "top_p",
                "stream", "tools", "tool_choice", "metadata", "reasoning", "logprobs", "top_logprobs", "parallel_tool_calls",
                "provider", "model_policy", "modelPolicy", "model_pool_id", "modelPoolId",
                "pinned_platform_id", "pinnedPlatformId", "pinned_model_id", "pinnedModelId");
            var openAiBody = ConvertOpenAiResponsesToChatBody(body);
            var requestType = ContainsOpenAiImageInput(openAiBody) ? ModelTypes.Vision : ModelTypes.Chat;
            var defaultAppCaller = string.Equals(requestType, ModelTypes.Vision, StringComparison.OrdinalIgnoreCase)
                ? AppCallerRegistry.OpenApi.Proxy.Vision
                : AppCallerRegistry.OpenApi.Proxy.Chat;

            var ingress = new GatewayIngressRequest
            {
                RequestId = requestId,
                SourceSystem = ResolveHeader(http, "X-Gateway-Source") ?? "external",
                IngressProtocol = "openai-compatible",
                AppCallerCode = ResolveHeader(http, "X-Gateway-App-Caller") ?? defaultAppCaller,
                AppCallerTitle = ResolveHeader(http, "X-OpenRouter-Title") ?? ResolveHeader(http, "X-Gateway-App-Title"),
                RequestType = requestType,
                ModelPolicy = modelPolicy,
                ModelPoolId = modelPoolId,
                ParameterPolicy = ReadProviderRequireParameters(body) ? "strict-require" : "default-drop",
                ExpectedModel = string.IsNullOrWhiteSpace(requestedModel) ? null : requestedModel,
                PinnedPlatformId = pinnedPlatformId,
                PinnedModelId = pinnedModelId,
                RequestBody = openAiBody,
                DroppedParameters = droppedParameters,
                Context = new GatewayRequestContext
                {
                    RequestId = requestId,
                    RunId = runId,
                    UserId = ResolveHeader(http, "X-Gateway-User-Id"),
                    QuestionText = ExtractQuestionText(openAiBody),
                    GatewayTransport = GatewayTransports.Http,
                },
            };

            if (await TryRejectStrictDroppedParametersAsync(http, ingress))
                return;

            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;
            var gatewayRequest = ingress.ToGatewayRequest(stream);
            using var _ = OpenContextScope(accessor, gatewayRequest.Context, gatewayRequest.ModelType, gatewayRequest.AppCallerCode);
            if (stream)
                await StreamOpenAiResponsesCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
            else
                await SendOpenAiResponsesCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
        });

        // OpenAI Images 兼容入口。JSON 文生图走 raw JSON；图片编辑走 raw multipart。
        app.MapPost("/v1/images/generations", async (
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            IServiceProvider services) =>
        {
            var body = await ReadJsonBodyAsync(http.Request, CancellationToken.None);
            if (body == null)
            {
                await WriteCompatErrorAsync(http, "请求体必须是合法 JSON object", "invalid_request_error", "invalid_json", 400);
                return;
            }

            var requestId = ResolveHeader(http, "X-Request-Id") ?? Guid.NewGuid().ToString("N");
            var runId = ResolveCompatRunId(http, body);
            var requestedModel = ReadString(body, "model");
            var modelPoolId = ResolveCompatModelPoolId(http, body);
            var (pinnedPlatformId, pinnedModelId) = ResolveCompatPinnedTarget(http, body);
            var modelPolicy = ResolveCompatModelPolicy(http, body, requestedModel, pinnedPlatformId, pinnedModelId);
            body.Remove("model");
            StripGatewayRoutingFields(body);

            var ingress = new GatewayIngressRequest
            {
                RequestId = requestId,
                SourceSystem = ResolveHeader(http, "X-Gateway-Source") ?? "external",
                IngressProtocol = "openai-compatible",
                AppCallerCode = ResolveHeader(http, "X-Gateway-App-Caller") ?? AppCallerRegistry.OpenApi.Proxy.Generation,
                AppCallerTitle = ResolveHeader(http, "X-OpenRouter-Title") ?? ResolveHeader(http, "X-Gateway-App-Title"),
                RequestType = ModelTypes.ImageGen,
                ModelPolicy = modelPolicy,
                ModelPoolId = modelPoolId,
                ParameterPolicy = ReadProviderRequireParameters(body) ? "strict-require" : "default-drop",
                ExpectedModel = string.IsNullOrWhiteSpace(requestedModel) ? null : requestedModel,
                PinnedPlatformId = pinnedPlatformId,
                PinnedModelId = pinnedModelId,
                RequestBody = body,
                DroppedParameters = FindDroppedParameters(
                    body,
                    "prompt", "n", "size", "quality", "style", "response_format", "user",
                    "provider", "model_policy", "modelPolicy", "model_pool_id", "modelPoolId",
                    "pinned_platform_id", "pinnedPlatformId", "pinned_model_id", "pinnedModelId"),
                Context = new GatewayRequestContext
                {
                    RequestId = requestId,
                    RunId = runId,
                    UserId = ResolveHeader(http, "X-Gateway-User-Id"),
                    QuestionText = ReadString(body, "prompt"),
                    GatewayTransport = GatewayTransports.Http,
                },
            };

            if (await TryRejectStrictDroppedParametersAsync(http, ingress))
                return;

            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;
            var rawRequest = ToOpenAiImageRawRequest(ingress);
            using var _ = OpenContextScope(accessor, rawRequest.Context, rawRequest.ModelType, rawRequest.AppCallerCode);
            var resolution = await gateway.ResolveModelAsync(
                rawRequest.AppCallerCode,
                rawRequest.ModelType,
                rawRequest.ExpectedModel,
                rawRequest.PinnedPlatformId,
                rawRequest.PinnedModelId,
                CancellationToken.None);
            var raw = await gateway.SendRawWithResolutionAsync(rawRequest, resolution, CancellationToken.None);
            await WriteOpenAiRawCompatAsync(http, raw);
        });

        app.MapPost("/v1/images/edits", async (
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            IServiceProvider services) =>
        {
            if (!http.Request.HasFormContentType)
            {
                await WriteCompatErrorAsync(http, "请求体必须是 multipart/form-data", "invalid_request_error", "invalid_content_type", 400);
                return;
            }

            var parsed = await ReadOpenAiImageMultipartAsync(http.Request, CancellationToken.None);
            if (!parsed.Success)
            {
                await WriteCompatErrorAsync(http, parsed.ErrorMessage ?? "multipart 请求解析失败", "invalid_request_error", parsed.ErrorCode, parsed.StatusCode);
                return;
            }

            var requestId = ResolveHeader(http, "X-Request-Id") ?? Guid.NewGuid().ToString("N");
            var requestedModel = parsed.Model;
            var multipartFields = parsed.MultipartFields ?? new Dictionary<string, object>(StringComparer.Ordinal);
            var runId = ResolveCompatRunId(http, multipartFields);
            var modelPoolId = ResolveCompatModelPoolId(http, multipartFields);
            var (pinnedPlatformId, pinnedModelId) = ResolveCompatPinnedTarget(http, multipartFields);
            var modelPolicy = ResolveCompatModelPolicy(http, multipartFields, requestedModel, pinnedPlatformId, pinnedModelId);
            var ingress = new GatewayIngressRequest
            {
                RequestId = requestId,
                SourceSystem = ResolveHeader(http, "X-Gateway-Source") ?? "external",
                IngressProtocol = "openai-compatible",
                AppCallerCode = ResolveHeader(http, "X-Gateway-App-Caller") ?? AppCallerRegistry.OpenApi.Proxy.Generation,
                AppCallerTitle = ResolveHeader(http, "X-OpenRouter-Title") ?? ResolveHeader(http, "X-Gateway-App-Title"),
                RequestType = ModelTypes.ImageGen,
                ModelPolicy = modelPolicy,
                ModelPoolId = modelPoolId,
                ParameterPolicy = "default-drop",
                ExpectedModel = string.IsNullOrWhiteSpace(requestedModel) ? null : requestedModel,
                PinnedPlatformId = pinnedPlatformId,
                PinnedModelId = pinnedModelId,
                RequestBody = new JsonObject
                {
                    ["prompt"] = parsed.Prompt,
                },
                DroppedParameters = parsed.DroppedParameters,
                Context = new GatewayRequestContext
                {
                    RequestId = requestId,
                    RunId = runId,
                    UserId = ResolveHeader(http, "X-Gateway-User-Id"),
                    QuestionText = parsed.Prompt,
                    GatewayTransport = GatewayTransports.Http,
                },
            };

            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;
            var rawRequest = ToOpenAiImageRawRequest(
                ingress,
                "/v1/images/edits",
                multipartFields,
                parsed.MultipartFiles);
            using var _ = OpenContextScope(accessor, rawRequest.Context, rawRequest.ModelType, rawRequest.AppCallerCode);
            var resolution = await gateway.ResolveModelAsync(
                rawRequest.AppCallerCode,
                rawRequest.ModelType,
                rawRequest.ExpectedModel,
                rawRequest.PinnedPlatformId,
                rawRequest.PinnedModelId,
                CancellationToken.None);
            var raw = await gateway.SendRawWithResolutionAsync(rawRequest, resolution, CancellationToken.None);
            await WriteOpenAiRawCompatAsync(http, raw);
        });

        // OpenAI-compatible M2M 入口。用于 claude-sdk-sidecar 的 legacy/openai-compatible
        // 工具循环：sidecar 继续负责多轮 tool calls，模型请求统一穿过 llmgw-serve。
        app.MapPost("/v1/chat/completions", async (
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            IServiceProvider services) =>
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
            var runId = ResolveCompatRunId(http, body);
            var modelPoolId = ResolveCompatModelPoolId(http, body);
            var (pinnedPlatformId, pinnedModelId) = ResolveCompatPinnedTarget(http, body);
            var modelPolicy = ResolveCompatModelPolicy(http, body, requestedModel, pinnedPlatformId, pinnedModelId);
            var stream = ReadBool(body, "stream");
            body.Remove("model");
            StripGatewayRoutingFields(body);
            var droppedParameters = FindDroppedParameters(
                body,
                "messages", "max_tokens", "temperature", "top_p", "stream",
                "tools", "tool_choice", "response_format", "metadata", "reasoning", "logprobs", "top_logprobs", "parallel_tool_calls",
                "provider", "model_policy", "modelPolicy", "model_pool_id", "modelPoolId",
                "pinned_platform_id", "pinnedPlatformId", "pinned_model_id", "pinnedModelId");

            var ingress = new GatewayIngressRequest
            {
                RequestId = requestId,
                SourceSystem = ResolveHeader(http, "X-Gateway-Source") ?? "external",
                IngressProtocol = "openai-compatible",
                AppCallerCode = appCallerCode,
                AppCallerTitle = ResolveHeader(http, "X-OpenRouter-Title") ?? ResolveHeader(http, "X-Gateway-App-Title"),
                RequestType = ModelTypes.Chat,
                ModelPolicy = modelPolicy,
                ModelPoolId = modelPoolId,
                ParameterPolicy = ReadProviderRequireParameters(body) ? "strict-require" : "default-drop",
                ExpectedModel = string.IsNullOrWhiteSpace(requestedModel) ? null : requestedModel,
                PinnedPlatformId = pinnedPlatformId,
                PinnedModelId = pinnedModelId,
                RequestBody = body,
                DroppedParameters = droppedParameters,
                Context = new GatewayRequestContext
                {
                    RequestId = requestId,
                    RunId = runId,
                    UserId = userId,
                    QuestionText = ExtractQuestionText(body),
                    GatewayTransport = GatewayTransports.Http,
                }
            };

            if (await TryRejectStrictDroppedParametersAsync(http, ingress))
                return;

            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;
            var gatewayRequest = ingress.ToGatewayRequest(stream);
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

        // Claude-compatible 入口：接收 Anthropic Messages 形状，统一转成 GW IR 后进入同一个 router。
        app.MapPost("/v1/messages", async (
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services) =>
        {
            var body = await ReadJsonBodyAsync(http.Request, CancellationToken.None);
            if (body == null)
            {
                await WriteCompatErrorAsync(http, "请求体必须是合法 JSON object", "invalid_request_error", "invalid_json", 400);
                return;
            }

            var requestId = ResolveHeader(http, "X-Request-Id") ?? Guid.NewGuid().ToString("N");
            var runId = ResolveCompatRunId(http, body);
            var requestedModel = ReadString(body, "model");
            var modelPoolId = ResolveCompatModelPoolId(http, body);
            var (pinnedPlatformId, pinnedModelId) = ResolveCompatPinnedTarget(http, body);
            var modelPolicy = ResolveCompatModelPolicy(http, body, requestedModel, pinnedPlatformId, pinnedModelId);
            var stream = ReadBool(body, "stream");
            StripGatewayRoutingFields(body);
            var droppedParameters = FindDroppedParameters(
                body,
                "model", "system", "messages", "max_tokens", "temperature", "top_p", "top_k",
                "stream", "tools", "tool_choice", "stop_sequences", "model_policy", "modelPolicy", "model_pool_id", "modelPoolId",
                "pinned_platform_id", "pinnedPlatformId", "pinned_model_id", "pinnedModelId");
            var openAiBody = ConvertClaudeMessagesToOpenAiBody(body);
            openAiBody.Remove("model");
            var requestType = ContainsOpenAiImageInput(openAiBody) ? ModelTypes.Vision : ModelTypes.Chat;
            var defaultAppCaller = string.Equals(requestType, ModelTypes.Vision, StringComparison.OrdinalIgnoreCase)
                ? AppCallerRegistry.OpenApi.Proxy.Vision
                : AppCallerRegistry.OpenApi.Proxy.Chat;

            var ingress = new GatewayIngressRequest
            {
                RequestId = requestId,
                SourceSystem = ResolveHeader(http, "X-Gateway-Source") ?? "external",
                IngressProtocol = "claude-compatible",
                AppCallerCode = ResolveHeader(http, "X-Gateway-App-Caller") ?? defaultAppCaller,
                AppCallerTitle = ResolveHeader(http, "X-Gateway-App-Title"),
                RequestType = requestType,
                ModelPolicy = modelPolicy,
                ModelPoolId = modelPoolId,
                ParameterPolicy = "default-drop",
                ExpectedModel = string.IsNullOrWhiteSpace(requestedModel) ? null : requestedModel,
                PinnedPlatformId = pinnedPlatformId,
                PinnedModelId = pinnedModelId,
                RequestBody = openAiBody,
                DroppedParameters = droppedParameters,
                Context = new GatewayRequestContext
                {
                    RequestId = requestId,
                    RunId = runId,
                    UserId = ResolveHeader(http, "X-Gateway-User-Id"),
                    QuestionText = ExtractQuestionText(openAiBody),
                    GatewayTransport = GatewayTransports.Http,
                },
            };

            if (await TryRejectStrictDroppedParametersAsync(http, ingress))
                return;

            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;
            var gatewayRequest = ingress.ToGatewayRequest(stream);
            using var _ = OpenContextScope(accessor, gatewayRequest.Context, gatewayRequest.ModelType, gatewayRequest.AppCallerCode);
            if (stream)
                await StreamClaudeCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
            else
                await SendClaudeCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
        });

        // Gemini-compatible 入口：接收 generateContent 形状，统一转成 GW IR 后进入同一个 router。
        app.MapPost("/v1beta/models/{model}:generateContent", (
            string model,
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services)
            => GeminiGenerateContentAsync(model, stream: false, http, gateway, accessor, services));
        app.MapPost("/gemini/v1beta/models/{model}:generateContent", (
            string model,
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services)
            => GeminiGenerateContentAsync(model, stream: false, http, gateway, accessor, services));
        app.MapPost("/v1beta/models/{model}:streamGenerateContent", (
            string model,
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services)
            => GeminiGenerateContentAsync(model, stream: true, http, gateway, accessor, services));
        app.MapPost("/gemini/v1beta/models/{model}:streamGenerateContent", (
            string model,
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services)
            => GeminiGenerateContentAsync(model, stream: true, http, gateway, accessor, services));

        async Task GeminiGenerateContentAsync(
            string model,
            bool stream,
            HttpContext http,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services)
        {
            var body = await ReadJsonBodyAsync(http.Request, CancellationToken.None);
            if (body == null)
            {
                await WriteCompatErrorAsync(http, "请求体必须是合法 JSON object", "INVALID_ARGUMENT", "invalid_json", 400);
                return;
            }

            var requestId = ResolveHeader(http, "X-Request-Id") ?? Guid.NewGuid().ToString("N");
            var runId = ResolveCompatRunId(http, body);
            var requestedModel = NormalizeGeminiRouteModel(model);
            var modelPoolId = ResolveCompatModelPoolId(http, body);
            var (pinnedPlatformId, pinnedModelId) = ResolveCompatPinnedTarget(http, body);
            var modelPolicy = ResolveCompatModelPolicy(http, body, requestedModel, pinnedPlatformId, pinnedModelId);
            StripGatewayRoutingFields(body);
            var droppedParameters = FindDroppedParameters(
                body,
                "contents", "systemInstruction", "generationConfig", "tools", "toolConfig",
                "model_policy", "modelPolicy", "model_pool_id", "modelPoolId",
                "pinned_platform_id", "pinnedPlatformId", "pinned_model_id", "pinnedModelId");
            var openAiBody = ConvertGeminiGenerateContentToOpenAiBody(body);
            var requestType = ContainsOpenAiImageInput(openAiBody) ? ModelTypes.Vision : ModelTypes.Chat;
            var defaultAppCaller = string.Equals(requestType, ModelTypes.Vision, StringComparison.OrdinalIgnoreCase)
                ? AppCallerRegistry.OpenApi.Proxy.Vision
                : AppCallerRegistry.OpenApi.Proxy.Chat;

            var ingress = new GatewayIngressRequest
            {
                RequestId = requestId,
                SourceSystem = ResolveHeader(http, "X-Gateway-Source") ?? "external",
                IngressProtocol = "gemini-compatible",
                AppCallerCode = ResolveHeader(http, "X-Gateway-App-Caller") ?? defaultAppCaller,
                AppCallerTitle = ResolveHeader(http, "X-Gateway-App-Title"),
                RequestType = requestType,
                ModelPolicy = modelPolicy,
                ModelPoolId = modelPoolId,
                ParameterPolicy = "default-drop",
                ExpectedModel = requestedModel,
                PinnedPlatformId = pinnedPlatformId,
                PinnedModelId = pinnedModelId,
                RequestBody = openAiBody,
                DroppedParameters = droppedParameters,
                Context = new GatewayRequestContext
                {
                    RequestId = requestId,
                    RunId = runId,
                    UserId = ResolveHeader(http, "X-Gateway-User-Id"),
                    QuestionText = ExtractQuestionText(openAiBody),
                    GatewayTransport = GatewayTransports.Http,
                },
            };

            if (await TryRejectStrictDroppedParametersAsync(http, ingress))
                return;

            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;
            var gatewayRequest = ingress.ToGatewayRequest(stream);
            using var _ = OpenContextScope(accessor, gatewayRequest.Context, gatewayRequest.ModelType, gatewayRequest.AppCallerCode);
            if (stream)
                await StreamGeminiCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
            else
                await SendGeminiCompatibleAsync(http, gateway, gatewayRequest, requestId, requestedModel);
        }

        // 预解析模型调度结果（不发送请求）。
        app.MapPost("/gw/v1/resolve", async (
            ResolveRequestDto body,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services) =>
        {
            var resolveModelPolicy = NormalizeModelPolicy(body.ModelPolicy)
                                     ?? NormalizeModelPolicy(body.Context?.ModelPolicy);
            var resolveModelPoolId = FirstNonEmpty(body.ModelPoolId, body.Context?.ModelPoolId);
            var effectiveExpectedModel = string.Equals(resolveModelPolicy, "pool", StringComparison.OrdinalIgnoreCase)
                                         && !string.IsNullOrWhiteSpace(resolveModelPoolId)
                ? resolveModelPoolId
                : body.ExpectedModel;
            await RecordDiscoveredAppCallerAsync(services, new GatewayIngressRequest
            {
                RequestId = Guid.NewGuid().ToString("N"),
                SourceSystem = "map",
                IngressProtocol = "gw-native",
                AppCallerCode = body.AppCallerCode,
                RequestType = body.ModelType,
                ModelPolicy = resolveModelPolicy
                    ?? (!string.IsNullOrWhiteSpace(body.PinnedPlatformId) || !string.IsNullOrWhiteSpace(body.PinnedModelId)
                        ? "pinned"
                        : string.IsNullOrWhiteSpace(body.ExpectedModel) ? "auto" : "pinned"),
                ModelPoolId = resolveModelPoolId,
                ExpectedModel = effectiveExpectedModel,
                PinnedPlatformId = body.PinnedPlatformId,
                PinnedModelId = body.PinnedModelId,
            }, CancellationToken.None);
            var resolution = await gateway.ResolveModelAsync(
                body.AppCallerCode, body.ModelType, effectiveExpectedModel, body.PinnedPlatformId, body.PinnedModelId, CancellationToken.None);
            return Results.Json(resolution, jsonOpts);
        });

        async Task<IResult> HandleNativeInvokeAsync(
            HttpContext http,
            GatewayRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services)
        {
            var ingress = ToIngress(request, "gw-native", "map");
            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            var governanceResult = GovernanceResult(http, governance, jsonOpts);
            if (governanceResult is not null) return governanceResult;
            var routedRequest = ApplyIngressRouting(request, ingress, stream: false);
            using var _ = OpenContextScope(accessor, routedRequest.Context, routedRequest.ModelType, routedRequest.AppCallerCode);
            var response = await gateway.SendAsync(routedRequest, CancellationToken.None);
            return Results.Json(response, jsonOpts);
        }

        // GW Native 非流式调用入口。/gw/v1/invoke 是目标协议名，/gw/v1/send 保持 MAP 现有客户端兼容。
        app.MapPost("/gw/v1/invoke", HandleNativeInvokeAsync);
        app.MapPost("/gw/v1/send", HandleNativeInvokeAsync);

        // 流式发送（SSE）。server-authority：客户端断开不取消网关任务，向网关传 CancellationToken.None，
        // 仅在写失败时静默 break。
        app.MapPost("/gw/v1/stream", async (
            HttpContext http,
            GatewayRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services) =>
        {
            var ingress = ToIngress(request, "gw-native", "map");
            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;

            http.Response.Headers.ContentType = "text/event-stream";
            http.Response.Headers.CacheControl = "no-cache";
            http.Response.Headers["X-Accel-Buffering"] = "no";

            var routedRequest = ApplyIngressRouting(request, ingress, stream: true);
            using var _ = OpenContextScope(accessor, routedRequest.Context, routedRequest.ModelType, routedRequest.AppCallerCode);
            try
            {
                await foreach (var chunk in gateway.StreamAsync(routedRequest, CancellationToken.None))
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
            HttpContext http,
            GatewayRawRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services) =>
        {
            var ingress = ToIngress(request, "gw-native", "map");
            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            var governanceResult = GovernanceResult(http, governance, jsonOpts);
            if (governanceResult is not null) return governanceResult;
            var rehydrated = await RehydrateMultipartFileRefsAsync(request, services.GetService<IAssetStorage>(), CancellationToken.None);
            if (!rehydrated.Success)
            {
                return JsonContentResult(rehydrated.Error, jsonOpts);
            }

            request = rehydrated.Request ?? request;
            var routedRequest = ApplyIngressRouting(request, ingress);
            using var _ = OpenContextScope(accessor, routedRequest.Context, routedRequest.ModelType, routedRequest.AppCallerCode);
            var res = await gateway.ResolveModelAsync(
                routedRequest.AppCallerCode,
                routedRequest.ModelType,
                routedRequest.ExpectedModel,
                routedRequest.PinnedPlatformId,
                routedRequest.PinnedModelId,
                CancellationToken.None);
            var raw = await gateway.SendRawWithResolutionAsync(routedRequest, res, CancellationToken.None);
            return JsonContentResult(raw, jsonOpts);
        });

        // 用户保存的 Infra Agent runtime profile 连通性测试。
        // 该端点只接受内部 M2M 调用（受 X-Gateway-Key 保护），上游 API key 只用于本次测试发送，
        // 不向 MAP 进程暴露任何网关发送细节。
        app.MapPost("/gw/v1/profile-test", async (
            HttpContext http,
            GatewayUpstreamProfileTestRequest request,
            PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services) =>
        {
            var requestId = string.IsNullOrWhiteSpace(request.RequestId) ? Guid.NewGuid().ToString("N") : request.RequestId.Trim();
            var profileTitle = string.IsNullOrWhiteSpace(request.ProfileName) ? "Runtime profile test" : request.ProfileName.Trim();
            var profileContext = new GatewayRequestContext
            {
                RequestId = requestId,
                UserId = request.UserId,
                SourceSystem = "map",
                IngressProtocol = "gw-native",
                AppCallerTitle = profileTitle,
                ModelPolicy = "pinned",
                ParameterPolicy = "default-drop",
                GatewayTransport = GatewayTransports.Http,
            };
            var profileRequest = new GatewayUpstreamProfileTestRequest
            {
                AppCallerCode = request.AppCallerCode,
                Protocol = request.Protocol,
                BaseUrl = request.BaseUrl,
                Model = request.Model,
                ApiKey = request.ApiKey,
                ProfileId = request.ProfileId,
                ProfileName = request.ProfileName,
                UserId = request.UserId,
                RequestId = requestId,
                Context = profileContext,
                TimeoutSeconds = request.TimeoutSeconds,
            };
            var ingress = new GatewayIngressRequest
            {
                RequestId = requestId,
                SourceSystem = "map",
                IngressProtocol = "gw-native",
                AppCallerCode = profileRequest.AppCallerCode,
                AppCallerTitle = profileTitle,
                RequestType = ModelTypes.Chat,
                ModelPolicy = "pinned",
                ExpectedModel = profileRequest.Model,
                PinnedModelId = profileRequest.Model,
                ParameterPolicy = "default-drop",
                Context = profileContext,
            };
            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            var governanceResult = GovernanceResult(http, governance, jsonOpts);
            if (governanceResult is not null) return governanceResult;

            var raw = await gateway.TestUpstreamProfileAsync(profileRequest, CancellationToken.None);
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
            ILLMRequestContextAccessor accessor,
            [Microsoft.AspNetCore.Mvc.FromServices] IServiceProvider services) =>
        {
            var ingress = new GatewayIngressRequest
            {
                RequestId = body.Context?.RequestId ?? Guid.NewGuid().ToString("N"),
                SourceSystem = body.Context?.SourceSystem ?? "map",
                IngressProtocol = body.Context?.IngressProtocol ?? "gw-native",
                AppCallerCode = body.AppCallerCode,
                AppCallerTitle = body.Context?.AppCallerTitle,
                RequestType = body.ModelType,
                ModelPolicy = NormalizeModelPolicy(body.Context?.ModelPolicy)
                    ?? (!string.IsNullOrWhiteSpace(body.PinnedPlatformId) || !string.IsNullOrWhiteSpace(body.PinnedModelId)
                        ? "pinned"
                        : string.IsNullOrWhiteSpace(body.ExpectedModel) ? "auto" : "pinned"),
                ModelPoolId = body.Context?.ModelPoolId,
                ExpectedModel = string.Equals(NormalizeModelPolicy(body.Context?.ModelPolicy), "pool", StringComparison.OrdinalIgnoreCase)
                                && !string.IsNullOrWhiteSpace(body.Context?.ModelPoolId)
                    ? body.Context.ModelPoolId
                    : body.ExpectedModel,
                PinnedPlatformId = body.PinnedPlatformId,
                PinnedModelId = body.PinnedModelId,
                Context = body.Context,
            };
            var governance = await RecordAndCheckAppCallerGovernanceAsync(services, ingress, CancellationToken.None);
            if (await TryWriteGovernanceErrorAsync(http, governance)) return;

            http.Response.Headers.ContentType = "text/event-stream";
            http.Response.Headers.CacheControl = "no-cache";
            http.Response.Headers["X-Accel-Buffering"] = "no";
            using var _ = OpenContextScope(accessor, body.Context, body.ModelType, body.AppCallerCode);
            var clientExpectedModel = string.Equals(NormalizeModelPolicy(body.Context?.ModelPolicy), "pool", StringComparison.OrdinalIgnoreCase)
                                      && !string.IsNullOrWhiteSpace(body.Context?.ModelPoolId)
                ? body.Context.ModelPoolId
                : body.ExpectedModel;
            var client = gateway.CreateClient(
                body.AppCallerCode,
                body.ModelType,
                body.MaxTokens,
                body.Temperature,
                body.IncludeThinking,
                clientExpectedModel,
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

    private static bool IsOpenAiCompatibleProtectedPath(string path)
        => path.Equals("/v1/chat/completions", StringComparison.OrdinalIgnoreCase)
           || path.Equals("/v1/responses", StringComparison.OrdinalIgnoreCase)
           || path.Equals("/v1/images/generations", StringComparison.OrdinalIgnoreCase)
           || path.Equals("/v1/images/edits", StringComparison.OrdinalIgnoreCase);

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

    private static bool ReadProviderRequireParameters(JsonObject body)
    {
        return body.TryGetPropertyValue("provider", out var providerNode)
            && providerNode is JsonObject provider
            && ReadBool(provider, "require_parameters");
    }

    private static string ResolveCompatModelPolicy(
        HttpContext http,
        JsonObject body,
        string? requestedModel,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null)
    {
        var explicitPolicy = NormalizeModelPolicy(ResolveHeader(http, "X-Gateway-Model-Policy"))
                             ?? NormalizeModelPolicy(ReadString(body, "model_policy"))
                             ?? NormalizeModelPolicy(ReadString(body, "modelPolicy"));
        if (explicitPolicy is not null)
            return explicitPolicy;

        if (body.TryGetPropertyValue("provider", out var providerNode) && providerNode is JsonObject provider)
        {
            explicitPolicy = NormalizeModelPolicy(ReadString(provider, "model_policy"))
                             ?? NormalizeModelPolicy(ReadString(provider, "modelPolicy"));
            if (explicitPolicy is not null)
                return explicitPolicy;
        }

        if (!string.IsNullOrWhiteSpace(pinnedPlatformId) || !string.IsNullOrWhiteSpace(pinnedModelId))
            return "pinned";

        return string.IsNullOrWhiteSpace(requestedModel) ? "auto" : "pinned";
    }

    private static string ResolveCompatModelPolicy(
        HttpContext http,
        Dictionary<string, object> fields,
        string? requestedModel,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null)
    {
        var explicitPolicy = NormalizeModelPolicy(ResolveHeader(http, "X-Gateway-Model-Policy"))
                             ?? NormalizeModelPolicy(ReadFieldString(fields, "model_policy"))
                             ?? NormalizeModelPolicy(ReadFieldString(fields, "modelPolicy"));
        if (explicitPolicy is not null)
            return explicitPolicy;

        if (!string.IsNullOrWhiteSpace(pinnedPlatformId) || !string.IsNullOrWhiteSpace(pinnedModelId))
            return "pinned";

        return string.IsNullOrWhiteSpace(requestedModel) ? "auto" : "pinned";
    }

    private static string? ResolveCompatModelPoolId(HttpContext http, JsonObject body)
    {
        var explicitPoolId = FirstNonEmpty(
            ResolveHeader(http, "X-Gateway-Model-Pool-Id"),
            ReadString(body, "model_pool_id"),
            ReadString(body, "modelPoolId"));
        if (!string.IsNullOrWhiteSpace(explicitPoolId))
            return explicitPoolId;

        if (body.TryGetPropertyValue("provider", out var providerNode) && providerNode is JsonObject provider)
        {
            return FirstNonEmpty(
                ReadString(provider, "model_pool_id"),
                ReadString(provider, "modelPoolId"));
        }

        return null;
    }

    private static string? ResolveCompatModelPoolId(HttpContext http, Dictionary<string, object> fields)
    {
        return FirstNonEmpty(
            ResolveHeader(http, "X-Gateway-Model-Pool-Id"),
            ReadFieldString(fields, "model_pool_id"),
            ReadFieldString(fields, "modelPoolId"));
    }

    private static string? ResolveCompatRunId(HttpContext http, JsonObject body)
    {
        var runId = FirstNonEmpty(
            ResolveHeader(http, "X-Gateway-Run-Id"),
            ResolveHeader(http, "X-Run-Id"),
            ReadString(body, "run_id"),
            ReadString(body, "runId"));
        if (!string.IsNullOrWhiteSpace(runId))
            return runId;

        if (body.TryGetPropertyValue("metadata", out var metadataNode) && metadataNode is JsonObject metadata)
        {
            runId = FirstNonEmpty(ReadString(metadata, "run_id"), ReadString(metadata, "runId"));
            if (!string.IsNullOrWhiteSpace(runId))
                return runId;
        }

        if (body.TryGetPropertyValue("provider", out var providerNode) && providerNode is JsonObject provider)
        {
            return FirstNonEmpty(ReadString(provider, "run_id"), ReadString(provider, "runId"));
        }

        return null;
    }

    private static string? ResolveCompatRunId(HttpContext http, Dictionary<string, object> fields)
    {
        return FirstNonEmpty(
            ResolveHeader(http, "X-Gateway-Run-Id"),
            ResolveHeader(http, "X-Run-Id"),
            ReadFieldString(fields, "run_id"),
            ReadFieldString(fields, "runId"));
    }

    private static (string? PinnedPlatformId, string? PinnedModelId) ResolveCompatPinnedTarget(
        HttpContext http,
        JsonObject body)
    {
        var pinnedPlatformId = FirstNonEmpty(
            ResolveHeader(http, "X-Gateway-Pinned-Platform-Id"),
            ReadString(body, "pinned_platform_id"),
            ReadString(body, "pinnedPlatformId"));
        var pinnedModelId = FirstNonEmpty(
            ResolveHeader(http, "X-Gateway-Pinned-Model-Id"),
            ReadString(body, "pinned_model_id"),
            ReadString(body, "pinnedModelId"));

        if (body.TryGetPropertyValue("provider", out var providerNode) && providerNode is JsonObject provider)
        {
            pinnedPlatformId = FirstNonEmpty(
                pinnedPlatformId,
                ReadString(provider, "pinned_platform_id"),
                ReadString(provider, "pinnedPlatformId"));
            pinnedModelId = FirstNonEmpty(
                pinnedModelId,
                ReadString(provider, "pinned_model_id"),
                ReadString(provider, "pinnedModelId"));
        }

        return (pinnedPlatformId, pinnedModelId);
    }

    private static (string? PinnedPlatformId, string? PinnedModelId) ResolveCompatPinnedTarget(
        HttpContext http,
        Dictionary<string, object> fields)
    {
        return (
            FirstNonEmpty(
                ResolveHeader(http, "X-Gateway-Pinned-Platform-Id"),
                ReadFieldString(fields, "pinned_platform_id"),
                ReadFieldString(fields, "pinnedPlatformId")),
            FirstNonEmpty(
                ResolveHeader(http, "X-Gateway-Pinned-Model-Id"),
                ReadFieldString(fields, "pinned_model_id"),
                ReadFieldString(fields, "pinnedModelId")));
    }

    private static string? FirstNonEmpty(params string?[] values)
        => values.Select(v => v?.Trim()).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    private static string? ReadFieldString(Dictionary<string, object> fields, string key)
        => fields.TryGetValue(key, out var value) ? value?.ToString() : null;

    private static string? NormalizeModelPolicy(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant();
        return normalized is "auto" or "pool" or "pinned" ? normalized : null;
    }

    private static string NormalizeIngressProtocol(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "unknown";
        var normalized = value.Trim().ToLowerInvariant().Replace('_', '-');
        return normalized switch
        {
            "native" or "gw" or "gateway-native" => "gw-native",
            "openai" or "openai-compatible" or "openai-chat" => "openai-compatible",
            "claude" or "anthropic" or "anthropic-compatible" => "claude-compatible",
            "gemini" or "google" or "google-compatible" => "gemini-compatible",
            _ => normalized,
        };
    }

    private static async Task<bool> TryRejectStrictDroppedParametersAsync(HttpContext http, GatewayIngressRequest ingress)
    {
        if (!string.Equals(ingress.ParameterPolicy, "strict-require", StringComparison.OrdinalIgnoreCase)
            || ingress.DroppedParameters.Count == 0)
        {
            return false;
        }

        await WriteCompatErrorAsync(
            http,
            $"strict-require 不允许入口适配器丢弃参数: {string.Join(", ", ingress.DroppedParameters)}",
            "invalid_request_error",
            "dropped_parameters",
            StatusCodes.Status400BadRequest);
        return true;
    }

    private static List<RouteSelfTestCaseResult> BuildRouteSelfTestCases()
    {
        var nativeRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.LlmGatewaySelfTest.Route.NativeChat,
            ModelType = ModelTypes.Chat,
            ExpectedModel = "ignored-native-model",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = "route self-test" },
                },
            },
            Context = new GatewayRequestContext
            {
                RequestId = "route-self-test-native",
                SourceSystem = "map",
                ModelPolicy = "pool",
                ModelPoolId = "self-test-native-chat-pool",
                ParameterPolicy = "strict-require",
                DroppedParameters = new List<string>(),
                GatewayTransport = GatewayTransports.Http,
            },
        };
        var nativeIngress = ToIngress(nativeRequest, "gw-native", "map");
        var nativeRouted = ApplyIngressRouting(nativeRequest, nativeIngress, stream: false);

        var openAiIngress = new GatewayIngressRequest
        {
            RequestId = "route-self-test-openai",
            SourceSystem = "external",
            IngressProtocol = "openai-compatible",
            AppCallerCode = AppCallerRegistry.LlmGatewaySelfTest.Route.OpenAiChat,
            AppCallerTitle = "Route self-test OpenAI",
            RequestType = ModelTypes.Chat,
            ModelPolicy = "auto",
            ParameterPolicy = "default-drop",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = "route self-test" },
                },
                ["logprobs"] = true,
            },
            DroppedParameters = new List<string>(),
        };
        var openAiRequest = openAiIngress.ToGatewayRequest(stream: false);

        var claudeIngress = new GatewayIngressRequest
        {
            RequestId = "route-self-test-claude",
            SourceSystem = "external",
            IngressProtocol = "claude-compatible",
            AppCallerCode = AppCallerRegistry.LlmGatewaySelfTest.Route.ClaudeChat,
            AppCallerTitle = "Route self-test Claude",
            RequestType = ModelTypes.Chat,
            ModelPolicy = "pinned",
            ParameterPolicy = "default-drop",
            PinnedPlatformId = "self-test-anthropic-platform",
            PinnedModelId = "claude-3-7-sonnet-latest",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = "route self-test" },
                },
            },
            DroppedParameters = new List<string> { "metadata" },
        };
        var claudeRequest = claudeIngress.ToGatewayRequest(stream: false);

        var geminiIngress = new GatewayIngressRequest
        {
            RequestId = "route-self-test-gemini",
            SourceSystem = "external",
            IngressProtocol = "gemini-compatible",
            AppCallerCode = AppCallerRegistry.LlmGatewaySelfTest.Route.GeminiChat,
            AppCallerTitle = "Route self-test Gemini",
            RequestType = ModelTypes.Chat,
            ModelPolicy = "pool",
            ModelPoolId = "self-test-gemini-chat-pool",
            ParameterPolicy = "default-drop",
            ExpectedModel = "gemini-2.5-pro",
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = "route self-test" },
                },
            },
            DroppedParameters = new List<string>(),
        };
        var geminiRequest = geminiIngress.ToGatewayRequest(stream: false);

        return new List<RouteSelfTestCaseResult>
        {
            SnapshotRouteSelfTestCase("gw-native pool", nativeRouted, "gw-native", "map", "pool", "self-test-native-chat-pool", "strict-require"),
            SnapshotRouteSelfTestCase("openai-compatible auto", openAiRequest, "openai-compatible", "external", "auto", null, "default-drop"),
            SnapshotRouteSelfTestCase("claude-compatible pinned", claudeRequest, "claude-compatible", "external", "pinned", null, "default-drop"),
            SnapshotRouteSelfTestCase("gemini-compatible pool", geminiRequest, "gemini-compatible", "external", "pool", "self-test-gemini-chat-pool", "default-drop"),
        };
    }

    private static RouteSelfTestCaseResult SnapshotRouteSelfTestCase(
        string name,
        GatewayRequest request,
        string expectedIngressProtocol,
        string expectedSourceSystem,
        string expectedModelPolicy,
        string? expectedModelPoolId,
        string expectedParameterPolicy)
    {
        var context = request.Context;
        var assertions = new List<RouteSelfTestAssertion>
        {
            AssertSelfTest("context_present", context is not null),
            AssertSelfTest("source_system", string.Equals(context?.SourceSystem, expectedSourceSystem, StringComparison.Ordinal)),
            AssertSelfTest("ingress_protocol", string.Equals(context?.IngressProtocol, expectedIngressProtocol, StringComparison.Ordinal)),
            AssertSelfTest("app_caller_code", !string.IsNullOrWhiteSpace(request.AppCallerCode)),
            AssertSelfTest("request_type", !string.IsNullOrWhiteSpace(request.ModelType)),
            AssertSelfTest("model_policy", string.Equals(context?.ModelPolicy, expectedModelPolicy, StringComparison.Ordinal)),
            AssertSelfTest("model_pool_id", string.Equals(context?.ModelPoolId, expectedModelPoolId, StringComparison.Ordinal)),
            AssertSelfTest("parameter_policy", string.Equals(context?.ParameterPolicy, expectedParameterPolicy, StringComparison.Ordinal)),
            AssertSelfTest("request_body_present", request.RequestBody is not null),
        };

        if (string.Equals(expectedModelPolicy, "pool", StringComparison.Ordinal))
            assertions.Add(AssertSelfTest("pool_expected_model", string.Equals(request.ExpectedModel, expectedModelPoolId, StringComparison.Ordinal)));

        if (string.Equals(expectedModelPolicy, "pinned", StringComparison.Ordinal))
            assertions.Add(AssertSelfTest("pinned_target", !string.IsNullOrWhiteSpace(request.PinnedPlatformId) && !string.IsNullOrWhiteSpace(request.PinnedModelId)));

        return new RouteSelfTestCaseResult(
            Name: name,
            Passed: assertions.All(x => x.Passed),
            SourceSystem: context?.SourceSystem,
            IngressProtocol: context?.IngressProtocol,
            AppCallerCode: request.AppCallerCode,
            RequestType: request.ModelType,
            ModelPolicy: context?.ModelPolicy,
            ModelPoolId: context?.ModelPoolId,
            ExpectedModel: request.ExpectedModel,
            PinnedPlatformId: request.PinnedPlatformId,
            PinnedModelId: request.PinnedModelId,
            ParameterPolicy: context?.ParameterPolicy,
            DroppedParameters: context?.DroppedParameters ?? new List<string>(),
            Assertions: assertions);
    }

    private static RouteSelfTestAssertion AssertSelfTest(string name, bool passed)
        => new(name, passed);

    private static List<string> FindDroppedParameters(JsonObject body, params string[] supported)
    {
        var supportedSet = supported.ToHashSet(StringComparer.Ordinal);
        return body
            .Select(kv => kv.Key)
            .Where(k => !supportedSet.Contains(k))
            .OrderBy(k => k, StringComparer.Ordinal)
            .ToList();
    }

    private static void StripGatewayRoutingFields(JsonObject body)
    {
        foreach (var key in GatewayRoutingFieldNames)
        {
            body.Remove(key);
        }

        if (body["provider"] is JsonObject provider)
        {
            foreach (var key in GatewayRoutingFieldNames)
            {
                provider.Remove(key);
            }
        }
    }

    private static readonly string[] GatewayRoutingFieldNames =
    [
        "model_policy",
        "modelPolicy",
        "model_pool_id",
        "modelPoolId",
        "pinned_platform_id",
        "pinnedPlatformId",
        "pinned_model_id",
        "pinnedModelId",
        "run_id",
        "runId",
    ];

    private static async Task<AppCallerGovernanceDecision> RecordAndCheckAppCallerGovernanceAsync(
        IServiceProvider services,
        GatewayIngressRequest ingress,
        CancellationToken ct)
    {
        await RecordDiscoveredAppCallerAsync(services, ingress, ct);
        return await CheckAppCallerGovernanceAsync(services, ingress.AppCallerCode, ingress.RequestType, ct);
    }

    private static async Task<AppCallerGovernanceDecision> CheckAppCallerGovernanceAsync(
        IServiceProvider services,
        string appCallerCode,
        string requestType,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(appCallerCode) || string.IsNullOrWhiteSpace(requestType))
            return AppCallerGovernanceDecision.Allow(appCallerCode, requestType);

        var gatewayData = services.GetService<LlmGatewayDataContext>();
        if (gatewayData == null)
            return AppCallerGovernanceDecision.Allow(appCallerCode, requestType);

        try
        {
            var callers = gatewayData.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers");
            var caller = await callers.Find(Builders<GatewayAppCallerRecord>.Filter.And(
                    Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.AppCallerCode, appCallerCode),
                    Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.RequestType, requestType)))
                .FirstOrDefaultAsync(ct);
            var status = CheckAppCallerStatus(appCallerCode, requestType, caller?.Status);
            if (status.Rejected)
                return new AppCallerGovernanceDecision(
                    status,
                    AppCallerRateLimitDecision.Allow(appCallerCode, requestType),
                    AppCallerBudgetDecision.Allow(appCallerCode, requestType, 0, 0, hasCostEvidence: false));

            var budget = await CheckAppCallerMonthlyBudgetAsync(gatewayData, appCallerCode, requestType, caller?.MonthlyBudgetUsd, ct);
            if (budget.Rejected)
                return new AppCallerGovernanceDecision(
                    status,
                    AppCallerRateLimitDecision.Allow(appCallerCode, requestType),
                    budget);

            var limit = caller?.RateLimitPerMinute ?? 0;
            if (limit <= 0)
                return new AppCallerGovernanceDecision(status, AppCallerRateLimitDecision.Allow(appCallerCode, requestType), budget);

            var now = DateTime.UtcNow;
            var windowStart = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute, 0, DateTimeKind.Utc);
            var windows = gatewayData.Database.GetCollection<BsonDocument>("llmgw_app_caller_rate_windows");
            var windowFilter = Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("AppCallerCode", appCallerCode),
                Builders<BsonDocument>.Filter.Eq("RequestType", requestType),
                Builders<BsonDocument>.Filter.Eq("WindowStart", windowStart));
            var updated = await windows.FindOneAndUpdateAsync(
                windowFilter,
                Builders<BsonDocument>.Update
                    .SetOnInsert("AppCallerCode", appCallerCode)
                    .SetOnInsert("RequestType", requestType)
                    .SetOnInsert("WindowStart", windowStart)
                    .Set("ExpiresAt", windowStart.AddMinutes(10))
                    .Inc("Count", 1),
                new FindOneAndUpdateOptions<BsonDocument>
                {
                    IsUpsert = true,
                    ReturnDocument = ReturnDocument.After,
                },
                ct);
            var count = ReadBsonLong(updated, "Count") ?? 0;
            var rateLimit = count > limit
                ? AppCallerRateLimitDecision.Reject(appCallerCode, requestType, limit, count, windowStart)
                : AppCallerRateLimitDecision.Allow(appCallerCode, requestType, limit, count, windowStart);
            return new AppCallerGovernanceDecision(status, rateLimit, budget);
        }
        catch
        {
            // 治理窗口异常不能把全部 AI 请求打挂；DB 恢复后下一次请求重新计数。
            return AppCallerGovernanceDecision.Allow(appCallerCode, requestType);
        }
    }

    private static AppCallerStatusDecision CheckAppCallerStatus(string appCallerCode, string requestType, string? status)
    {
        var normalized = string.IsNullOrWhiteSpace(status) ? "discovered" : status.Trim().ToLowerInvariant();
        return normalized is "disabled" or "archived"
            ? AppCallerStatusDecision.Reject(appCallerCode, requestType, normalized)
            : AppCallerStatusDecision.Allow(appCallerCode, requestType, normalized);
    }

    private static async Task<AppCallerBudgetDecision> CheckAppCallerMonthlyBudgetAsync(
        LlmGatewayDataContext gatewayData,
        string appCallerCode,
        string requestType,
        decimal? monthlyBudgetUsd,
        CancellationToken ct)
    {
        if (monthlyBudgetUsd is null or <= 0)
            return AppCallerBudgetDecision.Allow(appCallerCode, requestType, monthlyBudgetUsd ?? 0, 0, hasCostEvidence: false);

        var now = DateTime.UtcNow;
        var monthStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var monthEnd = monthStart.AddMonths(1);
        var logs = gatewayData.Database.GetCollection<BsonDocument>("llmrequestlogs");
        var filter = Builders<BsonDocument>.Filter.And(
            Builders<BsonDocument>.Filter.Eq("AppCallerCode", appCallerCode),
            Builders<BsonDocument>.Filter.Eq("RequestType", requestType),
            Builders<BsonDocument>.Filter.Gte("StartedAt", monthStart),
            Builders<BsonDocument>.Filter.Lt("StartedAt", monthEnd),
            Builders<BsonDocument>.Filter.Eq("Status", "succeeded"));

        var docs = await logs.Find(filter)
            .Project(Builders<BsonDocument>.Projection
                .Include("TotalCostUsd")
                .Include("CostUsd")
                .Include("EstimatedCostUsd"))
            .ToListAsync(ct);
        var hasCostEvidence = false;
        var spend = 0m;
        foreach (var doc in docs)
        {
            var cost = ReadBsonDecimal(doc, "TotalCostUsd")
                       ?? ReadBsonDecimal(doc, "CostUsd")
                       ?? ReadBsonDecimal(doc, "EstimatedCostUsd");
            if (cost is null) continue;
            hasCostEvidence = true;
            spend += Math.Max(0, cost.Value);
        }

        if (!hasCostEvidence)
            return AppCallerBudgetDecision.Allow(appCallerCode, requestType, monthlyBudgetUsd.Value, spend, hasCostEvidence: false);

        return spend >= monthlyBudgetUsd.Value
            ? AppCallerBudgetDecision.Reject(appCallerCode, requestType, monthlyBudgetUsd.Value, spend, monthStart)
            : AppCallerBudgetDecision.Allow(appCallerCode, requestType, monthlyBudgetUsd.Value, spend, hasCostEvidence: true, monthStart);
    }

    private static long? ReadBsonLong(BsonDocument? doc, string field)
    {
        if (doc == null || !doc.TryGetValue(field, out var value) || value.IsBsonNull) return null;
        return value.BsonType switch
        {
            BsonType.Int32 => value.AsInt32,
            BsonType.Int64 => value.AsInt64,
            BsonType.Double => (long)value.AsDouble,
            BsonType.Decimal128 => (long)(decimal)value.AsDecimal128,
            BsonType.String when long.TryParse(value.AsString, out var parsed) => parsed,
            _ => null,
        };
    }

    private static decimal? ReadBsonDecimal(BsonDocument? doc, string field)
    {
        if (doc == null || !doc.TryGetValue(field, out var value) || value.IsBsonNull) return null;
        return value.BsonType switch
        {
            BsonType.Decimal128 => (decimal)value.AsDecimal128,
            BsonType.Double => (decimal)value.AsDouble,
            BsonType.Int32 => value.AsInt32,
            BsonType.Int64 => value.AsInt64,
            BsonType.String when decimal.TryParse(
                value.AsString,
                System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture,
                out var parsed) => parsed,
            _ => null,
        };
    }

    private static async Task WriteRateLimitErrorAsync(HttpContext http, AppCallerRateLimitDecision decision)
    {
        ApplyRateLimitHeaders(http, decision);
        await WriteCompatErrorAsync(
            http,
            $"appCaller {decision.AppCallerCode} 超过每分钟限流 {decision.LimitPerMinute}",
            "rate_limit_error",
            "APP_CALLER_RATE_LIMITED",
            StatusCodes.Status429TooManyRequests);
    }

    private static async Task WriteStatusErrorAsync(HttpContext http, AppCallerStatusDecision decision)
    {
        await WriteCompatErrorAsync(
            http,
            $"appCaller {decision.AppCallerCode} 当前状态为 {decision.Status}，已禁止调用",
            "permission_error",
            "APP_CALLER_DISABLED",
            StatusCodes.Status403Forbidden);
    }

    private static async Task<bool> TryWriteGovernanceErrorAsync(HttpContext http, AppCallerGovernanceDecision decision)
    {
        if (decision.Status.Rejected)
        {
            await WriteStatusErrorAsync(http, decision.Status);
            return true;
        }
        if (decision.Budget.Rejected)
        {
            await WriteBudgetErrorAsync(http, decision.Budget);
            return true;
        }
        if (decision.RateLimit.Rejected)
        {
            await WriteRateLimitErrorAsync(http, decision.RateLimit);
            return true;
        }
        return false;
    }

    private static IResult? GovernanceResult(
        HttpContext http,
        AppCallerGovernanceDecision decision,
        JsonSerializerOptions jsonOpts)
    {
        if (decision.Status.Rejected) return StatusResult(decision.Status, jsonOpts);
        if (decision.Budget.Rejected) return BudgetResult(decision.Budget, jsonOpts);
        if (decision.RateLimit.Rejected) return RateLimitResult(http, decision.RateLimit, jsonOpts);
        return null;
    }

    private static IResult StatusResult(AppCallerStatusDecision decision, JsonSerializerOptions jsonOpts)
        => Results.Json(new
        {
            error = new
            {
                code = "APP_CALLER_DISABLED",
                message = $"appCaller {decision.AppCallerCode} 当前状态为 {decision.Status}，已禁止调用",
                appCallerCode = decision.AppCallerCode,
                requestType = decision.RequestType,
                status = decision.Status,
            },
        }, jsonOpts, statusCode: StatusCodes.Status403Forbidden);

    private static IResult RateLimitResult(
        HttpContext http,
        AppCallerRateLimitDecision decision,
        JsonSerializerOptions jsonOpts)
    {
        ApplyRateLimitHeaders(http, decision);
        return Results.Json(new
        {
            error = new
            {
                code = "APP_CALLER_RATE_LIMITED",
                message = $"appCaller {decision.AppCallerCode} 超过每分钟限流 {decision.LimitPerMinute}",
                appCallerCode = decision.AppCallerCode,
                requestType = decision.RequestType,
                limitPerMinute = decision.LimitPerMinute,
                count = decision.Count,
                windowStart = decision.WindowStart,
            },
        }, jsonOpts, statusCode: StatusCodes.Status429TooManyRequests);
    }

    private static async Task WriteBudgetErrorAsync(HttpContext http, AppCallerBudgetDecision decision)
    {
        await WriteCompatErrorAsync(
            http,
            $"appCaller {decision.AppCallerCode} 已达到月预算 ${decision.MonthlyBudgetUsd:F2}",
            "rate_limit_error",
            "APP_CALLER_MONTHLY_BUDGET_EXCEEDED",
            StatusCodes.Status429TooManyRequests);
    }

    private static IResult BudgetResult(AppCallerBudgetDecision decision, JsonSerializerOptions jsonOpts)
        => Results.Json(new
        {
            error = new
            {
                code = "APP_CALLER_MONTHLY_BUDGET_EXCEEDED",
                message = $"appCaller {decision.AppCallerCode} 已达到月预算 ${decision.MonthlyBudgetUsd:F2}",
                appCallerCode = decision.AppCallerCode,
                requestType = decision.RequestType,
                monthlyBudgetUsd = decision.MonthlyBudgetUsd,
                monthSpendUsd = decision.MonthSpendUsd,
                monthStart = decision.MonthStart,
                hasCostEvidence = decision.HasCostEvidence,
            },
        }, jsonOpts, statusCode: StatusCodes.Status429TooManyRequests);

    private static void ApplyRateLimitHeaders(HttpContext http, AppCallerRateLimitDecision decision)
    {
        var retryAfter = Math.Max(1, (int)Math.Ceiling((decision.WindowStart.AddMinutes(1) - DateTime.UtcNow).TotalSeconds));
        http.Response.Headers.RetryAfter = retryAfter.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static JsonObject ConvertClaudeMessagesToOpenAiBody(JsonObject claudeBody)
    {
        var result = new JsonObject();
        var messages = new JsonArray();

        if (claudeBody.TryGetPropertyValue("system", out var systemNode) && systemNode is not null)
        {
            messages.Add(new JsonObject
            {
                ["role"] = "system",
                ["content"] = systemNode.DeepClone(),
            });
        }

        if (claudeBody.TryGetPropertyValue("messages", out var messagesNode) && messagesNode is JsonArray claudeMessages)
        {
            foreach (var message in claudeMessages)
            {
                if (message is not JsonObject obj) continue;
                var converted = new JsonObject
                {
                    ["role"] = (obj["role"] ?? "user").DeepClone(),
                };
                if (obj.TryGetPropertyValue("content", out var contentNode) && contentNode is not null)
                    converted["content"] = ConvertClaudeContentToOpenAiContent(contentNode);
                foreach (var (key, value) in obj)
                {
                    if (string.Equals(key, "role", StringComparison.Ordinal)
                        || string.Equals(key, "content", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    converted[key] = value?.DeepClone();
                }
                messages.Add(converted);
            }
        }

        result["messages"] = messages;
        CopyJsonField(claudeBody, result, "max_tokens");
        CopyJsonField(claudeBody, result, "temperature");
        CopyJsonField(claudeBody, result, "top_p");
        CopyJsonField(claudeBody, result, "top_k");
        CopyJsonField(claudeBody, result, "stream");
        CopyJsonField(claudeBody, result, "tools");
        CopyJsonField(claudeBody, result, "tool_choice");
        if (claudeBody.TryGetPropertyValue("stop_sequences", out var stop) && stop is not null)
            result["stop"] = stop.DeepClone();

        return result;
    }

    private static JsonNode ConvertClaudeContentToOpenAiContent(JsonNode content)
    {
        if (content is not JsonArray parts)
            return content.DeepClone();

        var openAiParts = new JsonArray();
        foreach (var part in parts)
        {
            if (part is not JsonObject partObj)
            {
                openAiParts.Add(part?.DeepClone());
                continue;
            }
            openAiParts.Add(ConvertClaudeContentPart(partObj));
        }

        return openAiParts;
    }

    private static JsonNode ConvertClaudeContentPart(JsonObject part)
    {
        var type = ReadString(part, "type");
        if (string.Equals(type, "text", StringComparison.OrdinalIgnoreCase))
        {
            return new JsonObject
            {
                ["type"] = "text",
                ["text"] = part.TryGetPropertyValue("text", out var text) && text is not null
                    ? text.DeepClone()
                    : string.Empty,
            };
        }

        if (string.Equals(type, "image", StringComparison.OrdinalIgnoreCase)
            && part.TryGetPropertyValue("source", out var sourceNode)
            && sourceNode is JsonObject source)
        {
            var sourceType = ReadString(source, "type");
            var mediaType = ReadString(source, "media_type") ?? ReadString(source, "mediaType") ?? "application/octet-stream";
            var data = ReadString(source, "data");
            var url = ReadString(source, "url");
            var imageUrl = string.Equals(sourceType, "base64", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(data)
                ? $"data:{mediaType};base64,{data}"
                : url;
            if (!string.IsNullOrWhiteSpace(imageUrl))
            {
                return new JsonObject
                {
                    ["type"] = "image_url",
                    ["image_url"] = new JsonObject
                    {
                        ["url"] = imageUrl,
                    },
                };
            }
        }

        return part.DeepClone();
    }

    private static JsonObject ConvertGeminiGenerateContentToOpenAiBody(JsonObject geminiBody)
    {
        var result = new JsonObject();
        var messages = new JsonArray();

        if (geminiBody.TryGetPropertyValue("systemInstruction", out var systemNode) && systemNode is JsonObject systemObj)
        {
            messages.Add(new JsonObject
            {
                ["role"] = "system",
                ["content"] = ExtractGeminiPartsContent(systemObj),
            });
        }

        if (geminiBody.TryGetPropertyValue("contents", out var contentsNode) && contentsNode is JsonArray contents)
        {
            foreach (var item in contents)
            {
                if (item is not JsonObject content) continue;
                var role = string.Equals(ReadString(content, "role"), "model", StringComparison.OrdinalIgnoreCase)
                    ? "assistant"
                    : "user";
                if (HasGeminiRegularParts(content))
                {
                    messages.Add(new JsonObject
                    {
                        ["role"] = role,
                        ["content"] = ExtractGeminiPartsContent(content),
                    });
                }

                var toolCalls = ExtractGeminiFunctionCalls(content);
                if (toolCalls.Count > 0)
                {
                    messages.Add(new JsonObject
                    {
                        ["role"] = "assistant",
                        ["content"] = null,
                        ["tool_calls"] = toolCalls,
                    });
                }

                foreach (var toolResult in ExtractGeminiFunctionResponseMessages(content))
                    messages.Add(toolResult);
            }
        }

        result["messages"] = messages;
        if (geminiBody.TryGetPropertyValue("generationConfig", out var configNode) && configNode is JsonObject config)
        {
            CopyJsonField(config, result, "temperature");
            if (config.TryGetPropertyValue("topP", out var topP) && topP is not null)
                result["top_p"] = topP.DeepClone();
            if (config.TryGetPropertyValue("topK", out var topK) && topK is not null)
                result["top_k"] = topK.DeepClone();
            if (config.TryGetPropertyValue("maxOutputTokens", out var maxTokens) && maxTokens is not null)
                result["max_tokens"] = maxTokens.DeepClone();
            if (config.TryGetPropertyValue("stopSequences", out var stop) && stop is not null)
                result["stop"] = stop.DeepClone();
        }

        if (geminiBody.TryGetPropertyValue("tools", out var toolsNode) && toolsNode is JsonArray geminiTools)
        {
            var openAiTools = ConvertGeminiToolsToOpenAiTools(geminiTools);
            if (openAiTools.Count > 0)
                result["tools"] = openAiTools;
        }

        if (geminiBody.TryGetPropertyValue("toolConfig", out var toolConfigNode) && toolConfigNode is JsonObject toolConfig)
        {
            var toolChoice = ConvertGeminiToolConfigToOpenAiToolChoice(toolConfig);
            if (toolChoice is not null)
                result["tool_choice"] = toolChoice;
        }

        return result;
    }

    private static JsonArray ConvertGeminiToolsToOpenAiTools(JsonArray geminiTools)
    {
        var result = new JsonArray();
        foreach (var toolNode in geminiTools)
        {
            if (toolNode is not JsonObject tool) continue;
            var declarations = tool["functionDeclarations"] as JsonArray
                               ?? tool["function_declarations"] as JsonArray;
            if (declarations is null) continue;

            foreach (var declarationNode in declarations)
            {
                if (declarationNode is not JsonObject declaration) continue;
                var name = ReadString(declaration, "name");
                if (string.IsNullOrWhiteSpace(name)) continue;

                var function = new JsonObject
                {
                    ["name"] = name,
                };
                if (declaration.TryGetPropertyValue("description", out var description) && description is not null)
                    function["description"] = description.DeepClone();
                if (declaration.TryGetPropertyValue("parameters", out var parameters) && parameters is not null)
                    function["parameters"] = parameters.DeepClone();

                result.Add(new JsonObject
                {
                    ["type"] = "function",
                    ["function"] = function,
                });
            }
        }

        return result;
    }

    private static JsonNode? ConvertGeminiToolConfigToOpenAiToolChoice(JsonObject toolConfig)
    {
        var functionCallingConfig = toolConfig["functionCallingConfig"] as JsonObject
                                    ?? toolConfig["function_calling_config"] as JsonObject;
        if (functionCallingConfig is null) return null;

        var mode = ReadString(functionCallingConfig, "mode");
        if (string.Equals(mode, "NONE", StringComparison.OrdinalIgnoreCase))
            return "none";
        if (string.Equals(mode, "AUTO", StringComparison.OrdinalIgnoreCase))
            return "auto";

        if (string.Equals(mode, "ANY", StringComparison.OrdinalIgnoreCase)
            && functionCallingConfig.TryGetPropertyValue("allowedFunctionNames", out var allowed)
            && allowed is JsonArray { Count: > 0 } names
            && names[0] is JsonValue firstName
            && firstName.TryGetValue<string>(out var name)
            && !string.IsNullOrWhiteSpace(name))
        {
            return new JsonObject
            {
                ["type"] = "function",
                ["function"] = new JsonObject
                {
                    ["name"] = name,
                },
            };
        }

        return null;
    }

    private static JsonObject ConvertOpenAiResponsesToChatBody(JsonObject responsesBody)
    {
        var result = new JsonObject();
        var messages = new JsonArray();

        if (responsesBody.TryGetPropertyValue("instructions", out var instructions) && instructions is not null)
        {
            messages.Add(new JsonObject
            {
                ["role"] = "system",
                ["content"] = NormalizeResponsesInputContent(instructions),
            });
        }

        if (responsesBody.TryGetPropertyValue("input", out var input) && input is not null)
        {
            if (input is JsonValue)
            {
                messages.Add(new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = NormalizeResponsesInputContent(input),
                });
            }
            else if (input is JsonArray items)
            {
                foreach (var item in items)
                {
                    if (item is JsonObject obj && obj.TryGetPropertyValue("role", out var roleNode) && roleNode is not null)
                    {
                        var content = obj.TryGetPropertyValue("content", out var contentNode) && contentNode is not null
                            ? NormalizeResponsesInputContent(contentNode)
                            : obj.DeepClone();
                        messages.Add(new JsonObject
                        {
                            ["role"] = roleNode.DeepClone(),
                            ["content"] = content,
                        });
                    }
                    else if (item is not null)
                    {
                        messages.Add(new JsonObject
                        {
                            ["role"] = "user",
                            ["content"] = NormalizeResponsesInputContent(item),
                        });
                    }
                }
            }
            else
            {
                messages.Add(new JsonObject
                {
                    ["role"] = "user",
                    ["content"] = NormalizeResponsesInputContent(input),
                });
            }
        }

        if (messages.Count == 0)
        {
            messages.Add(new JsonObject
            {
                ["role"] = "user",
                ["content"] = string.Empty,
            });
        }

        result["messages"] = messages;
        CopyJsonField(responsesBody, result, "temperature");
        CopyJsonField(responsesBody, result, "top_p");
        CopyJsonField(responsesBody, result, "stream");
        CopyJsonField(responsesBody, result, "tools");
        CopyJsonField(responsesBody, result, "tool_choice");
        CopyJsonField(responsesBody, result, "logprobs");
        CopyJsonField(responsesBody, result, "top_logprobs");
        CopyJsonField(responsesBody, result, "parallel_tool_calls");
        if (responsesBody.TryGetPropertyValue("max_output_tokens", out var maxOutputTokens) && maxOutputTokens is not null)
            result["max_tokens"] = maxOutputTokens.DeepClone();
        if (responsesBody.TryGetPropertyValue("reasoning", out var reasoning) && reasoning is not null)
            result["reasoning"] = reasoning.DeepClone();

        return result;
    }

    private static JsonNode NormalizeResponsesInputContent(JsonNode node)
    {
        if (node is JsonValue value && value.TryGetValue<string>(out var s))
            return s;

        if (node is JsonArray array)
        {
            var content = new JsonArray();
            foreach (var item in array)
            {
                if (item is JsonObject partObj)
                    content.Add(ConvertResponsesContentPart(partObj));
                else if (item is not null)
                    content.Add(item.DeepClone());
            }
            return content;
        }

        if (node is JsonObject contentObj)
            return ConvertResponsesContentPart(contentObj);

        return node.DeepClone();
    }

    private static JsonNode ConvertResponsesContentPart(JsonObject part)
    {
        var type = ReadString(part, "type");
        if (string.Equals(type, "input_text", StringComparison.OrdinalIgnoreCase))
        {
            return new JsonObject
            {
                ["type"] = "text",
                ["text"] = part.TryGetPropertyValue("text", out var text) && text is not null
                    ? text.DeepClone()
                    : string.Empty,
            };
        }

        if (string.Equals(type, "input_image", StringComparison.OrdinalIgnoreCase))
        {
            var imageUrl = part.TryGetPropertyValue("image_url", out var url) && url is not null
                ? url.DeepClone()
                : part.TryGetPropertyValue("file_id", out var fileId) && fileId is not null
                    ? fileId.DeepClone()
                    : string.Empty;
            var imageUrlObject = new JsonObject
            {
                ["url"] = imageUrl,
            };
            if (part.TryGetPropertyValue("detail", out var detail) && detail is not null)
                imageUrlObject["detail"] = detail.DeepClone();
            return new JsonObject
            {
                ["type"] = "image_url",
                ["image_url"] = imageUrlObject,
            };
        }

        return part.DeepClone();
    }

    private static bool ContainsOpenAiImageInput(JsonNode? node)
    {
        if (node is null) return false;
        if (node is JsonObject obj)
        {
            if (string.Equals(ReadString(obj, "type"), "image_url", StringComparison.OrdinalIgnoreCase))
                return true;
            foreach (var (_, value) in obj)
            {
                if (ContainsOpenAiImageInput(value)) return true;
            }
            return false;
        }

        if (node is JsonArray array)
        {
            foreach (var item in array)
            {
                if (ContainsOpenAiImageInput(item)) return true;
            }
        }

        return false;
    }

    private static bool HasGeminiRegularParts(JsonObject content)
    {
        if (!content.TryGetPropertyValue("parts", out var partsNode) || partsNode is not JsonArray parts)
            return false;

        foreach (var part in parts)
        {
            if (part is not JsonObject obj) continue;
            if (obj.TryGetPropertyValue("text", out var text) && text is not null) return true;
            if (obj["inlineData"] is JsonObject || obj["inline_data"] is JsonObject) return true;
            if (IsGeminiImageFileData(obj)) return true;
        }

        return false;
    }

    private static JsonNode ExtractGeminiPartsContent(JsonObject content)
    {
        if (!content.TryGetPropertyValue("parts", out var partsNode) || partsNode is not JsonArray parts)
            return string.Empty;

        var openAiParts = new JsonArray();
        foreach (var part in parts)
        {
            if (part is not JsonObject obj) continue;
            if (obj.TryGetPropertyValue("text", out var text) && text is not null)
            {
                openAiParts.Add(new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = text.DeepClone(),
                });
                continue;
            }

            var inline = obj["inlineData"] as JsonObject ?? obj["inline_data"] as JsonObject;
            if (inline != null)
            {
                var mimeType = ReadString(inline, "mimeType") ?? ReadString(inline, "mime_type") ?? "application/octet-stream";
                var data = ReadString(inline, "data") ?? string.Empty;
                openAiParts.Add(new JsonObject
                {
                    ["type"] = "image_url",
                    ["image_url"] = new JsonObject
                    {
                        ["url"] = $"data:{mimeType};base64,{data}",
                    },
                });
                continue;
            }

            var fileData = obj["fileData"] as JsonObject ?? obj["file_data"] as JsonObject;
            if (fileData != null)
            {
                var mimeType = ReadString(fileData, "mimeType") ?? ReadString(fileData, "mime_type") ?? "application/octet-stream";
                var fileUri = ReadString(fileData, "fileUri") ?? ReadString(fileData, "file_uri");
                if (mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
                    && !string.IsNullOrWhiteSpace(fileUri))
                {
                    openAiParts.Add(new JsonObject
                    {
                        ["type"] = "image_url",
                        ["image_url"] = new JsonObject
                        {
                            ["url"] = fileUri,
                        },
                    });
                }
            }
        }

        if (openAiParts.Count == 1
            && openAiParts[0] is JsonObject only
            && string.Equals(ReadString(only, "type"), "text", StringComparison.OrdinalIgnoreCase)
            && only.TryGetPropertyValue("text", out var singleText)
            && singleText is not null)
        {
            return singleText.DeepClone();
        }

        return openAiParts;
    }

    private static bool IsGeminiImageFileData(JsonObject part)
    {
        var fileData = part["fileData"] as JsonObject ?? part["file_data"] as JsonObject;
        if (fileData == null)
            return false;
        var mimeType = ReadString(fileData, "mimeType") ?? ReadString(fileData, "mime_type");
        var fileUri = ReadString(fileData, "fileUri") ?? ReadString(fileData, "file_uri");
        return !string.IsNullOrWhiteSpace(fileUri)
               && !string.IsNullOrWhiteSpace(mimeType)
               && mimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase);
    }

    private static JsonArray ExtractGeminiFunctionCalls(JsonObject content)
    {
        var result = new JsonArray();
        if (!content.TryGetPropertyValue("parts", out var partsNode) || partsNode is not JsonArray parts)
            return result;

        foreach (var part in parts)
        {
            if (part is not JsonObject obj) continue;
            var functionCall = obj["functionCall"] as JsonObject ?? obj["function_call"] as JsonObject;
            if (functionCall is null) continue;

            var name = ReadString(functionCall, "name");
            if (string.IsNullOrWhiteSpace(name)) continue;
            var args = functionCall.TryGetPropertyValue("args", out var argsNode) && argsNode is not null
                ? argsNode
                : functionCall.TryGetPropertyValue("arguments", out var argumentsNode) && argumentsNode is not null
                    ? argumentsNode
                    : new JsonObject();

            result.Add(new JsonObject
            {
                ["id"] = BuildGeminiToolCallId(name),
                ["type"] = "function",
                ["function"] = new JsonObject
                {
                    ["name"] = name,
                    ["arguments"] = SerializeJsonNode(args),
                },
            });
        }

        return result;
    }

    private static IEnumerable<JsonObject> ExtractGeminiFunctionResponseMessages(JsonObject content)
    {
        if (!content.TryGetPropertyValue("parts", out var partsNode) || partsNode is not JsonArray parts)
            yield break;

        foreach (var part in parts)
        {
            if (part is not JsonObject obj) continue;
            var functionResponse = obj["functionResponse"] as JsonObject ?? obj["function_response"] as JsonObject;
            if (functionResponse is null) continue;

            var name = ReadString(functionResponse, "name");
            if (string.IsNullOrWhiteSpace(name)) continue;
            var response = functionResponse.TryGetPropertyValue("response", out var responseNode) && responseNode is not null
                ? responseNode
                : new JsonObject();

            yield return new JsonObject
            {
                ["role"] = "tool",
                ["tool_call_id"] = BuildGeminiToolCallId(name),
                ["name"] = name,
                ["content"] = SerializeJsonNode(response),
            };
        }
    }

    private static string BuildGeminiToolCallId(string name)
        => $"gemini-call-{name}";

    private static string SerializeJsonNode(JsonNode node)
        => node.ToJsonString();

    private static void CopyJsonField(JsonObject source, JsonObject target, string field)
    {
        if (source.TryGetPropertyValue(field, out var node) && node is not null)
            target[field] = node.DeepClone();
    }

    private static string? NormalizeGeminiRouteModel(string? model)
    {
        if (string.IsNullOrWhiteSpace(model)) return null;
        var trimmed = model.Trim();
        return trimmed.StartsWith("models/", StringComparison.OrdinalIgnoreCase)
            ? trimmed["models/".Length..]
            : trimmed;
    }

    private static async Task WriteCompatErrorAsync(
        HttpContext http,
        string message,
        string type,
        string? code,
        int statusCode)
    {
        http.Response.StatusCode = statusCode;
        http.Response.ContentType = "application/json";
        await http.Response.WriteAsync(JsonSerializer.Serialize(new
        {
            error = new { message, type, code }
        }, SnakeJson));
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
        var logprobs = response.Extensions is not null
            && response.Extensions.TryGetValue("logprobs", out var logprobsNode)
            ? logprobsNode
            : null;
        http.Response.ContentType = "application/json";
        if (response.ToolCalls is { Count: > 0 })
        {
            var toolCompletion = new
            {
                id = $"chatcmpl-{requestId}",
                @object = "chat.completion",
                created,
                model,
                choices = new[] { new { index = 0, message = new { role = "assistant", content = (string?)null, toolCalls = response.ToolCalls }, logprobs, finishReason = "tool_calls" } },
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
            choices = new[] { new { index = 0, message = new { role = "assistant", content = response.Content ?? string.Empty, toolCalls = (JsonArray?)null }, logprobs, finishReason = "stop" } },
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

    private static async Task SendOpenAiResponsesCompatibleAsync(
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
            await WriteCompatErrorAsync(
                http,
                response.ErrorMessage ?? "上游模型调用失败",
                "api_error",
                response.ErrorCode,
                response.StatusCode > 0 ? response.StatusCode : StatusCodes.Status502BadGateway);
            return;
        }

        var inputTokens = response.TokenUsage?.InputTokens ?? 0;
        var outputTokens = response.TokenUsage?.OutputTokens ?? 0;
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var content = response.Content ?? string.Empty;
        var output = BuildOpenAiResponsesOutput(requestId, content, response.ToolCalls);
        http.Response.ContentType = "application/json";
        await http.Response.WriteAsync(JsonSerializer.Serialize(new
        {
            id = $"resp-{requestId}",
            @object = "response",
            createdAt = created,
            status = "completed",
            model,
            output,
            outputText = content,
            usage = new
            {
                inputTokens,
                outputTokens,
                totalTokens = inputTokens + outputTokens,
            },
        }, SnakeJson));
    }

    private static JsonArray BuildOpenAiResponsesOutput(string requestId, string content, JsonArray? toolCalls)
    {
        var output = new JsonArray();
        if (!string.IsNullOrEmpty(content) || toolCalls is not { Count: > 0 })
        {
            output.Add(new JsonObject
            {
                ["id"] = $"msg-{requestId}",
                ["type"] = "message",
                ["status"] = "completed",
                ["role"] = "assistant",
                ["content"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["type"] = "output_text",
                        ["text"] = content,
                    },
                },
            });
        }

        if (toolCalls is { Count: > 0 })
        {
            for (var i = 0; i < toolCalls.Count; i++)
            {
                if (toolCalls[i] is JsonObject toolCall)
                    output.Add(ConvertOpenAiToolCallToResponsesFunctionCall(toolCall, requestId, i));
            }
        }

        return output;
    }

    private static JsonObject ConvertOpenAiToolCallToResponsesFunctionCall(JsonObject toolCall, string requestId, int index)
    {
        var function = toolCall["function"] as JsonObject;
        return new JsonObject
        {
            ["id"] = ReadString(toolCall, "id") ?? $"fc-{requestId}-{index}",
            ["type"] = "function_call",
            ["status"] = "completed",
            ["call_id"] = ReadString(toolCall, "id") ?? $"call-{requestId}-{index}",
            ["name"] = function is null ? null : ReadString(function, "name"),
            ["arguments"] = function is null ? "{}" : ReadString(function, "arguments") ?? "{}",
        };
    }

    private static IEnumerable<ResponsesStreamEvent> BuildOpenAiResponsesToolCallStreamEvents(string requestId, JsonArray toolCallDelta)
    {
        for (var i = 0; i < toolCallDelta.Count; i++)
        {
            if (toolCallDelta[i] is not JsonObject toolCall) continue;

            var index = ReadInt(toolCall, "index") ?? i;
            var function = toolCall["function"] as JsonObject;
            var id = ReadString(toolCall, "id") ?? $"fc-{requestId}-{index}";
            var name = function is null ? null : ReadString(function, "name");
            var arguments = function is null ? string.Empty : ReadString(function, "arguments") ?? string.Empty;

            if (!string.IsNullOrWhiteSpace(name))
            {
                yield return new ResponsesStreamEvent("response.output_item.added", new JsonObject
                {
                    ["type"] = "response.output_item.added",
                    ["output_index"] = index,
                    ["item"] = new JsonObject
                    {
                        ["id"] = id,
                        ["type"] = "function_call",
                        ["status"] = "in_progress",
                        ["call_id"] = id,
                        ["name"] = name,
                        ["arguments"] = string.Empty,
                    },
                });
            }

            if (!string.IsNullOrEmpty(arguments))
            {
                yield return new ResponsesStreamEvent("response.function_call_arguments.delta", new JsonObject
                {
                    ["type"] = "response.function_call_arguments.delta",
                    ["item_id"] = id,
                    ["output_index"] = index,
                    ["delta"] = arguments,
                });

                yield return new ResponsesStreamEvent("response.function_call_arguments.done", new JsonObject
                {
                    ["type"] = "response.function_call_arguments.done",
                    ["item_id"] = id,
                    ["output_index"] = index,
                    ["arguments"] = arguments,
                });

                yield return new ResponsesStreamEvent("response.output_item.done", new JsonObject
                {
                    ["type"] = "response.output_item.done",
                    ["output_index"] = index,
                    ["item"] = new JsonObject
                    {
                        ["id"] = id,
                        ["type"] = "function_call",
                        ["status"] = "completed",
                        ["call_id"] = id,
                        ["name"] = name,
                        ["arguments"] = arguments,
                    },
                });
            }
        }
    }

    private static int? ReadInt(JsonObject body, string key)
    {
        if (!body.TryGetPropertyValue(key, out var node) || node is not JsonValue value)
            return null;
        if (value.TryGetValue<int>(out var i)) return i;
        if (value.TryGetValue<long>(out var l)) return l is >= int.MinValue and <= int.MaxValue ? (int)l : null;
        return null;
    }

    private sealed record ResponsesStreamEvent(string Name, JsonObject Data);

    private static async Task StreamOpenAiResponsesCompatibleAsync(
        HttpContext http,
        PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
        GatewayRequest request,
        string requestId,
        string? requestedModel)
    {
        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no";

        var model = requestedModel ?? "auto";
        var started = false;

        async Task WriteEventAsync(string name, object data)
        {
            await http.Response.WriteAsync($"event: {name}\n");
            await http.Response.WriteAsync("data: " + JsonSerializer.Serialize(data, SnakeJson) + "\n\n");
            await http.Response.Body.FlushAsync();
        }

        try
        {
            await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
            {
                if (!started)
                {
                    started = true;
                    await WriteEventAsync("response.created", new
                    {
                        type = "response.created",
                        response = new { id = $"resp-{requestId}", @object = "response", status = "in_progress", model },
                    });
                }

                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    model = chunk.Resolution.ActualModel ?? model;
                }
                else if ((chunk.Type == GatewayChunkType.Text || chunk.Type == GatewayChunkType.Thinking)
                         && !string.IsNullOrEmpty(chunk.Content))
                {
                    await WriteEventAsync("response.output_text.delta", new
                    {
                        type = "response.output_text.delta",
                        itemId = $"msg-{requestId}",
                        outputIndex = 0,
                        contentIndex = 0,
                        delta = chunk.Content,
                    });
                }
                else if (chunk.Type == GatewayChunkType.ToolCall && chunk.ToolCallDelta != null)
                {
                    foreach (var toolEvent in BuildOpenAiResponsesToolCallStreamEvents(requestId, chunk.ToolCallDelta))
                    {
                        await WriteEventAsync(toolEvent.Name, toolEvent.Data);
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteEventAsync("response.failed", new
                    {
                        type = "response.failed",
                        response = new { id = $"resp-{requestId}", status = "failed" },
                        error = new { message = chunk.Error ?? "上游模型调用失败", type = "api_error", code = "upstream_error" },
                    });
                    return;
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    var inputTokens = chunk.TokenUsage?.InputTokens ?? 0;
                    var outputTokens = chunk.TokenUsage?.OutputTokens ?? 0;
                    await WriteEventAsync("response.completed", new
                    {
                        type = "response.completed",
                        response = new
                        {
                            id = $"resp-{requestId}",
                            @object = "response",
                            status = "completed",
                            model,
                            usage = new { inputTokens, outputTokens, totalTokens = inputTokens + outputTokens },
                        },
                    });
                    await http.Response.WriteAsync("data: [DONE]\n\n");
                    await http.Response.Body.FlushAsync();
                    return;
                }
            }
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

    private static GatewayRawRequest ToOpenAiImageRawRequest(
        GatewayIngressRequest ingress,
        string endpointPath = "/v1/images/generations",
        Dictionary<string, object>? multipartFields = null,
        Dictionary<string, (string FileName, byte[] Content, string MimeType)>? multipartFiles = null)
        => new()
        {
            AppCallerCode = ingress.AppCallerCode,
            ModelType = ingress.RequestType,
            EndpointPath = endpointPath,
            ExpectedModel = string.Equals(ingress.ModelPolicy, "pool", StringComparison.OrdinalIgnoreCase)
                            && !string.IsNullOrWhiteSpace(ingress.ModelPoolId)
                ? ingress.ModelPoolId
                : ingress.ExpectedModel,
            PinnedPlatformId = ingress.PinnedPlatformId,
            PinnedModelId = ingress.PinnedModelId,
            RequestBody = ingress.RequestBody,
            IsMultipart = multipartFiles is { Count: > 0 },
            MultipartFields = multipartFields,
            MultipartFiles = multipartFiles,
            TimeoutSeconds = 600,
            Context = new GatewayRequestContext
            {
                RequestId = ingress.Context?.RequestId ?? ingress.RequestId,
                SessionId = ingress.Context?.SessionId,
                RunId = ingress.Context?.RunId,
                GroupId = ingress.Context?.GroupId,
                UserId = ingress.Context?.UserId,
                QuestionText = ingress.Context?.QuestionText,
                GatewayTransport = ingress.Context?.GatewayTransport,
                SourceSystem = ingress.SourceSystem,
                IngressProtocol = ingress.IngressProtocol,
                AppCallerTitle = ingress.AppCallerTitle,
                ModelPolicy = ingress.ModelPolicy,
                ModelPoolId = ingress.ModelPoolId,
                ParameterPolicy = ingress.ParameterPolicy,
                DroppedParameters = ingress.DroppedParameters,
            },
        };

    private static async Task<OpenAiImageMultipartParseResult> ReadOpenAiImageMultipartAsync(
        HttpRequest request,
        CancellationToken ct)
    {
        IFormCollection form;
        try
        {
            form = await request.ReadFormAsync(ct);
        }
        catch
        {
            return OpenAiImageMultipartParseResult.Fail("invalid_multipart", "multipart/form-data 解析失败", 400);
        }

        var fields = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var key in form.Keys)
        {
            if (string.Equals(key, "model", StringComparison.OrdinalIgnoreCase)) continue;
            var values = form[key];
            fields[key] = values.Count <= 1
                ? values.ToString()
                : values.ToArray();
        }

        var files = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>(StringComparer.Ordinal);
        var fileIndexByName = new Dictionary<string, int>(StringComparer.Ordinal);
        var imageFileCount = form.Files.Count(f => IsOpenAiImageEditImageField(f.Name));
        var imageFileIndex = 0;
        foreach (var file in form.Files)
        {
            if (file.Length <= 0) continue;

            await using var stream = file.OpenReadStream();
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms, ct);

            var rawFieldName = string.IsNullOrWhiteSpace(file.Name) ? "file" : file.Name;
            var fieldName = rawFieldName;
            if (IsOpenAiImageEditImageField(rawFieldName))
            {
                fieldName = imageFileCount > 1 || IsOpenAiImageEditArrayField(rawFieldName)
                    ? $"image[{imageFileIndex++}]"
                    : "image";
            }
            else if (files.ContainsKey(fieldName))
            {
                var next = fileIndexByName.TryGetValue(fieldName, out var current) ? current + 1 : 1;
                fileIndexByName[fieldName] = next;
                fieldName = $"{fieldName}[{next}]";
            }
            else
            {
                fileIndexByName[fieldName] = 0;
            }

            files[fieldName] = (
                string.IsNullOrWhiteSpace(file.FileName) ? $"{fieldName}.bin" : Path.GetFileName(file.FileName),
                ms.ToArray(),
                string.IsNullOrWhiteSpace(file.ContentType) ? "application/octet-stream" : file.ContentType);
        }

        if (files.Count == 0)
        {
            return OpenAiImageMultipartParseResult.Fail("missing_image", "图片编辑请求必须包含 image 文件", 400);
        }

        var supported = new HashSet<string>(StringComparer.Ordinal)
        {
            "model",
            "image",
            "mask",
            "prompt",
            "n",
            "size",
            "response_format",
            "user",
            "provider",
            "run_id",
            "runId",
        };
        var dropped = form.Keys
            .Concat(form.Files.Select(f => f.Name))
            .Where(k => !supported.Contains(k) && !IsOpenAiImageEditImageField(k))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(k => k, StringComparer.Ordinal)
            .ToList();

        return OpenAiImageMultipartParseResult.Ok(
            form["model"].FirstOrDefault(),
            form["prompt"].FirstOrDefault(),
            fields,
            files,
            dropped);
    }

    private sealed record OpenAiImageMultipartParseResult(
        bool Success,
        string? Model,
        string? Prompt,
        Dictionary<string, object>? MultipartFields,
        Dictionary<string, (string FileName, byte[] Content, string MimeType)>? MultipartFiles,
        List<string> DroppedParameters,
        string? ErrorCode,
        string? ErrorMessage,
        int StatusCode)
    {
        public static OpenAiImageMultipartParseResult Ok(
            string? model,
            string? prompt,
            Dictionary<string, object> fields,
            Dictionary<string, (string FileName, byte[] Content, string MimeType)> files,
            List<string> droppedParameters)
            => new(true, model, prompt, fields, files, droppedParameters, null, null, 200);

        public static OpenAiImageMultipartParseResult Fail(string code, string message, int statusCode)
            => new(false, null, null, null, null, new List<string>(), code, message, statusCode);
    }

    private static bool IsOpenAiImageEditImageField(string? fieldName)
    {
        if (string.IsNullOrWhiteSpace(fieldName))
            return false;
        return string.Equals(fieldName, "image", StringComparison.Ordinal)
               || IsOpenAiImageEditArrayField(fieldName);
    }

    private static bool IsOpenAiImageEditArrayField(string fieldName)
        => string.Equals(fieldName, "image[]", StringComparison.Ordinal)
           || (fieldName.StartsWith("image[", StringComparison.Ordinal)
               && fieldName.EndsWith("]", StringComparison.Ordinal));

    private static async Task WriteOpenAiRawCompatAsync(HttpContext http, GatewayRawResponse raw)
    {
        http.Response.StatusCode = raw.StatusCode > 0 ? raw.StatusCode : (raw.Success ? StatusCodes.Status200OK : StatusCodes.Status502BadGateway);
        if (!raw.Success)
        {
            http.Response.ContentType = "application/json";
            await http.Response.WriteAsync(JsonSerializer.Serialize(new
            {
                error = new
                {
                    message = raw.ErrorMessage ?? "上游模型调用失败",
                    type = "api_error",
                    code = raw.ErrorCode,
                },
            }, SnakeJson));
            return;
        }

        if (raw.BinaryContent is { Length: > 0 })
        {
            http.Response.ContentType = string.IsNullOrWhiteSpace(raw.ContentType) ? "application/octet-stream" : raw.ContentType;
            await http.Response.Body.WriteAsync(raw.BinaryContent);
            return;
        }

        http.Response.ContentType = string.IsNullOrWhiteSpace(raw.ContentType) ? "application/json" : raw.ContentType;
        await http.Response.WriteAsync(raw.Content ?? string.Empty);
    }

    private static async Task SendClaudeCompatibleAsync(
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
            await WriteCompatErrorAsync(
                http,
                response.ErrorMessage ?? "上游模型调用失败",
                "api_error",
                response.ErrorCode,
                response.StatusCode > 0 ? response.StatusCode : StatusCodes.Status502BadGateway);
            return;
        }

        var usage = new
        {
            inputTokens = response.TokenUsage?.InputTokens ?? 0,
            outputTokens = response.TokenUsage?.OutputTokens ?? 0,
        };
        var content = BuildClaudeContent(response.Content ?? string.Empty, response.ToolCalls);
        http.Response.ContentType = "application/json";
        await http.Response.WriteAsync(JsonSerializer.Serialize(new
        {
            id = $"msg-{requestId}",
            type = "message",
            role = "assistant",
            model,
            content,
            stopReason = response.ToolCalls is { Count: > 0 } ? "tool_use" : "end_turn",
            usage,
        }, SnakeJson));
    }

    private static JsonArray BuildClaudeContent(string text, JsonArray? toolCalls)
    {
        var content = new JsonArray();
        if (!string.IsNullOrEmpty(text) || toolCalls is not { Count: > 0 })
        {
            content.Add(new JsonObject
            {
                ["type"] = "text",
                ["text"] = text,
            });
        }

        if (toolCalls is { Count: > 0 })
        {
            foreach (var node in toolCalls)
            {
                if (node is JsonObject toolCall)
                    content.Add(ConvertOpenAiToolCallToClaudeToolUse(toolCall));
            }
        }

        return content;
    }

    private static JsonObject ConvertOpenAiToolCallToClaudeToolUse(JsonObject toolCall)
    {
        var function = toolCall["function"] as JsonObject;
        var arguments = function is null ? "{}" : ReadString(function, "arguments") ?? "{}";
        return new JsonObject
        {
            ["type"] = "tool_use",
            ["id"] = ReadString(toolCall, "id") ?? Guid.NewGuid().ToString("N"),
            ["name"] = function is null ? null : ReadString(function, "name"),
            ["input"] = ParseJsonObjectOrString(arguments),
        };
    }

    private static JsonNode ParseJsonObjectOrString(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return new JsonObject();
        try
        {
            return JsonNode.Parse(value) ?? value;
        }
        catch
        {
            return value;
        }
    }

    private static IEnumerable<ClaudeStreamEvent> BuildClaudeToolUseStreamEvents(JsonArray toolCallDelta)
    {
        for (var i = 0; i < toolCallDelta.Count; i++)
        {
            if (toolCallDelta[i] is not JsonObject toolCall) continue;

            var rawIndex = ReadInt(toolCall, "index") ?? i;
            var index = rawIndex <= 0 ? rawIndex + 1 : rawIndex;
            var function = toolCall["function"] as JsonObject;
            var id = ReadString(toolCall, "id") ?? $"toolu_{Guid.NewGuid():N}";
            var name = function is null ? null : ReadString(function, "name");
            var arguments = function is null ? string.Empty : ReadString(function, "arguments") ?? string.Empty;

            if (!string.IsNullOrWhiteSpace(name))
            {
                yield return new ClaudeStreamEvent("content_block_start", new JsonObject
                {
                    ["type"] = "content_block_start",
                    ["index"] = index,
                    ["content_block"] = new JsonObject
                    {
                        ["type"] = "tool_use",
                        ["id"] = id,
                        ["name"] = name,
                        ["input"] = new JsonObject(),
                    },
                });
            }

            if (!string.IsNullOrEmpty(arguments))
            {
                yield return new ClaudeStreamEvent("content_block_delta", new JsonObject
                {
                    ["type"] = "content_block_delta",
                    ["index"] = index,
                    ["delta"] = new JsonObject
                    {
                        ["type"] = "input_json_delta",
                        ["partial_json"] = arguments,
                    },
                });

                yield return new ClaudeStreamEvent("content_block_stop", new JsonObject
                {
                    ["type"] = "content_block_stop",
                    ["index"] = index,
                });
            }
        }
    }

    private sealed record ClaudeStreamEvent(string Name, JsonObject Data);

    private static async Task StreamClaudeCompatibleAsync(
        HttpContext http,
        PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
        GatewayRequest request,
        string requestId,
        string? requestedModel)
    {
        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no";

        var model = requestedModel ?? "auto";
        var started = false;

        async Task WriteEventAsync(string name, object data)
        {
            await http.Response.WriteAsync($"event: {name}\n");
            await http.Response.WriteAsync("data: " + JsonSerializer.Serialize(data, SnakeJson) + "\n\n");
            await http.Response.Body.FlushAsync();
        }

        try
        {
            await foreach (var chunk in gateway.StreamAsync(request, CancellationToken.None))
            {
                if (!started)
                {
                    started = true;
                    await WriteEventAsync("message_start", new
                    {
                        type = "message_start",
                        message = new { id = $"msg-{requestId}", type = "message", role = "assistant", model, content = Array.Empty<object>() },
                    });
                    await WriteEventAsync("content_block_start", new
                    {
                        type = "content_block_start",
                        index = 0,
                        contentBlock = new { type = "text", text = string.Empty },
                    });
                }

                if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    model = chunk.Resolution.ActualModel ?? model;
                }
                else if ((chunk.Type == GatewayChunkType.Text || chunk.Type == GatewayChunkType.Thinking)
                         && !string.IsNullOrEmpty(chunk.Content))
                {
                    await WriteEventAsync("content_block_delta", new
                    {
                        type = "content_block_delta",
                        index = 0,
                        delta = new { type = "text_delta", text = chunk.Content },
                    });
                }
                else if (chunk.Type == GatewayChunkType.ToolCall && chunk.ToolCallDelta != null)
                {
                    foreach (var toolEvent in BuildClaudeToolUseStreamEvents(chunk.ToolCallDelta))
                    {
                        await WriteEventAsync(toolEvent.Name, toolEvent.Data);
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteEventAsync("error", new { type = "error", error = new { type = "api_error", message = chunk.Error ?? "上游模型调用失败" } });
                    return;
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    await WriteEventAsync("content_block_stop", new { type = "content_block_stop", index = 0 });
                    await WriteEventAsync("message_delta", new
                    {
                        type = "message_delta",
                        delta = new { stopReason = chunk.FinishReason ?? "end_turn" },
                        usage = new { outputTokens = chunk.TokenUsage?.OutputTokens ?? 0 },
                    });
                    await WriteEventAsync("message_stop", new { type = "message_stop" });
                    return;
                }
            }

            if (started)
            {
                await WriteEventAsync("content_block_stop", new { type = "content_block_stop", index = 0 });
                await WriteEventAsync("message_stop", new { type = "message_stop" });
            }
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

    private static async Task SendGeminiCompatibleAsync(
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
            await WriteCompatErrorAsync(
                http,
                response.ErrorMessage ?? "上游模型调用失败",
                "api_error",
                response.ErrorCode,
                response.StatusCode > 0 ? response.StatusCode : StatusCodes.Status502BadGateway);
            return;
        }

        http.Response.ContentType = "application/json";
        var parts = BuildGeminiParts(response.Content ?? string.Empty, response.ToolCalls);
        await http.Response.WriteAsync(JsonSerializer.Serialize(new
        {
            responseId = requestId,
            modelVersion = model,
            candidates = new[]
            {
                new
                {
                    content = new { role = "model", parts },
                    finishReason = response.ToolCalls is { Count: > 0 } ? "FUNCTION_CALL" : "STOP",
                    index = 0,
                }
            },
            usageMetadata = new
            {
                promptTokenCount = response.TokenUsage?.InputTokens ?? 0,
                candidatesTokenCount = response.TokenUsage?.OutputTokens ?? 0,
                totalTokenCount = (response.TokenUsage?.InputTokens ?? 0) + (response.TokenUsage?.OutputTokens ?? 0),
            },
        }));
    }

    private static async Task StreamGeminiCompatibleAsync(
        HttpContext http,
        PrdAgent.Infrastructure.LlmGateway.ILlmGateway gateway,
        GatewayRequest request,
        string requestId,
        string? requestedModel)
    {
        http.Response.Headers.ContentType = "text/event-stream";
        http.Response.Headers.CacheControl = "no-cache";
        http.Response.Headers["X-Accel-Buffering"] = "no";

        var model = requestedModel ?? "auto";

        async Task WriteDataAsync(JsonObject data)
        {
            await http.Response.WriteAsync("data: " + data.ToJsonString() + "\n\n");
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
                else if ((chunk.Type == GatewayChunkType.Text || chunk.Type == GatewayChunkType.Thinking)
                         && !string.IsNullOrEmpty(chunk.Content))
                {
                    await WriteDataAsync(BuildGeminiResponseObject(
                        requestId,
                        model,
                        new JsonArray { new JsonObject { ["text"] = chunk.Content } },
                        null,
                        null));
                }
                else if (chunk.Type == GatewayChunkType.ToolCall && chunk.ToolCallDelta != null)
                {
                    await WriteDataAsync(BuildGeminiResponseObject(
                        requestId,
                        model,
                        BuildGeminiParts(string.Empty, chunk.ToolCallDelta),
                        "FUNCTION_CALL",
                        null));
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    await WriteDataAsync(new JsonObject
                    {
                        ["error"] = new JsonObject
                        {
                            ["code"] = 502,
                            ["message"] = chunk.Error ?? "上游模型调用失败",
                            ["status"] = "UPSTREAM_ERROR",
                        },
                    });
                    return;
                }
                else if (chunk.Type == GatewayChunkType.Done)
                {
                    await WriteDataAsync(BuildGeminiResponseObject(
                        requestId,
                        model,
                        new JsonArray(),
                        string.Equals(chunk.FinishReason, "tool_calls", StringComparison.OrdinalIgnoreCase)
                            ? "FUNCTION_CALL"
                            : "STOP",
                        chunk.TokenUsage));
                    return;
                }
            }
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

    private static JsonObject BuildGeminiResponseObject(
        string requestId,
        string model,
        JsonArray parts,
        string? finishReason,
        GatewayTokenUsage? tokenUsage)
    {
        var candidate = new JsonObject
        {
            ["content"] = new JsonObject
            {
                ["role"] = "model",
                ["parts"] = parts,
            },
            ["index"] = 0,
        };
        if (!string.IsNullOrWhiteSpace(finishReason))
            candidate["finishReason"] = finishReason;

        var response = new JsonObject
        {
            ["responseId"] = requestId,
            ["modelVersion"] = model,
            ["candidates"] = new JsonArray { candidate },
        };

        if (tokenUsage is not null)
        {
            var promptTokens = tokenUsage.InputTokens;
            var candidatesTokens = tokenUsage.OutputTokens;
            response["usageMetadata"] = new JsonObject
            {
                ["promptTokenCount"] = promptTokens,
                ["candidatesTokenCount"] = candidatesTokens,
                ["totalTokenCount"] = promptTokens + candidatesTokens,
            };
        }

        return response;
    }

    private static JsonArray BuildGeminiParts(string text, JsonArray? toolCalls)
    {
        var parts = new JsonArray();
        if (!string.IsNullOrEmpty(text) || toolCalls is not { Count: > 0 })
        {
            parts.Add(new JsonObject
            {
                ["text"] = text,
            });
        }

        if (toolCalls is { Count: > 0 })
        {
            foreach (var node in toolCalls)
            {
                if (node is JsonObject toolCall)
                    parts.Add(ConvertOpenAiToolCallToGeminiFunctionCall(toolCall));
            }
        }

        return parts;
    }

    private static JsonObject ConvertOpenAiToolCallToGeminiFunctionCall(JsonObject toolCall)
    {
        var function = toolCall["function"] as JsonObject;
        var arguments = function is null ? "{}" : ReadString(function, "arguments") ?? "{}";
        return new JsonObject
        {
            ["functionCall"] = new JsonObject
            {
                ["name"] = function is null ? null : ReadString(function, "name"),
                ["args"] = ParseJsonObjectOrString(arguments),
            },
        };
    }

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
            RunId: ctx?.RunId,
            UserId: ctx?.UserId,
            ViewRole: ctx?.ViewRole,
            DocumentChars: ctx?.DocumentChars,
            DocumentHash: ctx?.DocumentHash,
            SystemPromptRedacted: null,
            RequestType: requestType,
            AppCallerCode: appCallerCode,
            // S2：MAP 侧 http 模式已把传输标记随 body.Context 过线，透传进作用域，
            // 供 serving 端直连客户端（若有）读取；网关日志由 LlmGateway 直接读 request.Context 标注。
            GatewayTransport: ctx?.GatewayTransport,
            IsHealthProbe: ctx?.IsHealthProbe));
    }

    private static GatewayIngressRequest ToIngress(GatewayRequest request, string ingressProtocol, string sourceSystem)
    {
        var explicitModelPolicy = NormalizeModelPolicy(request.Context?.ModelPolicy);
        return new GatewayIngressRequest
        {
            RequestId = request.Context?.RequestId ?? Guid.NewGuid().ToString("N"),
            SourceSystem = request.Context?.SourceSystem ?? sourceSystem,
            IngressProtocol = request.Context?.IngressProtocol ?? ingressProtocol,
            AppCallerCode = request.AppCallerCode,
            AppCallerTitle = request.Context?.AppCallerTitle,
            RequestType = request.ModelType,
            ModelPolicy = explicitModelPolicy
                ?? (!string.IsNullOrWhiteSpace(request.PinnedPlatformId) || !string.IsNullOrWhiteSpace(request.PinnedModelId)
                ? "pinned"
                : string.IsNullOrWhiteSpace(request.GetEffectiveExpectedModel()) ? "auto" : "pinned"),
            ModelPoolId = request.Context?.ModelPoolId,
            ParameterPolicy = request.Context?.ParameterPolicy ?? "default-drop",
            ExpectedModel = string.Equals(explicitModelPolicy, "pool", StringComparison.OrdinalIgnoreCase)
                            && !string.IsNullOrWhiteSpace(request.Context?.ModelPoolId)
                ? request.Context.ModelPoolId
                : request.GetEffectiveExpectedModel(),
            PinnedPlatformId = request.PinnedPlatformId,
            PinnedModelId = request.PinnedModelId,
            RequestBody = request.GetEffectiveRequestBody(),
            DroppedParameters = request.Context?.DroppedParameters ?? new List<string>(),
            Context = request.Context,
        };
    }

    private static GatewayRequest ApplyIngressRouting(GatewayRequest request, GatewayIngressRequest ingress, bool stream)
    {
        var source = request.Context;
        return new GatewayRequest
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = request.ModelType,
            ExpectedModel = ingress.ExpectedModel,
            PinnedPlatformId = ingress.PinnedPlatformId,
            PinnedModelId = ingress.PinnedModelId,
            RequestBody = request.RequestBody,
            RequestBodyRaw = request.RequestBodyRaw,
            Stream = stream,
            EnablePromptCache = request.EnablePromptCache,
            TimeoutSeconds = request.TimeoutSeconds,
            IncludeThinking = request.IncludeThinking,
            Context = new GatewayRequestContext
            {
                RequestId = source?.RequestId ?? ingress.RequestId,
                SessionId = source?.SessionId,
                RunId = source?.RunId,
                GroupId = source?.GroupId,
                UserId = source?.UserId,
                ViewRole = source?.ViewRole,
                DocumentChars = source?.DocumentChars,
                DocumentHash = source?.DocumentHash,
                QuestionText = source?.QuestionText,
                SystemPromptChars = source?.SystemPromptChars,
                SystemPromptText = source?.SystemPromptText,
                ImageReferences = source?.ImageReferences,
                GatewayTransport = GatewayTransports.Http,
                SourceSystem = ingress.SourceSystem,
                IngressProtocol = ingress.IngressProtocol,
                AppCallerTitle = ingress.AppCallerTitle,
                ModelPolicy = ingress.ModelPolicy,
                ModelPoolId = ingress.ModelPoolId,
                ParameterPolicy = ingress.ParameterPolicy,
                DroppedParameters = ingress.DroppedParameters,
                IsHealthProbe = source?.IsHealthProbe,
            },
        };
    }

    private static GatewayRawRequest ApplyIngressRouting(GatewayRawRequest request, GatewayIngressRequest ingress)
    {
        var source = request.Context;
        return new GatewayRawRequest
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = request.ModelType,
            EndpointPath = request.EndpointPath,
            ExpectedModel = ingress.ExpectedModel,
            PinnedPlatformId = ingress.PinnedPlatformId,
            PinnedModelId = ingress.PinnedModelId,
            RequestBody = request.RequestBody,
            IsMultipart = request.IsMultipart,
            MultipartFields = request.MultipartFields,
            MultipartFiles = request.MultipartFiles,
            MultipartFileRefs = request.MultipartFileRefs,
            HttpMethod = request.HttpMethod,
            ExtraHeaders = request.ExtraHeaders,
            TimeoutSeconds = request.TimeoutSeconds,
            ExpectBinaryResponse = request.ExpectBinaryResponse,
            Context = new GatewayRequestContext
            {
                RequestId = source?.RequestId ?? ingress.RequestId,
                SessionId = source?.SessionId,
                RunId = source?.RunId,
                GroupId = source?.GroupId,
                UserId = source?.UserId,
                ViewRole = source?.ViewRole,
                DocumentChars = source?.DocumentChars,
                DocumentHash = source?.DocumentHash,
                QuestionText = source?.QuestionText,
                SystemPromptChars = source?.SystemPromptChars,
                SystemPromptText = source?.SystemPromptText,
                ImageReferences = source?.ImageReferences,
                GatewayTransport = GatewayTransports.Http,
                SourceSystem = ingress.SourceSystem,
                IngressProtocol = ingress.IngressProtocol,
                AppCallerTitle = ingress.AppCallerTitle,
                ModelPolicy = ingress.ModelPolicy,
                ModelPoolId = ingress.ModelPoolId,
                ParameterPolicy = ingress.ParameterPolicy,
                DroppedParameters = ingress.DroppedParameters,
                IsHealthProbe = source?.IsHealthProbe,
            },
        };
    }

    private static GatewayIngressRequest ToIngress(GatewayRawRequest request, string ingressProtocol, string sourceSystem)
    {
        var explicitModelPolicy = NormalizeModelPolicy(request.Context?.ModelPolicy);
        return new GatewayIngressRequest
        {
            RequestId = request.Context?.RequestId ?? Guid.NewGuid().ToString("N"),
            SourceSystem = request.Context?.SourceSystem ?? sourceSystem,
            IngressProtocol = request.Context?.IngressProtocol ?? ingressProtocol,
            AppCallerCode = request.AppCallerCode,
            AppCallerTitle = request.Context?.AppCallerTitle,
            RequestType = request.ModelType,
            ModelPolicy = explicitModelPolicy
                ?? (!string.IsNullOrWhiteSpace(request.PinnedPlatformId) || !string.IsNullOrWhiteSpace(request.PinnedModelId)
                ? "pinned"
                : string.IsNullOrWhiteSpace(request.ExpectedModel) ? "auto" : "pinned"),
            ModelPoolId = request.Context?.ModelPoolId,
            ParameterPolicy = request.Context?.ParameterPolicy ?? "default-drop",
            ExpectedModel = string.Equals(explicitModelPolicy, "pool", StringComparison.OrdinalIgnoreCase)
                            && !string.IsNullOrWhiteSpace(request.Context?.ModelPoolId)
                ? request.Context.ModelPoolId
                : request.ExpectedModel,
            PinnedPlatformId = request.PinnedPlatformId,
            PinnedModelId = request.PinnedModelId,
            RequestBody = request.RequestBody ?? new JsonObject(),
            DroppedParameters = request.Context?.DroppedParameters ?? new List<string>(),
            Context = request.Context,
        };
    }

    private static async Task RecordDiscoveredAppCallerAsync(
        IServiceProvider services,
        GatewayIngressRequest ingress,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(ingress.AppCallerCode) || string.IsNullOrWhiteSpace(ingress.RequestType))
            return;

        var gatewayData = services.GetService<LlmGatewayDataContext>();
        if (gatewayData == null)
            return;

        var collection = gatewayData.Database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers");
        var now = DateTime.UtcNow;
        var modelPolicy = string.IsNullOrWhiteSpace(ingress.ModelPolicy) ? "auto" : ingress.ModelPolicy.Trim().ToLowerInvariant();
        var modelPoolId = string.IsNullOrWhiteSpace(ingress.ModelPoolId) ? null : ingress.ModelPoolId.Trim();
        var parameterPolicy = string.IsNullOrWhiteSpace(ingress.ParameterPolicy) ? "default-drop" : ingress.ParameterPolicy.Trim().ToLowerInvariant();
        var ingressProtocol = NormalizeIngressProtocol(ingress.IngressProtocol);
        var requestId = NormalizeOptionalTraceId(ingress.Context?.RequestId) ?? NormalizeOptionalTraceId(ingress.RequestId);
        var sessionId = NormalizeOptionalTraceId(ingress.Context?.SessionId);
        var runId = NormalizeOptionalTraceId(ingress.Context?.RunId);
        var filter = Builders<GatewayAppCallerRecord>.Filter.And(
            Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.AppCallerCode, ingress.AppCallerCode),
            Builders<GatewayAppCallerRecord>.Filter.Eq(x => x.RequestType, ingress.RequestType));
        var updates = new List<UpdateDefinition<GatewayAppCallerRecord>>
        {
            Builders<GatewayAppCallerRecord>.Update
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.AppCallerCode, ingress.AppCallerCode)
            .SetOnInsert(x => x.RequestType, ingress.RequestType)
            .SetOnInsert(x => x.Status, "discovered")
            .SetOnInsert(x => x.ModelPolicy, modelPolicy)
            .SetOnInsert(x => x.ParameterPolicy, parameterPolicy)
            .SetOnInsert(x => x.FirstSeenAt, now)
            .SetOnInsert(x => x.CreatedAt, now)
            .Set(x => x.SourceSystem, string.IsNullOrWhiteSpace(ingress.SourceSystem) ? "external" : ingress.SourceSystem)
            .Set(x => x.IngressProtocol, ingressProtocol)
            .AddToSet(x => x.ObservedIngressProtocols, ingressProtocol)
            .Set(x => x.Title, string.IsNullOrWhiteSpace(ingress.AppCallerTitle) ? ingress.AppCallerCode : ingress.AppCallerTitle)
            .Set(x => x.LastObservedModelPolicy, modelPolicy)
            .Set(x => x.LastObservedModelPoolId, modelPoolId)
            .Set(x => x.LastObservedParameterPolicy, parameterPolicy)
            .Set(x => x.LastObservedRequestId, requestId)
            .Set(x => x.LastObservedSessionId, sessionId)
            .Set(x => x.LastObservedRunId, runId)
            .Set(x => x.LastSeenAt, now)
            .Set(x => x.UpdatedAt, now)
            .Inc(x => x.TotalSeen, 1)
        };
        if (modelPoolId is not null)
        {
            updates.Add(Builders<GatewayAppCallerRecord>.Update.SetOnInsert(x => x.ModelPoolId, modelPoolId));
        }
        var update = Builders<GatewayAppCallerRecord>.Update.Combine(updates);

        try
        {
            await collection.UpdateOneAsync(filter, update, new UpdateOptions { IsUpsert = true }, ct);
        }
        catch
        {
            // 被动登记是观测能力，不能阻断模型请求主链路。
        }
    }

    private static string? NormalizeOptionalTraceId(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed;
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

    private sealed record AppCallerStatusDecision(
        bool Rejected,
        string AppCallerCode,
        string RequestType,
        string Status)
    {
        public static AppCallerStatusDecision Allow(string appCallerCode, string requestType, string status)
            => new(false, appCallerCode, requestType, status);

        public static AppCallerStatusDecision Reject(string appCallerCode, string requestType, string status)
            => new(true, appCallerCode, requestType, status);
    }

    private sealed record AppCallerRateLimitDecision(
        bool Rejected,
        string AppCallerCode,
        string RequestType,
        int LimitPerMinute,
        long Count,
        DateTime WindowStart)
    {
        public static AppCallerRateLimitDecision Allow(
            string appCallerCode,
            string requestType,
            int limitPerMinute = 0,
            long count = 0,
            DateTime? windowStart = null)
            => new(false, appCallerCode, requestType, limitPerMinute, count, windowStart ?? DateTime.UtcNow);

        public static AppCallerRateLimitDecision Reject(
            string appCallerCode,
            string requestType,
            int limitPerMinute,
            long count,
            DateTime windowStart)
            => new(true, appCallerCode, requestType, limitPerMinute, count, windowStart);
    }

    private sealed record AppCallerBudgetDecision(
        bool Rejected,
        string AppCallerCode,
        string RequestType,
        decimal MonthlyBudgetUsd,
        decimal MonthSpendUsd,
        bool HasCostEvidence,
        DateTime MonthStart)
    {
        public static AppCallerBudgetDecision Allow(
            string appCallerCode,
            string requestType,
            decimal monthlyBudgetUsd,
            decimal monthSpendUsd,
            bool hasCostEvidence,
            DateTime? monthStart = null)
            => new(false, appCallerCode, requestType, monthlyBudgetUsd, monthSpendUsd, hasCostEvidence, monthStart ?? DateTime.UtcNow);

        public static AppCallerBudgetDecision Reject(
            string appCallerCode,
            string requestType,
            decimal monthlyBudgetUsd,
            decimal monthSpendUsd,
            DateTime monthStart)
            => new(true, appCallerCode, requestType, monthlyBudgetUsd, monthSpendUsd, true, monthStart);
    }

    private sealed record AppCallerGovernanceDecision(
        AppCallerStatusDecision Status,
        AppCallerRateLimitDecision RateLimit,
        AppCallerBudgetDecision Budget)
    {
        public static AppCallerGovernanceDecision Allow(string appCallerCode, string requestType)
            => new(
                AppCallerStatusDecision.Allow(appCallerCode, requestType, "discovered"),
                AppCallerRateLimitDecision.Allow(appCallerCode, requestType),
                AppCallerBudgetDecision.Allow(appCallerCode, requestType, 0, 0, hasCostEvidence: false));
    }
}

public sealed record RouteSelfTestResponse(
    string Status,
    string Mode,
    bool UpstreamCalled,
    int Total,
    int Passed,
    IReadOnlyList<RouteSelfTestCaseResult> Cases);

public sealed record RouteSelfTestCaseResult(
    string Name,
    bool Passed,
    string? SourceSystem,
    string? IngressProtocol,
    string AppCallerCode,
    string RequestType,
    string? ModelPolicy,
    string? ModelPoolId,
    string? ExpectedModel,
    string? PinnedPlatformId,
    string? PinnedModelId,
    string? ParameterPolicy,
    IReadOnlyList<string> DroppedParameters,
    IReadOnlyList<RouteSelfTestAssertion> Assertions);

public sealed record RouteSelfTestAssertion(string Name, bool Passed);

// /gw/v1/resolve 的请求体 DTO（PascalCase）。
public sealed record ResolveRequestDto(
    string AppCallerCode,
    string ModelType,
    string? ExpectedModel,
    string? PinnedPlatformId,
    string? PinnedModelId,
    string? ModelPolicy = null,
    string? ModelPoolId = null,
    GatewayRequestContext? Context = null);

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
