using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
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
    private readonly PrdAgent.Core.Interfaces.ILLMRequestContextAccessor? _ctxAccessor;
    private readonly IAssetStorage? _assetStorage;
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
        ILogger<HttpLlmGatewayClient> logger,
        PrdAgent.Core.Interfaces.ILLMRequestContextAccessor? ctxAccessor = null,
        IAssetStorage? assetStorage = null)
    {
        _httpFactory = httpFactory;
        _logger = logger;
        _ctxAccessor = ctxAccessor;
        _assetStorage = assetStorage;
        // serving 服务的根地址（如 http://llmgw-serve:8091），去掉尾部斜杠避免拼接出双斜杠。
        _baseUrl = (config["LlmGateway:ServeBaseUrl"] ?? "http://llmgw-serve:8091").TrimEnd('/');
        // 共享密钥门（内部 M2M），与 serving 端 LlmGwServe:ApiKey 对齐。
        // 不回退到众所周知的占位 key：http 模式未显式配 LlmGwServe:ApiKey 时用空串，让 X-Gateway-Key 门
        // 直接 401 响亮失败，而非用可预测的共享密钥静默通过、削弱本 PR 新增的密钥门（Cursor Bugbot）。
        _gatewayKey = config["LlmGwServe:ApiKey"] ?? string.Empty;
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

    /// <summary>
    /// S2 观测：返回一份把 Context.GatewayTransport 打成 "http" 的请求副本（其余字段原样拷贝）。
    /// serving 端据此把该条日志标为 http 传输（跨进程），区分于本地 inproc。
    /// </summary>
    private static GatewayRequest TagHttpTransport(GatewayRequest request)
        => new()
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = request.ModelType,
            ExpectedModel = request.ExpectedModel,
            PinnedPlatformId = request.PinnedPlatformId,
            PinnedModelId = request.PinnedModelId,
            RequestBody = request.RequestBody,
            RequestBodyRaw = request.RequestBodyRaw,
            Stream = request.Stream,
            EnablePromptCache = request.EnablePromptCache,
            TimeoutSeconds = request.TimeoutSeconds,
            IncludeThinking = request.IncludeThinking,
            Context = GatewayRequestContext.WithTransport(request.Context, GatewayTransports.Http),
        };

    public async Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
    {
        request = TagHttpTransport(request);
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
        request = TagHttpTransport(request);
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
        // compute-then-send（见 .claude/rules/compute-then-send.md）：调用方已锁定 resolution，
        // serving 端 /gw/v1/raw 会基于 ExpectedModel 重 Resolve（仅在服务端 rehydrate ApiKey）。
        //   - 若调用方的解析本身失败：直接短路返回，绝不让 serving 重新选一个"能用的"模型（防"选 A 给 B"）。
        //   - 否则：把 request.ExpectedModel 锁定为 resolution.ActualModel，serving 的重 Resolve 被 expectedModel
        //     锁回同一个模型，与本仓既有 expectedModel-honoring 解析一致。ApiKey 等敏感字段绝不随 request 过线。
        if (!resolution.Success)
        {
            return GatewayRawResponse.Fail(
                "RESOLUTION_FAILED",
                resolution.ErrorMessage ?? "调用方 resolution 已失败，http 模式不得重新选模型");
        }

        var multipartFileRefs = request.MultipartFileRefs;
        var hasInlineMultipartFiles = request.IsMultipart
            && request.MultipartFiles is { Count: > 0 }
            && (request.MultipartFileRefs is null || request.MultipartFileRefs.Count == 0);
        if (hasInlineMultipartFiles)
        {
            if (_assetStorage == null)
            {
                return GatewayRawResponse.Fail(
                    "MULTIPART_STORAGE_UNAVAILABLE",
                    "http 模式需要 IAssetStorage 将 multipart 文件转换为 MultipartFileRefs 后跨进程发送，但当前服务未注册对象存储。",
                    500);
            }

            try
            {
                multipartFileRefs = await UploadMultipartFileRefsAsync(request.MultipartFiles!, _assetStorage, ct);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[HttpLlmGatewayClient] multipart 文件上传对象存储失败 base={Base}", _baseUrl);
                return GatewayRawResponse.Fail("MULTIPART_UPLOAD_FAILED", ex.Message, 500);
            }
        }

        // S2 观测：把 Context.GatewayTransport 打成 "http"（跨进程 raw），serving 端据此标注日志传输通道。
        // 无论是否锁定 ExpectedModel 都重建一份副本以打标记；ActualModel 非空时同时锁定 ExpectedModel。
        var httpTaggedContext = GatewayRequestContext.WithTransport(request.Context, GatewayTransports.Http);
        // GatewayRawRequest 是普通类（init-only 属性，非 record），用对象初始化器建副本。
        var outboundRequest = new GatewayRawRequest
        {
            AppCallerCode = request.AppCallerCode,
            ModelType = request.ModelType,
            EndpointPath = request.EndpointPath,
            ExpectedModel = string.IsNullOrWhiteSpace(resolution.ActualModel) ? request.ExpectedModel : resolution.ActualModel,
            PinnedPlatformId = request.PinnedPlatformId,
            PinnedModelId = request.PinnedModelId,
            RequestBody = request.RequestBody,
            IsMultipart = request.IsMultipart,
            MultipartFields = request.MultipartFields,
            MultipartFiles = null,
            MultipartFileRefs = multipartFileRefs,
            HttpMethod = request.HttpMethod,
            ExtraHeaders = request.ExtraHeaders,
            TimeoutSeconds = request.TimeoutSeconds,
            ExpectBinaryResponse = request.ExpectBinaryResponse,
            Context = httpTaggedContext,
        };

        try
        {
            using var http = CreateHttp(infiniteTimeout: false);
            using var resp = await http.PostAsync($"{_baseUrl}/gw/v1/raw", JsonBody(outboundRequest), ct);
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

    public async Task<GatewayRawResponse> TestUpstreamProfileAsync(
        GatewayUpstreamProfileTestRequest request,
        CancellationToken ct = default)
    {
        try
        {
            using var http = CreateHttp(infiniteTimeout: false);
            using var resp = await http.PostAsync($"{_baseUrl}/gw/v1/profile-test", JsonBody(request), ct);
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
            _logger.LogError(ex, "[HttpLlmGatewayClient] TestUpstreamProfileAsync 失败 base={Base}", _baseUrl);
            return GatewayRawResponse.Fail("GATEWAY_HTTP_ERROR", ex.Message);
        }
    }

    private static async Task<Dictionary<string, MultipartFileRef>> UploadMultipartFileRefsAsync(
        Dictionary<string, (string FileName, byte[] Content, string MimeType)> files,
        IAssetStorage storage,
        CancellationToken ct)
    {
        var refs = new Dictionary<string, MultipartFileRef>(StringComparer.Ordinal);
        var requestSegment = Guid.NewGuid().ToString("N");
        foreach (var (fieldName, fileInfo) in files)
        {
            var safeField = SafeKeySegment(fieldName, "file");
            var safeFileName = SafeFileName(fileInfo.FileName, $"{safeField}.bin");
            var ext = SafeExtension(Path.GetExtension(safeFileName));
            var sha256 = Sha256Hex(fileInfo.Content);
            var key = $"llmgw/multipart/{DateTime.UtcNow:yyyyMMdd}/{requestSegment}/{safeField}-{sha256[..16]}{ext}";

            await storage.UploadToKeyAsync(key, fileInfo.Content, fileInfo.MimeType, ct, "private, max-age=3600");

            refs[fieldName] = new MultipartFileRef
            {
                RefKey = key,
                FileName = safeFileName,
                MimeType = string.IsNullOrWhiteSpace(fileInfo.MimeType) ? "application/octet-stream" : fileInfo.MimeType,
                SizeBytes = fileInfo.Content.LongLength,
                Sha256 = sha256,
                Url = storage.BuildUrlForKey(key),
            };
        }

        return refs;
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(bytes)).ToLowerInvariant();
    }

    private static string SafeFileName(string? fileName, string fallback)
    {
        var name = Path.GetFileName((fileName ?? string.Empty).Trim());
        return string.IsNullOrWhiteSpace(name) ? fallback : name;
    }

    private static string SafeExtension(string? ext)
    {
        var e = (ext ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(e)) return ".bin";
        if (!e.StartsWith('.')) e = "." + e;
        return e.Length <= 16 && e.Skip(1).All(ch => char.IsLetterOrDigit(ch)) ? e : ".bin";
    }

    private static string SafeKeySegment(string? value, string fallback)
    {
        var raw = (value ?? string.Empty).Trim().ToLowerInvariant();
        var sb = new StringBuilder(raw.Length);
        foreach (var ch in raw)
        {
            sb.Append(char.IsLetterOrDigit(ch) ? ch : '-');
        }

        var cleaned = sb.ToString().Trim('-');
        while (cleaned.Contains("--", StringComparison.Ordinal))
        {
            cleaned = cleaned.Replace("--", "-", StringComparison.Ordinal);
        }

        return string.IsNullOrWhiteSpace(cleaned) ? fallback : cleaned;
    }

    public async Task<GatewayModelResolution> ResolveModelAsync(
        string appCallerCode,
        string modelType,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null,
        CancellationToken ct = default)
    {
        // 注意：ApiKey 在 HTTP 模式下恒为 null（serving 端 [JsonIgnore] 不序列化敏感字段）。
        // 这是预期行为——此解析结果仅供调用方做元信息展示，真正发送时由网关在 send/raw 重新解析。
        try
        {
            using var http = CreateHttp(infiniteTimeout: false);
            var dto = new
            {
                AppCallerCode = appCallerCode,
                ModelType = modelType,
                ExpectedModel = expectedModel,
                PinnedPlatformId = pinnedPlatformId,
                PinnedModelId = pinnedModelId
            };
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
                // serving 不可达 / 鉴权失败 / 坏负载 不能伪装成「空池」——否则 admin/smoke 看到「无可用池」
                // 却分不清网关其实是 down 的（Cursor Bugbot）。与 inproc 实现一致：错误向上抛，让调用方区分
                // 「真的没池」(200 + []) 与「网关故障」。
                _logger.LogWarning("[HttpLlmGatewayClient] GetAvailablePoolsAsync serving 返回 {Code}: {Body}",
                    (int)resp.StatusCode, Truncate(body));
                throw new InvalidOperationException(
                    $"serving /gw/v1/pools 返回 {(int)resp.StatusCode}: {Truncate(body)}");
            }
            var result = JsonSerializer.Deserialize<List<AvailableModelPool>>(body, JsonOpts);
            // 200 + 空数组 = 真的没可用池（合法），照常返回空；只有上面的非成功/异常才视为故障。
            return result ?? new List<AvailableModelPool>();
        }
        catch (Exception ex)
        {
            // 传输异常（连不上 serving / 超时 / 反序列化失败）同样向上抛，不静默吞成空池。
            _logger.LogError(ex, "[HttpLlmGatewayClient] GetAvailablePoolsAsync 失败 base={Base}", _baseUrl);
            throw;
        }
    }

    public Core.Interfaces.ILLMClient CreateClient(
        string appCallerCode,
        string modelType,
        int maxTokens = 4096,
        double temperature = 0.2,
        bool includeThinking = false,
        string? expectedModel = null,
        string? pinnedPlatformId = null,
        string? pinnedModelId = null)
    {
        return new HttpLlmClient(
            _httpFactory, _baseUrl, _gatewayKey,
            appCallerCode, modelType, maxTokens, temperature, includeThinking, expectedModel, pinnedPlatformId, pinnedModelId,
            JsonOpts, _logger, _ctxAccessor);
    }

    private static string Truncate(string? s, int max = 500)
        => string.IsNullOrEmpty(s) ? string.Empty : (s.Length <= max ? s : s.Substring(0, max));
}
