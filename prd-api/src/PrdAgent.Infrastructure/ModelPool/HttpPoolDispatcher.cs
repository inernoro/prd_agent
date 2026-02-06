using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Adapters;
using PrdAgent.Infrastructure.ModelPool.Models;

namespace PrdAgent.Infrastructure.ModelPool;

/// <summary>
/// HTTP 模型池请求执行器
/// 使用现有的 IGatewayAdapter 来处理不同平台的请求格式
/// </summary>
public class HttpPoolDispatcher : IPoolHttpDispatcher
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly Dictionary<string, IGatewayAdapter> _adapters;
    private readonly ILogger? _logger;

    public HttpPoolDispatcher(
        IHttpClientFactory httpClientFactory,
        IEnumerable<IGatewayAdapter>? adapters = null,
        ILogger? logger = null)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;

        _adapters = new Dictionary<string, IGatewayAdapter>(StringComparer.OrdinalIgnoreCase);
        if (adapters != null)
        {
            foreach (var adapter in adapters)
                _adapters[adapter.PlatformType] = adapter;
        }
        else
        {
            // 注册默认适配器
            var openai = new OpenAIGatewayAdapter();
            var claude = new ClaudeGatewayAdapter();
            _adapters[openai.PlatformType] = openai;
            _adapters[claude.PlatformType] = claude;
        }
    }

    public async Task<PoolHttpResult> SendAsync(PoolEndpoint endpoint, PoolRequest request, CancellationToken ct = default)
    {
        var startedAt = DateTime.UtcNow;

        try
        {
            var adapter = GetAdapter(endpoint.PlatformType);
            var requestBody = CloneRequestBody(request.RequestBody);
            requestBody["model"] = endpoint.ModelId;
            requestBody["stream"] = false;

            // 应用端点级覆盖
            if (endpoint.MaxTokens.HasValue)
                requestBody["max_tokens"] = endpoint.MaxTokens.Value;

            var endpointUrl = adapter.BuildEndpoint(endpoint.ApiUrl, request.ModelType);
            var httpRequest = adapter.BuildHttpRequest(
                endpointUrl, endpoint.ApiKey, requestBody,
                endpoint.EnablePromptCache ?? request.EnablePromptCache);

            var httpClient = _httpClientFactory.CreateClient();
            httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

            var response = await httpClient.SendAsync(httpRequest, ct);
            var responseBody = await response.Content.ReadAsStringAsync(ct);
            var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;

            if (!response.IsSuccessStatusCode)
            {
                var errorMsg = TryExtractErrorMessage(responseBody) ?? $"HTTP {(int)response.StatusCode}";
                return PoolHttpResult.Fail(errorMsg, (int)response.StatusCode, latencyMs);
            }

            var tokenUsage = adapter.ParseTokenUsage(responseBody);
            return new PoolHttpResult
            {
                IsSuccess = true,
                StatusCode = (int)response.StatusCode,
                ResponseBody = responseBody,
                LatencyMs = latencyMs,
                TokenUsage = tokenUsage != null ? new PoolTokenUsage
                {
                    InputTokens = tokenUsage.InputTokens,
                    OutputTokens = tokenUsage.OutputTokens,
                    CacheCreationInputTokens = tokenUsage.CacheCreationInputTokens,
                    CacheReadInputTokens = tokenUsage.CacheReadInputTokens,
                    Source = tokenUsage.Source
                } : null
            };
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (TaskCanceledException)
        {
            var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
            return PoolHttpResult.Fail("请求超时", 408, latencyMs);
        }
        catch (Exception ex)
        {
            var latencyMs = (long)(DateTime.UtcNow - startedAt).TotalMilliseconds;
            return PoolHttpResult.Fail(ex.Message, 500, latencyMs);
        }
    }

    public async IAsyncEnumerable<PoolStreamChunk> SendStreamAsync(
        PoolEndpoint endpoint,
        PoolRequest request,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var adapter = GetAdapter(endpoint.PlatformType);
        var requestBody = CloneRequestBody(request.RequestBody);
        requestBody["model"] = endpoint.ModelId;
        requestBody["stream"] = true;

        if (endpoint.MaxTokens.HasValue)
            requestBody["max_tokens"] = endpoint.MaxTokens.Value;

        var endpointUrl = adapter.BuildEndpoint(endpoint.ApiUrl, request.ModelType);
        var httpRequest = adapter.BuildHttpRequest(
            endpointUrl, endpoint.ApiKey, requestBody,
            endpoint.EnablePromptCache ?? request.EnablePromptCache);

        var httpClient = _httpClientFactory.CreateClient();
        httpClient.Timeout = TimeSpan.FromSeconds(request.TimeoutSeconds);

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (Exception ex)
        {
            yield return PoolStreamChunk.Fail(ex.Message);
            yield break;
        }

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct);
            var errorMsg = TryExtractErrorMessage(errorBody) ?? $"HTTP {(int)response.StatusCode}";
            yield return PoolStreamChunk.Fail(errorMsg);
            yield break;
        }

        using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);

        while (!reader.EndOfStream)
        {
            var line = await reader.ReadLineAsync(ct);
            if (string.IsNullOrEmpty(line)) continue;
            if (!line.StartsWith("data:")) continue;

            var data = line.Substring(5).Trim();
            if (data == "[DONE]") break;

            var chunk = adapter.ParseStreamChunk(data);
            if (chunk == null) continue;

            // 转换 GatewayStreamChunk 到 PoolStreamChunk
            if (!string.IsNullOrEmpty(chunk.Content))
                yield return PoolStreamChunk.Text(chunk.Content);

            if (!string.IsNullOrEmpty(chunk.FinishReason))
            {
                var tokenUsage = chunk.TokenUsage != null ? new PoolTokenUsage
                {
                    InputTokens = chunk.TokenUsage.InputTokens,
                    OutputTokens = chunk.TokenUsage.OutputTokens,
                    CacheCreationInputTokens = chunk.TokenUsage.CacheCreationInputTokens,
                    CacheReadInputTokens = chunk.TokenUsage.CacheReadInputTokens,
                    Source = chunk.TokenUsage.Source
                } : null;

                yield return PoolStreamChunk.Done(chunk.FinishReason, tokenUsage);
            }
        }
    }

    private IGatewayAdapter GetAdapter(string? platformType)
    {
        if (!string.IsNullOrWhiteSpace(platformType) && _adapters.TryGetValue(platformType, out var adapter))
            return adapter;

        return _adapters.GetValueOrDefault("openai")
            ?? throw new InvalidOperationException("No OpenAI adapter registered");
    }

    private static JsonObject CloneRequestBody(JsonObject source)
    {
        var json = source.ToJsonString();
        return JsonNode.Parse(json)?.AsObject() ?? new JsonObject();
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
        catch { }
        return null;
    }
}
