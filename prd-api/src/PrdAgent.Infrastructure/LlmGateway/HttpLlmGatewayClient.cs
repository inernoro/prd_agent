using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using CoreGateway = PrdAgent.Core.Interfaces.LlmGateway;

namespace PrdAgent.Infrastructure.LlmGateway;

/// <summary>
/// 跨进程 LLM Gateway 客户端 —— 把 MAP 自身的 LLM 调用从进程内（直接 new LlmGateway）
/// 切换到 HTTP，远程调用独立部署的 PrdAgent.LlmGateway serving 服务（/gw/v1/*）。
///
/// 物理隔离设计见 doc/design.llm-gateway-physical-isolation.md。
/// 仅当配置 LlmGateway:Mode=http（环境变量 LlmGateway__Mode=http）时由 DI 注册，默认走进程内 LlmGateway。
///
/// 同时实现 Infrastructure 与 Core 两个 ILlmGateway 接口（两者仅命名空间不同；
/// CreateClient 签名完全一致，单一实现满足两者），与进程内 LlmGateway 保持一致，
/// 这样 Core 桥接注册（强转 Infrastructure → Core）在 http 模式下仍成立。
///
/// JSON 口径与 serving 端严格对齐：PascalCase（PropertyNamingPolicy = null）。
/// </summary>
public sealed class HttpLlmGatewayClient
    : PrdAgent.Infrastructure.LlmGateway.ILlmGateway, CoreGateway.ILlmGateway
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<HttpLlmGatewayClient> _logger;
    private readonly string _baseUrl;
    private readonly string _gatewayKey;

    /// <summary>
    /// 与 serving 端一致的序列化口径：PascalCase + 不写 null 字段。
    /// </summary>
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public HttpLlmGatewayClient(
        IHttpClientFactory httpFactory,
        IConfiguration config,
        ILogger<HttpLlmGatewayClient> logger)
    {
        _httpFactory = httpFactory;
        _logger = logger;
        // serving 服务的根地址（如 http://llmgw-serve:8091），去掉尾部斜杠避免拼接出双斜杠。
        _baseUrl = (config["LlmGateway:ServeBaseUrl"] ?? "http://llmgw-serve:8091").TrimEnd('/');
        // 共享密钥门（内部 M2M），与 serving 端 LlmGwServe:ApiKey 对齐。
        _gatewayKey = config["LlmGwServe:ApiKey"] ?? "dev-llmgw-serve-key";
    }

    private HttpClient CreateHttp(bool infiniteTimeout)
    {
        var http = _httpFactory.CreateClient();
        http.Timeout = infiniteTimeout ? Timeout.InfiniteTimeSpan : TimeSpan.FromMinutes(10);
        http.DefaultRequestHeaders.Remove("X-Gateway-Key");
        http.DefaultRequestHeaders.Add("X-Gateway-Key", _gatewayKey);
        return http;
    }

    private static StringContent JsonBody<T>(T value)
        => new(JsonSerializer.Serialize(value, JsonOpts), Encoding.UTF8, "application/json");

    public async Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
    {
        try
        {
            using var http = CreateHttp(infiniteTimeout: false);
            using var resp = await http.PostAsync($"{_baseUrl}/gw/v1/send", JsonBody(request), ct);
            var body = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
            {
                return GatewayResponse.Fail("GATEWAY_HTTP_ERROR",
                    $"serving 返回 {(int)resp.StatusCode}: {Truncate(body)}", (int)resp.StatusCode);
            }
            var result = JsonSerializer.Deserialize<GatewayResponse>(body, JsonOpts);
            return result ?? GatewayResponse.Fail("GATEWAY_HTTP_ERROR", "serving 响应反序列化为空");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[HttpLlmGatewayClient] SendAsync 失败 base={Base}", _baseUrl);
            return GatewayResponse.Fail("GATEWAY_HTTP_ERROR", ex.Message);
        }
    }

    public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
        GatewayRequest request,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        HttpClient http = CreateHttp(infiniteTimeout: true);
        HttpResponseMessage? resp = null;
        Stream? stream = null;
        StreamReader? reader = null;
        string? earlyError = null;
        try
        {
            using var reqMsg = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/gw/v1/stream")
            {
                Content = JsonBody(request),
            };
            reqMsg.Headers.Remove("X-Gateway-Key");
            reqMsg.Headers.Add("X-Gateway-Key", _gatewayKey);

            resp = await http.SendAsync(reqMsg, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!resp.IsSuccessStatusCode)
            {
                var body = await resp.Content.ReadAsStringAsync(ct);
                earlyError = $"serving 返回 {(int)resp.StatusCode}: {Truncate(body)}";
            }
            else
            {
                stream = await resp.Content.ReadAsStreamAsync(ct);
                reader = new StreamReader(stream, Encoding.UTF8);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[HttpLlmGatewayClient] StreamAsync 连接失败 base={Base}", _baseUrl);
            earlyError = ex.Message;
        }

        if (earlyError != null)
        {
            reader?.Dispose();
            stream?.Dispose();
            resp?.Dispose();
            http.Dispose();
            yield return GatewayStreamChunk.Fail(earlyError);
            yield break;
        }

        // 逐行读取 SSE，遇到 "data: " 行反序列化为 GatewayStreamChunk。
        // 复用项目内 SseEventReader 的语义：每个 data 行是完整 JSON，[DONE] 终止。
        try
        {
            var sse = new SseEventReader(reader!);
            await foreach (var data in sse.ReadEventsAsync(ct))
            {
                GatewayStreamChunk? chunk;
                try
                {
                    chunk = JsonSerializer.Deserialize<GatewayStreamChunk>(data, JsonOpts);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[HttpLlmGatewayClient] 流块反序列化失败，跳过");
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

    public async Task<GatewayRawResponse> SendRawWithResolutionAsync(
        GatewayRawRequest request,
        GatewayModelResolution resolution,
        CancellationToken ct = default)
    {
        // 注意：resolution 参数刻意不发送给 serving 端。serving 端会在 /gw/v1/raw 内部
        // 重新 Resolve（含 ApiKey 解密），把敏感凭据牢牢留在网关进程内，绝不跨 HTTP 边界回传。
        // 这里保留该参数只为满足接口签名 + compute-then-send 语义对齐进程内实现。
        try
        {
            using var http = CreateHttp(infiniteTimeout: false);
            using var resp = await http.PostAsync($"{_baseUrl}/gw/v1/raw", JsonBody(request), ct);
            var body = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
            {
                return GatewayRawResponse.Fail("GATEWAY_HTTP_ERROR",
                    $"serving 返回 {(int)resp.StatusCode}: {Truncate(body)}", (int)resp.StatusCode);
            }
            var result = JsonSerializer.Deserialize<GatewayRawResponse>(body, JsonOpts);
            return result ?? GatewayRawResponse.Fail("GATEWAY_HTTP_ERROR", "serving 响应反序列化为空");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[HttpLlmGatewayClient] SendRawWithResolutionAsync 失败 base={Base}", _baseUrl);
            return GatewayRawResponse.Fail("GATEWAY_HTTP_ERROR", ex.Message);
        }
    }

    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        CancellationToken ct = default)
    {
        // 注意：ApiKey 在 HTTP 模式下恒为 null（serving 端 [JsonIgnore] 不序列化敏感字段）。
        // 这是预期行为——此解析结果仅供调用方做元信息展示，真正发送时由网关在 send/raw 重新解析。
        try
        {
            using var http = CreateHttp(infiniteTimeout: false);
            var dto = new { AppCallerCode = appCallerCode, ModelType = modelType, ExpectedModel = expectedModel };
            using var resp = await http.PostAsync($"{_baseUrl}/gw/v1/resolve", JsonBody(dto), ct);
            var body = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
            {
                return new GatewayModelResolution
                {
                    Success = false,
                    ErrorMessage = $"serving 返回 {(int)resp.StatusCode}: {Truncate(body)}",
                };
            }
            var result = JsonSerializer.Deserialize<GatewayModelResolution>(body, JsonOpts);
            return result ?? new GatewayModelResolution { Success = false, ErrorMessage = "serving 响应反序列化为空" };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[HttpLlmGatewayClient] ResolveModelAsync 失败 base={Base}", _baseUrl);
            return new GatewayModelResolution { Success = false, ErrorMessage = ex.Message };
        }
    }

    public async Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
        string appCallerCode,
        string modelType,
        CancellationToken ct = default)
    {
        try
        {
            using var http = CreateHttp(infiniteTimeout: false);
            var url = $"{_baseUrl}/gw/v1/pools?appCallerCode={Uri.EscapeDataString(appCallerCode)}&modelType={Uri.EscapeDataString(modelType)}";
            using var resp = await http.GetAsync(url, ct);
            var body = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("[HttpLlmGatewayClient] GetAvailablePoolsAsync serving 返回 {Code}: {Body}",
                    (int)resp.StatusCode, Truncate(body));
                return new List<AvailableModelPool>();
            }
            var result = JsonSerializer.Deserialize<List<AvailableModelPool>>(body, JsonOpts);
            return result ?? new List<AvailableModelPool>();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[HttpLlmGatewayClient] GetAvailablePoolsAsync 失败 base={Base}", _baseUrl);
            return new List<AvailableModelPool>();
        }
    }

    public Core.Interfaces.ILLMClient CreateClient(
        string appCallerCode,
        string modelType,
        int maxTokens = 4096,
        double temperature = 0.2,
        bool includeThinking = false,
        string? expectedModel = null)
    {
        return new HttpLlmClient(
            _httpFactory, _baseUrl, _gatewayKey,
            appCallerCode, modelType, maxTokens, temperature, includeThinking, expectedModel,
            JsonOpts, _logger);
    }

    private static string Truncate(string? s, int max = 500)
        => string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s.Substring(0, max));
}
