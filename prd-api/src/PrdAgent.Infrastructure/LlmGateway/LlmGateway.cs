using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
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
    private readonly ILLMRequestContextAccessor? _contextAccessor;
    private readonly ModelPool.IPoolFailoverNotifier? _failoverNotifier;
    private readonly IDoubaoStreamAsrExecutor _doubaoStreamAsr;
    private readonly Dictionary<string, IGatewayAdapter> _adapters = new(StringComparer.OrdinalIgnoreCase);
    private readonly ExchangeTransformerRegistry _transformerRegistry = new();
    private const string InvalidAppCallerErrorCode = "APP_CALLER_INVALID";

    public LlmGateway(
        IModelResolver modelResolver,
        IHttpClientFactory httpClientFactory,
        ILogger<LlmGateway> logger,
        ILlmRequestLogWriter? logWriter = null,
        ILLMRequestContextAccessor? contextAccessor = null,
        ModelPool.IPoolFailoverNotifier? failoverNotifier = null,
        IDoubaoStreamAsrExecutor? doubaoStreamAsr = null)
    {
        _modelResolver = modelResolver;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _logWriter = logWriter;
        _contextAccessor = contextAccessor;
        _failoverNotifier = failoverNotifier;
        _doubaoStreamAsr = doubaoStreamAsr
            ?? new DoubaoStreamAsrService(NullLogger<DoubaoStreamAsrService>.Instance);

        // 注册适配器
        RegisterAdapter(new OpenAIGatewayAdapter());
        RegisterAdapter(new ClaudeGatewayAdapter());
    }

    private void RegisterAdapter(IGatewayAdapter adapter)
    {
        _adapters[adapter.PlatformType] = adapter;
    }

    /// <summary>
    /// 计算是否实际允许思考内容透传。
    /// Intent 模型类型强制禁止思考输出，其他类型尊重请求方的 IncludeThinking 设置。
    /// </summary>
    public static bool IsThinkingEffective(bool includeThinking, string modelType)
    {
        return includeThinking
            && !string.Equals(modelType, ModelTypes.Intent, StringComparison.OrdinalIgnoreCase);
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
                request.AppCallerCode, request.ModelType, effectiveExpectedModel, request.PinnedPlatformId, request.PinnedModelId, ct);

            if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                // 向请求失败的用户发送故障通知
                _ = TryNotifyUserFailureAsync(request, resolution);

                return GatewayResponse.Fail("MODEL_NOT_FOUND",
                    resolution.ErrorMessage ?? "未找到可用模型", 404);
            }

            // 2. 选择适配器
            var adapter = GetAdapterForResolution(resolution);
            if (adapter == null)
            {
                return GatewayResponse.Fail("UNSUPPORTED_PLATFORM",
                    $"不支持的平台类型: {resolution.PlatformType}", 400);
            }

            // 3. 构建请求
            var requestBody = request.GetEffectiveRequestBody();
            requestBody["model"] = resolution.ActualModel;
            requestBody["stream"] = false;

            // G4 能力软门：带 tools 但模型能力明确不支持 function_calling → 熔断报错（不骗用户）。
            // 未知/未分类（null）放行（best-effort）。
            if (RequestHasTools(requestBody) && resolution.SupportsFunctionCalling == false)
            {
                return GatewayResponse.Fail("FUNCTION_CALLING_UNSUPPORTED",
                    $"模型 {resolution.ActualModel} 未声明支持函数调用（function_calling），请改用支持函数调用的模型或移除 tools。", 400);
            }

            var endpoint = adapter.BuildEndpoint(resolution.ApiUrl!, request.ModelType);
            var httpRequest = adapter.BuildHttpRequest(endpoint, resolution.ApiKey, requestBody, request.EnablePromptCache);
            ApplyOpenRouterAttribution(httpRequest, resolution.ApiUrl, request.AppCallerCode);

            // 4. 写入日志（开始）
            var gatewayResolution = resolution.ToGatewayResolution();
            logId = await StartLogAsync(request, gatewayResolution, endpoint, requestBody, startedAt, ct);

            // 5. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway] 向 LLM 发起非流式请求\n" +
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
            System.Text.Json.Nodes.JsonArray? toolCalls = null;
            string? finishReason = null;
            if (response.IsSuccessStatusCode)
            {
                tokenUsage = adapter.ParseTokenUsage(responseBody);
                // 协议保真：提取工具调用（函数调用），归一为 OpenAI 形状（无则 null，不影响纯文本响应）
                toolCalls = adapter.ParseToolCalls(responseBody);
                finishReason = ExtractFinishReason(responseBody);
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
            await FinishLogAsync(logId, response, responseBody, tokenUsage, durationMs, toolCalls, finishReason, ct);

            if (!response.IsSuccessStatusCode)
            {
                var errorMsg = TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}";
                if (IsQuotaExceeded((int)response.StatusCode, errorMsg))
                {
                    var (qCode, qMsg) = await HandleQuotaExceededAsync(resolution.ActualPlatformName, errorMsg);
                    return GatewayResponse.Fail(qCode, qMsg, (int)response.StatusCode);
                }
                return GatewayResponse.Fail("LLM_ERROR", errorMsg, (int)response.StatusCode);
            }

            // 从原始响应中提取消息文本内容
            var messageContent = adapter.ParseMessageContent(responseBody);

            return new GatewayResponse
            {
                Success = true,
                StatusCode = (int)response.StatusCode,
                Content = messageContent ?? responseBody,
                RawResponseBody = responseBody,
                ToolCalls = toolCalls,
                Resolution = gatewayResolution,
                TokenUsage = tokenUsage,
                DurationMs = durationMs,
                LogId = logId
            };
        }
        catch (Exception ex)
        {
            var (msg, code) = ClassifyTransportException(ex, ct.IsCancellationRequested);
            _logger.LogError(ex, "[LlmGateway] 请求失败 status={Code}", code);
            if (logId != null)
            {
                _logWriter?.MarkError(logId, msg, code);
            }
            return GatewayResponse.Fail("GATEWAY_ERROR", msg, code);
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
        // 函数调用增量按 index 合并累积（首个 delta 带 id/name，后续 delta 拼 arguments），用于日志可视化
        var toolCallAccum = new Dictionary<int, System.Text.Json.Nodes.JsonObject>();

        ModelResolutionResult? resolution = null;
        GatewayModelResolution? gatewayResolution = null;
        GatewayTokenUsage? tokenUsage = null;

        try
        {
            // 1. 使用 ModelResolver 解析模型
            var effectiveExpectedModel = request.GetEffectiveExpectedModel();
            resolution = await _modelResolver.ResolveAsync(
                request.AppCallerCode, request.ModelType, effectiveExpectedModel, request.PinnedPlatformId, request.PinnedModelId, ct);

            if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                // 向请求失败的用户发送故障通知
                _ = TryNotifyUserFailureAsync(request, resolution);

                yield return GatewayStreamChunk.Fail(resolution.ErrorMessage ?? "未找到可用模型");
                yield break;
            }

            gatewayResolution = resolution.ToGatewayResolution();

            // 2. 选择适配器
            var adapter = GetAdapterForResolution(resolution);
            if (adapter == null)
            {
                yield return GatewayStreamChunk.Fail($"不支持的平台类型: {resolution.PlatformType}");
                yield break;
            }

            // 3. 构建请求
            var requestBody = request.GetEffectiveRequestBody();
            requestBody["model"] = resolution.ActualModel;
            requestBody["stream"] = true;

            // G4 能力软门：带 tools 但模型能力明确不支持 function_calling → 熔断报错（不骗用户）。未知放行。
            if (RequestHasTools(requestBody) && resolution.SupportsFunctionCalling == false)
            {
                yield return GatewayStreamChunk.Fail(
                    $"模型 {resolution.ActualModel} 未声明支持函数调用（function_calling），请改用支持函数调用的模型或移除 tools。");
                yield break;
            }

            var endpoint = adapter.BuildEndpoint(resolution.ApiUrl!, request.ModelType);
            var httpRequest = adapter.BuildHttpRequest(endpoint, resolution.ApiKey, requestBody, request.EnablePromptCache);
            ApplyOpenRouterAttribution(httpRequest, resolution.ApiUrl, request.AppCallerCode);

            // 4. 写入日志（开始）
            logId = await StartLogAsync(request, gatewayResolution, endpoint, requestBody, startedAt, ct);

            // 5. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway] 向 LLM 发起流式请求\n" +
                "  AppCallerCode: {AppCallerCode}\n" +
                "  ExpectedModel: {ExpectedModel}\n" +
                "  ActualModel: {ActualModel}\n" +
                "  Platform: {Platform}",
                request.AppCallerCode,
                effectiveExpectedModel ?? "(无)",
                resolution.ActualModel,
                resolution.ActualPlatformName ?? resolution.ActualPlatformId);

            // 5.1 SendAsync 异常捕获：HttpClient 超时 / 连接失败等传输层异常必须落日志，
            //     否则日志会滞留 status=running，直到 LlmRequestLogWatchdog 5 分钟后强写
            //     error="TIMEOUT"、dur=300000，真实错误信息和状态码被彻底吞掉。
            HttpResponseMessage? rawResponse = null;
            Exception? sendException = null;
            try
            {
                rawResponse = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);
            }
            catch (Exception ex)
            {
                sendException = ex;
            }

            if (sendException != null)
            {
                var (sendMsg, sendCode) = ClassifyTransportException(sendException, ct.IsCancellationRequested);
                _logger.LogWarning(sendException,
                    "[LlmGateway] HttpClient.SendAsync 失败 status={Code} model={Model}",
                    sendCode, resolution.ActualModel);
                if (logId != null)
                {
                    _logWriter?.MarkError(logId, sendMsg, sendCode);
                }
                if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
                {
                    await _modelResolver.RecordFailureAsync(resolution, ct);
                }
                yield return GatewayStreamChunk.Fail(sendMsg);
                yield break;
            }

            using var response = rawResponse!;

            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync(ct);
                var errorMsg = TryExtractErrorMessage(errorBody) ?? $"HTTP {(int)response.StatusCode}";

                // 先落日志再 yield：caller 收到 Error chunk 后可能立刻 return 释放迭代器，
                // 导致 yield 之后的代码永不执行。这样 MarkError 就会被跳过，日志滞留 running
                // 直到 Watchdog 5 分钟后盖成 "TIMEOUT"——这正是"禁用 key 秒级返回但日志仍
                // 显示 TIMEOUT"的罪魁祸首。
                if (logId != null)
                {
                    _logWriter?.MarkError(logId, errorMsg, (int)response.StatusCode);
                }

                if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
                {
                    await _modelResolver.RecordFailureAsync(resolution, ct);
                }

                // 额度用尽/限额：与非流式 SendAsync/Raw 路径对齐——触发站内告警 + 透传友好额度文案。
                // 流式 Fail chunk 无独立 code 字段，退而把 LLM_QUOTA_EXCEEDED 友好 message 作为 Error 透传；
                // toolbox/defect/literary/polish 等主聊天走 StreamAsync，OpenRouter 402 / Key limit exceeded
                // 同样需要触发 admin 额度通知，不能只在非流式路径生效（Codex review）。
                if (IsQuotaExceeded((int)response.StatusCode, errorMsg))
                {
                    var (_, qMsg) = await HandleQuotaExceededAsync(resolution.ActualPlatformName, errorMsg);
                    yield return GatewayStreamChunk.Fail(qMsg);
                    yield break;
                }

                yield return GatewayStreamChunk.Fail(errorMsg);
                yield break;
            }

            // 发送开始块（包含调度信息）
            yield return GatewayStreamChunk.Start(gatewayResolution);

            // 6. 读取流式响应
            using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var reader = new StreamReader(stream);
            var sseReader = new SseEventReader(reader);

            string? finishReason = null;
            var thinkingBuilder = new StringBuilder(); // 记录思考过程（用于日志）
            var thinkTagStripper = new ThinkTagStripper(captureThinking: true); // 始终捕获 <think> 内容
            var thinkingStarted = false; // 调试：标记思考是否已开始
            var contentStarted = false;  // 调试：标记正文是否已开始

            // Intent 模型类型强制禁止思考输出，其他类型尊重请求方设置
            var effectiveIncludeThinking = IsThinkingEffective(request.IncludeThinking, request.ModelType);

            // 6.1 手工迭代 SSE 读取器，把 MoveNextAsync 的传输层异常（上游中途断连、读超时等）
            //     转成日志 MarkError + Fail chunk；否则异常冒泡出 StreamAsync，日志保持 running，
            //     Watchdog 5 分钟后兜底成 "TIMEOUT"，真实原因丢失。
            await using var eventEnum = sseReader.ReadEventsAsync(ct).GetAsyncEnumerator(ct);
            bool streamAborted = false;
            string? streamAbortMsg = null;
            int? streamAbortCode = null;

            while (true)
            {
                bool hasNext;
                string data = string.Empty;
                Exception? readException = null;
                try
                {
                    hasNext = await eventEnum.MoveNextAsync();
                    if (hasNext)
                    {
                        data = eventEnum.Current;
                    }
                }
                catch (Exception ex)
                {
                    readException = ex;
                    hasNext = false;
                }

                if (readException != null)
                {
                    var (readMsg, readCode) = ClassifyTransportException(readException, ct.IsCancellationRequested);
                    _logger.LogWarning(readException,
                        "[LlmGateway] 流式读取中断 status={Code} model={Model} firstByteAt={FirstByteAt}",
                        readCode, resolution.ActualModel, firstByteAt);
                    streamAborted = true;
                    streamAbortMsg = readMsg;
                    streamAbortCode = readCode;
                    break;
                }

                if (!hasNext) break;

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
                    continue;
                }

                // 函数调用增量（ToolCall）：透传给调用方（OpenApiController 转 OpenAI SSE delta.tool_calls）
                // + 按 index 累积入日志。ToolCall chunk 无 Content，不会走下面的文本分支，必须显式处理。
                if (chunk.Type == GatewayChunkType.ToolCall)
                {
                    if (chunk.ToolCallDelta != null)
                    {
                        AccumulateToolCallDeltas(toolCallAccum, chunk.ToolCallDelta);
                        yield return chunk;
                    }
                    continue;
                }

                // Thinking 类型（来自 reasoning_content 字段）
                // Gateway 根据 IncludeThinking 决定是否透传给调用方
                // Intent 模型类型强制禁止思考输出（无论 IncludeThinking 设置如何）
                if (chunk.Type == GatewayChunkType.Thinking)
                {
                    if (!thinkingStarted)
                    {
                        thinkingStarted = true;
                        _logger.LogInformation("[LlmGateway] 思考开始。AppCallerCode: {AppCallerCode}", request.AppCallerCode);
                    }
                    if (!string.IsNullOrEmpty(chunk.Content))
                    {
                        thinkingBuilder.Append(chunk.Content); // 日志始终记录，无论是否透传
                    }
                    // 仅在 IncludeThinking=true 且非 Intent 模型类型时透传
                    if (effectiveIncludeThinking)
                    {
                        yield return chunk;
                    }
                    continue;
                }

                if (!string.IsNullOrEmpty(chunk.Content) && chunk.Type == GatewayChunkType.Text)
                {
                    if (!contentStarted)
                    {
                        contentStarted = true;
                        _logger.LogInformation("[LlmGateway] 正文开始。AppCallerCode: {AppCallerCode}", request.AppCallerCode);
                    }
                    // 通过 ThinkTagStripper 过滤 <think>...</think> 标签
                    var stripped = thinkTagStripper.Process(chunk.Content);

                    // <think> 标签内容：日志始终记录，仅在 effectiveIncludeThinking 时透传
                    var capturedThink = thinkTagStripper.PopCapturedThinking();
                    if (!string.IsNullOrEmpty(capturedThink))
                    {
                        thinkingBuilder.Append(capturedThink);
                        if (effectiveIncludeThinking)
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

            // 6.2 流被迫中断时，把真实错误落进日志并推 Fail chunk 出去。
            //     这条路径必须在 Watchdog 扫到之前写，否则 error 会被覆盖成 "TIMEOUT"。
            if (streamAborted)
            {
                if (logId != null)
                {
                    _logWriter?.MarkError(logId, streamAbortMsg!, streamAbortCode);
                }
                if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
                {
                    await _modelResolver.RecordFailureAsync(resolution, ct);
                }
                yield return GatewayStreamChunk.Fail(streamAbortMsg!);
                yield break;
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
                _logger.LogDebug(
                    "[LlmGateway] 模型思考过程（{ThinkingChars} 字符）。AppCallerCode: {AppCallerCode}, Model: {Model}",
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
            var assembledToolCalls = BuildAccumulatedToolCalls(toolCallAccum);
            await FinishStreamLogAsync(logId, assembledText, assembledThinking, tokenUsage, durationMs, assembledToolCalls, finishReason, ct);
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
    public async Task<GatewayRawResponse> SendRawWithResolutionAsync(
        GatewayRawRequest request,
        GatewayModelResolution resolution,
        CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(request.AppCallerCode, request.ModelType, out var error))
            return GatewayRawResponse.Fail(InvalidAppCallerErrorCode, error, 400);

        if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            return GatewayRawResponse.Fail("MODEL_NOT_FOUND",
                resolution.ErrorMessage ?? "未找到可用模型", 404);

        // 将 GatewayModelResolution 转回 ModelResolutionResult 以复用内部执行逻辑
        // GatewayModelResolution 已包含 ApiKey / ExchangeAuthScheme / ExchangeTransformerConfig
        var internalResolution = new ModelResolutionResult
        {
            Success = resolution.Success,
            ResolutionType = resolution.ResolutionType,
            ExpectedModel = resolution.ExpectedModel,
            ActualModel = resolution.ActualModel,
            ActualPlatformId = resolution.ActualPlatformId,
            ActualPlatformName = resolution.ActualPlatformName,
            PlatformType = resolution.PlatformType,
            ApiUrl = resolution.ApiUrl,
            ApiKey = resolution.ApiKey,
            ModelGroupId = resolution.ModelGroupId,
            ModelGroupName = resolution.ModelGroupName,
            ModelGroupCode = resolution.ModelGroupCode,
            ModelPriority = resolution.ModelPriority,
            HealthStatus = resolution.HealthStatus,
            IsFallback = resolution.IsFallback,
            FallbackReason = resolution.FallbackReason,
            OriginalPoolId = resolution.OriginalPoolId,
            OriginalPoolName = resolution.OriginalPoolName,
            OriginalModels = resolution.OriginalModels?.Select(m => new OriginalModelInfo
            {
                ModelId = m.ModelId,
                PlatformId = m.PlatformId,
                HealthStatus = m.HealthStatus,
                IsAvailable = m.IsAvailable,
                ConsecutiveFailures = m.ConsecutiveFailures
            }).ToList(),
            IsExchange = resolution.IsExchange,
            ExchangeId = resolution.ExchangeId,
            ExchangeName = resolution.ExchangeName,
            ExchangeTransformerType = resolution.ExchangeTransformerType,
            ExchangeAuthScheme = resolution.ExchangeAuthScheme,
            ExchangeTransformerConfig = resolution.ExchangeTransformerConfig
        };

        var startedAt = DateTime.UtcNow;
        return await ExecuteRawWithResolutionAsync(request, internalResolution, startedAt, ct);
    }

    /// <inheritdoc />
    public Task<GatewayRawResponse> TestUpstreamProfileAsync(
        GatewayUpstreamProfileTestRequest request,
        CancellationToken ct = default)
    {
        if (!TryValidateAppCaller(request.AppCallerCode, ModelTypes.Chat, out var error))
            return Task.FromResult(GatewayRawResponse.Fail(InvalidAppCallerErrorCode, error, 400));

        var protocol = NormalizeProfileTestProtocol(request.Protocol);
        var baseUrl = request.BaseUrl.TrimEnd('/');
        var profileId = string.IsNullOrWhiteSpace(request.ProfileId)
            ? "runtime-profile-test"
            : request.ProfileId.Trim();
        var profileName = string.IsNullOrWhiteSpace(request.ProfileName)
            ? "Runtime profile test"
            : request.ProfileName.Trim();

        var resolution = new GatewayModelResolution
        {
            Success = true,
            ResolutionType = "DirectModel",
            ExpectedModel = request.Model,
            ActualModel = request.Model,
            ActualPlatformId = profileId,
            ActualPlatformName = profileName,
            PlatformType = protocol,
            Protocol = protocol,
            ResolutionReason = "infra-agent-runtime-profile-test",
            ApiUrl = baseUrl,
            ApiKey = request.ApiKey
        };

        var rawRequest = new GatewayRawRequest
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = ModelTypes.Chat,
            ExpectedModel = request.Model,
            RequestBody = new JsonObject
            {
                ["model"] = request.Model,
                ["max_tokens"] = 8,
                ["stream"] = false,
                ["messages"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["content"] = "Reply with ok."
                    }
                }
            },
            TimeoutSeconds = Math.Clamp(request.TimeoutSeconds, 5, 120),
            ExtraHeaders = new Dictionary<string, string>
            {
                ["User-Agent"] = "prd-agent-runtime-profile-test/1.0"
            },
            Context = new GatewayRequestContext
            {
                RequestId = string.IsNullOrWhiteSpace(request.RequestId)
                    ? Guid.NewGuid().ToString("N")
                    : request.RequestId.Trim(),
                UserId = request.UserId,
                QuestionText = "[Runtime Profile Test] Reply with ok."
            }
        };

        return SendRawWithResolutionAsync(rawRequest, resolution, ct);
    }

    /// <summary>
    /// 发送阶段的核心实现：接收已解析的 <see cref="ModelResolutionResult"/>，
    /// 执行 HTTP 请求、日志写入、健康状态回写等所有"发送后"逻辑。
    /// 遵循 compute-then-send 原则（见 .claude/rules/compute-then-send.md）：
    /// 调用此方法时模型已确定，内部不再调用 _modelResolver.ResolveAsync。
    /// </summary>
    private async Task<GatewayRawResponse> ExecuteRawWithResolutionAsync(
        GatewayRawRequest request,
        ModelResolutionResult resolution,
        DateTime startedAt,
        CancellationToken ct)
    {
        string? logId = null;

        try
        {
            var gatewayResolution = resolution.ToGatewayResolution();

            if (resolution.IsExchange
                && string.Equals(resolution.ExchangeTransformerType, "doubao-asr-stream", StringComparison.OrdinalIgnoreCase))
            {
                return await ExecuteDoubaoStreamAsrWithResolutionAsync(
                    request,
                    resolution,
                    gatewayResolution,
                    startedAt,
                    ct);
            }

            // 2. 选择适配器并构建 endpoint
            var isExchange = resolution.IsExchange;
            var adapter = isExchange ? null : GetAdapterForResolution(resolution);
            string endpoint;

            if (isExchange)
            {
                // Exchange 模式：直接使用目标 URL，支持 {model} 占位符替换
                endpoint = ResolveEndpointTemplate(resolution.ApiUrl!, resolution.ActualModel);
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

                // Exchange 转换器额外 headers（如 X-Api-Resource-Id）
                var extraTransformerHeaders = transformer.GetExtraHeaders(resolution.ExchangeTransformerConfig);
                if (extraTransformerHeaders != null)
                {
                    foreach (var (key, value) in extraTransformerHeaders)
                    {
                        httpRequest.Headers.TryAddWithoutValidation(key, value);
                    }
                }
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
                var authScheme = isExchange
                    ? resolution.ExchangeAuthScheme
                    : GetDefaultAuthSchemeForResolution(resolution);
                SetAuthHeader(httpRequest, authScheme ?? "Bearer", resolution.ApiKey);
            }
            ApplyRequiredProviderHeaders(httpRequest, resolution);

            if (request.ExtraHeaders != null)
            {
                foreach (var (key, value) in request.ExtraHeaders)
                {
                    httpRequest.Headers.TryAddWithoutValidation(key, value);
                }
            }

            ApplyOpenRouterAttribution(httpRequest, resolution.ApiUrl, request.AppCallerCode);

            // 5. 写入日志（开始）
            logId = await StartRawLogAsync(request, gatewayResolution, endpoint, requestBodyForLog, startedAt, ct);

            // 6. 发送请求
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            _logger.LogInformation(
                "[LlmGateway.SendRaw] 向 LLM 发起原始请求\n" +
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

            // 检测响应类型：二进制（音频 / 视频 / 图片等）还是文本（JSON）。
            // 先无损读出全部字节，再决定按二进制还是文本处理——避免下游把二进制 Content-Type 标错
            // （OpenRouter 视频下载实际回 mp4 却标 application/json）时用 ReadAsString 损坏字节。
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "";
            var rawBytes = await response.Content.ReadAsByteArrayAsync(ct);
            var isBinaryResponse = request.ExpectBinaryResponse ||
                                   contentType.StartsWith("audio/") ||
                                   contentType.StartsWith("video/") ||
                                   contentType.StartsWith("image/") ||
                                   contentType == "application/octet-stream" ||
                                   LooksBinary(rawBytes, contentType);

            string? responseBody;
            byte[]? binaryContent = null;

            if (isBinaryResponse && response.IsSuccessStatusCode)
            {
                binaryContent = rawBytes;
                responseBody = $"[binary:{contentType}, {rawBytes.Length} bytes]";
            }
            else
            {
                responseBody = System.Text.Encoding.UTF8.GetString(rawBytes);
            }

            // 6.5 Exchange 异步轮询（submit+query 模式）
            var submitResponseHeaders = new Dictionary<string, string>();
            foreach (var h in response.Headers)
                submitResponseHeaders[h.Key] = string.Join(", ", h.Value);

            // 二进制响应（视频/图片下载）是终态读取，绝不是 async-submit 任务，
            // 必须跳过 Exchange 轮询，否则下载到的 mp4 字节会被当成"任务未完成"误进轮询。
            if (isExchange && !isBinaryResponse && _transformerRegistry.Get(resolution.ExchangeTransformerType) is IAsyncExchangeTransformer asyncTransformer)
            {
                // 检查 submit 响应状态
                if (asyncTransformer.IsTaskFailed((int)response.StatusCode, submitResponseHeaders, responseBody, out var submitError))
                {
                    var endedNow = DateTime.UtcNow;
                    var dur = (long)(endedNow - startedAt).TotalMilliseconds;
                    await FinishRawLogAsync(logId, (int)response.StatusCode, responseBody, dur, ct);
                    return GatewayRawResponse.Fail("EXCHANGE_ASYNC_SUBMIT_FAILED", submitError, (int)response.StatusCode);
                }

                if (asyncTransformer.IsTaskPending((int)response.StatusCode, submitResponseHeaders, responseBody)
                    || asyncTransformer.IsTaskComplete((int)response.StatusCode, submitResponseHeaders, responseBody) == false)
                {
                    _logger.LogInformation("[LlmGateway.Exchange.Async] 进入轮询模式, Exchange={ExchangeName}", resolution.ExchangeName);

                    var (queryUrl, queryBody, queryExtraHeaders) = asyncTransformer.BuildQueryRequest(
                        endpoint, (int)response.StatusCode, submitResponseHeaders, responseBody, resolution.ExchangeTransformerConfig);

                    var pollAttempt = 0;
                    while (pollAttempt < asyncTransformer.MaxPollAttempts)
                    {
                        await Task.Delay(asyncTransformer.PollIntervalMs, CancellationToken.None);
                        pollAttempt++;

                        var queryRequest = new HttpRequestMessage(HttpMethod.Post, queryUrl)
                        {
                            Content = new StringContent(
                                queryBody?.ToJsonString() ?? "{}",
                                System.Text.Encoding.UTF8, "application/json")
                        };

                        // 设置认证头（与 submit 相同）
                        if (!string.IsNullOrWhiteSpace(resolution.ApiKey))
                        {
                            var authScheme = resolution.ExchangeAuthScheme ?? "Bearer";
                            SetAuthHeader(queryRequest, authScheme, resolution.ApiKey);
                        }

                        // 添加 query 额外 headers（包含 X-Tt-Logid 等）
                        foreach (var (key, value) in queryExtraHeaders)
                            queryRequest.Headers.TryAddWithoutValidation(key, value);

                        // 传递 submit 时的 X-Api-Request-Id（豆包 query 需要）
                        string? submitRequestId = null;
                        if (submitResponseHeaders.TryGetValue("X-Api-Request-Id", out var reqId))
                            submitRequestId = reqId;
                        else if (httpRequest.Headers.TryGetValues("X-Api-Request-Id", out var reqIdValues))
                            submitRequestId = reqIdValues.FirstOrDefault();
                        if (submitRequestId != null)
                            queryRequest.Headers.TryAddWithoutValidation("X-Api-Request-Id", submitRequestId);

                        var queryClient = _httpClientFactory.CreateClient();
                        queryClient.Timeout = TimeSpan.FromSeconds(30);
                        var queryResp = await queryClient.SendAsync(queryRequest, CancellationToken.None);

                        var queryHeaders = new Dictionary<string, string>();
                        foreach (var h in queryResp.Headers)
                            queryHeaders[h.Key] = string.Join(", ", h.Value);

                        responseBody = await queryResp.Content.ReadAsStringAsync(CancellationToken.None);
                        response = queryResp;

                        if (asyncTransformer.IsTaskComplete((int)queryResp.StatusCode, queryHeaders, responseBody))
                        {
                            _logger.LogInformation(
                                "[LlmGateway.Exchange.Async] 任务完成, Exchange={ExchangeName}, pollAttempts={Attempts}",
                                resolution.ExchangeName, pollAttempt);
                            // 更新 submitResponseHeaders 为最终的 headers
                            submitResponseHeaders = queryHeaders;
                            break;
                        }

                        if (asyncTransformer.IsTaskFailed((int)queryResp.StatusCode, queryHeaders, responseBody, out var queryError))
                        {
                            var endedNow = DateTime.UtcNow;
                            var dur = (long)(endedNow - startedAt).TotalMilliseconds;
                            await FinishRawLogAsync(logId, (int)queryResp.StatusCode, responseBody, dur, ct);
                            return GatewayRawResponse.Fail("EXCHANGE_ASYNC_QUERY_FAILED", queryError, (int)queryResp.StatusCode);
                        }

                        if (pollAttempt % 10 == 0)
                        {
                            _logger.LogInformation(
                                "[LlmGateway.Exchange.Async] 轮询中... Exchange={ExchangeName}, attempt={Attempt}",
                                resolution.ExchangeName, pollAttempt);
                        }
                    }

                    if (pollAttempt >= asyncTransformer.MaxPollAttempts)
                    {
                        var endedNow = DateTime.UtcNow;
                        var dur = (long)(endedNow - startedAt).TotalMilliseconds;
                        await FinishRawLogAsync(logId, 408, "轮询超时", dur, ct);
                        return GatewayRawResponse.Fail("EXCHANGE_ASYNC_TIMEOUT",
                            $"异步任务超时，已轮询 {pollAttempt} 次 ({pollAttempt * asyncTransformer.PollIntervalMs / 1000}秒)", 408);
                    }
                }
            }

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

            // 8. Exchange 响应转换（仅文本响应）
            var finalResponseBody = responseBody;
            if (isExchange && response.IsSuccessStatusCode && !isBinaryResponse)
            {
                try
                {
                    var respTransformer = _transformerRegistry.Get(resolution.ExchangeTransformerType);
                    if (respTransformer != null)
                    {
                        var rawJson = JsonNode.Parse(responseBody!);
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
                var errorMsg = TryExtractErrorMessage(responseBody!) ?? $"HTTP {(int)response.StatusCode}";
                var (rawCode, rawMsg) = IsQuotaExceeded((int)response.StatusCode, errorMsg)
                    ? await HandleQuotaExceededAsync(resolution.ActualPlatformName, errorMsg)
                    : ("LLM_ERROR", errorMsg);
                return new GatewayRawResponse
                {
                    Success = false,
                    StatusCode = (int)response.StatusCode,
                    Content = responseBody,
                    ResponseHeaders = responseHeaders,
                    ErrorCode = rawCode,
                    ErrorMessage = rawMsg,
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
                BinaryContent = binaryContent,
                ContentType = contentType,
                ResponseHeaders = responseHeaders,
                Resolution = gatewayResolution,
                DurationMs = durationMs,
                LogId = logId
            };
        }
        catch (Exception ex)
        {
            var (msg, code) = ClassifyTransportException(ex, ct.IsCancellationRequested);
            _logger.LogError(ex, "[LlmGateway.SendRaw] 请求失败 status={Code}", code);
            if (logId != null)
            {
                _logWriter?.MarkError(logId, msg, code);
            }
            return GatewayRawResponse.Fail("GATEWAY_ERROR", msg, code);
        }
    }

    private async Task<GatewayRawResponse> ExecuteDoubaoStreamAsrWithResolutionAsync(
        GatewayRawRequest request,
        ModelResolutionResult resolution,
        GatewayModelResolution gatewayResolution,
        DateTime startedAt,
        CancellationToken ct)
    {
        var wsUrl = ResolveDoubaoStreamAsrUrl(resolution);
        var requestBodyForLog = BuildDoubaoStreamAsrRequestLogBody(request);
        var logId = await StartRawLogAsync(request, gatewayResolution, wsUrl, requestBodyForLog, startedAt, ct);

        try
        {
            if (!TryGetAsrAudioBytes(request, out var audioBytes, out var audioName, out var audioError))
            {
                var duration = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                await FinishRawLogAsync(logId, 400, audioError, duration, ct);
                return new GatewayRawResponse
                {
                    Success = false,
                    StatusCode = 400,
                    Content = audioError,
                    ErrorCode = "ASR_AUDIO_MISSING",
                    ErrorMessage = audioError,
                    Resolution = gatewayResolution,
                    DurationMs = duration,
                    LogId = logId
                };
            }

            var (appKey, accessKey) = SplitDoubaoApiKey(resolution.ApiKey, resolution.ExchangeTransformerConfig);
            if (string.IsNullOrWhiteSpace(accessKey))
            {
                var duration = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                var message = "doubao-asr-stream 缺少 Access Key，无法建立 WebSocket ASR 连接。";
                await FinishRawLogAsync(logId, 401, message, duration, ct);
                return new GatewayRawResponse
                {
                    Success = false,
                    StatusCode = 401,
                    Content = message,
                    ErrorCode = "ASR_KEY_MISSING",
                    ErrorMessage = message,
                    Resolution = gatewayResolution,
                    DurationMs = duration,
                    LogId = logId
                };
            }

            _logger.LogInformation(
                "[LlmGateway.DoubaoStreamAsr] 经网关执行 WebSocket ASR appCaller={AppCallerCode} model={Model} audio={AudioName} bytes={Bytes}",
                request.AppCallerCode,
                resolution.ActualModel,
                audioName,
                audioBytes.Length);

            var streamResult = await _doubaoStreamAsr.TranscribeAsync(
                wsUrl,
                appKey,
                accessKey,
                audioBytes,
                resolution.ExchangeTransformerConfig,
                ct);

            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;
            var statusCode = streamResult.Success ? 200 : 502;
            var content = BuildDoubaoStreamAsrVerboseJson(streamResult);

            if (!string.IsNullOrWhiteSpace(resolution.ModelGroupId))
            {
                if (streamResult.Success)
                    await _modelResolver.RecordSuccessAsync(resolution, ct);
                else
                    await _modelResolver.RecordFailureAsync(resolution, ct);
            }

            await FinishRawLogAsync(logId, statusCode, content, durationMs, ct);

            var headers = new Dictionary<string, string>
            {
                ["x-gateway-exchange-protocol"] = "websocket",
                ["x-gateway-transformer"] = "doubao-asr-stream",
            };

            if (!streamResult.Success)
            {
                var message = streamResult.Error
                    ?? streamResult.Diagnostic.FriendlyError
                    ?? "豆包 WebSocket ASR 调用失败";
                return new GatewayRawResponse
                {
                    Success = false,
                    StatusCode = statusCode,
                    Content = content,
                    ContentType = "application/json",
                    ResponseHeaders = headers,
                    ErrorCode = "DOUBAO_STREAM_ASR_FAILED",
                    ErrorMessage = message,
                    Resolution = gatewayResolution,
                    DurationMs = durationMs,
                    LogId = logId
                };
            }

            return new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = content,
                ContentType = "application/json",
                ResponseHeaders = headers,
                Resolution = gatewayResolution,
                DurationMs = durationMs,
                LogId = logId
            };
        }
        catch (Exception ex)
        {
            var (msg, code) = ClassifyTransportException(ex, ct.IsCancellationRequested);
            _logger.LogError(ex, "[LlmGateway.DoubaoStreamAsr] 请求失败 status={Code}", code);
            if (logId != null)
                _logWriter?.MarkError(logId, msg, code);
            return GatewayRawResponse.Fail("GATEWAY_ERROR", msg, code);
        }
    }

    private static string ResolveDoubaoStreamAsrUrl(ModelResolutionResult resolution)
    {
        if (resolution.ExchangeTransformerConfig != null
            && resolution.ExchangeTransformerConfig.TryGetValue("wsUrl", out var configured)
            && !string.IsNullOrWhiteSpace(configured?.ToString()))
        {
            return configured.ToString()!;
        }

        if (!string.IsNullOrWhiteSpace(resolution.ApiUrl))
            return resolution.ApiUrl!;

        return "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
    }

    private static (string AppKey, string AccessKey) SplitDoubaoApiKey(
        string? apiKey,
        Dictionary<string, object>? config)
    {
        var configuredAppKey = config?.GetValueOrDefault("appKey")?.ToString() ?? "";
        var raw = apiKey ?? "";
        if (raw.Contains('|', StringComparison.Ordinal))
        {
            var parts = raw.Split('|', 2);
            return (parts[0], parts[1]);
        }

        return (configuredAppKey, raw);
    }

    private static bool TryGetAsrAudioBytes(
        GatewayRawRequest request,
        out byte[] audioBytes,
        out string audioName,
        out string error)
    {
        if (request.MultipartFiles is { Count: > 0 })
        {
            var entry = request.MultipartFiles.TryGetValue("file", out var named)
                ? named
                : request.MultipartFiles.Values.First();
            audioBytes = entry.Content;
            audioName = entry.FileName;
            error = "";
            return audioBytes.Length > 0;
        }

        if (request.RequestBody != null)
        {
            var base64 = TryGetString(request.RequestBody, "audio_data")
                         ?? TryGetString(request.RequestBody, "audioData")
                         ?? TryGetString(request.RequestBody, "file_data")
                         ?? TryGetString(request.RequestBody, "fileData");
            if (!string.IsNullOrWhiteSpace(base64))
            {
                try
                {
                    audioBytes = Convert.FromBase64String(base64);
                    audioName = TryGetString(request.RequestBody, "file_name")
                                ?? TryGetString(request.RequestBody, "fileName")
                                ?? "audio.wav";
                    error = "";
                    return audioBytes.Length > 0;
                }
                catch (FormatException)
                {
                    audioBytes = [];
                    audioName = "";
                    error = "doubao-asr-stream RequestBody.audio_data 不是合法 base64。";
                    return false;
                }
            }
        }

        audioBytes = [];
        audioName = "";
        error = "doubao-asr-stream 需要 multipart file 或 RequestBody.audio_data。";
        return false;
    }

    private static string? TryGetString(JsonObject body, string key)
        => body.TryGetPropertyValue(key, out var node) ? node?.GetValue<string>() : null;

    private static string BuildDoubaoStreamAsrRequestLogBody(GatewayRawRequest request)
    {
        var fileCount = request.MultipartFiles?.Count ?? request.MultipartFileRefs?.Count ?? 0;
        var fields = request.MultipartFields?.Keys.OrderBy(x => x).ToArray() ?? [];
        var bodyKeys = request.RequestBody?.Select(kv => kv.Key).OrderBy(x => x).ToArray() ?? [];
        return JsonSerializer.Serialize(new
        {
            protocol = "doubao-asr-stream",
            isMultipart = request.IsMultipart,
            fileCount,
            fields,
            bodyKeys,
        });
    }

    private static string BuildDoubaoStreamAsrVerboseJson(StreamAsrResult result)
    {
        var segments = new JsonArray();
        var segmentId = 0;
        foreach (var (startSec, endSec, text) in ExtractDoubaoSegments(result))
        {
            segments.Add(new JsonObject
            {
                ["id"] = segmentId++,
                ["seek"] = 0,
                ["start"] = startSec,
                ["end"] = endSec,
                ["text"] = text,
            });
        }

        var root = new JsonObject
        {
            ["text"] = result.FullText ?? "",
            ["segments"] = segments,
            ["language"] = "zh",
            ["gateway"] = new JsonObject
            {
                ["provider"] = "doubao",
                ["protocol"] = "websocket",
                ["success"] = result.Success,
                ["error"] = result.Error,
                ["diagnostic"] = JsonSerializer.SerializeToNode(result.Diagnostic),
            },
        };

        return root.ToJsonString();
    }

    private static IEnumerable<(double StartSec, double EndSec, string Text)> ExtractDoubaoSegments(StreamAsrResult result)
    {
        foreach (var response in result.Responses)
        {
            if (response.PayloadMsg == null) continue;
            var payload = response.PayloadMsg.Value;
            if (!payload.TryGetProperty("result", out var responseResult)
                || responseResult.ValueKind != JsonValueKind.Object
                || !responseResult.TryGetProperty("utterances", out var utterances)
                || utterances.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var utterance in utterances.EnumerateArray())
            {
                var text = utterance.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                if (string.IsNullOrWhiteSpace(text)) continue;
                var startMs = utterance.TryGetProperty("start_time", out var st) && st.ValueKind == JsonValueKind.Number
                    ? st.GetDouble()
                    : 0;
                var endMs = utterance.TryGetProperty("end_time", out var et) && et.ValueKind == JsonValueKind.Number
                    ? et.GetDouble()
                    : startMs;
                yield return (startMs / 1000.0, endMs / 1000.0, text.Trim());
            }
        }

        if (result.Segments.Count > 0)
        {
            var cursor = 0.0;
            foreach (var segment in result.Segments)
            {
                if (string.IsNullOrWhiteSpace(segment.Text)) continue;
                var end = cursor + Math.Max(0, segment.DurationSec);
                yield return (cursor, end, segment.Text.Trim());
                cursor = end;
            }
            yield break;
        }

        if (!string.IsNullOrWhiteSpace(result.FullText))
            yield return (0, 0, result.FullText.Trim());
    }

    /// <inheritdoc />
    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
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

        var result = await _modelResolver.ResolveAsync(appCallerCode, modelType, expectedModel, pinnedPlatformId, pinnedModelId, ct);
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
    /// 将 URL 模版中的 {model} 占位符替换为实际模型 ID。
    /// 用于 Exchange 模式下一个中继承接多个模型（如 Gemini 原生协议）。
    /// 不含占位符时原样返回，保证旧数据零影响。
    /// </summary>
    public static string ResolveEndpointTemplate(string urlTemplate, string? actualModel)
    {
        if (string.IsNullOrWhiteSpace(urlTemplate) || string.IsNullOrWhiteSpace(actualModel))
            return urlTemplate;

        if (!urlTemplate.Contains("{model}", StringComparison.Ordinal))
            return urlTemplate;

        // Uri.EscapeDataString 保证 model 名里的特殊字符（极少但有可能）不破坏 URL
        var encoded = Uri.EscapeDataString(actualModel);
        return urlTemplate.Replace("{model}", encoded, StringComparison.Ordinal);
    }

    /// <summary>
    /// OpenRouter 应用归属：通过 HTTP-Referer + X-Title header 告诉 OpenRouter 本次调用来自哪个 AppCaller。
    /// 仅在 ApiUrl 指向 openrouter.ai 时注入，避免污染其他严格校验 header/body 的上游（DeepSeek、通义、
    /// Claude 原生、各类中转站等）。body 不动，彻底规避未知字段导致 400 的风险。
    /// </summary>
    private static void ApplyOpenRouterAttribution(
        HttpRequestMessage httpRequest,
        string? apiUrl,
        string appCallerCode)
    {
        if (string.IsNullOrWhiteSpace(apiUrl)) return;
        if (apiUrl.IndexOf("openrouter.ai", StringComparison.OrdinalIgnoreCase) < 0) return;

        httpRequest.Headers.TryAddWithoutValidation("HTTP-Referer", "https://prd-agent.miduo.org");
        if (!string.IsNullOrWhiteSpace(appCallerCode))
        {
            httpRequest.Headers.TryAddWithoutValidation("X-Title", appCallerCode);
        }
    }

    /// <summary>
    /// 把 HttpClient / 流式读取阶段抛出的异常分类为 (人类可读错误, HTTP 风格状态码)。
    /// 目的：让 llmrequestlogs 里的 StatusCode + Error 能体现真实故障类型，
    /// 避免被 Watchdog 5 分钟兜底成 "TIMEOUT"/status=null 的观测黑洞。
    /// - TaskCanceled / OperationCanceled（非 caller 取消）→ 504（上游超时）
    /// - HttpRequestException → 502（网络层失败）
    /// - 其他 → 500
    /// </summary>
    private static (string Message, int StatusCode) ClassifyTransportException(Exception ex, bool callerCancelled)
    {
        if (callerCancelled)
        {
            return ("caller 已取消", 499);
        }

        return ex switch
        {
            TaskCanceledException => ("上游超时未响应（HttpClient timeout）", 504),
            OperationCanceledException => ("上游超时未响应", 504),
            HttpRequestException http => ($"网络请求失败：{http.Message}", 502),
            _ => ($"传输层异常：{ex.Message}", 500)
        };
    }

    /// <summary>
    /// 按文件魔数判断响应体是否为二进制——兜底「下游把二进制 Content-Type 标成 application/json/text」
    /// 的情况（OpenRouter 视频下载即此坑）。覆盖 mp4/mov、png、jpeg、gif、webp 及「标称文本却以 NUL 开头」。
    /// </summary>
    private static bool LooksBinary(byte[] data, string contentType)
    {
        if (data == null || data.Length < 4) return false;
        // mp4 / mov：ftyp box 在偏移 4
        if (data.Length >= 12 && data[4] == (byte)'f' && data[5] == (byte)'t' && data[6] == (byte)'y' && data[7] == (byte)'p') return true;
        // png
        if (data.Length >= 8 && data[0] == 0x89 && data[1] == (byte)'P' && data[2] == (byte)'N' && data[3] == (byte)'G') return true;
        // jpeg
        if (data.Length >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF) return true;
        // gif
        if (data.Length >= 4 && data[0] == (byte)'G' && data[1] == (byte)'I' && data[2] == (byte)'F' && data[3] == (byte)'8') return true;
        // webp (RIFF....WEBP)
        if (data.Length >= 12 && data[0] == (byte)'R' && data[1] == (byte)'I' && data[2] == (byte)'F' && data[3] == (byte)'F'
            && data[8] == (byte)'W' && data[9] == (byte)'E' && data[10] == (byte)'B' && data[11] == (byte)'P') return true;
        // 标称为文本/JSON 却以 NUL 字节开头 = 实为二进制（JSON/文本绝不会以 \0 起始）
        if ((contentType.Contains("json", StringComparison.OrdinalIgnoreCase) || contentType.Contains("text", StringComparison.OrdinalIgnoreCase))
            && data[0] == 0x00) return true;
        return false;
    }

    /// <summary>
    /// 判断上游错误是否为「额度用尽 / key 限额」类（OpenRouter "Key limit exceeded"、402 Payment Required、
    /// "insufficient credits/quota exceeded/billing" 等）。命中后走专门错误码 + 主动站内告警，便于及时提醒。
    /// </summary>
    private static bool IsQuotaExceeded(int statusCode, string? rawMessage)
    {
        var m = (rawMessage ?? string.Empty).ToLowerInvariant();

        // 限流（节流）排除：只把「文本明确指向速率/每分钟请求数」的失败排除掉，不能用「429 一律 false」短路——
        // 部分供应商（如 OpenAI insufficient_quota）也用 429 返回额度耗尽，需让后面的 quota/credit/balance 文本判定
        // 继续生效，否则这些额度失败会走泛化 LLM_ERROR、漏掉额度告警（Codex review）。
        // "Rate limit exceeded" 含 "limit exceeded" 子串，由下面的 rate-limit 文本判定先行排除，不会误判为额度。
        if (m.Contains("rate limit") || m.Contains("rate-limit")
            || m.Contains("requests per") || m.Contains("per minute")
            || m.Contains("too many requests"))
            return false;

        if (statusCode == 402) return true; // Payment Required = 额度/账单
        if (m.Length == 0) return false;

        // 只认明确指向「额度/余额/账单/key 限额」的信号；裸 "limit exceeded" 不再单独判定为额度。
        return m.Contains("key limit")                                   // OpenRouter "Key limit exceeded"
            || m.Contains("credit limit")
            || (m.Contains("limit exceeded") && (m.Contains("credit") || m.Contains("quota") || m.Contains("balance") || m.Contains("key")))
            || (m.Contains("quota") && (m.Contains("exceed") || m.Contains("insufficient")))
            || (m.Contains("insufficient") && (m.Contains("credit") || m.Contains("balance")))
            || m.Contains("exceeded your current")
            || (m.Contains("billing") && m.Contains("limit"));
    }

    /// <summary>
    /// 命中额度用尽时：发专门错误码 + 触发主动站内告警（去重，复用 IPoolFailoverNotifier）。
    /// 必须 await——IPoolFailoverNotifier 是 Scoped、持有 scoped MongoDbContext，fire-and-forget 在
    /// request/stream scope 释放后 upsert 会被取消或 off-thread 失败，恰在 402/额度用尽时丢告警（Codex review）。
    /// 用 CancellationToken.None 确保 scope 存活期内写完，告警失败不阻断主流程。
    /// </summary>
    private async Task<(string Code, string Message)> HandleQuotaExceededAsync(string? platformName, string rawMessage)
    {
        var raw = rawMessage.Length > 220 ? rawMessage.Substring(0, 220) + "…" : rawMessage;
        var friendly = $"大模型平台额度已用尽或被限额，请充值或更换 API Key。上游信息：{raw}";
        try
        {
            if (_failoverNotifier != null)
                await _failoverNotifier.NotifyQuotaExceededAsync(platformName ?? "未知平台", friendly, CancellationToken.None);
        }
        catch (Exception ex) { _logger.LogWarning(ex, "[LlmGateway] 额度告警写入失败（不阻断主流程）"); }
        _logger.LogWarning("[LlmGateway] 检测到额度用尽/限额: platform={Platform} msg={Msg}", platformName, raw);
        return ("LLM_QUOTA_EXCEEDED", friendly);
    }

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
            case "x-goog-api-key":
            case "xgoogapikey":
                // Google Gemini 原生协议认证头
                httpRequest.Headers.TryAddWithoutValidation("x-goog-api-key", apiKey);
                break;
            case "key":
                httpRequest.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Key", apiKey);
                break;
            case "doubao-asr":
                // 豆包 ASR 认证：apiKey 格式 "appId|accessToken"
                // Resource-Id / Request-Id / Sequence 由转换器 GetExtraHeaders 提供
                var parts = apiKey.Split('|', 2);
                var appId = parts.Length > 1 ? parts[0] : "";
                var accessToken = parts.Length > 1 ? parts[1] : apiKey;
                httpRequest.Headers.TryAddWithoutValidation("X-Api-App-Key", appId);
                httpRequest.Headers.TryAddWithoutValidation("X-Api-Access-Key", accessToken);
                break;
            default: // "bearer" or anything else
                httpRequest.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);
                break;
        }
    }

    private static string GetDefaultAuthSchemeForResolution(ModelResolutionResult resolution)
    {
        var protocol = string.IsNullOrWhiteSpace(resolution.Protocol)
            ? resolution.PlatformType
            : resolution.Protocol;
        var normalized = protocol?.Trim().ToLowerInvariant();

        return normalized switch
        {
            "claude" or "anthropic" => "x-api-key",
            "google" or "gemini" => "x-goog-api-key",
            _ => "Bearer"
        };
    }

    private static string NormalizeProfileTestProtocol(string protocol)
    {
        var normalized = protocol.Trim().ToLowerInvariant();
        return normalized switch
        {
            "anthropic" => "claude",
            "openai-compatible" => "openai",
            "gemini" => "google",
            _ => normalized
        };
    }

    private static void ApplyRequiredProviderHeaders(HttpRequestMessage httpRequest, ModelResolutionResult resolution)
    {
        var protocol = string.IsNullOrWhiteSpace(resolution.Protocol)
            ? resolution.PlatformType
            : resolution.Protocol;
        var normalized = protocol?.Trim().ToLowerInvariant();

        if (normalized is "claude" or "anthropic")
        {
            httpRequest.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
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

    /// <summary>
    /// 尝试向请求失败的用户发送故障通知（fire-and-forget，不阻断主流程）
    /// </summary>
    private async Task TryNotifyUserFailureAsync(GatewayRequest request, ModelResolutionResult resolution)
    {
        try
        {
            var userId = request.Context?.UserId;
            if (string.IsNullOrWhiteSpace(userId) || _failoverNotifier == null)
                return;

            await _failoverNotifier.NotifyUserFailureAsync(
                userId, request.ModelType,
                resolution.OriginalPoolName ?? "未知",
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "[LlmGateway] 发送用户故障通知失败");
        }
    }

    /// <summary>
    /// 请求体是否携带非空的 tools 数组（函数调用）。供 G4 能力软门判断。
    /// </summary>
    private static bool RequestHasTools(System.Text.Json.Nodes.JsonObject requestBody)
        => requestBody.TryGetPropertyValue("tools", out var tools)
           && tools is System.Text.Json.Nodes.JsonArray arr && arr.Count > 0;

    // 按「解析出的 wire 协议」选适配器，而非平台类型。pool-item 可覆盖 Protocol（混合/代理平台
    // 走不同 wire），此时必须按 resolution.Protocol 选 adapter，否则请求仍用旧平台适配器构造、只有
    // 日志显示 protocol-from-pool-item（Codex P2）。Protocol 默认回落 PlatformType，普通平台零差异；
    // Protocol 为空时退回 PlatformType 兜底。
    private IGatewayAdapter? GetAdapterForResolution(GatewayModelResolution resolution)
        => GetAdapter(string.IsNullOrWhiteSpace(resolution.Protocol) ? resolution.PlatformType : resolution.Protocol);

    // raw 路径用 ModelResolutionResult（与 send/stream 的 GatewayModelResolution 不同类型，两者都有
    // Protocol/PlatformType）。同样按解析 Protocol 选 adapter，Protocol 空回落 PlatformType。
    private IGatewayAdapter? GetAdapterForResolution(ModelResolutionResult resolution)
        => GetAdapter(string.IsNullOrWhiteSpace(resolution.Protocol) ? resolution.PlatformType : resolution.Protocol);

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
            // 是否流式：SendAsync 置 stream=false，StreamAsync 置 stream=true，此处统一从请求体读
            bool? isStreaming = requestBody.TryGetPropertyValue("stream", out var streamNode)
                && streamNode is JsonValue streamVal && streamVal.TryGetValue<bool>(out var sb)
                ? sb : (bool?)null;

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
                    AppCallerCode: request.AppCallerCode,
                    PlatformId: resolution.ActualPlatformId,
                    PlatformName: resolution.ActualPlatformName,
                    Protocol: resolution.Protocol,
                    ResolutionReason: resolution.ResolutionReason,
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
                    ExpectedModel: resolution.ExpectedModel,
                    IsHealthProbe: request.Context?.IsHealthProbe,
                    IsStreaming: isStreaming,
                    // S2：默认进程内网关路径。若 serving 端处理来自 MAP 的跨进程请求，
                    // MAP 侧 HttpLlmGatewayClient 已把 Context.GatewayTransport 置为 "http" 过线，此处尊重之。
                    GatewayTransport: request.Context?.GatewayTransport ?? GatewayTransports.Inproc),
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
        System.Text.Json.Nodes.JsonArray? toolCalls,
        string? finishReason,
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
                    DurationMs: durationMs,
                    ResponseToolCalls: toolCalls?.ToJsonString(),
                    ToolCallCount: toolCalls?.Count,
                    FinishReason: finishReason));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成日志失败");
        }
    }

    /// <summary>
    /// 从非流式响应体提取完成原因：OpenAI choices[0].finish_reason / Claude stop_reason。无则 null。
    /// </summary>
    private static string? ExtractFinishReason(string responseBody)
    {
        try
        {
            if (System.Text.Json.Nodes.JsonNode.Parse(responseBody) is not System.Text.Json.Nodes.JsonObject root)
                return null;
            if (root["choices"] is System.Text.Json.Nodes.JsonArray choices && choices.Count > 0 &&
                choices[0] is System.Text.Json.Nodes.JsonObject c0 && c0["finish_reason"] is { } fr &&
                fr.GetValueKind() == System.Text.Json.JsonValueKind.String)
            {
                return fr.GetValue<string>();
            }
            if (root["stop_reason"] is { } sr && sr.GetValueKind() == System.Text.Json.JsonValueKind.String)
            {
                return sr.GetValue<string>();
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private async Task FinishStreamLogAsync(
        string? logId,
        string assembledText,
        string assembledThinking,
        GatewayTokenUsage? tokenUsage,
        long durationMs,
        System.Text.Json.Nodes.JsonArray? toolCalls,
        string? finishReason,
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
                    DurationMs: durationMs,
                    ResponseToolCalls: toolCalls?.ToJsonString(),
                    ToolCallCount: toolCalls?.Count,
                    FinishReason: finishReason));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成流式日志失败");
        }
    }

    /// <summary>
    /// 把一批 OpenAI 形状 tool_calls 流式增量按 index 合并进累加器：
    /// 首个 delta 带 id/name，后续 delta 只追加 function.arguments 片段。纯日志用途，best-effort 容错。
    /// </summary>
    private static void AccumulateToolCallDeltas(
        Dictionary<int, System.Text.Json.Nodes.JsonObject> accum,
        System.Text.Json.Nodes.JsonArray delta)
    {
        try
        {
            foreach (var item in delta)
            {
                if (item is not System.Text.Json.Nodes.JsonObject d) continue;
                var idx = (d["index"] as System.Text.Json.Nodes.JsonValue) is { } iv && iv.TryGetValue<int>(out var i)
                    ? i : accum.Count;

                if (!accum.TryGetValue(idx, out var existing))
                {
                    existing = new System.Text.Json.Nodes.JsonObject
                    {
                        ["index"] = idx,
                        ["type"] = "function",
                        ["function"] = new System.Text.Json.Nodes.JsonObject { ["name"] = "", ["arguments"] = "" }
                    };
                    accum[idx] = existing;
                }

                if (d["id"] is { } id && existing["id"] == null) existing["id"] = id.DeepClone();
                if (d["type"] is { } ty) existing["type"] = ty.DeepClone();

                if (d["function"] is System.Text.Json.Nodes.JsonObject fn &&
                    existing["function"] is System.Text.Json.Nodes.JsonObject ef)
                {
                    if (fn["name"] is { } nm)
                    {
                        var nmStr = nm.GetValueKind() == System.Text.Json.JsonValueKind.String ? nm.GetValue<string>() : null;
                        if (!string.IsNullOrEmpty(nmStr)) ef["name"] = nmStr;
                    }
                    if (fn["arguments"] is { } ar && ar.GetValueKind() == System.Text.Json.JsonValueKind.String)
                    {
                        var prev = ef["arguments"]?.GetValueKind() == System.Text.Json.JsonValueKind.String
                            ? ef["arguments"]!.GetValue<string>() : "";
                        ef["arguments"] = prev + ar.GetValue<string>();
                    }
                }
            }
        }
        catch
        {
            // 日志累积容错：解析异常不影响主流程
        }
    }

    /// <summary>累加器 → 按 index 排序的 OpenAI 形状 tool_calls 数组；空则 null。</summary>
    private static System.Text.Json.Nodes.JsonArray? BuildAccumulatedToolCalls(
        Dictionary<int, System.Text.Json.Nodes.JsonObject> accum)
    {
        if (accum.Count == 0) return null;
        var arr = new System.Text.Json.Nodes.JsonArray();
        foreach (var kv in accum.OrderBy(k => k.Key))
        {
            arr.Add(kv.Value.DeepClone());
        }
        return arr;
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
                    AppCallerCode: request.AppCallerCode,
                    PlatformId: resolution.ActualPlatformId,
                    PlatformName: resolution.ActualPlatformName,
                    Protocol: resolution.Protocol,
                    ResolutionReason: resolution.ResolutionReason,
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
                    ExpectedModel: resolution.ExpectedModel,
                    IsHealthProbe: request.Context?.IsHealthProbe,
                    // S2：默认进程内网关 raw 路径（生图/视频等）。serving 端处理跨进程请求时，
                    // MAP 侧已把 Context.GatewayTransport 置为 "http"，此处尊重之。
                    GatewayTransport: request.Context?.GatewayTransport ?? GatewayTransports.Inproc),
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
        bool includeThinking = false,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null)
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
            includeThinking: includeThinking,
            contextAccessor: _contextAccessor,
            expectedModel: expectedModel,
            pinnedPlatformId: pinnedPlatformId,
            pinnedModelId: pinnedModelId);
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
