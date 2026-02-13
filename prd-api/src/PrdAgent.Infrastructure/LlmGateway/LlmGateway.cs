using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using CoreGateway = PrdAgent.Core.Interfaces.LlmGateway;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// LLM Gateway 核心实现 - 所有大模型调用的守门员
/// </summary>
public class LlmGateway : ILlmGateway, CoreGateway.ILlmGateway
{
    private readonly IModelResolver _modelResolver;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<LlmGateway> _logger;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly Dictionary<string, IGatewayAdapter> _adapters = new(StringComparer.OrdinalIgnoreCase);
    private readonly ExchangeTransformerRegistry _transformerRegistry = new();
    private const string InvalidAppCallerErrorCode = "APP_CALLER_INVALID";

    public LlmGateway(
        IModelResolver modelResolver,
        IHttpClientFactory httpClientFactory,
        ILogger<LlmGateway> logger,
        ILlmRequestLogWriter? logWriter = null)
    {
        _modelResolver = modelResolver;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _logWriter = logWriter;

        // 注册适配器
        RegisterAdapter(new OpenAIGatewayAdapter());
        RegisterAdapter(new ClaudeGatewayAdapter());
    }

    private void RegisterAdapter(IGatewayAdapter adapter)
    {
        _adapters[adapter.PlatformType] = adapter;
    }

    /// <inheritdoc />
    public async Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(request.AppCallerCode, request.ModelType, out var error))
        {
            return GatewayResponse.Fail(InvalidAppCallerErrorCode, error, 400);
        }

        var startedAt = DateTime.UtcNow;
        string? logId = null;
        ModelResolutionResult? resolution = null;

        try
        {
            // 1. 使用 ModelResolver 解析模型
            var effectiveExpectedModel = request.GetEffectiveExpectedModel();
            resolution = await _modelResolver.ResolveAsync(
                request.AppCallerCode, request.ModelType, effectiveExpectedModel, ct);

            if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                return GatewayResponse.Fail("MODEL_NOT_FOUND",
                    resolution.ErrorMessage ?? "未找到可用模型", 404);
            }

            // 2. 选择适配器
            var adapter = GetAdapter(resolution.PlatformType);
            if (adapter == null)
            {
                return GatewayResponse.Fail("UNSUPPORTED_PLATFORM",
                    $"不支持的平台类型: {resolution.PlatformType}", 400);
            }

            // 3. 构建请求
            var requestBody = request.GetEffectiveRequestBody();
            requestBody["model"] = resolution.ActualModel;
            requestBody["stream"] = false;

            var endpoint = adapter.BuildEndpoint(resolution.ApiUrl!, request.ModelType);
            var httpRequest = adapter.BuildHttpRequest(endpoint, resolution.ApiKey, requestBody, request.EnablePromptCache);

            // 4. 写入日志（开始）
            var gatewayResolution = resolution.ToGatewayResolution();
            logId = await StartLogAsync(request, gatewayResolution, endpoint, requestBody, startedAt, ct);

            // 5. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway] 发送请求\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ExpectedModel: {ExpectedModel}\n" +
                "  ActualModel: {ActualModel}\n" +
                "  Platform: {Platform}\n" +
                "  Endpoint: {Endpoint}",
                request.AppCallerCode,
                effectiveExpectedModel ?? "(无)",
                resolution.ActualModel,
                resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                endpoint);

            var response = await httpClient.SendAsync(httpRequest, ct);
            var responseBody = await response.Content.ReadAsStringAsync(ct);

            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;

            // 6. 解析响应
            GatewayTokenUsage? tokenUsage = null;
            if (response.IsSuccessStatusCode)
            {
                tokenUsage = adapter.ParseTokenUsage(responseBody);
            }

            // 7. 更新健康状态
            if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            {
                if (response.IsSuccessStatusCode)
                {
                    await _modelResolver.RecordSuccessAsync(resolution, ct);
                }
                else
                {
                    await _modelResolver.RecordFailureAsync(resolution, ct);
                }
            }

            // 8. 写入日志（完成）
            await FinishLogAsync(logId, response, responseBody, tokenUsage, durationMs, ct);

            if (!response.IsSuccessStatusCode)
            {
                var errorMsg = TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}";
                return GatewayResponse.Fail("LLM_ERROR", errorMsg, (int)response.StatusCode);
            }

            return new GatewayResponse
            {
                Success = true,
                StatusCode = (int)response.StatusCode,
                Content = responseBody,
                Resolution = gatewayResolution,
                TokenUsage = tokenUsage,
                DurationMs = durationMs,
                LogId = logId
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[LlmGateway] 请求失败");
            if (logId != null)
            {
                _logWriter?.MarkError(logId, ex.Message);
            }
            return GatewayResponse.Fail("GATEWAY_ERROR", ex.Message);
        }
    }

    /// <inheritdoc />
    public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
        GatewayRequest request,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(request.AppCallerCode, request.ModelType, out var error))
        {
            yield return GatewayStreamChunk.Fail($"{InvalidAppCallerErrorCode}: {error}");
            yield break;
        }

        var startedAt = DateTime.UtcNow;
        string? logId = null;
        DateTime? firstByteAt = null;
        var textBuilder = new StringBuilder();

        ModelResolutionResult? resolution = null;
        GatewayModelResolution? gatewayResolution = null;
        GatewayTokenUsage? tokenUsage = null;

        try
        {
            // 1. 使用 ModelResolver 解析模型
            var effectiveExpectedModel = request.GetEffectiveExpectedModel();
            resolution = await _modelResolver.ResolveAsync(
                request.AppCallerCode, request.ModelType, effectiveExpectedModel, ct);

            if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                yield return GatewayStreamChunk.Fail(resolution.ErrorMessage ?? "未找到可用模型");
                yield break;
            }

            gatewayResolution = resolution.ToGatewayResolution();

            // 2. 选择适配器
            var adapter = GetAdapter(resolution.PlatformType);
            if (adapter == null)
            {
                yield return GatewayStreamChunk.Fail($"不支持的平台类型: {resolution.PlatformType}");
                yield break;
            }

            // 3. 构建请求
            var requestBody = request.GetEffectiveRequestBody();
            requestBody["model"] = resolution.ActualModel;
            requestBody["stream"] = true;

            var endpoint = adapter.BuildEndpoint(resolution.ApiUrl!, request.ModelType);
            var httpRequest = adapter.BuildHttpRequest(endpoint, resolution.ApiKey, requestBody, request.EnablePromptCache);

            // 4. 写入日志（开始）
            logId = await StartLogAsync(request, gatewayResolution, endpoint, requestBody, startedAt, ct);

            // 5. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway] 发送流式请求\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ExpectedModel: {ExpectedModel}\n" +
                "  ActualModel: {ActualModel}\n" +
                "  Platform: {Platform}",
                request.AppCallerCode,
                effectiveExpectedModel ?? "(无)",
                resolution.ActualModel,
                resolution.ActualPlatformName ?? resolution.ActualPlatformId);

            using var response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);

            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync(ct);
                var errorMsg = TryExtractErrorMessage(errorBody) ?? $"HTTP {(int)response.StatusCode}";
                yield return GatewayStreamChunk.Fail(errorMsg);

                // 更新日志状态为失败
                if (logId != null)
                {
                    _logWriter?.MarkError(logId, errorMsg, (int)response.StatusCode);
                }

                if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
                {
                    await _modelResolver.RecordFailureAsync(resolution, ct);
                }
                yield break;
            }

            // 发送开始块（包含调度信息）
            yield return GatewayStreamChunk.Start(gatewayResolution);

            // 6. 读取流式响应
            using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream);

            string? finishReason = null;
            var thinkingBuilder = new StringBuilder(); // 记录思考过程（用于日志）
            var thinkTagStripper = new ThinkTagStripper(captureThinking: request.IncludeThinking); // 剥离 <think> 标签，可选捕获

            while (!reader.EndOfStream)
            {
                var line = await reader.ReadLineAsync(ct);
                if (string.IsNullOrEmpty(line)) continue;

                if (!line.StartsWith("data:")) continue;
                var data = line.Substring(5).Trim();

                if (data == "[DONE]")
                {
                    break;
                }

                // 标记首字节
                if (firstByteAt == null)
                {
                    firstByteAt = DateTime.UtcNow;
                    if (logId != null)
                    {
                        _logWriter?.MarkFirstByte(logId, firstByteAt.Value);
                    }
                }

                // 解析 SSE 数据
                GatewayStreamChunk? chunk;
                try
                {
                    chunk = adapter.ParseStreamChunk(data);
                }
                catch (Exception parseEx)
                {
                    // Adapter 解析失败（JSON 异常等），记录错误但不中断流
                    var dataPreview = data.Length > 200 ? data[..200] + "..." : data;
                    _logger.LogWarning(parseEx, "[LlmGateway] ParseStreamChunk 异常, data: {DataPreview}", dataPreview);
                    continue;
                }
                if (chunk == null)
                {
                    // 调试：记录无法解析的 SSE 数据（仅记录前 200 字符）
                    var dataPreview = data.Length > 200 ? data[..200] + "..." : data;
                    _logger.LogDebug("[LlmGateway] ParseStreamChunk returned null for data: {DataPreview}", dataPreview);
                    continue;
                }

                // Thinking 类型（来自 reasoning_content 字段）
                if (chunk.Type == GatewayChunkType.Thinking)
                {
                    if (!string.IsNullOrEmpty(chunk.Content))
                    {
                        thinkingBuilder.Append(chunk.Content);
                    }
                    // 当 IncludeThinking 时，将思考块传递给调用方
                    if (request.IncludeThinking && !string.IsNullOrEmpty(chunk.Content))
                    {
                        yield return chunk;
                    }
                    continue;
                }

                if (!string.IsNullOrEmpty(chunk.Content) && chunk.Type == GatewayChunkType.Text)
                {
                    // 通过 ThinkTagStripper 过滤 <think>...</think> 标签
                    var stripped = thinkTagStripper.Process(chunk.Content);

                    // 当 IncludeThinking 时，将 <think> 标签内容作为 Thinking 块传递
                    var capturedThink = thinkTagStripper.PopCapturedThinking();
                    if (!string.IsNullOrEmpty(capturedThink))
                    {
                        thinkingBuilder.Append(capturedThink);
                        if (request.IncludeThinking)
                        {
                            yield return GatewayStreamChunk.Thinking(capturedThink);
                        }
                    }

                    if (!string.IsNullOrEmpty(stripped))
                    {
                        textBuilder.Append(stripped);
                        yield return GatewayStreamChunk.Text(stripped);
                    }
                }
                else if (!string.IsNullOrEmpty(chunk.Content))
                {
                    textBuilder.Append(chunk.Content);
                    yield return chunk;
                }

                if (!string.IsNullOrEmpty(chunk.FinishReason))
                {
                    finishReason = chunk.FinishReason;
                }

                if (chunk.TokenUsage != null)
                {
                    tokenUsage = chunk.TokenUsage;
                }
            }

            // 刷新 ThinkTagStripper 缓冲区
            var flushed = thinkTagStripper.Flush();
            if (!string.IsNullOrEmpty(flushed))
            {
                textBuilder.Append(flushed);
                yield return GatewayStreamChunk.Text(flushed);
            }

            // 记录思考过程（如果有）
            if (thinkingBuilder.Length > 0)
            {
                var thinkingAction = request.IncludeThinking ? "已传递给调用方" : "已过滤";
                _logger.LogDebug(
                    "[LlmGateway] 模型思考过程{ThinkingAction}（{ThinkingChars} 字符）。AppCallerCode: {AppCallerCode}, Model: {Model}",
                    thinkingAction,
                    thinkingBuilder.Length,
                    request.AppCallerCode,
                    resolution?.ActualModel);
            }

            // 7. 更新健康状态（成功）
            if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            {
                await _modelResolver.RecordSuccessAsync(resolution, ct);
            }

            // 8. 发送完成块
            yield return GatewayStreamChunk.Done(finishReason, tokenUsage);

            // 9. 写入日志（完成）
            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;
            var assembledText = textBuilder.ToString();

            // 调试：如果没有拼接到内容，记录警告
            if (string.IsNullOrEmpty(assembledText) && tokenUsage?.OutputTokens > 0)
            {
                _logger.LogWarning(
                    "[LlmGateway] 流式响应 OutputTokens={OutputTokens} 但 AssembledText 为空，" +
                    "可能是 SSE 格式不兼容。AppCallerCode: {AppCallerCode}, Model: {Model}",
                    tokenUsage.OutputTokens,
                    request.AppCallerCode,
                    resolution?.ActualModel);
            }

            var assembledThinking = thinkingBuilder.ToString();
            await FinishStreamLogAsync(logId, assembledText, assembledThinking, tokenUsage, durationMs, ct);
        }
        finally
        {
            // 注意：对于流式响应，正常情况下日志会在行 319 的 FinishStreamLogAsync 中更新
            // 这里不需要额外处理，因为：
            // 1. HTTP 失败时，已在行 232 调用 MarkError
            // 2. 异常情况会被调用方捕获，调用方负责处理日志
        }
    }

    /// <inheritdoc />
    public async Task<GatewayRawResponse> SendRawAsync(GatewayRawRequest request, CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(request.AppCallerCode, request.ModelType, out var error))
        {
            return GatewayRawResponse.Fail(InvalidAppCallerErrorCode, error, 400);
        }

        var startedAt = DateTime.UtcNow;
        string? logId = null;
        ModelResolutionResult? resolution = null;

        try
        {
            // 1. 模型调度
            resolution = await _modelResolver.ResolveAsync(
                request.AppCallerCode, request.ModelType, null, ct);

            if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                return GatewayRawResponse.Fail("MODEL_NOT_FOUND",
                    resolution.ErrorMessage ?? "未找到可用模型", 404);
            }

            var gatewayResolution = resolution.ToGatewayResolution();

            // 2. 选择适配器并构建 endpoint
            var isExchange = resolution.IsExchange;
            var adapter = isExchange ? null : GetAdapter(resolution.PlatformType);
            string endpoint;

            if (isExchange)
            {
                // Exchange 模式：直接使用目标 URL
                endpoint = resolution.ApiUrl!;
            }
            else if (string.IsNullOrWhiteSpace(request.EndpointPath))
            {
                // 使用适配器构建默认 endpoint（处理不同平台的 URL 格式）
                endpoint = adapter?.BuildEndpoint(resolution.ApiUrl!, request.ModelType)
                    ?? $"{resolution.ApiUrl!.TrimEnd('/')}/v1/chat/completions";
            }
            else
            {
                // 使用自定义 endpoint path
                var baseUrl = resolution.ApiUrl!.TrimEnd('/');
                var endpointPath = request.EndpointPath;

                // 检测 baseUrl 是否已包含版本号
                var hasVersionSuffix = System.Text.RegularExpressions.Regex.IsMatch(
                    baseUrl, @"/(api/)?v\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

                if (hasVersionSuffix)
                {
                    // baseUrl 已有版本号（如 /api/v3）
                    // 如果 endpointPath 以 /v1 开头，移除它避免重复
                    if (endpointPath.StartsWith("/v1/", StringComparison.OrdinalIgnoreCase))
                    {
                        endpointPath = endpointPath[3..]; // 移除 "/v1"
                    }
                    else if (endpointPath.StartsWith("v1/", StringComparison.OrdinalIgnoreCase))
                    {
                        endpointPath = endpointPath[2..]; // 移除 "v1"
                    }
                    endpoint = $"{baseUrl}{(endpointPath.StartsWith("/") ? "" : "/")}{endpointPath}";
                }
                else
                {
                    // baseUrl 没有版本号（如 https://api.vveai.com 或 https://api.apiyi.com）
                    // 检测 endpointPath 是否已包含版本号（v1, v1beta, v2 等）
                    if (System.Text.RegularExpressions.Regex.IsMatch(
                        endpointPath, @"^/?v\d+", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                    {
                        // endpointPath 已包含版本号，直接拼接
                        endpoint = $"{baseUrl}{(endpointPath.StartsWith("/") ? "" : "/")}{endpointPath}";
                    }
                    else
                    {
                        // endpointPath 不包含版本号，添加 /v1
                        endpoint = $"{baseUrl}/v1{(endpointPath.StartsWith("/") ? "" : "/")}{endpointPath}";
                    }
                }
            }

            // 3. 构建 HTTP 请求
            HttpRequestMessage httpRequest;
            string requestBodyForLog;

            if (isExchange)
            {
                // ========== Exchange 中继模式 ==========
                var transformer = _transformerRegistry.Get(resolution.ExchangeTransformerType);
                if (transformer == null)
                {
                    return GatewayRawResponse.Fail("EXCHANGE_TRANSFORMER_NOT_FOUND",
                        $"Exchange 转换器未找到: {resolution.ExchangeTransformerType}", 400);
                }

                var rawBody = request.RequestBody ?? new JsonObject();

                // Exchange 模式下处理 multipart 请求：将字段和文件合并到 JSON
                if (request.IsMultipart)
                {
                    rawBody = ConsolidateMultipartToJson(request);
                    _logger.LogInformation(
                        "[LlmGateway.Exchange] Multipart → JSON 合并完成，字段数: {FieldCount}, 文件数: {FileCount}",
                        request.MultipartFields?.Count ?? 0,
                        request.MultipartFiles?.Count ?? 0);
                }

                // 智能路由：根据请求内容决定实际目标 URL
                var resolvedUrl = transformer.ResolveTargetUrl(endpoint, rawBody, resolution.ExchangeTransformerConfig);
                if (resolvedUrl != null) endpoint = resolvedUrl;

                var transformedBody = transformer.TransformRequest(rawBody, resolution.ExchangeTransformerConfig);

                _logger.LogInformation(
                    "[LlmGateway.Exchange] 请求转换完成\n" +
                    "  Exchange: {ExchangeName}\n" +
                    "  Transformer: {Transformer}\n" +
                    "  TargetUrl: {TargetUrl}",
                    resolution.ExchangeName, resolution.ExchangeTransformerType, endpoint);

                var jsonContent = transformedBody.ToJsonString();
                httpRequest = new HttpRequestMessage(new HttpMethod(request.HttpMethod), endpoint)
                {
                    Content = new StringContent(jsonContent, System.Text.Encoding.UTF8, "application/json")
                };
                requestBodyForLog = jsonContent;
            }
            else if (request.IsMultipart)
            {
                // multipart/form-data 请求
                var multipartContent = new MultipartFormDataContent();

                // 添加 model 字段
                multipartContent.Add(new StringContent(resolution.ActualModel), "model");

                // 添加其他字段
                if (request.MultipartFields != null)
                {
                    foreach (var (key, value) in request.MultipartFields)
                    {
                        if (key != "model") // model 已经添加
                        {
                            multipartContent.Add(new StringContent(value?.ToString() ?? ""), key);
                        }
                    }
                }

                // 添加文件
                if (request.MultipartFiles != null)
                {
                    foreach (var (fieldName, fileInfo) in request.MultipartFiles)
                    {
                        var fileContent = new ByteArrayContent(fileInfo.Content);
                        fileContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(fileInfo.MimeType);
                        multipartContent.Add(fileContent, fieldName, fileInfo.FileName);
                    }
                }

                httpRequest = new HttpRequestMessage(new HttpMethod(request.HttpMethod), endpoint)
                {
                    Content = multipartContent
                };
                requestBodyForLog = "[multipart/form-data]";
            }
            else
            {
                // JSON 请求
                var requestBody = request.RequestBody ?? new JsonObject();
                requestBody["model"] = resolution.ActualModel;

                var jsonContent = requestBody.ToJsonString();
                httpRequest = new HttpRequestMessage(new HttpMethod(request.HttpMethod), endpoint)
                {
                    Content = new StringContent(jsonContent, System.Text.Encoding.UTF8, "application/json")
                };
                requestBodyForLog = jsonContent;
            }

            // 4. 设置请求头（支持 Exchange 可配置认证方案）
            if (!string.IsNullOrWhiteSpace(resolution.ApiKey))
            {
                var authScheme = isExchange ? resolution.ExchangeAuthScheme : "Bearer";
                SetAuthHeader(httpRequest, authScheme ?? "Bearer", resolution.ApiKey);
            }

            if (request.ExtraHeaders != null)
            {
                foreach (var (key, value) in request.ExtraHeaders)
                {
                    httpRequest.Headers.TryAddWithoutValidation(key, value);
                }
            }

            // 5. 写入日志（开始）
            logId = await StartRawLogAsync(request, gatewayResolution, endpoint, requestBodyForLog, startedAt, ct);

            // 6. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway.SendRaw] 发送请求\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ActualModel: {ActualModel}\n" +
                "  Platform: {Platform}\n" +
                "  Endpoint: {Endpoint}\n" +
                "  IsMultipart: {IsMultipart}",
                request.AppCallerCode,
                resolution.ActualModel,
                resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                endpoint,
                request.IsMultipart);

            var response = await httpClient.SendAsync(httpRequest, ct);
            var responseBody = await response.Content.ReadAsStringAsync(ct);

            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;

            // 7. 更新健康状态
            if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            {
                if (response.IsSuccessStatusCode)
                {
                    await _modelResolver.RecordSuccessAsync(resolution, ct);
                }
                else
                {
                    await _modelResolver.RecordFailureAsync(resolution, ct);
                }
            }

            // 8. Exchange 响应转换
            var finalResponseBody = responseBody;
            if (isExchange && response.IsSuccessStatusCode)
            {
                try
                {
                    var respTransformer = _transformerRegistry.Get(resolution.ExchangeTransformerType);
                    if (respTransformer != null)
                    {
                        var rawJson = JsonNode.Parse(responseBody);
                        if (rawJson is JsonObject rawObj)
                        {
                            var transformed = respTransformer.TransformResponse(rawObj, resolution.ExchangeTransformerConfig);
                            finalResponseBody = transformed.ToJsonString();

                            _logger.LogInformation(
                                "[LlmGateway.Exchange] 响应转换完成: Exchange={ExchangeName}",
                                resolution.ExchangeName);
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex,
                        "[LlmGateway.Exchange] 响应转换失败，返回原始响应: Exchange={ExchangeName}",
                        resolution.ExchangeName);
                    // 转换失败时使用原始响应，不阻断流程
                }
            }

            // 9. 写入日志（完成）
            await FinishRawLogAsync(logId, (int)response.StatusCode, finalResponseBody, durationMs, ct);

            // 10. 返回响应
            var responseHeaders = new Dictionary<string, string>();
            foreach (var header in response.Headers)
            {
                responseHeaders[header.Key] = string.Join(", ", header.Value);
            }

            if (!response.IsSuccessStatusCode)
            {
                var errorMsg = TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}";
                return new GatewayRawResponse
                {
                    Success = false,
                    StatusCode = (int)response.StatusCode,
                    Content = responseBody,
                    ResponseHeaders = responseHeaders,
                    ErrorCode = "LLM_ERROR",
                    ErrorMessage = errorMsg,
                    Resolution = gatewayResolution,
                    DurationMs = durationMs,
                    LogId = logId
                };
            }

            return new GatewayRawResponse
            {
                Success = true,
                StatusCode = (int)response.StatusCode,
                Content = finalResponseBody,
                ResponseHeaders = responseHeaders,
                Resolution = gatewayResolution,
                DurationMs = durationMs,
                LogId = logId
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[LlmGateway.SendRaw] 请求失败");
            if (logId != null)
            {
                _logWriter?.MarkError(logId, ex.Message);
            }
            return GatewayRawResponse.Fail("GATEWAY_ERROR", ex.Message);
        }
    }

    /// <inheritdoc />
    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(appCallerCode, modelType, out var error))
        {
            return new GatewayModelResolution
            {
                Success = false,
                ErrorMessage = error,
                ResolutionType = "NotFound"
            };
        }

        var result = await _modelResolver.ResolveAsync(appCallerCode, modelType, expectedModel, ct);
        return result.ToGatewayResolution();
    }

    /// <inheritdoc />
    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(appCallerCode, modelType, out var error))
        {
            _logger.LogWarning("[LlmGateway] Invalid appCallerCode for GetAvailablePoolsAsync: {Error}", error);
            return new List<AvailableModelPool>();
        }

        return await _modelResolver.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
    }

    #region Private Methods

    /// <summary>
    /// 根据认证方案设置 HTTP 请求头
    /// </summary>
    private static void SetAuthHeader(HttpRequestMessage httpRequest, string authScheme, string apiKey)
    {
        switch (authScheme.ToLowerInvariant())
        {
            case "x-api-key":
            case "xapikey":
                httpRequest.Headers.TryAddWithoutValidation("x-api-key", apiKey);
                break;
            case "key":
                httpRequest.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Key", apiKey);
                break;
            default: // "bearer" or anything else
                httpRequest.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
                break;
        }
    }

    /// <summary>
    /// 将 multipart 请求的字段和文件合并为 JSON 对象，供 Exchange 转换器使用。
    /// MultipartFields → JSON 属性，MultipartFiles 中的图片 → base64 data URI 放入 image_urls。
    /// </summary>
    private static JsonObject ConsolidateMultipartToJson(GatewayRawRequest request)
    {
        var body = new JsonObject();

        // 合并 MultipartFields 到 JSON
        if (request.MultipartFields != null)
        {
            foreach (var (key, value) in request.MultipartFields)
            {
                if (string.Equals(key, "model", StringComparison.OrdinalIgnoreCase))
                    continue; // model 由 Gateway 调度管理，不透传

                body[key] = value switch
                {
                    int i => JsonValue.Create(i),
                    long l => JsonValue.Create(l),
                    double d => JsonValue.Create(d),
                    float f => JsonValue.Create(f),
                    bool b => JsonValue.Create(b),
                    string s => JsonValue.Create(s),
                    _ => JsonValue.Create(value?.ToString())
                };
            }
        }

        // 将 MultipartFiles 中的图片转换为 base64 data URI，放入 image_urls
        if (request.MultipartFiles is { Count: > 0 })
        {
            var imageUrls = new JsonArray();
            foreach (var (_, fileInfo) in request.MultipartFiles)
            {
                var base64 = Convert.ToBase64String(fileInfo.Content);
                var dataUri = $"data:{fileInfo.MimeType};base64,{base64}";
                imageUrls.Add(dataUri);
            }
            body["image_urls"] = imageUrls;
        }

        return body;
    }

    private IGatewayAdapter? GetAdapter(string? platformType)
    {
        if (string.IsNullOrWhiteSpace(platformType))
            return _adapters.GetValueOrDefault("openai"); // 默认 OpenAI

        if (_adapters.TryGetValue(platformType, out var adapter))
            return adapter;

        // OpenAI 兼容
        return _adapters.GetValueOrDefault("openai");
    }

    private async Task<string?> StartLogAsync(
        GatewayRequest request,
        GatewayModelResolution resolution,
        string endpoint,
        JsonObject requestBody,
        DateTime startedAt,
        CancellationToken ct)
    {
        if (_logWriter == null) return null;

        try
        {
            var requestJson = requestBody.ToJsonString();
            var redactedJson = LlmLogRedactor.RedactJson(requestJson);

            return await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: request.Context?.RequestId ?? Guid.NewGuid().ToString("N"),
                    Provider: resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                    Model: resolution.ActualModel,
                    ApiBase: new Uri(endpoint).GetLeftPart(UriPartial.Authority),
                    Path: new Uri(endpoint).AbsolutePath.TrimStart('/'),
                    HttpMethod: "POST",
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json"
                    },
                    RequestBodyRedacted: redactedJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(redactedJson),
                    QuestionText: request.Context?.QuestionText,
                    SystemPromptChars: request.Context?.SystemPromptChars,
                    SystemPromptHash: null,
                    SystemPromptText: request.Context?.SystemPromptText,
                    MessageCount: null,
                    GroupId: request.Context?.GroupId,
                    SessionId: request.Context?.SessionId,
                    UserId: request.Context?.UserId,
                    ViewRole: request.Context?.ViewRole,
                    DocumentChars: request.Context?.DocumentChars,
                    DocumentHash: request.Context?.DocumentHash,
                    UserPromptChars: request.Context?.QuestionText?.Length,
                    StartedAt: startedAt,
                    RequestType: request.ModelType,
                    RequestPurpose: request.AppCallerCode,
                    PlatformId: resolution.ActualPlatformId,
                    PlatformName: resolution.ActualPlatformName,
                    ModelResolutionType: ParseResolutionType(resolution.ResolutionType),
                    ModelGroupId: resolution.ModelGroupId,
                    ModelGroupName: resolution.ModelGroupName,
                    IsExchange: resolution.IsExchange ? true : null,
                    ExchangeId: resolution.ExchangeId,
                    ExchangeName: resolution.ExchangeName,
                    ExchangeTransformerType: resolution.ExchangeTransformerType,
                    ImageReferences: request.Context?.ImageReferences,
                    IsFallback: resolution.IsFallback ? true : null,
                    FallbackReason: resolution.FallbackReason,
                    ExpectedModel: resolution.ExpectedModel),
                ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 写入日志失败");
            return null;
        }
    }

    private async Task FinishLogAsync(
        string? logId,
        HttpResponseMessage response,
        string responseBody,
        GatewayTokenUsage? tokenUsage,
        long durationMs,
        CancellationToken ct)
    {
        if (_logWriter == null || logId == null) return;

        try
        {
            var status = response.IsSuccessStatusCode ? "succeeded" : "failed";
            var answerText = responseBody.Length > 10000
                ? responseBody.Substring(0, 10000) + "...[truncated]"
                : responseBody;

            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: (int)response.StatusCode,
                    ResponseHeaders: new Dictionary<string, string>
                    {
                        ["content-type"] = response.Content.Headers.ContentType?.ToString() ?? "application/json"
                    },
                    InputTokens: tokenUsage?.InputTokens,
                    OutputTokens: tokenUsage?.OutputTokens,
                    CacheCreationInputTokens: tokenUsage?.CacheCreationInputTokens,
                    CacheReadInputTokens: tokenUsage?.CacheReadInputTokens,
                    TokenUsageSource: tokenUsage?.Source ?? "missing",
                    ImageSuccessCount: null,
                    AnswerText: answerText,
                    ThinkingText: null,
                    AssembledTextChars: responseBody.Length,
                    AssembledTextHash: LlmLogRedactor.Sha256Hex(responseBody),
                    Status: status,
                    EndedAt: DateTime.UtcNow,
                    DurationMs: durationMs));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成日志失败");
        }
    }

    private async Task FinishStreamLogAsync(
        string? logId,
        string assembledText,
        string assembledThinking,
        GatewayTokenUsage? tokenUsage,
        long durationMs,
        CancellationToken ct)
    {
        if (_logWriter == null || logId == null) return;

        try
        {
            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: 200,
                    ResponseHeaders: new Dictionary<string, string>
                    {
                        ["content-type"] = "text/event-stream"
                    },
                    InputTokens: tokenUsage?.InputTokens,
                    OutputTokens: tokenUsage?.OutputTokens,
                    CacheCreationInputTokens: tokenUsage?.CacheCreationInputTokens,
                    CacheReadInputTokens: tokenUsage?.CacheReadInputTokens,
                    TokenUsageSource: tokenUsage?.Source ?? "missing",
                    ImageSuccessCount: null,
                    AnswerText: assembledText.Length > 5000 ? assembledText.Substring(0, 5000) + "..." : assembledText,
                    ThinkingText: string.IsNullOrEmpty(assembledThinking) ? null : assembledThinking,
                    AssembledTextChars: assembledText.Length,
                    AssembledTextHash: LlmLogRedactor.Sha256Hex(assembledText),
                    Status: "succeeded",
                    EndedAt: DateTime.UtcNow,
                    DurationMs: durationMs));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成流式日志失败");
        }
    }

    private async Task<string?> StartRawLogAsync(
        GatewayRawRequest request,
        GatewayModelResolution resolution,
        string endpoint,
        string requestBodyForLog,
        DateTime startedAt,
        CancellationToken ct)
    {
        if (_logWriter == null) return null;

        try
        {
            var redactedBody = request.IsMultipart
                ? requestBodyForLog
                : LlmLogRedactor.RedactJson(requestBodyForLog);

            return await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: request.Context?.RequestId ?? Guid.NewGuid().ToString("N"),
                    Provider: resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                    Model: resolution.ActualModel,
                    ApiBase: new Uri(endpoint).GetLeftPart(UriPartial.Authority),
                    Path: new Uri(endpoint).AbsolutePath.TrimStart('/'),
                    HttpMethod: request.HttpMethod,
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = request.IsMultipart ? "multipart/form-data" : "application/json"
                    },
                    RequestBodyRedacted: redactedBody,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(redactedBody),
                    QuestionText: request.Context?.QuestionText,
                    SystemPromptChars: request.Context?.SystemPromptChars,
                    SystemPromptHash: null,
                    SystemPromptText: request.Context?.SystemPromptText,
                    MessageCount: null,
                    GroupId: request.Context?.GroupId,
                    SessionId: request.Context?.SessionId,
                    UserId: request.Context?.UserId,
                    ViewRole: request.Context?.ViewRole,
                    DocumentChars: request.Context?.DocumentChars,
                    DocumentHash: request.Context?.DocumentHash,
                    UserPromptChars: request.Context?.QuestionText?.Length,
                    StartedAt: startedAt,
                    RequestType: request.ModelType,
                    RequestPurpose: request.AppCallerCode,
                    PlatformId: resolution.ActualPlatformId,
                    PlatformName: resolution.ActualPlatformName,
                    ModelResolutionType: ParseResolutionType(resolution.ResolutionType),
                    ModelGroupId: resolution.ModelGroupId,
                    ModelGroupName: resolution.ModelGroupName,
                    IsExchange: resolution.IsExchange ? true : null,
                    ExchangeId: resolution.ExchangeId,
                    ExchangeName: resolution.ExchangeName,
                    ExchangeTransformerType: resolution.ExchangeTransformerType,
                    ImageReferences: request.Context?.ImageReferences,
                    IsFallback: resolution.IsFallback ? true : null,
                    FallbackReason: resolution.FallbackReason,
                    ExpectedModel: resolution.ExpectedModel),
                ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 写入 Raw 日志失败");
            return null;
        }
    }

    private async Task FinishRawLogAsync(
        string? logId,
        int statusCode,
        string responseBody,
        long durationMs,
        CancellationToken ct)
    {
        if (_logWriter == null || logId == null) return;

        try
        {
            var status = statusCode >= 200 && statusCode < 300 ? "succeeded" : "failed";
            var answerText = responseBody.Length > 10000
                ? responseBody.Substring(0, 10000) + "...[truncated]"
                : responseBody;

            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: statusCode,
                    ResponseHeaders: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json"
                    },
                    InputTokens: null,
                    OutputTokens: null,
                    CacheCreationInputTokens: null,
                    CacheReadInputTokens: null,
                    TokenUsageSource: "missing",
                    ImageSuccessCount: null,
                    AnswerText: answerText,
                    ThinkingText: null,
                    AssembledTextChars: responseBody.Length,
                    AssembledTextHash: LlmLogRedactor.Sha256Hex(responseBody),
                    Status: status,
                    EndedAt: DateTime.UtcNow,
                    DurationMs: durationMs));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成 Raw 日志失败");
        }
    }

    private static string? TryExtractErrorMessage(string responseBody)
    {
        try
        {
            using var doc = JsonDocument.Parse(responseBody);
            if (doc.RootElement.TryGetProperty("error", out var error))
            {
                if (error.TryGetProperty("message", out var msg))
                    return msg.GetString();
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static ModelResolutionType? ParseResolutionType(string? resolutionType)
    {
        if (string.IsNullOrWhiteSpace(resolutionType))
            return null;

        return resolutionType switch
        {
            "DedicatedPool" => ModelResolutionType.DedicatedPool,
            "DefaultPool" => ModelResolutionType.DefaultPool,
            "DirectModel" => ModelResolutionType.DirectModel,
            "Legacy" => ModelResolutionType.Legacy,
            _ => null
        };
    }

    #endregion

    #region CreateClient

    /// <inheritdoc />
    public ILLMClient CreateClient(
        string appCallerCode,
        string modelType,
        int maxTokens = 4096,
        double temperature = 0.2,
        bool includeThinking = false)
    {
        if (!TryValidateAppCaller(appCallerCode, modelType, out var error))
        {
            throw new InvalidOperationException($"{InvalidAppCallerErrorCode}: {error}");
        }

        return new GatewayLLMClient(
            gateway: this,
            appCallerCode: appCallerCode,
            modelType: modelType,
            platformId: null,
            platformName: null,
            enablePromptCache: true,
            maxTokens: maxTokens,
            temperature: temperature,
            includeThinking: includeThinking);
    }

    private static bool TryValidateAppCaller(string appCallerCode, string modelType, out string error)
    {
        var code = (appCallerCode ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(code))
        {
            error = "appCallerCode 不能为空";
            return false;
        }

        var type = (modelType ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(type))
        {
            error = "modelType 不能为空";
            return false;
        }

        var def = AppCallerRegistrationService.FindByAppCode(code);
        if (def == null)
        {
            error = $"appCallerCode 未注册: {code}";
            return false;
        }

        if (def.ModelTypes == null || !def.ModelTypes.Contains(type))
        {
            error = $"appCallerCode 与 modelType 不匹配: {code} -> {type}";
            return false;
        }

        error = string.Empty;
        return true;
    }

    #endregion
}
