using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrdAgent.Infrastructure.LlmGateway.Adapters;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// LLM Gateway 核心实现 - 所有大模型调用的守门员
/// </summary>
public class LlmGateway : ILlmGateway
{
    private readonly IModelResolver _modelResolver;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<LlmGateway> _logger;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly Dictionary<string, IGatewayAdapter> _adapters = new(StringComparer.OrdinalIgnoreCase);

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
                    _logWriter?.MarkFirstByte(logId, firstByteAt.Value);
                }

                // 解析 SSE 数据
                var chunk = adapter.ParseStreamChunk(data);
                if (chunk == null) continue;

                if (!string.IsNullOrEmpty(chunk.Content))
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

            await FinishStreamLogAsync(logId, assembledText, tokenUsage, durationMs, ct);
        }
        finally
        {
            // 确保日志在异常情况下也能关闭
        }
    }

    /// <inheritdoc />
    public async Task<ImageGenGatewayResponse> GenerateImageAsync(
        ImageGenGatewayRequest request,
        CancellationToken ct = default)
    {
        // TODO: 实现图片生成
        // 当前先返回未实现错误，后续迁移 OpenAIImageClient 逻辑
        throw new NotImplementedException("图片生成功能正在迁移中");
    }

    /// <inheritdoc />
    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        var result = await _modelResolver.ResolveAsync(appCallerCode, modelType, expectedModel, ct);
        return result.ToGatewayResolution();
    }

    /// <inheritdoc />
    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        return await _modelResolver.GetAvailablePoolsAsync(appCallerCode, modelType, ct);
    }

    #region Private Methods

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
                    ModelResolutionType: resolution.ResolutionType,
                    ModelGroupId: resolution.ModelGroupId,
                    ModelGroupName: resolution.ModelGroupName),
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

    #endregion
}
