using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 跨进程 LLM 客户端 —— HttpLlmGatewayClient.CreateClient 的返回实现。
/// 把 ILLMClient 的流式生成转成对 serving 端 /gw/v1/client-stream 的 SSE 调用，
/// 每个 "data: " 行是一个 LLMStreamChunk JSON。
///
/// 物理隔离设计见 doc/design.llm-gateway-physical-isolation.md。
/// </summary>
public sealed class HttpLlmClient : PrdAgent.Core.Interfaces.ILLMClient
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly string _baseUrl;
    private readonly string _gatewayKey;
    private readonly string _appCallerCode;
    private readonly string _modelType;
    private readonly int _maxTokens;
    private readonly double _temperature;
    private readonly bool _includeThinking;
    private readonly string? _expectedModel;
    private readonly JsonSerializerOptions _jsonOpts;
    private readonly ILogger _logger;
    private readonly ILLMRequestContextAccessor? _ctxAccessor;

    public HttpLlmClient(
        IHttpClientFactory httpFactory,
        string baseUrl,
        string gatewayKey,
        string appCallerCode,
        string modelType,
        int maxTokens,
        double temperature,
        bool includeThinking,
        string? expectedModel,
        JsonSerializerOptions jsonOpts,
        ILogger logger,
        ILLMRequestContextAccessor? ctxAccessor = null)
    {
        _httpFactory = httpFactory;
        _baseUrl = baseUrl;
        _gatewayKey = gatewayKey;
        _appCallerCode = appCallerCode;
        _modelType = modelType;
        _maxTokens = maxTokens;
        _temperature = temperature;
        _includeThinking = includeThinking;
        _expectedModel = expectedModel;
        _jsonOpts = jsonOpts;
        _logger = logger;
        _ctxAccessor = ctxAccessor;
    }

    public string Provider => "gateway-http";

    public IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        CancellationToken cancellationToken = default)
        => StreamGenerateAsync(systemPrompt, messages, enablePromptCache: false, cancellationToken);

    public async IAsyncEnumerable<LLMStreamChunk> StreamGenerateAsync(
        string systemPrompt,
        List<LLMMessage> messages,
        bool enablePromptCache,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // 把当前 LlmRequestContext 透传给 serving 端（RequestId/SessionId/GroupId/UserId/角色/文档元数据），
        // 否则跨 HTTP 后 serving 端日志关联与用户归属全断。敏感字段（密钥）本就不在 GatewayRequestContext 内。
        var current = _ctxAccessor?.Current;
        var context = current == null ? null : new GatewayRequestContext
        {
            RequestId = current.RequestId,
            GroupId = current.GroupId,
            SessionId = current.SessionId,
            UserId = current.UserId,
            ViewRole = current.ViewRole,
            DocumentChars = current.DocumentChars,
            DocumentHash = current.DocumentHash,
        };

        var payload = new
        {
            AppCallerCode = _appCallerCode,
            ModelType = _modelType,
            MaxTokens = _maxTokens,
            Temperature = _temperature,
            IncludeThinking = _includeThinking,
            ExpectedModel = _expectedModel,
            SystemPrompt = systemPrompt,
            Messages = messages,
            EnablePromptCache = enablePromptCache,
            Context = context,
        };

        var http = _httpFactory.CreateClient();
        http.Timeout = Timeout.InfiniteTimeSpan;
        HttpResponseMessage? resp = null;
        Stream? stream = null;
        StreamReader? reader = null;
        string? earlyError = null;
        try
        {
            using var reqMsg = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/gw/v1/client-stream")
            {
                Content = new StringContent(JsonSerializer.Serialize(payload, _jsonOpts), Encoding.UTF8, "application/json"),
            };
            reqMsg.Headers.Add("X-Gateway-Key", _gatewayKey);

            resp = await http.SendAsync(reqMsg, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!resp.IsSuccessStatusCode)
            {
                var body = await resp.Content.ReadAsStringAsync(cancellationToken);
                earlyError = $"serving 返回 {(int)resp.StatusCode}: {(body.Length <= 500 ? body : body.Substring(0, 500))}";
            }
            else
            {
                stream = await resp.Content.ReadAsStreamAsync(cancellationToken);
                reader = new StreamReader(stream, Encoding.UTF8);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[HttpLlmClient] client-stream 连接失败 base={Base}", _baseUrl);
            earlyError = ex.Message;
        }

        if (earlyError != null)
        {
            reader?.Dispose();
            stream?.Dispose();
            resp?.Dispose();
            http.Dispose();
            yield return new LLMStreamChunk { Type = "error", ErrorMessage = earlyError };
            yield break;
        }

        try
        {
            var sse = new SseEventReader(reader!);
            await foreach (var data in sse.ReadEventsAsync(cancellationToken))
            {
                LLMStreamChunk? chunk;
                try
                {
                    chunk = JsonSerializer.Deserialize<LLMStreamChunk>(data, _jsonOpts);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[HttpLlmClient] 流块反序列化失败，跳过");
                    continue;
                }
                if (chunk != null)
                    yield return chunk;
            }
        }
        finally
        {
            reader?.Dispose();
            stream?.Dispose();
            resp?.Dispose();
            http.Dispose();
        }
    }
}
