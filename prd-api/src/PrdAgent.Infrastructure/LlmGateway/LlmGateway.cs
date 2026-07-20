using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Services;
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
    private readonly GatewayProviderConcurrencyCoordinator? _concurrencyCoordinator;
    private readonly string _internalTenantId;
    private readonly Dictionary<string, IGatewayAdapter> _adapters = new(StringComparer.OrdinalIgnoreCase);
    private readonly ExchangeTransformerRegistry _transformerRegistry = new();
    private static readonly HashSet<string> StrictParameterCapabilityKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "seed",
        "stop",
        "frequency_penalty",
        "presence_penalty",
        "modalities",
        "audio",
        "prediction",
        "stream_options",
        "service_tier",
        "store",
        "user",
        "n"
    };
    private const string InvalidAppCallerErrorCode = "APP_CALLER_INVALID";
    private const string MaxTokensField = "max_tokens";
    private const string MaxCompletionTokensField = "max_completion_tokens";

    public LlmGateway(
        IModelResolver modelResolver,
        IHttpClientFactory httpClientFactory,
        ILogger<LlmGateway> logger,
        ILlmRequestLogWriter? logWriter = null,
        ILLMRequestContextAccessor? contextAccessor = null,
        ModelPool.IPoolFailoverNotifier? failoverNotifier = null,
        IDoubaoStreamAsrExecutor? doubaoStreamAsr = null,
        GatewayProviderConcurrencyCoordinator? concurrencyCoordinator = null,
        IConfiguration? configuration = null,
        ISafeOutboundWebSocketConnector? safeWebSocketConnector = null)
    {
        _modelResolver = modelResolver;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _logWriter = logWriter;
        _contextAccessor = contextAccessor;
        _failoverNotifier = failoverNotifier;
        _concurrencyCoordinator = concurrencyCoordinator;
        _internalTenantId = configuration?["LlmGateway:InternalTenantId"]?.Trim() is { Length: > 0 } tenantId
            ? tenantId
            : GatewayTenantDefaults.InternalTenantId;
        _doubaoStreamAsr = doubaoStreamAsr
            ?? new DoubaoStreamAsrService(NullLogger<DoubaoStreamAsrService>.Instance, safeWebSocketConnector);

        // 注册适配器
        RegisterAdapter(new OpenAIGatewayAdapter());
        RegisterAdapter(new ClaudeGatewayAdapter());
    }

    private void RegisterAdapter(IGatewayAdapter adapter)
    {
        _adapters[adapter.PlatformType] = adapter;
    }

    private bool IsExternalTenant(string? tenantId)
        => !string.IsNullOrWhiteSpace(tenantId)
           && !string.Equals(tenantId, _internalTenantId, StringComparison.Ordinal);

    private HttpClient CreateOutboundClient(string? tenantId)
        => IsExternalTenant(tenantId)
            ? _httpClientFactory.CreateClient("SafeOutbound")
            : _httpClientFactory.CreateClient();

    /// <summary>
    /// 计算是否实际允许思考内容透传。
    /// Intent 模型类型强制禁止思考输出，其他类型尊重请求方的 IncludeThinking 设置。
    /// </summary>
    public static bool IsThinkingEffective(bool includeThinking, string modelType)
    {
        return includeThinking
            && !string.Equals(modelType, ModelTypes.Intent, StringComparison.OrdinalIgnoreCase);
    }

    internal static int? ApplyResolvedMaxTokensCap(JsonObject requestBody, ModelResolutionResult resolution)
    {
        var cap = resolution.MaxTokens;
        if (cap is not > 0)
            return null;

        var tokenField = UsesOpenAiProtocol(resolution)
                         && IsGpt56FamilyModel(resolution.ActualModel)
                         && requestBody["messages"] is JsonArray
            ? MaxCompletionTokensField
            : MaxTokensField;

        if (!requestBody.TryGetPropertyValue(tokenField, out var raw) || raw == null)
        {
            requestBody[tokenField] = cap.Value;
            return cap.Value;
        }

        if (!TryReadInt(raw, out var requested))
            return null;

        if (requested > cap.Value)
        {
            requestBody[tokenField] = cap.Value;
            return cap.Value;
        }

        return null;
    }

    private static JsonObject CloneEffectiveRequestBody(GatewayRequest request)
    {
        var body = request.GetEffectiveRequestBody();
        return body.DeepClone() as JsonObject ?? new JsonObject();
    }

    private static List<ModelResolutionResult> GetProviderRetryResolutions(
        ModelResolutionResult resolution,
        GatewayRequest request)
    {
        var candidates = new List<ModelResolutionResult> { resolution };
        if (request.Context?.IsHealthProbe == true
            || (!string.IsNullOrWhiteSpace(request.ExpectedModel) && string.IsNullOrWhiteSpace(resolution.LogicalModelId))
            || !string.IsNullOrWhiteSpace(request.PinnedPlatformId)
            || !string.IsNullOrWhiteSpace(request.PinnedModelId))
        {
            return candidates;
        }

        if (resolution.RetryCandidates is { Count: > 0 })
        {
            candidates.AddRange(resolution.RetryCandidates.Where(c =>
                c.Success
                && !string.IsNullOrWhiteSpace(c.ActualModel)
                && !string.Equals(c.ActualModel, resolution.ActualModel, StringComparison.OrdinalIgnoreCase)));
        }

        var maxAttempts = GetProviderRetryMaxAttempts();
        return candidates
            .GroupBy(c => $"{c.ActualPlatformId}::{c.ActualModel}", StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .Take(maxAttempts)
            .ToList();
    }

    private static List<ModelResolutionResult> GetProviderRetryResolutions(
        ModelResolutionResult resolution,
        GatewayRawRequest request)
    {
        var candidates = new List<ModelResolutionResult> { resolution };
        if (request.Context?.IsHealthProbe == true
            || (!string.IsNullOrWhiteSpace(request.ExpectedModel) && string.IsNullOrWhiteSpace(resolution.LogicalModelId))
            || !string.IsNullOrWhiteSpace(request.PinnedPlatformId)
            || !string.IsNullOrWhiteSpace(request.PinnedModelId))
        {
            return candidates;
        }

        if (resolution.RetryCandidates is { Count: > 0 })
        {
            candidates.AddRange(resolution.RetryCandidates.Where(c =>
                c.Success
                && !string.IsNullOrWhiteSpace(c.ActualModel)
                && !string.Equals(c.ActualModel, resolution.ActualModel, StringComparison.OrdinalIgnoreCase)));
        }

        var maxAttempts = GetProviderRetryMaxAttempts();
        return candidates
            .GroupBy(c => $"{c.ActualPlatformId}::{c.ActualModel}", StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .Take(maxAttempts)
            .ToList();
    }

    private static int GetProviderRetryMaxAttempts()
    {
        var raw = Environment.GetEnvironmentVariable("LLMGW_PROVIDER_RETRY_MAX_ATTEMPTS");
        if (!int.TryParse(raw, out var parsed))
            parsed = 2;
        return Math.Clamp(parsed, 1, 4);
    }

    private static bool ShouldRetryProviderStatus(int statusCode)
        // 401-404 均是当前 Offering 的凭据、授权、模型或端点不可用，切换到同一逻辑模型的
        // 下一 Offering 是安全的；400 保持终止，避免对所有上游重复发送同一份非法请求。
        => statusCode is >= 401 and <= 404
           || statusCode is 408 or 409 or 425 or 429
           || statusCode is >= 500 and <= 599;

    private static bool IsAutoModelPolicy(GatewayRequest request)
        => string.Equals(request.Context?.ModelPolicy, "auto", StringComparison.OrdinalIgnoreCase);

    private static bool TryReadInt(JsonNode node, out int value)
    {
        if (node is JsonValue jsonValue)
        {
            if (jsonValue.TryGetValue<int>(out value))
                return true;
            if (jsonValue.TryGetValue<long>(out var longValue)
                && longValue >= int.MinValue
                && longValue <= int.MaxValue)
            {
                value = (int)longValue;
                return true;
            }
            if (jsonValue.TryGetValue<string>(out var text)
                && int.TryParse(text, out value))
                return true;
        }

        value = default;
        return false;
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
            var effectiveExpectedModel = IsAutoModelPolicy(request)
                ? request.ExpectedModel
                : request.GetEffectiveExpectedModel();
            resolution = await _modelResolver.ResolveAsync(
                request.AppCallerCode, request.ModelType, effectiveExpectedModel, request.PinnedPlatformId, request.PinnedModelId, ct);

            if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                // 向请求失败的用户发送故障通知
                _ = TryNotifyUserFailureAsync(request, resolution);

                return GatewayResponse.Fail("MODEL_NOT_FOUND",
                    resolution.ErrorMessage ?? "未找到可用模型", 404);
            }

            // 2. 选择首个适配器；若首个候选不支持，发送循环会记录失败并尝试后续候选。
            var adapter = GetAdapterForResolution(resolution);

            // 3. 发送请求。候选模型已在 Resolve 阶段一次性算好；发送阶段只消费结果，不再二次 resolve。
            var gatewayTransport = request.Context?.GatewayTransport ?? GatewayTransports.Inproc;
            var providerAttempts = BuildProviderAttempts(resolution, gatewayTransport);
            var retryResolutions = GetProviderRetryResolutions(resolution, request);
            var httpClient = CreateOutboundClient(request.Context?.TenantId);
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);
            HttpResponseMessage? response = null;
            var responseBody = string.Empty;
            var durationMs = 0L;
            var activeResolution = resolution;
            IGatewayAdapter? activeAdapter = adapter;
            GatewayTokenUsage? tokenUsage = null;
            System.Text.Json.Nodes.JsonArray? toolCalls = null;
            Dictionary<string, System.Text.Json.Nodes.JsonNode?>? extensions = null;
            string? finishReason = null;

            for (var attemptIndex = 0; attemptIndex < retryResolutions.Count; attemptIndex++)
            {
                activeResolution = retryResolutions[attemptIndex];
                activeAdapter = GetAdapterForResolution(activeResolution);
                if (activeAdapter == null)
                {
                    var unsupported = $"不支持的平台类型: {activeResolution.PlatformType}";
                    if (attemptIndex == 0 && retryResolutions.Count == 1)
                        return GatewayResponse.Fail("UNSUPPORTED_PLATFORM", unsupported, 400);
                    if (attemptIndex == 0)
                    {
                        CompleteLastSendAttempt(providerAttempts, 400, 0, unsupported);
                    }
                    else
                    {
                        AddProviderAttempt(
                            providerAttempts,
                            activeResolution,
                            stage: "send",
                            transport: gatewayTransport,
                            statusCode: 400,
                            durationMs: 0,
                            error: unsupported,
                            reason: unsupported);
                    }
                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            "previous candidate had unsupported platform type");
                    }
                    continue;
                }

                var requestBody = CloneEffectiveRequestBody(request);
                requestBody["model"] = activeResolution.ActualModel;
                requestBody["stream"] = false;
                ApplyGpt56ChatCompletionsCompatibility(requestBody, activeResolution);
                var cappedMaxTokens = ApplyResolvedMaxTokensCap(requestBody, activeResolution);
                if (cappedMaxTokens.HasValue)
                {
                    _logger.LogInformation(
                        "[LlmGateway] max_tokens 已按模型上限裁剪: AppCallerCode={AppCallerCode}, Model={Model}, MaxTokens={MaxTokens}",
                        request.AppCallerCode, activeResolution.ActualModel, cappedMaxTokens.Value);
                }

                if (TryBuildCapabilityFailure(request, activeResolution, requestBody, out var capabilityError))
                {
                    var capabilityMessage = capabilityError!.ErrorMessage ?? "模型能力不匹配";
                    if (attemptIndex == 0 && retryResolutions.Count == 1)
                        return capabilityError;
                    CompleteLastSendAttempt(providerAttempts, capabilityError.StatusCode, 0, capabilityMessage);
                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            "previous candidate failed capability gate");
                    }
                    continue;
                }

                var concurrency = await AcquireProviderConcurrencyAsync(request.Context?.TenantId, activeResolution, request.TimeoutSeconds, ct);
                if (!concurrency.Allowed)
                {
                    var message = ProviderAdmissionMessage(concurrency.ErrorCode);
                    CompleteLastSendAttempt(providerAttempts, 429, 0, message);
                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            $"previous candidate admission rejected: {concurrency.ErrorCode}");
                        continue;
                    }
                    return GatewayResponse.Fail(concurrency.ErrorCode, message, 429);
                }
                await using var providerLease = concurrency.Lease;

                var endpoint = string.IsNullOrWhiteSpace(activeResolution.OfferingEndpointPath)
                    ? activeAdapter.BuildEndpoint(activeResolution.ApiUrl!, request.ModelType)
                    : BuildOfferingEndpoint(activeResolution.ApiUrl!, activeResolution.OfferingEndpointPath);
                var httpRequest = activeAdapter.BuildHttpRequest(endpoint, activeResolution.ApiKey, requestBody, request.EnablePromptCache);
                ApplyOpenRouterAttribution(httpRequest, activeResolution.ApiUrl, request.AppCallerCode);

                if (logId == null)
                {
                    var gatewayResolution = activeResolution.ToGatewayResolution();
                    logId = await StartLogAsync(request, gatewayResolution, endpoint, requestBody, startedAt, ct);
                }

                _logger.LogInformation(
                    "[LlmGateway] 向 LLM 发起非流式请求\n" +
                    "  AppCallerCode: {AppCallerCode}\n" +
                    "  ExpectedModel: {ExpectedModel}\n" +
                    "  ActualModel: {ActualModel}\n" +
                    "  Platform: {Platform}\n" +
                    "  Endpoint: {Endpoint}\n" +
                    "  Attempt: {Attempt}/{AttemptCount}",
                    request.AppCallerCode,
                    effectiveExpectedModel ?? "(无)",
                    activeResolution.ActualModel,
                    activeResolution.ActualPlatformName ?? activeResolution.ActualPlatformId,
                    endpoint,
                    attemptIndex + 1,
                    retryResolutions.Count);

                var attemptStartedAt = DateTime.UtcNow;
                response = await httpClient.SendAsync(httpRequest, ct);
                responseBody = await response.Content.ReadAsStringAsync(ct);
                var attemptDurationMs = (long)(DateTime.UtcNow - attemptStartedAt).TotalMilliseconds;
                var attemptError = response.IsSuccessStatusCode
                    ? null
                    : TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}";
                CompleteLastSendAttempt(providerAttempts, (int)response.StatusCode, attemptDurationMs, attemptError);

                if (response.IsSuccessStatusCode)
                {
                    tokenUsage = activeAdapter.ParseTokenUsage(responseBody);
                    // 协议保真：提取工具调用（函数调用），归一为 OpenAI 形状（无则 null，不影响纯文本响应）
                    toolCalls = activeAdapter.ParseToolCalls(responseBody);
                    extensions = activeAdapter.ParseExtensions(responseBody);
                    finishReason = ExtractFinishReason(responseBody);
                }

                // 4. 更新健康状态
                if (HasTrackedHealthRoute(activeResolution))
                {
                    if (response.IsSuccessStatusCode)
                    {
                        await _modelResolver.RecordSuccessAsync(activeResolution, ct);
                    }
                    else
                    {
                        await _modelResolver.RecordFailureAsync(activeResolution, ct);
                    }
                }

                var shouldRetry = !response.IsSuccessStatusCode
                                  && attemptIndex < retryResolutions.Count - 1
                                  && ShouldRetryProviderStatus((int)response.StatusCode);
                if (!shouldRetry)
                    break;

                _logger.LogWarning(
                    "[LlmGateway] 非流式请求失败，切换下一个 Provider candidate: status={StatusCode}, model={Model}, nextModel={NextModel}",
                    (int)response.StatusCode,
                    activeResolution.ActualModel,
                    retryResolutions[attemptIndex + 1].ActualModel);
                AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                    $"previous candidate failed with HTTP {(int)response.StatusCode}");
                response.Dispose();
            }

            if (response == null)
            {
                var message = "没有可用的 provider retry candidate";
                if (logId != null)
                {
                    _logWriter?.MarkError(logId, message, 400);
                }
                return GatewayResponse.Fail("MODEL_NOT_FOUND", message, 400);
            }

            var endedAt = DateTime.UtcNow;
            durationMs = (long)(endedAt - startedAt).TotalMilliseconds;

            // 5. 写入日志（完成）
            await FinishLogAsync(logId, response, responseBody, tokenUsage, durationMs, toolCalls, finishReason, activeResolution, gatewayTransport, ct, providerAttempts);

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
            var messageContent = activeAdapter!.ParseMessageContent(responseBody);

            return new GatewayResponse
            {
                Success = true,
                StatusCode = (int)response.StatusCode,
                Content = messageContent ?? responseBody,
                RawResponseBody = responseBody,
                ToolCalls = toolCalls,
                Extensions = extensions,
                Resolution = activeResolution.ToGatewayResolution(),
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
        GatewayProviderConcurrencyLease? providerLease = null;

        try
        {
            // 1. 使用 ModelResolver 解析模型
            var effectiveExpectedModel = IsAutoModelPolicy(request)
                ? request.ExpectedModel
                : request.GetEffectiveExpectedModel();
            resolution = await _modelResolver.ResolveAsync(
                request.AppCallerCode, request.ModelType, effectiveExpectedModel, request.PinnedPlatformId, request.PinnedModelId, ct);

            if (!resolution.Success || string.IsNullOrWhiteSpace(resolution.ActualModel))
            {
                // 向请求失败的用户发送故障通知
                _ = TryNotifyUserFailureAsync(request, resolution);

                yield return GatewayStreamChunk.Fail(resolution.ErrorMessage ?? "未找到可用模型");
                yield break;
            }

            var gatewayTransport = request.Context?.GatewayTransport ?? GatewayTransports.Inproc;
            var providerAttempts = BuildProviderAttempts(resolution, gatewayTransport);
            var retryResolutions = GetProviderRetryResolutions(resolution, request);
            var httpClient = CreateOutboundClient(request.Context?.TenantId);
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);
            HttpResponseMessage? rawResponse = null;
            IGatewayAdapter? adapter = null;
            string? terminalError = null;
            int? terminalStatusCode = null;

            for (var attemptIndex = 0; attemptIndex < retryResolutions.Count; attemptIndex++)
            {
                resolution = retryResolutions[attemptIndex];
                gatewayResolution = resolution.ToGatewayResolution();
                adapter = GetAdapterForResolution(resolution);
                if (adapter == null)
                {
                    terminalError = $"不支持的平台类型: {resolution.PlatformType}";
                    terminalStatusCode = 400;
                    if (attemptIndex == 0)
                        CompleteLastSendAttempt(providerAttempts, 400, 0, terminalError);
                    else
                        AddProviderAttempt(providerAttempts, resolution, "send", gatewayTransport, 400, 0, terminalError, terminalError);
                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            "previous candidate had unsupported platform type");
                    }
                    continue;
                }

                var requestBody = CloneEffectiveRequestBody(request);
                requestBody["model"] = resolution.ActualModel;
                requestBody["stream"] = true;
                ApplyGpt56ChatCompletionsCompatibility(requestBody, resolution);
                var cappedMaxTokens = ApplyResolvedMaxTokensCap(requestBody, resolution);
                if (cappedMaxTokens.HasValue)
                {
                    _logger.LogInformation(
                        "[LlmGateway] max_tokens 已按模型上限裁剪: AppCallerCode={AppCallerCode}, Model={Model}, MaxTokens={MaxTokens}",
                        request.AppCallerCode, resolution.ActualModel, cappedMaxTokens.Value);
                }

                if (TryBuildCapabilityFailure(request, resolution, requestBody, out var capabilityError))
                {
                    terminalError = capabilityError!.ErrorMessage ?? "模型能力不匹配";
                    terminalStatusCode = capabilityError.StatusCode;
                    CompleteLastSendAttempt(providerAttempts, capabilityError.StatusCode, 0, terminalError);
                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            "previous candidate failed capability gate");
                    }
                    continue;
                }

                var concurrency = await AcquireProviderConcurrencyAsync(request.Context?.TenantId, resolution, request.TimeoutSeconds, ct);
                if (!concurrency.Allowed)
                {
                    terminalError = ProviderAdmissionMessage(concurrency.ErrorCode);
                    terminalStatusCode = 429;
                    CompleteLastSendAttempt(providerAttempts, 429, 0, terminalError);
                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            $"previous candidate admission rejected: {concurrency.ErrorCode}");
                        continue;
                    }
                    break;
                }
                providerLease = concurrency.Lease;

                var endpoint = string.IsNullOrWhiteSpace(resolution.OfferingEndpointPath)
                    ? adapter.BuildEndpoint(resolution.ApiUrl!, request.ModelType)
                    : BuildOfferingEndpoint(resolution.ApiUrl!, resolution.OfferingEndpointPath);
                var httpRequest = adapter.BuildHttpRequest(endpoint, resolution.ApiKey, requestBody, request.EnablePromptCache);
                ApplyOpenRouterAttribution(httpRequest, resolution.ApiUrl, request.AppCallerCode);

                if (logId == null)
                {
                    logId = await StartLogAsync(request, gatewayResolution, endpoint, requestBody, startedAt, ct);
                }

                _logger.LogInformation(
                    "[LlmGateway] 向 LLM 发起流式请求\n" +
                    "  AppCallerCode: {AppCallerCode}\n" +
                    "  ExpectedModel: {ExpectedModel}\n" +
                    "  ActualModel: {ActualModel}\n" +
                    "  Platform: {Platform}\n" +
                    "  Attempt: {Attempt}/{AttemptCount}",
                    request.AppCallerCode,
                    effectiveExpectedModel ?? "(无)",
                    resolution.ActualModel,
                    resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                    attemptIndex + 1,
                    retryResolutions.Count);

                Exception? sendException = null;
                var attemptStartedAt = DateTime.UtcNow;
                try
                {
                    rawResponse = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);
                }
                catch (Exception ex)
                {
                    sendException = ex;
                }

                var attemptDurationMs = (long)(DateTime.UtcNow - attemptStartedAt).TotalMilliseconds;
                if (sendException != null)
                {
                    var (sendMsg, sendCode) = ClassifyTransportException(sendException, ct.IsCancellationRequested);
                    terminalError = sendMsg;
                    terminalStatusCode = sendCode;
                    _logger.LogWarning(sendException,
                        "[LlmGateway] HttpClient.SendAsync 失败 status={Code} model={Model}",
                        sendCode, resolution.ActualModel);
                    CompleteLastSendAttempt(providerAttempts, sendCode, attemptDurationMs, sendMsg);
                    if (HasTrackedHealthRoute(resolution))
                        await _modelResolver.RecordFailureAsync(resolution, ct);
                    if (attemptIndex < retryResolutions.Count - 1 && ShouldRetryProviderStatus(sendCode))
                    {
                        if (providerLease is not null)
                        {
                            await providerLease.DisposeAsync();
                            providerLease = null;
                        }
                        AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            $"previous candidate failed with transport status {sendCode}");
                        continue;
                    }
                    break;
                }

                if (rawResponse!.IsSuccessStatusCode)
                {
                    CompleteLastSendAttempt(providerAttempts, (int)rawResponse.StatusCode, attemptDurationMs, null);
                    break;
                }

                var errorBody = await rawResponse.Content.ReadAsStringAsync(ct);
                var errorMsg = TryExtractErrorMessage(errorBody) ?? $"HTTP {(int)rawResponse.StatusCode}";
                terminalError = errorMsg;
                terminalStatusCode = (int)rawResponse.StatusCode;
                CompleteLastSendAttempt(providerAttempts, (int)rawResponse.StatusCode, attemptDurationMs, errorMsg);
                if (HasTrackedHealthRoute(resolution))
                    await _modelResolver.RecordFailureAsync(resolution, ct);

                if (attemptIndex < retryResolutions.Count - 1 && ShouldRetryProviderStatus((int)rawResponse.StatusCode))
                {
                    if (providerLease is not null)
                    {
                        await providerLease.DisposeAsync();
                        providerLease = null;
                    }
                    AddPendingProviderAttempt(providerAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                        $"previous candidate failed with HTTP {(int)rawResponse.StatusCode}");
                    rawResponse.Dispose();
                    rawResponse = null;
                    continue;
                }

                break;
            }

            if (rawResponse == null || !rawResponse.IsSuccessStatusCode)
            {
                if (logId != null)
                    _logWriter?.MarkError(logId, terminalError ?? "流式请求失败", terminalStatusCode);
                if (terminalStatusCode.HasValue && IsQuotaExceeded(terminalStatusCode.Value, terminalError))
                {
                    var (_, qMsg) = await HandleQuotaExceededAsync(resolution.ActualPlatformName, terminalError ?? "");
                    yield return GatewayStreamChunk.Fail(qMsg);
                    yield break;
                }
                yield return GatewayStreamChunk.Fail(terminalError ?? "流式请求失败");
                yield break;
            }

            using var response = rawResponse;
            var finalResolution = resolution;
            var finalGatewayResolution = gatewayResolution ?? finalResolution?.ToGatewayResolution();
            if (finalResolution == null || finalGatewayResolution == null)
            {
                if (logId != null)
                    _logWriter?.MarkError(logId, "流式请求缺少最终路由信息", 500);
                yield return GatewayStreamChunk.Fail("流式请求缺少最终路由信息");
                yield break;
            }

            // 发送开始块（包含调度信息）
            yield return GatewayStreamChunk.Start(finalGatewayResolution);

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
                        readCode, finalResolution.ActualModel, firstByteAt);
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
                    chunk = adapter!.ParseStreamChunk(data);
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

                // 部分 OpenAI 兼容上游会发送带 finish_reason 的终止帧，但既不发送
                // data: [DONE]，也不主动关闭连接。终止语义已经完整时必须立即收口，
                // 否则调用方会一直等到 HttpClient 超时，并丢失已经收到的正文。
                if (!string.IsNullOrEmpty(finishReason))
                {
                    break;
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
                if (HasTrackedHealthRoute(finalResolution))
                {
                    await _modelResolver.RecordFailureAsync(finalResolution, ct);
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
            if (resolution is not null && HasTrackedHealthRoute(resolution))
            {
                await _modelResolver.RecordSuccessAsync(finalResolution, ct);
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
            await FinishStreamLogAsync(
                logId, assembledText, assembledThinking, tokenUsage, durationMs, assembledToolCalls,
                finishReason, finalResolution, gatewayTransport, ct, providerAttempts,
                LlmCostEvidence.BuildSafeResponseHeaders(response, "text/event-stream"));
        }
        finally
        {
            if (providerLease is not null)
                await providerLease.DisposeAsync();
            // 注意：对于流式响应，正常情况下日志会在行 319 的 FinishStreamLogAsync 中更新
            // 这里不需要额外处理，因为：
            // 1. HTTP 失败时，已在行 232 调用 MarkError
            // 2. 异常情况会被调用方捕获，调用方负责处理日志
        }
    }

    private Task<GatewayProviderConcurrencyAdmission> AcquireProviderConcurrencyAsync(
        string? tenantId,
        ModelResolutionResult resolution,
        int timeoutSeconds,
        CancellationToken ct)
        => _concurrencyCoordinator is null
            ? Task.FromResult(GatewayProviderConcurrencyAdmission.Allow())
            : _concurrencyCoordinator.AcquireAsync(
                string.IsNullOrWhiteSpace(tenantId) ? _internalTenantId : tenantId,
                resolution,
                timeoutSeconds,
                ct);

    private static bool HasTrackedHealthRoute(ModelResolutionResult resolution)
        => !string.IsNullOrWhiteSpace(resolution.ModelGroupId)
           || !string.IsNullOrWhiteSpace(resolution.OfferingId);

    private static string ProviderAdmissionMessage(string errorCode)
        => string.Equals(errorCode, "PROVIDER_RATE_LIMIT_EXHAUSTED", StringComparison.Ordinal)
            ? "上游 Offering 已达到每分钟速率上限"
            : "上游平台、模型或 Offering 已达到最大并发";

    private static string BuildEndpointFromPath(string apiUrl, string endpointPath)
    {
        var baseUrl = apiUrl.TrimEnd('/');
        endpointPath = endpointPath.Trim();
        var hasVersionSuffix = System.Text.RegularExpressions.Regex.IsMatch(
            baseUrl, @"/(api/)?v\d+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        if (hasVersionSuffix)
        {
            if (endpointPath.StartsWith("/v1/", StringComparison.OrdinalIgnoreCase))
                endpointPath = endpointPath[3..];
            else if (endpointPath.StartsWith("v1/", StringComparison.OrdinalIgnoreCase))
                endpointPath = endpointPath[2..];
            return $"{baseUrl}{(endpointPath.StartsWith('/') ? "" : "/")}{endpointPath}";
        }

        if (System.Text.RegularExpressions.Regex.IsMatch(
                endpointPath, @"^/?v\d+", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return $"{baseUrl}{(endpointPath.StartsWith('/') ? "" : "/")}{endpointPath}";

        return $"{baseUrl}/v1{(endpointPath.StartsWith('/') ? "" : "/")}{endpointPath}";
    }

    private static string BuildOfferingEndpoint(string apiUrl, string endpointPath)
    {
        var baseUri = new Uri($"{apiUrl.TrimEnd('/')}/", UriKind.Absolute);
        endpointPath = endpointPath.Trim();
        if (endpointPath.StartsWith('/'))
            return $"{baseUri.Scheme}://{baseUri.Authority}{endpointPath}";

        return $"{apiUrl.TrimEnd('/')}/{endpointPath.TrimStart('/')}";
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

        if (!string.IsNullOrWhiteSpace(request.RequiredLogicalModelPublicId)
            && !string.Equals(
                request.RequiredLogicalModelPublicId.Trim(),
                resolution.LogicalModelPublicId?.Trim(),
                StringComparison.OrdinalIgnoreCase))
        {
            return GatewayRawResponse.Fail(
                "LOGICAL_MODEL_RESOLUTION_MISMATCH",
                $"逻辑模型 {request.RequiredLogicalModelPublicId.Trim()} 未能在当前租户与 appCaller 下解析，已拒绝退回其他模型池。",
                409);
        }

        // 将 GatewayModelResolution 转回 ModelResolutionResult 以复用内部执行逻辑
        // GatewayModelResolution 已包含 ApiKey / ExchangeAuthScheme / ExchangeTransformerConfig
        var internalResolution = new ModelResolutionResult
        {
            LogicalModelId = resolution.LogicalModelId,
            LogicalModelPublicId = resolution.LogicalModelPublicId,
            OfferingId = resolution.OfferingId,
            OfferingTargetKind = resolution.OfferingTargetKind,
            OfferingRateLimitPerMinute = resolution.OfferingRateLimitPerMinute,
            OfferingMaxConcurrency = resolution.OfferingMaxConcurrency,
            OfferingEndpointPath = resolution.OfferingEndpointPath,
            Success = resolution.Success,
            ResolutionType = resolution.ResolutionType,
            ExpectedModel = resolution.ExpectedModel,
            ActualModel = resolution.ActualModel,
            ActualPlatformId = resolution.ActualPlatformId,
            ActualPlatformName = resolution.ActualPlatformName,
            PlatformType = resolution.PlatformType,
            Protocol = resolution.Protocol ?? string.Empty,
            ApiUrl = resolution.ApiUrl,
            ApiKey = resolution.ApiKey,
            ModelGroupId = resolution.ModelGroupId,
            ModelGroupName = resolution.ModelGroupName,
            ModelGroupCode = resolution.ModelGroupCode,
            ModelPriority = resolution.ModelPriority,
            HealthStatus = resolution.HealthStatus,
            PlatformMaxConcurrency = resolution.PlatformMaxConcurrency,
            ModelMaxConcurrency = resolution.ModelMaxConcurrency,
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
            ExchangeTransformerConfig = resolution.ExchangeTransformerConfig,
            SupportsFunctionCalling = resolution.SupportsFunctionCalling,
            SupportsVision = resolution.SupportsVision,
            SupportsImageGeneration = resolution.SupportsImageGeneration,
            SupportsThinking = resolution.SupportsThinking,
            SupportsStructuredOutput = resolution.SupportsStructuredOutput,
            SupportsLogprobs = resolution.SupportsLogprobs,
            SupportsParallelToolCalls = resolution.SupportsParallelToolCalls,
            ParameterCapabilities = resolution.ParameterCapabilities,
            InputPricePerMillion = resolution.InputPricePerMillion,
            OutputPricePerMillion = resolution.OutputPricePerMillion,
            PricePerCall = resolution.PricePerCall,
            PriceCurrency = resolution.PriceCurrency,
            RetryCandidates = resolution.RetryCandidates
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
        var sourceContext = request.Context;

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
                TenantId = sourceContext?.TenantId,
                TeamId = sourceContext?.TeamId,
                ServiceKeyId = sourceContext?.ServiceKeyId,
                ClientCode = sourceContext?.ClientCode,
                Environment = sourceContext?.Environment,
                ServiceKeyPrefix = sourceContext?.ServiceKeyPrefix,
                RequestId = string.IsNullOrWhiteSpace(request.RequestId)
                    ? Guid.NewGuid().ToString("N")
                    : request.RequestId.Trim(),
                SessionId = sourceContext?.SessionId,
                RunId = sourceContext?.RunId,
                GroupId = sourceContext?.GroupId,
                UserId = string.IsNullOrWhiteSpace(request.UserId) ? sourceContext?.UserId : request.UserId,
                ViewRole = sourceContext?.ViewRole,
                DocumentChars = sourceContext?.DocumentChars,
                DocumentHash = sourceContext?.DocumentHash,
                QuestionText = "[Runtime Profile Test] Reply with ok.",
                SystemPromptChars = sourceContext?.SystemPromptChars,
                SystemPromptText = sourceContext?.SystemPromptText,
                ImageReferences = sourceContext?.ImageReferences,
                GatewayTransport = sourceContext?.GatewayTransport,
                SourceSystem = sourceContext?.SourceSystem,
                IngressProtocol = sourceContext?.IngressProtocol,
                AppCallerTitle = sourceContext?.AppCallerTitle,
                ModelPolicy = sourceContext?.ModelPolicy,
                ModelPoolId = sourceContext?.ModelPoolId,
                ParameterPolicy = sourceContext?.ParameterPolicy,
                DroppedParameters = sourceContext?.DroppedParameters,
                IsHealthProbe = sourceContext?.IsHealthProbe,
            }
        };

        return SendRawWithResolutionAsync(rawRequest, resolution, ct);
    }

    private sealed record RawHttpRequestBuildResult(
        HttpRequestMessage HttpRequest,
        string Endpoint,
        string RequestBodyForLog,
        bool IsExchange);

    private GatewayRawResponse? TryBuildRawHttpRequest(
        GatewayRawRequest request,
        ModelResolutionResult resolution,
        out RawHttpRequestBuildResult? result)
    {
        result = null;
        if (request.CanonicalImageRequest is not null)
            request = RebuildCanonicalImageRequest(request, resolution);
        var isExchange = resolution.IsExchange;
        var adapter = isExchange ? null : GetAdapterForResolution(resolution);
        string endpoint;

        if (isExchange)
        {
            endpoint = ResolveEndpointTemplate(resolution.ApiUrl!, resolution.ActualModel);
        }
        else if (string.IsNullOrWhiteSpace(resolution.OfferingEndpointPath ?? request.EndpointPath))
        {
            endpoint = adapter?.BuildEndpoint(resolution.ApiUrl!, request.ModelType)
                ?? $"{resolution.ApiUrl!.TrimEnd('/')}/v1/chat/completions";
        }
        else
        {
            endpoint = string.IsNullOrWhiteSpace(resolution.OfferingEndpointPath)
                ? BuildEndpointFromPath(resolution.ApiUrl!, request.EndpointPath!)
                : BuildOfferingEndpoint(resolution.ApiUrl!, resolution.OfferingEndpointPath);
        }

        HttpRequestMessage httpRequest;
        string requestBodyForLog;

        if (isExchange)
        {
            var transformer = _transformerRegistry.Get(resolution.ExchangeTransformerType);
            if (transformer == null)
            {
                return GatewayRawResponse.Fail("EXCHANGE_TRANSFORMER_NOT_FOUND",
                    $"Exchange 转换器未找到: {resolution.ExchangeTransformerType}", 400);
            }

            var rawBody = request.RequestBody?.DeepClone() as JsonObject ?? new JsonObject();
            if (request.IsMultipart)
            {
                rawBody = ConsolidateMultipartToJson(request);
                _logger.LogInformation(
                    "[LlmGateway.Exchange] Multipart → JSON 合并完成，字段数: {FieldCount}, 文件数: {FileCount}",
                    request.MultipartFields?.Count ?? 0,
                    request.MultipartFiles?.Count ?? 0);
            }

            if (TryBuildRawCapabilityFailure(request, resolution, rawBody, out var capabilityError))
            {
                return capabilityError!;
            }

            ApplyResolvedMaxTokensCap(rawBody, resolution);
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
            httpRequest = new HttpRequestMessage(new HttpMethod(request.HttpMethod), endpoint);
            if (!HttpMethodAllowsEmptyBody(request.HttpMethod))
            {
                httpRequest.Content = new StringContent(jsonContent, System.Text.Encoding.UTF8, "application/json");
            }
            requestBodyForLog = jsonContent;

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
            if (TryBuildRawCapabilityFailure(request, resolution, null, out var capabilityError))
            {
                return capabilityError!;
            }

            var multipartContent = new MultipartFormDataContent();
            multipartContent.Add(new StringContent(resolution.ActualModel ?? string.Empty), "model");

            if (request.MultipartFields != null)
            {
                foreach (var (key, value) in request.MultipartFields)
                {
                    if (key != "model")
                    {
                        multipartContent.Add(new StringContent(value?.ToString() ?? ""), key);
                    }
                }
            }

            if (request.MultipartFiles != null)
            {
                foreach (var (fieldName, fileInfo) in request.MultipartFiles)
                {
                    var fileContent = new ByteArrayContent(fileInfo.Content);
                    fileContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(fileInfo.MimeType);
                    multipartContent.Add(fileContent, NormalizeMultipartSendFieldName(fieldName), fileInfo.FileName);
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
            var requestBody = request.RequestBody?.DeepClone() as JsonObject ?? new JsonObject();
            requestBody["model"] = resolution.ActualModel;
            if (IsChatCompletionsEndpoint(endpoint))
                ApplyGpt56ChatCompletionsCompatibility(requestBody, resolution);
            ApplyResolvedMaxTokensCap(requestBody, resolution);
            if (TryBuildRawCapabilityFailure(request, resolution, requestBody, out var capabilityError))
            {
                return capabilityError!;
            }

            var jsonContent = requestBody.ToJsonString();
            httpRequest = new HttpRequestMessage(new HttpMethod(request.HttpMethod), endpoint)
            {
                Content = new StringContent(jsonContent, System.Text.Encoding.UTF8, "application/json")
            };
            requestBodyForLog = jsonContent;
        }

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

        result = new RawHttpRequestBuildResult(httpRequest, endpoint, requestBodyForLog, isExchange);
        return null;
    }

    private static GatewayRawRequest RebuildCanonicalImageRequest(
        GatewayRawRequest source,
        ModelResolutionResult resolution)
    {
        var spec = source.CanonicalImageRequest!;
        var protocol = string.IsNullOrWhiteSpace(resolution.Protocol) ? resolution.PlatformType : resolution.Protocol;
        var normalizedProtocol = protocol?.Trim().ToLowerInvariant();
        var images = spec.Images.Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
        JsonObject? body = null;
        Dictionary<string, object>? multipartFields = null;
        Dictionary<string, (string FileName, byte[] Content, string MimeType)>? multipartFiles = null;
        var endpointPath = source.EndpointPath;
        var isMultipart = false;

        if (resolution.IsExchange)
        {
            body = new JsonObject { ["prompt"] = spec.Prompt, ["n"] = Math.Max(1, spec.Count) };
            if (!string.IsNullOrWhiteSpace(spec.Size)) body["size"] = spec.Size;
            if (images.Count > 0)
            {
                var imageUrls = new JsonArray();
                foreach (var image in images) imageUrls.Add(image);
                body["image_urls"] = imageUrls;
            }
            endpointPath = null;
        }
        else if (normalizedProtocol is "google" or "gemini" or "gemini-compatible")
        {
            var (aspectRatio, imageSize) = LLM.Adapters.GooglePlatformAdapter.ParseSizeToGoogleParams(spec.Size);
            body = LLM.Adapters.GooglePlatformAdapter.BuildGoogleRequestBody(
                resolution.ActualModel!, spec.Prompt, aspectRatio, imageSize, images, spec.MaskBase64);
            endpointPath = LLM.Adapters.GooglePlatformAdapter.BuildGoogleEndpointPath(resolution.ActualModel!);
        }
        else if (normalizedProtocol == "openrouter"
                 || (resolution.ApiUrl?.Contains("openrouter.ai", StringComparison.OrdinalIgnoreCase) ?? false))
        {
            JsonNode userContent;
            if (images.Count == 0)
            {
                userContent = JsonValue.Create(spec.Prompt)!;
            }
            else
            {
                var content = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = spec.Prompt });
                foreach (var image in images)
                {
                    content.Add(new JsonObject
                    {
                        ["type"] = "image_url",
                        ["image_url"] = new JsonObject { ["url"] = EnsureImageDataUri(image) }
                    });
                }
                userContent = content;
            }
            body = new JsonObject
            {
                ["model"] = resolution.ActualModel,
                ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = userContent }),
                ["modalities"] = new JsonArray("image", "text"),
            };
            endpointPath = "chat/completions";
        }
        else
        {
            var adapter = LLM.Adapters.ImageGenPlatformAdapterFactory.GetAdapter(
                resolution.ApiUrl, resolution.ActualModel, normalizedProtocol);
            var effectiveSize = adapter.NormalizeSize(spec.Size);
            var effectiveFormat = adapter.ForceUrlResponseFormat ? "url" : spec.ResponseFormat;
            if (images.Count == 0)
            {
                var requestObject = adapter.BuildGenerationRequest(
                    resolution.ActualModel!, spec.Prompt, Math.Max(1, spec.Count), effectiveSize, effectiveFormat);
                body = JsonNode.Parse(adapter.SerializeRequest(requestObject))?.AsObject() ?? new JsonObject();
                endpointPath = "images/generations";
            }
            else if (TryDecodeCanonicalImage(images[0], out var bytes, out var mimeType))
            {
                isMultipart = true;
                endpointPath = "images/edits";
                multipartFields = new Dictionary<string, object>
                {
                    ["prompt"] = spec.Prompt,
                    ["n"] = Math.Max(1, spec.Count),
                };
                if (!string.IsNullOrWhiteSpace(effectiveSize)) multipartFields["size"] = effectiveSize;
                if (!string.IsNullOrWhiteSpace(effectiveFormat)) multipartFields["response_format"] = effectiveFormat;
                multipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
                {
                    ["image"] = ("input.png", bytes, mimeType),
                };
            }
        }

        if (!resolution.IsExchange && !string.IsNullOrWhiteSpace(resolution.OfferingEndpointPath))
            endpointPath = resolution.OfferingEndpointPath;

        return new GatewayRawRequest
        {
            AppCallerCode = source.AppCallerCode,
            ModelType = source.ModelType,
            ExpectedModel = source.ExpectedModel,
            PinnedPlatformId = source.PinnedPlatformId,
            PinnedModelId = source.PinnedModelId,
            EndpointPath = endpointPath,
            RequestBody = body ?? source.RequestBody,
            IsMultipart = isMultipart,
            MultipartFields = multipartFields,
            MultipartFiles = multipartFiles,
            HttpMethod = source.HttpMethod,
            ExtraHeaders = source.ExtraHeaders,
            TimeoutSeconds = source.TimeoutSeconds,
            ExpectBinaryResponse = source.ExpectBinaryResponse,
            Context = source.Context,
            CanonicalImageRequest = spec,
        };
    }

    private static string EnsureImageDataUri(string value)
        => value.StartsWith("data:", StringComparison.OrdinalIgnoreCase) ? value : $"data:image/png;base64,{value}";

    private static bool TryDecodeCanonicalImage(string value, out byte[] bytes, out string mimeType)
    {
        bytes = Array.Empty<byte>();
        mimeType = "image/png";
        try
        {
            var raw = value;
            if (value.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            {
                var comma = value.IndexOf(',');
                if (comma < 0) return false;
                var meta = value[5..comma];
                var separator = meta.IndexOf(';');
                if (separator > 0) mimeType = meta[..separator];
                raw = value[(comma + 1)..];
            }
            bytes = Convert.FromBase64String(raw);
            return bytes.Length > 0;
        }
        catch (FormatException)
        {
            return false;
        }
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
        GatewayProviderConcurrencyLease? providerLease = null;

        try
        {
            var gatewayResolution = resolution.ToGatewayResolution();
            var concurrency = await AcquireProviderConcurrencyAsync(request.Context?.TenantId, resolution, request.TimeoutSeconds, ct);
            if (!concurrency.Allowed)
            {
                var admissionMessage = ProviderAdmissionMessage(concurrency.ErrorCode);
                if (request.CanonicalImageRequest is not null
                    && resolution.RetryCandidates is { Count: > 0 })
                {
                    var candidate = resolution.RetryCandidates[0];
                    candidate.RetryCandidates = resolution.RetryCandidates.Skip(1).ToList();
                    var rebuiltRequest = RebuildCanonicalImageRequest(request, candidate);
                    return await ExecuteRawWithResolutionAsync(rebuiltRequest, candidate, startedAt, ct);
                }
                return GatewayRawResponse.Fail(concurrency.ErrorCode, admissionMessage, 429);
            }
            providerLease = concurrency.Lease;

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
            else if (string.IsNullOrWhiteSpace(resolution.OfferingEndpointPath ?? request.EndpointPath))
            {
                // 使用适配器构建默认 endpoint（处理不同平台的 URL 格式）
                endpoint = adapter?.BuildEndpoint(resolution.ApiUrl!, request.ModelType)
                    ?? $"{resolution.ApiUrl!.TrimEnd('/')}/v1/chat/completions";
            }
            else
            {
                endpoint = string.IsNullOrWhiteSpace(resolution.OfferingEndpointPath)
                    ? BuildEndpointFromPath(resolution.ApiUrl!, request.EndpointPath!)
                    : BuildOfferingEndpoint(resolution.ApiUrl!, resolution.OfferingEndpointPath);
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
                if (TryBuildRawCapabilityFailure(request, resolution, rawBody, out var capabilityError))
                {
                    return capabilityError!;
                }

                // 智能路由：根据请求内容决定实际目标 URL
                ApplyResolvedMaxTokensCap(rawBody, resolution);
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
                httpRequest = new HttpRequestMessage(new HttpMethod(request.HttpMethod), endpoint);
                if (!HttpMethodAllowsEmptyBody(request.HttpMethod))
                {
                    httpRequest.Content = new StringContent(jsonContent, System.Text.Encoding.UTF8, "application/json");
                }
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
                if (TryBuildRawCapabilityFailure(request, resolution, null, out var capabilityError))
                {
                    return capabilityError!;
                }

                // multipart/form-data 请求
                var multipartContent = new MultipartFormDataContent();

                // 添加 model 字段
                multipartContent.Add(new StringContent(resolution.ActualModel ?? string.Empty), "model");

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
                        multipartContent.Add(fileContent, NormalizeMultipartSendFieldName(fieldName), fileInfo.FileName);
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
                if (IsChatCompletionsEndpoint(endpoint))
                    ApplyGpt56ChatCompletionsCompatibility(requestBody, resolution);
                ApplyResolvedMaxTokensCap(requestBody, resolution);
                if (TryBuildRawCapabilityFailure(request, resolution, requestBody, out var capabilityError))
                {
                    return capabilityError!;
                }

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
            var httpClient = CreateOutboundClient(request.Context?.TenantId);
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);
            var gatewayTransport = request.Context?.GatewayTransport ?? GatewayTransports.Inproc;
            var rawProviderAttempts = BuildProviderAttempts(resolution, gatewayTransport);
            var retryResolutions = GetProviderRetryResolutions(resolution, request);

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

            var submitStartedAt = DateTime.UtcNow;
            var response = await httpClient.SendAsync(httpRequest, ct);

            // 检测响应类型：二进制（音频 / 视频 / 图片等）还是文本（JSON）。
            // 先无损读出全部字节，再决定按二进制还是文本处理——避免下游把二进制 Content-Type 标错
            // （OpenRouter 视频下载实际回 mp4 却标 application/json）时用 ReadAsString 损坏字节。
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "";
            var rawBytes = await response.Content.ReadAsByteArrayAsync(ct);
            var submitDurationMs = (long)(DateTime.UtcNow - submitStartedAt).TotalMilliseconds;
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
            CompleteLastSendAttempt(
                rawProviderAttempts,
                (int)response.StatusCode,
                submitDurationMs,
                response.IsSuccessStatusCode ? null : TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}");

            for (var attemptIndex = 1;
                 !response.IsSuccessStatusCode
                 && attemptIndex < retryResolutions.Count
                 && ShouldRetryProviderStatus((int)response.StatusCode);
                 attemptIndex++)
            {
                if (HasTrackedHealthRoute(resolution))
                {
                    await _modelResolver.RecordFailureAsync(resolution, ct);
                }

                var nextResolution = retryResolutions[attemptIndex];
                _logger.LogWarning(
                    "[LlmGateway.SendRaw] 原始请求失败，切换下一个 Provider candidate: status={StatusCode}, model={Model}, nextModel={NextModel}",
                    (int)response.StatusCode,
                    resolution.ActualModel,
                    nextResolution.ActualModel);

                AddPendingProviderAttempt(rawProviderAttempts, nextResolution, gatewayTransport,
                    $"previous candidate failed with HTTP {(int)response.StatusCode}");
                response.Dispose();

                var buildError = TryBuildRawHttpRequest(request, nextResolution, out var nextBuild);
                resolution = nextResolution;
                gatewayResolution = resolution.ToGatewayResolution();

                if (buildError != null || nextBuild == null)
                {
                    var buildStatusCode = buildError?.StatusCode > 0 ? buildError.StatusCode : 400;
                    var buildMessage = buildError?.ErrorMessage ?? buildError?.Content ?? "raw retry candidate build failed";
                    CompleteLastSendAttempt(rawProviderAttempts, buildStatusCode, 0, buildMessage);

                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        continue;
                    }

                    var dur = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                    await FinishRawLogAsync(logId, buildStatusCode, buildMessage, dur, resolution, gatewayTransport, ct, rawProviderAttempts);
                    return new GatewayRawResponse
                    {
                        Success = false,
                        StatusCode = buildStatusCode,
                        Content = buildMessage,
                        ErrorCode = buildError?.ErrorCode ?? "RAW_RETRY_BUILD_FAILED",
                        ErrorMessage = buildMessage,
                        Resolution = gatewayResolution,
                        DurationMs = dur,
                        LogId = logId
                    };
                }

                if (providerLease is not null)
                {
                    await providerLease.DisposeAsync();
                    providerLease = null;
                }
                var retryConcurrency = await AcquireProviderConcurrencyAsync(request.Context?.TenantId, resolution, request.TimeoutSeconds, ct);
                if (!retryConcurrency.Allowed)
                {
                    var dur = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                    var message = ProviderAdmissionMessage(retryConcurrency.ErrorCode);
                    CompleteLastSendAttempt(rawProviderAttempts, 429, 0, message);
                    if (attemptIndex < retryResolutions.Count - 1)
                    {
                        AddPendingProviderAttempt(rawProviderAttempts, retryResolutions[attemptIndex + 1], gatewayTransport,
                            $"previous candidate admission rejected: {retryConcurrency.ErrorCode}");
                        continue;
                    }
                    await FinishRawLogAsync(logId, 429, message, dur, resolution, gatewayTransport, ct, rawProviderAttempts);
                    return GatewayRawResponse.Fail(retryConcurrency.ErrorCode, message, 429);
                }
                providerLease = retryConcurrency.Lease;

                endpoint = nextBuild.Endpoint;
                isExchange = nextBuild.IsExchange;

                _logger.LogInformation(
                    "[LlmGateway.SendRaw] 向 LLM 发起原始请求 retry\n" +
                    "  AppCallerCode: {AppCallerCode}\n" +
                    "  ActualModel: {ActualModel}\n" +
                    "  Platform: {Platform}\n" +
                    "  Endpoint: {Endpoint}\n" +
                    "  IsMultipart: {IsMultipart}\n" +
                    "  Attempt: {Attempt}/{AttemptCount}",
                    request.AppCallerCode,
                    resolution.ActualModel,
                    resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                    endpoint,
                    request.IsMultipart,
                    attemptIndex + 1,
                    retryResolutions.Count);

                submitStartedAt = DateTime.UtcNow;
                response = await httpClient.SendAsync(nextBuild.HttpRequest, ct);
                contentType = response.Content.Headers.ContentType?.MediaType ?? "";
                rawBytes = await response.Content.ReadAsByteArrayAsync(ct);
                submitDurationMs = (long)(DateTime.UtcNow - submitStartedAt).TotalMilliseconds;
                isBinaryResponse = request.ExpectBinaryResponse ||
                                   contentType.StartsWith("audio/") ||
                                   contentType.StartsWith("video/") ||
                                   contentType.StartsWith("image/") ||
                                   contentType == "application/octet-stream" ||
                                   LooksBinary(rawBytes, contentType);

                if (isBinaryResponse && response.IsSuccessStatusCode)
                {
                    binaryContent = rawBytes;
                    responseBody = $"[binary:{contentType}, {rawBytes.Length} bytes]";
                }
                else
                {
                    binaryContent = null;
                    responseBody = System.Text.Encoding.UTF8.GetString(rawBytes);
                }

                CompleteLastSendAttempt(
                    rawProviderAttempts,
                    (int)response.StatusCode,
                    submitDurationMs,
                    response.IsSuccessStatusCode ? null : TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}");
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
                    CompleteLastSendAttempt(rawProviderAttempts, (int)response.StatusCode, submitDurationMs, submitError);
                    await FinishRawLogAsync(
                        logId, (int)response.StatusCode, responseBody, dur, resolution, gatewayTransport, ct,
                        rawProviderAttempts, LlmCostEvidence.BuildSafeResponseHeaders(response, "application/json"));
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
                        await Task.Delay(asyncTransformer.PollIntervalMs, ct);
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

                        var queryClient = CreateOutboundClient(request.Context?.TenantId);
                        queryClient.Timeout = TimeSpan.FromSeconds(30);
                        var queryStartedAt = DateTime.UtcNow;
                        var queryResp = await queryClient.SendAsync(queryRequest, ct);

                        var queryHeaders = new Dictionary<string, string>();
                        foreach (var h in queryResp.Headers)
                            queryHeaders[h.Key] = string.Join(", ", h.Value);

                        responseBody = await queryResp.Content.ReadAsStringAsync(ct);
                        var queryDurationMs = (long)(DateTime.UtcNow - queryStartedAt).TotalMilliseconds;
                        response = queryResp;

                        if (asyncTransformer.IsTaskComplete((int)queryResp.StatusCode, queryHeaders, responseBody))
                        {
                            AddProviderAttempt(
                                rawProviderAttempts,
                                resolution,
                                stage: "poll",
                                transport: gatewayTransport,
                                statusCode: (int)queryResp.StatusCode,
                                durationMs: queryDurationMs,
                                error: null,
                                reason: $"exchange async poll attempt {pollAttempt} complete");
                            _logger.LogInformation(
                                "[LlmGateway.Exchange.Async] 任务完成, Exchange={ExchangeName}, pollAttempts={Attempts}",
                                resolution.ExchangeName, pollAttempt);
                            // 更新 submitResponseHeaders 为最终的 headers
                            submitResponseHeaders = queryHeaders;
                            break;
                        }

                        if (asyncTransformer.IsTaskFailed((int)queryResp.StatusCode, queryHeaders, responseBody, out var queryError))
                        {
                            AddProviderAttempt(
                                rawProviderAttempts,
                                resolution,
                                stage: "poll",
                                transport: gatewayTransport,
                                statusCode: (int)queryResp.StatusCode,
                                durationMs: queryDurationMs,
                                error: queryError,
                                reason: $"exchange async poll attempt {pollAttempt} failed");
                            var endedNow = DateTime.UtcNow;
                            var dur = (long)(endedNow - startedAt).TotalMilliseconds;
                            await FinishRawLogAsync(
                                logId, (int)queryResp.StatusCode, responseBody, dur, resolution, gatewayTransport, ct,
                                rawProviderAttempts, LlmCostEvidence.BuildSafeResponseHeaders(queryResp, "application/json"));
                            return GatewayRawResponse.Fail("EXCHANGE_ASYNC_QUERY_FAILED", queryError, (int)queryResp.StatusCode);
                        }

                        AddProviderAttempt(
                            rawProviderAttempts,
                            resolution,
                            stage: "poll",
                            transport: gatewayTransport,
                            statusCode: (int)queryResp.StatusCode,
                            durationMs: queryDurationMs,
                            error: null,
                            reason: $"exchange async poll attempt {pollAttempt} pending",
                            statusOverride: "pending");

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
                        AddProviderAttempt(
                            rawProviderAttempts,
                            resolution,
                            stage: "poll-timeout",
                            transport: gatewayTransport,
                            statusCode: 408,
                            durationMs: dur,
                            error: "轮询超时",
                            reason: $"exchange async poll timeout after {pollAttempt} attempts");
                        await FinishRawLogAsync(logId, 408, "轮询超时", dur, resolution, gatewayTransport, ct, rawProviderAttempts);
                        return GatewayRawResponse.Fail("EXCHANGE_ASYNC_TIMEOUT",
                            $"异步任务超时，已轮询 {pollAttempt} 次 ({pollAttempt * asyncTransformer.PollIntervalMs / 1000}秒)", 408);
                    }
                }
            }

            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;

            // 7. 更新健康状态
            if (HasTrackedHealthRoute(resolution))
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
            await FinishRawLogAsync(
                logId, (int)response.StatusCode, finalResponseBody, durationMs, resolution, gatewayTransport, ct,
                rawProviderAttempts, LlmCostEvidence.BuildSafeResponseHeaders(
                    response, contentType.Length > 0 ? contentType : "application/json"));

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
        finally
        {
            if (providerLease is not null)
                await providerLease.DisposeAsync();
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
            var externalTenant = IsExternalTenant(request.Context?.TenantId);
            if (!TryGetAsrAudioBytes(request, out var audioBytes, out var audioName, out var audioError))
            {
                var duration = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
                await FinishRawLogAsync(logId, 400, audioError, duration, resolution, request.Context?.GatewayTransport ?? GatewayTransports.Inproc, ct);
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
                await FinishRawLogAsync(logId, 401, message, duration, resolution, request.Context?.GatewayTransport ?? GatewayTransports.Inproc, ct);
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
                ct,
                requirePublicPinnedWebSocket: externalTenant);

            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;
            var statusCode = streamResult.Success ? 200 : 502;
            var content = BuildDoubaoStreamAsrVerboseJson(streamResult);

            if (HasTrackedHealthRoute(resolution))
            {
                if (streamResult.Success)
                    await _modelResolver.RecordSuccessAsync(resolution, ct);
                else
                    await _modelResolver.RecordFailureAsync(resolution, ct);
            }

            await FinishRawLogAsync(logId, statusCode, content, durationMs, resolution, request.Context?.GatewayTransport ?? GatewayTransports.Inproc, ct);

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
    /// OpenRouter 应用归属：通过 HTTP-Referer + X-OpenRouter-Title header 告诉 OpenRouter 本次调用来自哪个 AppCaller。
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
            httpRequest.Headers.TryAddWithoutValidation("X-OpenRouter-Title", $"G-{appCallerCode}");
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

    private static bool HttpMethodAllowsEmptyBody(string? method)
    {
        var normalized = (method ?? "POST").Trim().ToUpperInvariant();
        return normalized is "GET" or "HEAD";
    }

    private static string NormalizeMultipartSendFieldName(string fieldName)
    {
        if (string.Equals(fieldName, "image[]", StringComparison.Ordinal)
            || IsIndexedMultipartArrayField(fieldName, "image"))
        {
            return "image[]";
        }

        return fieldName;
    }

    private static bool IsIndexedMultipartArrayField(string fieldName, string root)
    {
        var prefix = root + "[";
        if (!fieldName.StartsWith(prefix, StringComparison.Ordinal) || !fieldName.EndsWith("]", StringComparison.Ordinal))
            return false;

        var inner = fieldName.Substring(prefix.Length, fieldName.Length - prefix.Length - 1);
        return inner.Length > 0 && inner.All(char.IsDigit);
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

    private static void ApplyGpt56ChatCompletionsCompatibility(JsonObject requestBody, ModelResolutionResult resolution)
    {
        if (!UsesOpenAiProtocol(resolution)
            || !IsGpt56FamilyModel(resolution.ActualModel)
            || requestBody["messages"] is not JsonArray)
        {
            return;
        }

        if (!requestBody.ContainsKey("reasoning_effort"))
            requestBody["reasoning_effort"] = "none";

        if (requestBody.TryGetPropertyValue(MaxTokensField, out var maxTokens))
        {
            if (!requestBody.ContainsKey(MaxCompletionTokensField))
                requestBody[MaxCompletionTokensField] = maxTokens?.DeepClone();
            requestBody.Remove(MaxTokensField);
        }
    }

    private static bool UsesOpenAiProtocol(ModelResolutionResult resolution)
    {
        var protocol = string.IsNullOrWhiteSpace(resolution.Protocol)
            ? resolution.PlatformType
            : resolution.Protocol;
        return string.Equals(protocol, "openai", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsGpt56FamilyModel(string? model)
    {
        var normalized = (model ?? string.Empty).Trim().ToLowerInvariant();
        var slash = normalized.LastIndexOf('/');
        if (slash >= 0 && slash < normalized.Length - 1)
            normalized = normalized[(slash + 1)..];
        return normalized == "gpt-5.6" || normalized.StartsWith("gpt-5.6-", StringComparison.Ordinal);
    }

    private static bool IsChatCompletionsEndpoint(string? endpointPath)
        => !string.IsNullOrWhiteSpace(endpointPath)
           && endpointPath.Contains("chat/completions", StringComparison.OrdinalIgnoreCase);

    private static bool HasIncompatibleGpt56ToolReasoning(JsonObject requestBody, ModelResolutionResult resolution)
    {
        if (!UsesOpenAiProtocol(resolution)
            || !IsGpt56FamilyModel(resolution.ActualModel)
            || !RequestHasTools(requestBody))
        {
            return false;
        }

        return !requestBody.TryGetPropertyValue("reasoning_effort", out var effort)
               || effort is not JsonValue effortValue
               || !effortValue.TryGetValue<string>(out var effortText)
               || !string.Equals(effortText, "none", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryBuildCapabilityFailure(GatewayRequest request, ModelResolutionResult resolution, JsonObject requestBody, out GatewayResponse? error)
    {
        error = null;
        var strict = IsStrictParameterPolicy(request.Context);

        if (TryBuildStrictDroppedParameterFailure(request.Context, out var droppedError))
        {
            error = droppedError;
            return true;
        }

        if (TryBuildStrictParameterCapabilityFailure(request.Context, resolution, requestBody, out var parameterError))
        {
            error = parameterError;
            return true;
        }

        if (HasIncompatibleGpt56ToolReasoning(requestBody, resolution))
        {
            error = GatewayResponse.Fail(
                "GPT56_TOOLS_REQUIRE_REASONING_NONE",
                $"模型 {resolution.ActualModel} 通过 Chat Completions 调用函数工具时 reasoning_effort 必须为 none；需要推理与工具并用时请改用 Responses API。",
                400);
            return true;
        }

        if (RequestHasTools(requestBody) && CapabilityRejected(resolution.SupportsFunctionCalling, strict))
        {
            error = GatewayResponse.Fail(
                resolution.SupportsFunctionCalling == false ? "FUNCTION_CALLING_UNSUPPORTED" : "FUNCTION_CALLING_UNVERIFIED",
                resolution.SupportsFunctionCalling == false
                    ? $"模型 {resolution.ActualModel} 未声明支持函数调用（function_calling），请改用支持函数调用的模型或移除 tools。"
                    : $"strict-require 要求函数调用（function_calling）能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持的模型。",
                400);
            return true;
        }

        if (RequestNeedsVision(request.ModelType, requestBody, hasMultipartImage: false)
            && CapabilityRejected(resolution.SupportsVision, strict))
        {
            error = GatewayResponse.Fail(
                resolution.SupportsVision == false ? "VISION_UNSUPPORTED" : "VISION_UNVERIFIED",
                resolution.SupportsVision == false
                    ? $"模型 {resolution.ActualModel} 未声明支持视觉输入（vision/image_input），请改用视觉模型或移除图片输入。"
                    : $"strict-require 要求视觉输入（vision/image_input）能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持的视觉模型。",
                400);
            return true;
        }
        if (RequestNeedsImageGeneration(request.ModelType, requestBody, endpointPath: null)
            && CapabilityRejected(resolution.SupportsImageGeneration, strict))
        {
            error = GatewayResponse.Fail(
                resolution.SupportsImageGeneration == false ? "IMAGE_GENERATION_UNSUPPORTED" : "IMAGE_GENERATION_UNVERIFIED",
                resolution.SupportsImageGeneration == false
                    ? $"模型 {resolution.ActualModel} 未声明支持图片生成（image_generation），请改用生图模型。"
                    : $"strict-require 要求图片生成（image_generation）能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持的生图模型。",
                400);
            return true;
        }
        if (IsThinkingEffective(request.IncludeThinking, request.ModelType)
            && CapabilityRejected(resolution.SupportsThinking, strict))
        {
            error = GatewayResponse.Fail(
                resolution.SupportsThinking == false ? "THINKING_UNSUPPORTED" : "THINKING_UNVERIFIED",
                resolution.SupportsThinking == false
                    ? $"模型 {resolution.ActualModel} 未声明支持 thinking/reasoning 输出，请关闭 thinking 或改用支持推理输出的模型。"
                    : $"strict-require 要求 thinking/reasoning 输出能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持推理输出的模型。",
                400);
            return true;
        }
        if (RequestNeedsStructuredOutput(requestBody)
            && CapabilityRejected(resolution.SupportsStructuredOutput, strict))
        {
            error = GatewayResponse.Fail(
                resolution.SupportsStructuredOutput == false ? "STRUCTURED_OUTPUT_UNSUPPORTED" : "STRUCTURED_OUTPUT_UNVERIFIED",
                resolution.SupportsStructuredOutput == false
                    ? $"模型 {resolution.ActualModel} 未声明支持结构化输出（json_schema/json_object），请改用支持结构化输出的模型或移除 response_format。"
                    : $"strict-require 要求结构化输出（json_schema/json_object）能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持结构化输出的模型。",
                400);
            return true;
        }
        if (RequestNeedsLogprobs(requestBody)
            && CapabilityRejected(resolution.SupportsLogprobs, strict))
        {
            error = GatewayResponse.Fail(
                resolution.SupportsLogprobs == false ? "LOGPROBS_UNSUPPORTED" : "LOGPROBS_UNVERIFIED",
                resolution.SupportsLogprobs == false
                    ? $"模型 {resolution.ActualModel} 未声明支持 logprobs/top_logprobs，请改用支持 token logprobs 的模型或移除相关参数。"
                    : $"strict-require 要求 logprobs/top_logprobs 能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持 token logprobs 的模型。",
                400);
            return true;
        }
        if (RequestNeedsParallelToolCalls(requestBody)
            && CapabilityRejected(resolution.SupportsParallelToolCalls, strict))
        {
            error = GatewayResponse.Fail(
                resolution.SupportsParallelToolCalls == false ? "PARALLEL_TOOL_CALLS_UNSUPPORTED" : "PARALLEL_TOOL_CALLS_UNVERIFIED",
                resolution.SupportsParallelToolCalls == false
                    ? $"模型 {resolution.ActualModel} 未声明支持 parallel_tool_calls，请关闭并行工具调用或改用支持该能力的模型。"
                    : $"strict-require 要求 parallel_tool_calls 能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持并行工具调用的模型。",
                400);
            return true;
        }
        return false;
    }

    private static bool TryBuildRawCapabilityFailure(GatewayRawRequest request, ModelResolutionResult resolution, JsonObject? requestBody, out GatewayRawResponse? error)
    {
        error = null;
        var strict = IsStrictParameterPolicy(request.Context);
        if (TryBuildStrictDroppedParameterRawFailure(request.Context, out var droppedError))
        {
            error = droppedError;
            return true;
        }

        if (TryBuildStrictParameterCapabilityRawFailure(request.Context, resolution, requestBody, out var parameterError))
        {
            error = parameterError;
            return true;
        }

        if (requestBody is not null && HasIncompatibleGpt56ToolReasoning(requestBody, resolution))
        {
            error = GatewayRawResponse.Fail(
                "GPT56_TOOLS_REQUIRE_REASONING_NONE",
                $"模型 {resolution.ActualModel} 通过 Chat Completions 调用函数工具时 reasoning_effort 必须为 none；需要推理与工具并用时请改用 Responses API。",
                400);
            return true;
        }

        var hasMultipartImage = request.MultipartFiles?.Values.Any(f => f.MimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) == true
                                || request.MultipartFileRefs?.Values.Any(f => f.MimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) == true;
        if (RequestNeedsVision(request.ModelType, requestBody, hasMultipartImage)
            && CapabilityRejected(resolution.SupportsVision, strict))
        {
            error = GatewayRawResponse.Fail(
                resolution.SupportsVision == false ? "VISION_UNSUPPORTED" : "VISION_UNVERIFIED",
                resolution.SupportsVision == false
                    ? $"模型 {resolution.ActualModel} 未声明支持视觉输入（vision/image_input），请改用视觉模型或移除图片输入。"
                    : $"strict-require 要求视觉输入（vision/image_input）能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持的视觉模型。",
                400);
            return true;
        }
        if (RequestNeedsImageGeneration(request.ModelType, requestBody, request.EndpointPath)
            && CapabilityRejected(resolution.SupportsImageGeneration, strict))
        {
            error = GatewayRawResponse.Fail(
                resolution.SupportsImageGeneration == false ? "IMAGE_GENERATION_UNSUPPORTED" : "IMAGE_GENERATION_UNVERIFIED",
                resolution.SupportsImageGeneration == false
                    ? $"模型 {resolution.ActualModel} 未声明支持图片生成（image_generation），请改用生图模型。"
                    : $"strict-require 要求图片生成（image_generation）能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持的生图模型。",
                400);
            return true;
        }
        if (RequestNeedsStructuredOutput(requestBody)
            && CapabilityRejected(resolution.SupportsStructuredOutput, strict))
        {
            error = GatewayRawResponse.Fail(
                resolution.SupportsStructuredOutput == false ? "STRUCTURED_OUTPUT_UNSUPPORTED" : "STRUCTURED_OUTPUT_UNVERIFIED",
                resolution.SupportsStructuredOutput == false
                    ? $"模型 {resolution.ActualModel} 未声明支持结构化输出（json_schema/json_object），请改用支持结构化输出的模型或移除 response_format。"
                    : $"strict-require 要求结构化输出（json_schema/json_object）能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持结构化输出的模型。",
                400);
            return true;
        }
        if (RequestNeedsLogprobs(requestBody)
            && CapabilityRejected(resolution.SupportsLogprobs, strict))
        {
            error = GatewayRawResponse.Fail(
                resolution.SupportsLogprobs == false ? "LOGPROBS_UNSUPPORTED" : "LOGPROBS_UNVERIFIED",
                resolution.SupportsLogprobs == false
                    ? $"模型 {resolution.ActualModel} 未声明支持 logprobs/top_logprobs，请改用支持 token logprobs 的模型或移除相关参数。"
                    : $"strict-require 要求 logprobs/top_logprobs 能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持 token logprobs 的模型。",
                400);
            return true;
        }
        if (RequestNeedsParallelToolCalls(requestBody)
            && CapabilityRejected(resolution.SupportsParallelToolCalls, strict))
        {
            error = GatewayRawResponse.Fail(
                resolution.SupportsParallelToolCalls == false ? "PARALLEL_TOOL_CALLS_UNSUPPORTED" : "PARALLEL_TOOL_CALLS_UNVERIFIED",
                resolution.SupportsParallelToolCalls == false
                    ? $"模型 {resolution.ActualModel} 未声明支持 parallel_tool_calls，请关闭并行工具调用或改用支持该能力的模型。"
                    : $"strict-require 要求 parallel_tool_calls 能力，但模型 {resolution.ActualModel} 未确认支持；请配置模型能力或改用已确认支持并行工具调用的模型。",
                400);
            return true;
        }
        return false;
    }

    private static bool IsStrictParameterPolicy(GatewayRequestContext? context)
        => string.Equals(context?.ParameterPolicy, "strict-require", StringComparison.OrdinalIgnoreCase);

    private static bool TryBuildStrictDroppedParameterFailure(GatewayRequestContext? context, out GatewayResponse? error)
    {
        error = null;
        if (!IsStrictParameterPolicy(context) || context?.DroppedParameters is not { Count: > 0 } dropped)
            return false;

        error = GatewayResponse.Fail(
            "DROPPED_PARAMETERS_UNSUPPORTED",
            $"strict-require 不允许入口适配器丢弃参数: {string.Join(", ", dropped)}",
            400);
        return true;
    }

    private static bool TryBuildStrictDroppedParameterRawFailure(GatewayRequestContext? context, out GatewayRawResponse? error)
    {
        error = null;
        if (!IsStrictParameterPolicy(context) || context?.DroppedParameters is not { Count: > 0 } dropped)
            return false;

        error = GatewayRawResponse.Fail(
            "DROPPED_PARAMETERS_UNSUPPORTED",
            $"strict-require 不允许入口适配器丢弃参数: {string.Join(", ", dropped)}",
            400);
        return true;
    }

    private static bool TryBuildStrictParameterCapabilityFailure(
        GatewayRequestContext? context,
        ModelResolutionResult resolution,
        JsonObject? requestBody,
        out GatewayResponse? error)
    {
        error = null;
        if (!TryFindRejectedStrictParameter(context, resolution, requestBody, out var parameter, out var supported))
            return false;

        error = GatewayResponse.Fail(
            supported == false ? "PARAMETER_UNSUPPORTED" : "PARAMETER_UNVERIFIED",
            supported == false
                ? $"模型 {resolution.ActualModel} 未声明支持参数 {parameter}，请移除该参数或改用支持它的模型。"
                : $"strict-require 要求参数 {parameter}，但模型 {resolution.ActualModel} 未确认支持；请配置 parameter:{parameter} 能力或改用已确认支持的模型。",
            400);
        return true;
    }

    private static bool TryBuildStrictParameterCapabilityRawFailure(
        GatewayRequestContext? context,
        ModelResolutionResult resolution,
        JsonObject? requestBody,
        out GatewayRawResponse? error)
    {
        error = null;
        if (!TryFindRejectedStrictParameter(context, resolution, requestBody, out var parameter, out var supported))
            return false;

        error = GatewayRawResponse.Fail(
            supported == false ? "PARAMETER_UNSUPPORTED" : "PARAMETER_UNVERIFIED",
            supported == false
                ? $"模型 {resolution.ActualModel} 未声明支持参数 {parameter}，请移除该参数或改用支持它的模型。"
                : $"strict-require 要求参数 {parameter}，但模型 {resolution.ActualModel} 未确认支持；请配置 parameter:{parameter} 能力或改用已确认支持的模型。",
            400);
        return true;
    }

    private static bool TryFindRejectedStrictParameter(
        GatewayRequestContext? context,
        ModelResolutionResult resolution,
        JsonObject? requestBody,
        out string parameter,
        out bool? supported)
    {
        parameter = string.Empty;
        supported = null;
        if (requestBody is null)
            return false;

        var strict = IsStrictParameterPolicy(context);
        foreach (var key in StrictParameterCapabilityKeys.OrderBy(k => k, StringComparer.OrdinalIgnoreCase))
        {
            if (!IsRequestedJsonParameter(requestBody, key)) continue;
            parameter = key;
            supported = resolution.ParameterCapabilities is not null
                        && resolution.ParameterCapabilities.TryGetValue(key, out var value)
                ? value
                : null;
            return CapabilityRejected(supported, strict);
        }

        return false;
    }

    private static bool CapabilityRejected(bool? supported, bool strict)
        => supported == false || (strict && supported != true);

    private static bool RequestNeedsVision(string modelType, JsonObject? requestBody, bool hasMultipartImage)
        => string.Equals(modelType, ModelTypes.Vision, StringComparison.OrdinalIgnoreCase)
           || hasMultipartImage
           || JsonContainsImageInput(requestBody);

    private static bool RequestNeedsImageGeneration(string modelType, JsonObject? requestBody, string? endpointPath)
        => string.Equals(modelType, ModelTypes.ImageGen, StringComparison.OrdinalIgnoreCase)
           || (endpointPath?.Contains("/images/generations", StringComparison.OrdinalIgnoreCase) == true)
           || (requestBody?.TryGetPropertyValue("response_format", out var responseFormat) == true
               && responseFormat?.ToString().Contains("image", StringComparison.OrdinalIgnoreCase) == true);

    private static bool RequestNeedsStructuredOutput(JsonObject? requestBody)
    {
        if (requestBody?.TryGetPropertyValue("response_format", out var responseFormat) != true
            || responseFormat is null)
        {
            return false;
        }

        if (responseFormat is JsonObject responseFormatObject)
        {
            if (responseFormatObject.ContainsKey("json_schema"))
            {
                return true;
            }

            var type = responseFormatObject.TryGetPropertyValue("type", out var typeNode)
                ? typeNode?.ToString()
                : null;
            return IsStructuredResponseFormatType(type);
        }

        return IsStructuredResponseFormatType(responseFormat.ToString());
    }

    private static bool IsStructuredResponseFormatType(string? type)
        => string.Equals(type, "json_schema", StringComparison.OrdinalIgnoreCase)
           || string.Equals(type, "json_object", StringComparison.OrdinalIgnoreCase);

    private static bool RequestNeedsLogprobs(JsonObject? requestBody)
        => IsRequestedJsonParameter(requestBody, "logprobs")
           || IsRequestedJsonParameter(requestBody, "top_logprobs");

    private static bool RequestNeedsParallelToolCalls(JsonObject? requestBody)
        => IsRequestedJsonParameter(requestBody, "parallel_tool_calls");

    private static bool IsRequestedJsonParameter(JsonObject? requestBody, string key)
    {
        if (requestBody?.TryGetPropertyValue(key, out var node) != true || node is null)
        {
            return false;
        }

        if (node is JsonValue value)
        {
            if (value.TryGetValue<bool>(out var boolValue)) return boolValue;
            if (value.TryGetValue<int>(out var intValue)) return intValue > 0;
            if (value.TryGetValue<long>(out var longValue)) return longValue > 0;
            if (value.TryGetValue<double>(out var doubleValue)) return doubleValue > 0;
            if (value.TryGetValue<string>(out var stringValue))
            {
                var normalized = stringValue.Trim();
                return normalized.Length > 0
                       && !string.Equals(normalized, "false", StringComparison.OrdinalIgnoreCase)
                       && normalized != "0";
            }
        }

        return true;
    }

    private static bool JsonContainsImageInput(JsonNode? node)
    {
        if (node is null) return false;
        if (node is JsonObject obj)
        {
            if (obj.TryGetPropertyValue("type", out var type)
                && type?.ToString().Contains("image", StringComparison.OrdinalIgnoreCase) == true)
            {
                return true;
            }
            foreach (var (key, value) in obj)
            {
                if (IsImageInputKey(key) && value is not null)
                {
                    return true;
                }
                if (JsonContainsImageInput(value)) return true;
            }
            return false;
        }
        if (node is JsonArray arr)
        {
            return arr.Any(JsonContainsImageInput);
        }
        return false;
    }

    private static bool IsImageInputKey(string key)
        => string.Equals(key, "image_url", StringComparison.OrdinalIgnoreCase)
           || string.Equals(key, "image_urls", StringComparison.OrdinalIgnoreCase)
           || string.Equals(key, "input_image", StringComparison.OrdinalIgnoreCase)
           || string.Equals(key, "input_images", StringComparison.OrdinalIgnoreCase)
           || string.Equals(key, "images", StringComparison.OrdinalIgnoreCase)
           || string.Equals(key, "frame_images", StringComparison.OrdinalIgnoreCase)
           || string.Equals(key, "inlineData", StringComparison.OrdinalIgnoreCase)
           || string.Equals(key, "fileData", StringComparison.OrdinalIgnoreCase);

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
        var adapterKey = NormalizeAdapterKey(platformType);
        if (string.IsNullOrWhiteSpace(adapterKey))
            return _adapters.GetValueOrDefault("openai"); // 默认 OpenAI

        if (_adapters.TryGetValue(adapterKey, out var adapter))
            return adapter;

        // OpenAI 兼容
        return _adapters.GetValueOrDefault("openai");
    }

    internal static string? NormalizeAdapterKey(string? platformType)
    {
        var normalized = platformType?.Trim().ToLowerInvariant();
        return normalized switch
        {
            null or "" or "unknown" => null,
            "anthropic" or "claude-compatible" => "claude",
            "openai-compatible" or "openrouter" or "gemini-compatible" => "openai",
            _ => normalized
        };
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
            var requestBodyForLog = RedactAppliedPromptPolicy(requestBody, request.Context);
            var requestJson = requestBodyForLog.ToJsonString();
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
                    LogicalModelId: resolution.LogicalModelId,
                    LogicalModelPublicId: resolution.LogicalModelPublicId,
                    OfferingId: resolution.OfferingId,
                    OfferingTargetKind: resolution.OfferingTargetKind,
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
                    SystemPromptText: string.IsNullOrWhiteSpace(request.Context?.PromptPolicyId) ? request.Context?.SystemPromptText : null,
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
                    ProviderAttempts: BuildProviderAttempts(resolution, request.Context?.GatewayTransport ?? GatewayTransports.Inproc),
                    ImageReferences: request.Context?.ImageReferences,
                    IsFallback: resolution.IsFallback ? true : null,
                    FallbackReason: resolution.FallbackReason,
                    ExpectedModel: resolution.ExpectedModel,
                    IsHealthProbe: request.Context?.IsHealthProbe,
                    IsStreaming: isStreaming,
                    ParameterPolicy: request.Context?.ParameterPolicy,
                    DroppedParameters: request.Context?.DroppedParameters,
                    SourceSystem: request.Context?.SourceSystem,
                    IngressProtocol: request.Context?.IngressProtocol,
                    AppCallerTitle: request.Context?.AppCallerTitle,
                    ModelPolicy: request.Context?.ModelPolicy,
                    ModelPoolId: request.Context?.ModelPoolId,
                    RunId: request.Context?.RunId,
                    InputPricePerMillion: resolution.InputPricePerMillion,
                    OutputPricePerMillion: resolution.OutputPricePerMillion,
                    PricePerCall: resolution.PricePerCall,
                    PriceCurrency: resolution.PriceCurrency,
                    TenantId: request.Context?.TenantId,
                    TeamId: request.Context?.TeamId,
                    ServiceKeyId: request.Context?.ServiceKeyId,
                    ClientCode: request.Context?.ClientCode,
                    Environment: request.Context?.Environment,
                    ServiceKeyPrefix: request.Context?.ServiceKeyPrefix,
                    PromptPolicyId: request.Context?.PromptPolicyId,
                    PromptPolicyVersion: request.Context?.PromptPolicyVersion,
                    PromptPolicyHash: request.Context?.PromptPolicyHash,
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

    private Task FinishLogAsync(
        string? logId,
        HttpResponseMessage response,
        string responseBody,
        GatewayTokenUsage? tokenUsage,
        long durationMs,
        System.Text.Json.Nodes.JsonArray? toolCalls,
        string? finishReason,
        ModelResolutionResult resolution,
        string gatewayTransport,
        CancellationToken ct,
        List<LlmProviderAttempt>? providerAttempts = null)
    {
        if (_logWriter == null || logId == null) return Task.CompletedTask;

        try
        {
            var status = response.IsSuccessStatusCode ? "succeeded" : "failed";
            var answerText = responseBody.Length > 10000
                ? responseBody.Substring(0, 10000) + "...[truncated]"
                : responseBody;
            var cost = EstimateCost(resolution, tokenUsage, countCall: true);

            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: (int)response.StatusCode,
                    ResponseHeaders: LlmCostEvidence.BuildSafeResponseHeaders(response, "application/json"),
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
                    FinishReason: finishReason,
                    EstimatedInputCost: cost.Input,
                    EstimatedOutputCost: cost.Output,
                    EstimatedCallCost: cost.Call,
                    EstimatedCost: cost.Total,
                    EstimatedCostCurrency: cost.Currency,
                    EstimatedCostUsd: cost.Usd,
                    ProviderAttempts: providerAttempts ?? CompleteProviderAttempts(
                        resolution,
                        requestTransport: gatewayTransport,
                        statusCode: (int)response.StatusCode,
                        durationMs: durationMs,
                        error: response.IsSuccessStatusCode ? null : TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}"),
                    Provider: resolution.ActualPlatformName ?? resolution.ActualPlatformId ?? "unknown",
                    Model: resolution.ActualModel ?? "unknown",
                    ApiBase: resolution.ApiUrl,
                    Path: response.RequestMessage?.RequestUri?.AbsolutePath,
                    PlatformId: resolution.ActualPlatformId,
                    PlatformName: resolution.ActualPlatformName,
                    Protocol: resolution.Protocol,
                    ResolutionReason: resolution.ResolutionReason,
                    ModelResolutionType: ParseResolutionType(resolution.ResolutionType),
                    ModelGroupId: resolution.ModelGroupId,
                    ModelGroupName: resolution.ModelGroupName));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成日志失败");
        }

        return Task.CompletedTask;
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

    private static GatewayEstimatedCost EstimateCost(
        ModelResolutionResult? resolution,
        GatewayTokenUsage? tokenUsage,
        bool countCall)
    {
        var currency = string.IsNullOrWhiteSpace(resolution?.PriceCurrency)
            ? null
            : resolution.PriceCurrency.Trim().ToUpperInvariant();
        var inputCost = tokenUsage?.InputTokens is > 0 && resolution?.InputPricePerMillion is decimal inputPrice
            ? Math.Round(tokenUsage.InputTokens.Value * inputPrice / 1_000_000m, 8, MidpointRounding.AwayFromZero)
            : (decimal?)null;
        var outputCost = tokenUsage?.OutputTokens is > 0 && resolution?.OutputPricePerMillion is decimal outputPrice
            ? Math.Round(tokenUsage.OutputTokens.Value * outputPrice / 1_000_000m, 8, MidpointRounding.AwayFromZero)
            : (decimal?)null;
        var callCost = countCall && resolution?.PricePerCall is decimal pricePerCall
            ? Math.Round(Math.Max(0, pricePerCall), 8, MidpointRounding.AwayFromZero)
            : (decimal?)null;

        var parts = new[] { inputCost, outputCost, callCost }.Where(x => x is not null).Select(x => x!.Value).ToList();
        if (parts.Count == 0)
            return new GatewayEstimatedCost(null, null, null, null, currency, null);

        var total = Math.Round(parts.Sum(), 8, MidpointRounding.AwayFromZero);
        var usd = string.Equals(currency, "USD", StringComparison.OrdinalIgnoreCase) ? total : (decimal?)null;
        return new GatewayEstimatedCost(inputCost, outputCost, callCost, total, currency, usd);
    }

    private Task FinishStreamLogAsync(
        string? logId,
        string assembledText,
        string assembledThinking,
        GatewayTokenUsage? tokenUsage,
        long durationMs,
        System.Text.Json.Nodes.JsonArray? toolCalls,
        string? finishReason,
        ModelResolutionResult? resolution,
        string gatewayTransport,
        CancellationToken ct,
        List<LlmProviderAttempt>? providerAttempts = null,
        Dictionary<string, string>? responseHeaders = null)
    {
        if (_logWriter == null || logId == null) return Task.CompletedTask;

        try
        {
            var cost = EstimateCost(resolution, tokenUsage, countCall: true);
            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: 200,
                    ResponseHeaders: responseHeaders ?? new Dictionary<string, string>
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
                    FinishReason: finishReason,
                    EstimatedInputCost: cost.Input,
                    EstimatedOutputCost: cost.Output,
                    EstimatedCallCost: cost.Call,
                    EstimatedCost: cost.Total,
                    EstimatedCostCurrency: cost.Currency,
                    EstimatedCostUsd: cost.Usd,
                    ProviderAttempts: providerAttempts ?? (resolution is null
                        ? null
                        : CompleteProviderAttempts(
                            resolution,
                            requestTransport: gatewayTransport,
                            statusCode: 200,
                            durationMs: durationMs,
                            error: null)),
                    Provider: resolution?.ActualPlatformName ?? resolution?.ActualPlatformId,
                    Model: resolution?.ActualModel,
                    ApiBase: resolution?.ApiUrl,
                    PlatformId: resolution?.ActualPlatformId,
                    PlatformName: resolution?.ActualPlatformName,
                    Protocol: resolution?.Protocol,
                    ResolutionReason: resolution?.ResolutionReason,
                    ModelResolutionType: resolution is null ? null : ParseResolutionType(resolution.ResolutionType),
                    ModelGroupId: resolution?.ModelGroupId,
                    ModelGroupName: resolution?.ModelGroupName));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成流式日志失败");
        }

        return Task.CompletedTask;
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

    private sealed record GatewayEstimatedCost(
        decimal? Input,
        decimal? Output,
        decimal? Call,
        decimal? Total,
        string? Currency,
        decimal? Usd);

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
                    LogicalModelId: resolution.LogicalModelId,
                    LogicalModelPublicId: resolution.LogicalModelPublicId,
                    OfferingId: resolution.OfferingId,
                    OfferingTargetKind: resolution.OfferingTargetKind,
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
                    ProviderAttempts: BuildProviderAttempts(resolution, request.Context?.GatewayTransport ?? GatewayTransports.Inproc),
                    ImageReferences: request.Context?.ImageReferences,
                    IsFallback: resolution.IsFallback ? true : null,
                    FallbackReason: resolution.FallbackReason,
                    ExpectedModel: resolution.ExpectedModel,
                    IsHealthProbe: request.Context?.IsHealthProbe,
                    ParameterPolicy: request.Context?.ParameterPolicy,
                    DroppedParameters: request.Context?.DroppedParameters,
                    SourceSystem: request.Context?.SourceSystem,
                    IngressProtocol: request.Context?.IngressProtocol,
                    AppCallerTitle: request.Context?.AppCallerTitle,
                    ModelPolicy: request.Context?.ModelPolicy,
                    ModelPoolId: request.Context?.ModelPoolId,
                    RunId: request.Context?.RunId,
                    InputPricePerMillion: resolution.InputPricePerMillion,
                    OutputPricePerMillion: resolution.OutputPricePerMillion,
                    PricePerCall: resolution.PricePerCall,
                    PriceCurrency: resolution.PriceCurrency,
                    TenantId: request.Context?.TenantId,
                    TeamId: request.Context?.TeamId,
                    ServiceKeyId: request.Context?.ServiceKeyId,
                    ClientCode: request.Context?.ClientCode,
                    Environment: request.Context?.Environment,
                    ServiceKeyPrefix: request.Context?.ServiceKeyPrefix,
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

    private static JsonObject RedactAppliedPromptPolicy(JsonObject requestBody, GatewayRequestContext? context)
    {
        if (string.IsNullOrWhiteSpace(context?.PromptPolicyId)) return requestBody;
        var clone = requestBody.DeepClone().AsObject();
        var marker = $"[PROMPT_POLICY:{context.PromptPolicyId}:v{context.PromptPolicyVersion}:{context.PromptPolicyHash}]";
        if (clone["messages"] is JsonArray messages)
        {
            foreach (var node in messages)
            {
                if (node is JsonObject message
                    && string.Equals(message["role"]?.GetValue<string>(), "system", StringComparison.OrdinalIgnoreCase))
                    message["content"] = marker;
            }
        }
        if (clone.ContainsKey("system")) clone["system"] = marker;
        if (clone.ContainsKey("systemInstruction")) clone["systemInstruction"] = marker;
        return clone;
    }

    private Task FinishRawLogAsync(
        string? logId,
        int statusCode,
        string responseBody,
        long durationMs,
        ModelResolutionResult resolution,
        string gatewayTransport,
        CancellationToken ct,
        List<LlmProviderAttempt>? providerAttempts = null,
        Dictionary<string, string>? responseHeaders = null)
    {
        if (_logWriter == null || logId == null) return Task.CompletedTask;

        try
        {
            var status = statusCode >= 200 && statusCode < 300 ? "succeeded" : "failed";
            var answerText = responseBody.Length > 10000
                ? responseBody.Substring(0, 10000) + "...[truncated]"
                : responseBody;
            var cost = EstimateCost(resolution, tokenUsage: null, countCall: statusCode >= 200 && statusCode < 300);

            _logWriter.MarkDone(
                logId,
                new LlmLogDone(
                    StatusCode: statusCode,
                    ResponseHeaders: responseHeaders ?? new Dictionary<string, string>
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
                    DurationMs: durationMs,
                    EstimatedInputCost: cost.Input,
                    EstimatedOutputCost: cost.Output,
                    EstimatedCallCost: cost.Call,
                    EstimatedCost: cost.Total,
                    EstimatedCostCurrency: cost.Currency,
                    EstimatedCostUsd: cost.Usd,
                    ProviderAttempts: providerAttempts ?? CompleteProviderAttempts(
                        resolution,
                        requestTransport: gatewayTransport,
                        statusCode: statusCode,
                        durationMs: durationMs,
                        error: statusCode >= 200 && statusCode < 300 ? null : TryExtractErrorMessage(responseBody) ?? $"HTTP {statusCode}"),
                    Provider: resolution.ActualPlatformName ?? resolution.ActualPlatformId,
                    Model: resolution.ActualModel,
                    ApiBase: resolution.ApiUrl,
                    PlatformId: resolution.ActualPlatformId,
                    PlatformName: resolution.ActualPlatformName,
                    Protocol: resolution.Protocol,
                    ResolutionReason: resolution.ResolutionReason,
                    ModelResolutionType: ParseResolutionType(resolution.ResolutionType),
                    ModelGroupId: resolution.ModelGroupId,
                    ModelGroupName: resolution.ModelGroupName));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[LlmGateway] 完成 Raw 日志失败");
        }

        return Task.CompletedTask;
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
        return ModelResolutionTypeMapper.Parse(resolutionType);
    }

    private static List<LlmProviderAttempt> BuildProviderAttempts(ModelResolutionResult resolution, string transport)
    {
        var attempts = new List<LlmProviderAttempt>();
        if (resolution.OriginalModels is { Count: > 0 })
        {
            foreach (var model in resolution.OriginalModels)
            {
                attempts.Add(new LlmProviderAttempt
                {
                    Order = attempts.Count + 1,
                    Stage = "candidate",
                    Provider = resolution.OriginalPoolName,
                    PlatformId = model.PlatformId,
                    Model = model.ModelId,
                    ModelGroupId = resolution.OriginalPoolId,
                    ModelGroupName = resolution.OriginalPoolName,
                    Transport = transport,
                    Status = model.IsAvailable ? "candidate" : "skipped",
                    Reason = model.IsAvailable
                        ? $"health={model.HealthStatus}"
                        : $"unavailable health={model.HealthStatus} failures={model.ConsecutiveFailures}",
                });
            }
        }

        attempts.Add(new LlmProviderAttempt
        {
            Order = attempts.Count + 1,
            Stage = "send",
            Provider = resolution.ActualPlatformName ?? resolution.ActualPlatformId,
            PlatformId = resolution.ActualPlatformId,
            PlatformName = resolution.ActualPlatformName,
            Model = resolution.ActualModel,
            ModelGroupId = resolution.ModelGroupId,
            ModelGroupName = resolution.ModelGroupName,
            Protocol = resolution.Protocol,
            Transport = transport,
            Status = "sent",
            Reason = resolution.IsFallback ? resolution.FallbackReason : resolution.ResolutionReason,
        });

        return attempts;
    }

    private static List<LlmProviderAttempt> CompleteProviderAttempts(
        ModelResolutionResult resolution,
        string requestTransport,
        int statusCode,
        long durationMs,
        string? error)
    {
        var attempts = BuildProviderAttempts(resolution, requestTransport);
        CompleteLastSendAttempt(attempts, statusCode, durationMs, error);
        return attempts;
    }

    private static void AddProviderAttempt(
        List<LlmProviderAttempt> attempts,
        ModelResolutionResult resolution,
        string stage,
        string transport,
        int statusCode,
        long durationMs,
        string? error,
        string? reason = null,
        string? statusOverride = null)
    {
        attempts.Add(new LlmProviderAttempt
        {
            Order = attempts.Count + 1,
            Stage = stage,
            Provider = resolution.ExchangeName
                       ?? resolution.ActualPlatformName
                       ?? resolution.ActualPlatformId,
            PlatformId = resolution.ActualPlatformId,
            PlatformName = resolution.ActualPlatformName,
            Model = resolution.ActualModel,
            ModelGroupId = resolution.ModelGroupId,
            ModelGroupName = resolution.ModelGroupName,
            Protocol = resolution.Protocol,
            Transport = transport,
            Status = statusOverride
                     ?? (statusCode >= 200 && statusCode < 300 && string.IsNullOrWhiteSpace(error)
                         ? "succeeded"
                         : "failed"),
            Reason = reason ?? error,
            StatusCode = statusCode,
            DurationMs = durationMs,
            Error = string.IsNullOrWhiteSpace(error) ? null : error,
            EndedAt = DateTime.UtcNow,
        });
    }

    private static void AddPendingProviderAttempt(
        List<LlmProviderAttempt> attempts,
        ModelResolutionResult resolution,
        string transport,
        string? reason)
    {
        attempts.Add(new LlmProviderAttempt
        {
            Order = attempts.Count + 1,
            Stage = "send",
            Provider = resolution.ActualPlatformName ?? resolution.ActualPlatformId,
            PlatformId = resolution.ActualPlatformId,
            PlatformName = resolution.ActualPlatformName,
            Model = resolution.ActualModel,
            ModelGroupId = resolution.ModelGroupId,
            ModelGroupName = resolution.ModelGroupName,
            Protocol = resolution.Protocol,
            Transport = transport,
            Status = "sent",
            Reason = reason,
        });
    }

    private static List<LlmProviderAttempt> BuildProviderAttempts(GatewayModelResolution resolution, string transport)
    {
        var attempts = new List<LlmProviderAttempt>();
        if (resolution.OriginalModels is { Count: > 0 })
        {
            foreach (var model in resolution.OriginalModels)
            {
                attempts.Add(new LlmProviderAttempt
                {
                    Order = attempts.Count + 1,
                    Stage = "candidate",
                    Provider = resolution.OriginalPoolName,
                    PlatformId = model.PlatformId,
                    Model = model.ModelId,
                    ModelGroupId = resolution.OriginalPoolId,
                    ModelGroupName = resolution.OriginalPoolName,
                    Transport = transport,
                    Status = model.IsAvailable ? "candidate" : "skipped",
                    Reason = model.IsAvailable
                        ? $"health={model.HealthStatus}"
                        : $"unavailable health={model.HealthStatus} failures={model.ConsecutiveFailures}",
                });
            }
        }

        attempts.Add(new LlmProviderAttempt
        {
            Order = attempts.Count + 1,
            Stage = "send",
            Provider = resolution.ActualPlatformName ?? resolution.ActualPlatformId,
            PlatformId = resolution.ActualPlatformId,
            PlatformName = resolution.ActualPlatformName,
            Model = resolution.ActualModel,
            ModelGroupId = resolution.ModelGroupId,
            ModelGroupName = resolution.ModelGroupName,
            Protocol = resolution.Protocol,
            Transport = transport,
            Status = "sent",
            Reason = resolution.IsFallback ? resolution.FallbackReason : resolution.ResolutionReason,
        });

        return attempts;
    }

    private static void CompleteLastSendAttempt(
        List<LlmProviderAttempt> attempts,
        int statusCode,
        long durationMs,
        string? error)
    {
        var attempt = attempts.LastOrDefault(x => string.Equals(x.Stage, "send", StringComparison.OrdinalIgnoreCase))
                      ?? attempts.LastOrDefault();
        if (attempt is null)
            return;

        attempt.StatusCode = statusCode;
        attempt.DurationMs = durationMs;
        attempt.EndedAt = DateTime.UtcNow;
        attempt.Error = string.IsNullOrWhiteSpace(error) ? null : error;
        attempt.Status = statusCode >= 200 && statusCode < 300 ? "succeeded" : "failed";
        if (!string.IsNullOrWhiteSpace(error))
            attempt.Reason = error;
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

    internal static bool TryValidateAppCaller(string appCallerCode, string modelType, out string error)
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

        if (code.Length > 200)
        {
            error = "appCallerCode 不能超过 200 个字符";
            return false;
        }

        var separatorIndex = code.IndexOf("::", StringComparison.Ordinal);
        if (separatorIndex <= 0
            || separatorIndex != code.LastIndexOf("::", StringComparison.Ordinal)
            || separatorIndex + 2 >= code.Length)
        {
            error = "appCallerCode 必须使用 {app-key}.{feature}::{model-type} 格式";
            return false;
        }

        var path = code[..separatorIndex];
        var declaredType = code[(separatorIndex + 2)..];
        var segments = path.Split('.', StringSplitOptions.None);
        if (segments.Length < 2
            || segments.Any(segment => !IsKebabCaseSegment(segment))
            || !IsKebabCaseSegment(declaredType))
        {
            error = "appCallerCode 各段必须使用小写字母、数字和连字符";
            return false;
        }

        if (!string.Equals(declaredType, type, StringComparison.OrdinalIgnoreCase))
        {
            error = $"appCallerCode 与 modelType 不匹配: {code} -> {type}";
            return false;
        }

        var def = AppCallerRegistrationService.FindByAppCode(code);
        if (def != null
            && (def.ModelTypes == null || !def.ModelTypes.Contains(type, StringComparer.OrdinalIgnoreCase)))
        {
            error = $"appCallerCode 与 modelType 不匹配: {code} -> {type}";
            return false;
        }

        error = string.Empty;
        return true;
    }

    private static bool IsKebabCaseSegment(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value[0] is < 'a' or > 'z')
            return false;

        return value.All(ch => ch is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');
    }

    #endregion
}
