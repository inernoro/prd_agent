using System.Net.Http.Headers;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.LLM;

/// <summary>
/// OpenAI 兼容 Images API 客户端（/v1/images/generations）
/// - 不依赖 ILLMClient（避免影响现有文本流式实现）
/// - 仅用于“生图模型”（IsImageGen）
/// </summary>
public class OpenAIImageClient
{
    private readonly MongoDbContext _db;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<OpenAIImageClient> _logger;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly ILLMRequestContextAccessor? _ctxAccessor;

    public OpenAIImageClient(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<OpenAIImageClient> logger,
        ILlmRequestLogWriter? logWriter = null,
        ILLMRequestContextAccessor? ctxAccessor = null)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
        _logWriter = logWriter;
        _ctxAccessor = ctxAccessor;
    }

    public async Task<ApiResponse<ImageGenResult>> GenerateAsync(
        string prompt,
        int n,
        string? size,
        string? responseFormat,
        CancellationToken ct,
        string? modelId = null,
        string? platformId = null,
        string? modelName = null)
    {
        if (string.IsNullOrWhiteSpace(prompt))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空");
        }

        if (n <= 0) n = 1;
        if (n > 20) n = 20;

        // 日志上下文：若上游未设置 scope，则使用默认值兜底（仍保证“任何生图调用都有日志”）
        var ctx = _ctxAccessor?.Current;
        var requestId = (ctx?.RequestId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestId)) requestId = Guid.NewGuid().ToString("N");
        var startedAt = DateTime.UtcNow;
        string? logId = null;

        // 选择生图模型（支持按请求指定；支持“平台回退调用”）
        var requestedModelId = (modelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestedModelId)) requestedModelId = null;
        var requestedPlatformId = (platformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestedPlatformId)) requestedPlatformId = null;
        var requestedModelName = (modelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestedModelName)) requestedModelName = null;

        LLMModel? model = null;
        LLMPlatform? platform = null;
        if (!string.IsNullOrWhiteSpace(requestedModelId))
        {
            // 1) 优先：按“已配置模型 id”命中
            model = await _db.LLMModels.Find(m => m.Id == requestedModelId && m.Enabled).FirstOrDefaultAsync(ct);

            // 2) 回退：如果没命中配置模型，允许把 modelId 当成“模型名”，并通过 platformId 解析平台配置
            if (model == null && !string.IsNullOrWhiteSpace(requestedPlatformId))
            {
                platform = await _db.LLMPlatforms.Find(p => p.Id == requestedPlatformId && p.Enabled).FirstOrDefaultAsync(ct);
                if (platform == null)
                {
                    return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "指定的平台不存在或未启用");
                }
                requestedModelName ??= requestedModelId; // modelId 兜底当作 modelName
            }
            else if (model == null)
            {
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "指定的模型不存在或未启用");
            }
        }
        else
        {
            model = await _db.LLMModels.Find(m => m.IsImageGen && m.Enabled).FirstOrDefaultAsync(ct);
        }
        if (model == null && platform == null)
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "未配置可用的生图模型（请在模型管理中设置“生图”）");
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        string? apiUrl;
        string? apiKey;
        string? platformType;
        string effectiveModelName;
        if (model != null)
        {
            var cfg = await ResolveApiConfigForModelAsync(model, jwtSecret, ct);
            apiUrl = cfg.apiUrl;
            apiKey = cfg.apiKey;
            platformType = cfg.platformType;
            effectiveModelName = model.ModelName;
        }
        else
        {
            // 平台回退调用：直接用平台 API 配置 + 指定 modelName
            apiUrl = platform!.ApiUrl;
            apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted) ? null : DecryptApiKey(platform.ApiKeyEncrypted, jwtSecret);
            platformType = platform.PlatformType?.ToLowerInvariant();
            effectiveModelName = requestedModelName ?? string.Empty;
            if (string.IsNullOrWhiteSpace(effectiveModelName))
            {
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "未提供 modelName（平台回退调用需要 modelName）");
            }
        }

        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图模型 API 配置不完整");
        }

        // Anthropic 不支持 images endpoint；避免误配后 500
        if (string.Equals(platformType, "anthropic", StringComparison.OrdinalIgnoreCase) ||
            apiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图模型不支持 Anthropic 平台（请配置 OpenAI 兼容的 images API）");
        }

        var isVolces = IsVolcesImagesApi(apiUrl);
        var endpoint = GetImagesEndpoint(apiUrl);
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图模型 API URL 无效");
        }

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        // 生图请求通常比文本推理慢很多（部分平台可达 60s+），因此单独放大超时。
        // 默认 600s，可通过配置 LLM:ImageGenTimeoutSeconds 覆盖；不影响文本/意图等默认 60s。
        var imageGenTimeoutSeconds = _config.GetValue<int?>("LLM:ImageGenTimeoutSeconds") ?? 600;
        imageGenTimeoutSeconds = Math.Clamp(imageGenTimeoutSeconds, 60, 3600);
        httpClient.Timeout = TimeSpan.FromSeconds(imageGenTimeoutSeconds);

        // Authorization 头不允许多值：覆盖写法
        httpClient.DefaultRequestHeaders.Remove("Authorization");
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        // 允许 endpoint 为绝对 URL；否则以 BaseAddress 拼接
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var endpointUri))
        {
            httpClient.BaseAddress = new Uri(apiUrl.TrimEnd('/').TrimEnd('#') + "/");
        }

        var providerForLog = isVolces ? "Volces" : "OpenAI";
        object reqObj;
        if (isVolces)
        {
            // Volces Ark Images API（/api/v3/images/generations）
            // 兼容前端统一输入：即使前端请求 b64_json，Volces 侧也强制用 url（再由后端下载转 base64/dataURL 回传）
            var volcesResponseFormat = "url";
            var volcesSize = NormalizeVolcesSize(size);
            reqObj = new VolcesImageRequest
            {
                Model = effectiveModelName,
                Prompt = prompt.Trim(),
                N = n,
                Size = volcesSize,
                ResponseFormat = volcesResponseFormat,
                SequentialImageGeneration = "disabled",
                Stream = false,
                Watermark = true
            };
        }
        else
        {
            reqObj = new OpenAIImageRequest
            {
                Model = effectiveModelName,
                Prompt = prompt.Trim(),
                N = n,
                Size = string.IsNullOrWhiteSpace(size) ? null : size.Trim(),
                ResponseFormat = string.IsNullOrWhiteSpace(responseFormat) ? null : responseFormat.Trim()
            };
        }

        // 写入 LLM 请求日志（生图）
        if (_logWriter != null)
        {
            var reqRawJson = isVolces
                ? JsonSerializer.Serialize((VolcesImageRequest)reqObj, VolcesImageJsonContext.Default.VolcesImageRequest)
                : JsonSerializer.Serialize((OpenAIImageRequest)reqObj, OpenAIImageJsonContext.Default.OpenAIImageRequest);
            var reqLogJson = LlmLogRedactor.RedactJson(reqRawJson);
            logId = await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: requestId,
                    Provider: providerForLog,
                    Model: effectiveModelName,
                    ApiBase: endpointUri != null && endpointUri.IsAbsoluteUri ? $"{endpointUri.Scheme}://{endpointUri.Host}/" : httpClient.BaseAddress?.ToString(),
                    Path: endpointUri != null && endpointUri.IsAbsoluteUri ? endpointUri.AbsolutePath.TrimStart('/') : endpoint.TrimStart('/'),
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json",
                        ["authorization"] = "Bearer ***"
                    },
                    RequestBodyRedacted: reqLogJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(reqLogJson),
                    QuestionText: isVolces ? ((VolcesImageRequest)reqObj).Prompt : ((OpenAIImageRequest)reqObj).Prompt,
                    SystemPromptChars: null,
                    SystemPromptHash: null,
                    SystemPromptText: null,
                    MessageCount: null,
                    GroupId: ctx?.GroupId,
                    SessionId: ctx?.SessionId,
                    UserId: ctx?.UserId,
                    ViewRole: ctx?.ViewRole,
                    DocumentChars: null,
                    DocumentHash: null,
                    UserPromptChars: (isVolces ? ((VolcesImageRequest)reqObj).Prompt : ((OpenAIImageRequest)reqObj).Prompt)?.Length ?? 0,
                    StartedAt: startedAt,
                    RequestType: (ctx?.RequestType ?? "imageGen"),
                    RequestPurpose: (ctx?.RequestPurpose ?? "imageGen.generate")),
                ct);
        }

        HttpResponseMessage resp;
        try
        {
            async Task<HttpResponseMessage> SendOnceAsync(CancellationToken token)
            {
                var reqJsonInner = isVolces
                    ? JsonSerializer.Serialize((VolcesImageRequest)reqObj, VolcesImageJsonContext.Default.VolcesImageRequest)
                    : JsonSerializer.Serialize((OpenAIImageRequest)reqObj, OpenAIImageJsonContext.Default.OpenAIImageRequest);
                var contentInner = new StringContent(reqJsonInner, Encoding.UTF8, "application/json");
                var targetUriInner = endpointUri != null && endpointUri.IsAbsoluteUri
                    ? endpointUri
                    : new Uri(endpoint.TrimStart('/'), UriKind.Relative);
                return await httpClient.PostAsync(targetUriInner, contentInner, token);
            }

            resp = await SendOnceAsync(ct);

            // Volces：size 太小会 400，自动升级到最小要求并重试一次（前端无需改）
            if (isVolces && resp.StatusCode == HttpStatusCode.BadRequest)
            {
                var firstBody = await resp.Content.ReadAsStringAsync(ct);
                if (TryExtractUpstreamErrorMessage(firstBody ?? string.Empty, out var errMsg) &&
                    errMsg.Contains("size", StringComparison.OrdinalIgnoreCase) &&
                    errMsg.Contains("at least", StringComparison.OrdinalIgnoreCase) &&
                    reqObj is VolcesImageRequest vReq &&
                    !string.Equals(vReq.Size, "1920x1920", StringComparison.OrdinalIgnoreCase))
                {
                    vReq.Size = "1920x1920"; // 1920*1920=3,686,400（满足报错要求的最小像素数）
                    resp.Dispose();
                    resp = await SendOnceAsync(ct);
                }
                else
                {
                    // 兜底：把第一次 body 还回去，下面统一处理
                    resp.Dispose();
                    resp = new HttpResponseMessage(HttpStatusCode.BadRequest)
                    {
                        Content = new StringContent(firstBody ?? string.Empty, Encoding.UTF8, "application/json"),
                        RequestMessage = httpClient.BaseAddress != null ? new HttpRequestMessage(HttpMethod.Post, httpClient.BaseAddress) : null
                    };
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Image generate request failed");
            if (logId != null)
            {
                _logWriter?.MarkError(logId, $"Image generate request failed: {ex.Message}");
            }
            return ApiResponse<ImageGenResult>.Fail("NETWORK_ERROR", ex.Message);
        }

        if (logId != null)
        {
            // 此时已拿到响应头，视为“首字节”已到达
            _logWriter?.MarkFirstByte(logId, DateTime.UtcNow);
        }

        var body = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            // 注意：下游可能返回带签名的 URL（query 中含签名/credential 等敏感信息），避免写入日志
            _logger.LogWarning("Image generate failed: HTTP {Status} (body chars={Chars})", (int)resp.StatusCode, body?.Length ?? 0);
            if (logId != null)
            {
                var endedAt = DateTime.UtcNow;
                var respContentType = resp.Content.Headers.ContentType?.MediaType;
                var bodyPreview = RedactAndTruncateResponseBody(body ?? string.Empty, respContentType);
                string? upstreamMessage = null;
                if (TryExtractUpstreamErrorMessage(body ?? string.Empty, out var em)) upstreamMessage = em;
                var answerObj = new
                {
                    error = new
                    {
                        message = $"Image generate failed: HTTP {(int)resp.StatusCode}",
                        statusCode = (int)resp.StatusCode,
                        contentType = respContentType,
                        upstreamMessage,
                        bodyPreview
                    }
                };
                var answerText = JsonSerializer.Serialize(answerObj);
                _logWriter?.MarkDone(
                    logId,
                    new LlmLogDone(
                        StatusCode: (int)resp.StatusCode,
                        ResponseHeaders: new Dictionary<string, string>
                        {
                            ["content-type"] = resp.Content.Headers.ContentType?.ToString() ?? "application/json"
                        },
                        InputTokens: null,
                        OutputTokens: null,
                        CacheCreationInputTokens: null,
                        CacheReadInputTokens: null,
                        TokenUsageSource: "missing",
                        ImageSuccessCount: 0,
                        AnswerText: answerText,
                        AssembledTextChars: answerText.Length,
                        AssembledTextHash: LlmLogRedactor.Sha256Hex(answerText),
                        Status: "failed",
                        EndedAt: endedAt,
                        DurationMs: (long)(endedAt - startedAt).TotalMilliseconds));

                // 保留 Error 字段用于列表页快速查看
                _logWriter?.MarkError(logId, $"Image generate failed: HTTP {(int)resp.StatusCode}", (int)resp.StatusCode);
            }
            // 对 400/422 等参数类错误尽量返回 INVALID_FORMAT，便于前端直接提示用户
            if ((int)resp.StatusCode >= 400 && (int)resp.StatusCode < 500)
            {
                var msg = TryExtractUpstreamErrorMessage(body ?? string.Empty, out var em2) ? em2 : $"生图失败：HTTP {(int)resp.StatusCode}";
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, msg);
            }
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.LLM_ERROR, $"生图失败：HTTP {(int)resp.StatusCode}");
        }

        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var data = root.TryGetProperty("data", out var dataEl) && dataEl.ValueKind == JsonValueKind.Array
                ? dataEl.EnumerateArray().ToList()
                : new List<JsonElement>();

            var images = new List<ImageGenImage>();
            var idx = 0;
            foreach (var it in data)
            {
                string? b64 = null;
                string? url = null;
                string? revised = null;
                string? sizeHint = null;

                if (it.TryGetProperty("b64_json", out var b64El) && b64El.ValueKind == JsonValueKind.String)
                {
                    b64 = b64El.GetString();
                }
                // 兼容部分平台字段命名差异
                if (string.IsNullOrWhiteSpace(b64) && it.TryGetProperty("base64", out var b64El2) && b64El2.ValueKind == JsonValueKind.String)
                {
                    b64 = b64El2.GetString();
                }
                if (it.TryGetProperty("url", out var urlEl) && urlEl.ValueKind == JsonValueKind.String)
                {
                    url = urlEl.GetString();
                }
                // Volces 会返回 data[i].size 作为实际尺寸
                if (it.TryGetProperty("size", out var sizeEl) && sizeEl.ValueKind == JsonValueKind.String)
                {
                    sizeHint = sizeEl.GetString();
                }
                if (it.TryGetProperty("revised_prompt", out var rpEl) && rpEl.ValueKind == JsonValueKind.String)
                {
                    revised = rpEl.GetString();
                }

                // 兼容某些网关/代理把 b64_json 返回成 data URL（data:image/png;base64,...）
                if (!string.IsNullOrWhiteSpace(b64) && b64.TrimStart().StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                {
                    var comma = b64.IndexOf(',');
                    if (comma >= 0 && comma + 1 < b64.Length)
                    {
                        b64 = b64[(comma + 1)..];
                    }
                }

                images.Add(new ImageGenImage
                {
                    Index = idx++,
                    Base64 = string.IsNullOrWhiteSpace(b64) ? null : b64,
                    Url = string.IsNullOrWhiteSpace(url) ? null : url,
                    RevisedPrompt = string.IsNullOrWhiteSpace(revised) ? null : revised
                });
            }

            // 兼容：若下游只返回 url（或你希望统一给前端 base64），则后端自动下载转成 dataURL/base64
            for (var i = 0; i < images.Count; i++)
            {
                if (!string.IsNullOrWhiteSpace(images[i].Base64)) continue;
                if (string.IsNullOrWhiteSpace(images[i].Url)) continue;

                var dataUrl = await TryDownloadImageAsDataUrlAsync(images[i].Url!, ct);
                if (!string.IsNullOrWhiteSpace(dataUrl))
                {
                    images[i].Base64 = dataUrl;
                }
            }

            if (logId != null)
            {
                var endedAt = DateTime.UtcNow;
                var responseFormatForLog = isVolces ? ((VolcesImageRequest)reqObj).ResponseFormat : ((OpenAIImageRequest)reqObj).ResponseFormat;
                var sizeForLog = isVolces ? ((VolcesImageRequest)reqObj).Size : ((OpenAIImageRequest)reqObj).Size;
                var summary = new
                {
                    images = images.Count,
                    responseFormat = responseFormatForLog,
                    size = sizeForLog,
                    // 不记录 base64 内容；仅记录是否返回
                    hasBase64 = images.Any(x => !string.IsNullOrWhiteSpace(x.Base64)),
                    hasUrl = images.Any(x => !string.IsNullOrWhiteSpace(x.Url)),
                    revisedPrompt = images.FirstOrDefault()?.RevisedPrompt
                };
                var answerText = JsonSerializer.Serialize(summary);
                var hash = LlmLogRedactor.Sha256Hex(answerText);
                _logWriter?.MarkDone(
                    logId,
                    new LlmLogDone(
                        StatusCode: (int)resp.StatusCode,
                        ResponseHeaders: new Dictionary<string, string>
                        {
                            ["content-type"] = resp.Content.Headers.ContentType?.ToString() ?? "application/json"
                        },
                        InputTokens: null,
                        OutputTokens: null,
                        CacheCreationInputTokens: null,
                        CacheReadInputTokens: null,
                        TokenUsageSource: "missing",
                        ImageSuccessCount: images.Count,
                        AnswerText: answerText,
                        AssembledTextChars: answerText.Length,
                        AssembledTextHash: hash,
                        Status: "succeeded",
                        EndedAt: endedAt,
                        DurationMs: (long)(endedAt - startedAt).TotalMilliseconds));
            }

            return ApiResponse<ImageGenResult>.Ok(new ImageGenResult { Images = images });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Image generate parse failed");
            if (logId != null)
            {
                var endedAt = DateTime.UtcNow;
                var answerText = JsonSerializer.Serialize(new { error = new { message = "Image generate parse failed" } });
                _logWriter?.MarkDone(
                    logId,
                    new LlmLogDone(
                        StatusCode: (int)resp.StatusCode,
                        ResponseHeaders: new Dictionary<string, string>
                        {
                            ["content-type"] = resp.Content.Headers.ContentType?.ToString() ?? "application/json"
                        },
                        InputTokens: null,
                        OutputTokens: null,
                        CacheCreationInputTokens: null,
                        CacheReadInputTokens: null,
                        TokenUsageSource: "missing",
                        ImageSuccessCount: 0,
                        AnswerText: answerText,
                        AssembledTextChars: answerText.Length,
                        AssembledTextHash: LlmLogRedactor.Sha256Hex(answerText),
                        Status: "failed",
                        EndedAt: endedAt,
                        DurationMs: (long)(endedAt - startedAt).TotalMilliseconds));
                _logWriter?.MarkError(logId, "Image generate parse failed");
            }
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图响应解析失败");
        }
    }

    private async Task<(string? apiUrl, string? apiKey, string? platformType)> ResolveApiConfigForModelAsync(
        LLMModel model,
        string jwtSecret,
        CancellationToken ct)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : DecryptApiKey(model.ApiKeyEncrypted, jwtSecret);
        string? platformType = null;

        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync(ct);
            platformType = platform?.PlatformType?.ToLowerInvariant();
            if (platform != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= DecryptApiKey(platform.ApiKeyEncrypted, jwtSecret);
            }
        }

        return (apiUrl, apiKey, platformType);
    }

    private static string DecryptApiKey(string encryptedKey, string secretKey)
    {
        if (string.IsNullOrEmpty(encryptedKey)) return string.Empty;
        try
        {
            var parts = encryptedKey.Split(':');
            if (parts.Length != 2) return string.Empty;

            var keyBytes = Encoding.UTF8.GetBytes(secretKey.Length >= 32 ? secretKey[..32] : secretKey.PadRight(32));
            var iv = Convert.FromBase64String(parts[0]);
            var encryptedBytes = Convert.FromBase64String(parts[1]);

            using var aes = Aes.Create();
            aes.Key = keyBytes;
            aes.IV = iv;

            using var decryptor = aes.CreateDecryptor();
            var decryptedBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
            return Encoding.UTF8.GetString(decryptedBytes);
        }
        catch
        {
            return string.Empty;
        }
    }

    /// <summary>
    /// 兼容 apiUrl（与 OpenAICompatUrl 规则一致）：
    /// - 以 / 结尾：忽略 v1，拼接 images/generations
    /// - 以 # 结尾：强制使用原地址（trim #，不做拼接）
    /// - 其他：默认拼接 /v1/images/generations
    /// </summary>
    public static string GetImagesEndpoint(string apiUrl)
    {
        if (IsVolcesImagesApi(apiUrl))
        {
            return BuildVolcesEndpoint(apiUrl, "images/generations");
        }
        return OpenAICompatUrl.BuildEndpoint(apiUrl, "images/generations");
    }

    /// <summary>
    /// Volces Ark（ark.*.volces.com / *.volces.com）图片生成使用 /api/v3/images/generations，
    /// 其余保持 OpenAICompatUrl 默认规则（/v1/...）。
    /// </summary>
    private static bool IsVolcesImagesApi(string apiUrl)
    {
        var raw = (apiUrl ?? string.Empty).Trim();
        raw = raw.TrimEnd('#');
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var u)) return false;
        if (!u.Host.EndsWith("volces.com", StringComparison.OrdinalIgnoreCase)) return false;
        return true;
    }

    private static string BuildVolcesEndpoint(string baseUrl, string capabilityPath)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) return string.Empty;
        if (string.IsNullOrWhiteSpace(capabilityPath)) return string.Empty;

        var raw = baseUrl.Trim();
        var cap = capabilityPath.Trim().TrimStart('/');

        // 规则二：以 # 结尾 —— 强制使用原地址（不做任何拼接）
        if (raw.EndsWith("#", StringComparison.Ordinal))
        {
            return raw.TrimEnd('#');
        }

        if (Uri.TryCreate(raw, UriKind.Absolute, out var u))
        {
            var path = (u.AbsolutePath ?? string.Empty).TrimEnd('/');

            // 若 baseUrl 已经是完整的能力 endpoint（例如 .../api/v3/images/generations），则直接使用
            if (path.EndsWith("/" + cap, StringComparison.OrdinalIgnoreCase))
            {
                return raw;
            }

            // 规则一：以 / 结尾
            if (raw.EndsWith("/", StringComparison.Ordinal))
            {
                // 若已包含 /api/v3（作为 base），则直接拼接能力路径；否则补上 /api/v3
                if (path.Contains("/api/v3", StringComparison.OrdinalIgnoreCase))
                {
                    return raw.TrimEnd('/') + "/" + cap;
                }
                return raw.TrimEnd('/') + "/api/v3/" + cap;
            }

            // 若 baseUrl 已包含 /api/v3（作为 base），则直接拼接 {capabilityPath}
            if (path.Contains("/api/v3", StringComparison.OrdinalIgnoreCase))
            {
                return raw.TrimEnd('/') + "/" + cap;
            }
        }

        // 规则一：以 / 结尾（无法解析为绝对 URL 的兜底逻辑）
        if (raw.EndsWith("/", StringComparison.Ordinal))
        {
            return raw.TrimEnd('/') + "/api/v3/" + cap;
        }

        // Volces：否则默认补上 /api/v3
        return raw.TrimEnd('/') + "/api/v3/" + cap;
    }

    private async Task<string?> TryDownloadImageAsDataUrlAsync(string imageUrl, CancellationToken ct)
    {
        if (!Uri.TryCreate((imageUrl ?? string.Empty).Trim(), UriKind.Absolute, out var uri)) return null;
        if (!IsSafeExternalImageUri(uri)) return null;

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        // 生图 URL 下载转 base64：通常较快，但为避免大图/慢链路误伤，给更宽松的超时。
        var downloadTimeoutSeconds = _config.GetValue<int?>("LLM:ImageGenDownloadTimeoutSeconds") ?? 120;
        downloadTimeoutSeconds = Math.Clamp(downloadTimeoutSeconds, 30, 3600);
        httpClient.Timeout = TimeSpan.FromSeconds(downloadTimeoutSeconds);
        // 避免把上游生图平台的 Bearer token 泄露给图片 URL 的第三方 host
        httpClient.DefaultRequestHeaders.Remove("Authorization");
        httpClient.DefaultRequestHeaders.Accept.Clear();
        httpClient.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("image/*"));

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, uri);
            using var resp = await httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.LogWarning("Image url download failed: HTTP {Status} host={Host}", (int)resp.StatusCode, uri.Host);
                return null;
            }

            var contentType = resp.Content.Headers.ContentType?.MediaType;
            var maxBytes = 15 * 1024 * 1024; // 15MB 上限：防止异常大文件拖垮内存

            await using var stream = await resp.Content.ReadAsStreamAsync(ct);
            using var ms = new MemoryStream(capacity: 1024 * 1024);
            await CopyToWithLimitAsync(stream, ms, maxBytes, ct);
            var bytes = ms.ToArray();

            var mime = GuessImageMimeType(contentType, bytes);
            var b64 = Convert.ToBase64String(bytes);
            return $"data:{mime};base64,{b64}";
        }
        catch (OperationCanceledException)
        {
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Image url download failed: host={Host}", uri.Host);
            return null;
        }
    }

    private static async Task CopyToWithLimitAsync(Stream input, Stream output, int maxBytes, CancellationToken ct)
    {
        var buf = new byte[81920];
        var total = 0;
        while (true)
        {
            var read = await input.ReadAsync(buf.AsMemory(0, buf.Length), ct);
            if (read <= 0) break;
            total += read;
            if (total > maxBytes)
            {
                throw new InvalidOperationException("Image too large");
            }
            await output.WriteAsync(buf.AsMemory(0, read), ct);
        }
    }

    private static bool IsSafeExternalImageUri(Uri uri)
    {
        if (!string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return false;
        if (string.IsNullOrWhiteSpace(uri.Host)) return false;

        // 基础 SSRF 防护：拒绝本地/私网/环回
        if (string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)) return false;

        if (IPAddress.TryParse(uri.Host, out var ip))
        {
            if (IsPrivateOrLocalIp(ip)) return false;
        }

        return true;
    }

    private static bool IsPrivateOrLocalIp(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;

        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            // 10.0.0.0/8
            if (b[0] == 10) return true;
            // 172.16.0.0/12
            if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
            // 192.168.0.0/16
            if (b[0] == 192 && b[1] == 168) return true;
            // 169.254.0.0/16 (link-local)
            if (b[0] == 169 && b[1] == 254) return true;
            return false;
        }

        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal) return true;
            // fc00::/7 (unique local)
            var b = ip.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) return true;
        }

        return false;
    }

    private static string GuessImageMimeType(string? contentTypeHeader, byte[] bytes)
    {
        // 优先使用响应头
        if (!string.IsNullOrWhiteSpace(contentTypeHeader) &&
            contentTypeHeader.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        {
            return contentTypeHeader;
        }

        // 魔数兜底
        if (bytes.Length >= 12)
        {
            // PNG: 89 50 4E 47 0D 0A 1A 0A
            if (bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) return "image/png";
            // JPEG: FF D8 FF
            if (bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return "image/jpeg";
            // GIF: GIF87a / GIF89a
            if (bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) return "image/gif";
            // WEBP: RIFF....WEBP
            if (bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 &&
                bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50) return "image/webp";
        }

        return "image/png";
    }

    private static string RedactAndTruncateResponseBody(string body, string? contentType)
    {
        var raw = body ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;

        // 对 JSON 先做“密钥类字段”脱敏，再额外处理“带签名 URL”
        string s;
        if (!string.IsNullOrWhiteSpace(contentType) && contentType.Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            s = LlmLogRedactor.RedactJson(raw);
            s = RedactSignedUrls(s);
        }
        else
        {
            s = raw;
            s = RedactSignedUrls(s);
        }

        var maxChars = LlmLogLimits.DefaultErrorMaxChars;
        if (s.Length > maxChars) s = s[..maxChars] + "...[TRUNCATED]";
        return s;
    }

    private static string RedactSignedUrls(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;

        // 粗粒度兜底：把包含常见签名参数的 URL query 去掉（避免泄露 X-Tos-* / Signature / Credential）
        // 不追求完美，只保证“不会把签名原文落库/展示”
        return Regex.Replace(
            text,
            @"https?://[^\s""']+",
            m =>
            {
                var u = m.Value;
                if (!Uri.TryCreate(u, UriKind.Absolute, out var uri)) return u;
                var q = uri.Query ?? string.Empty;
                var hasSig =
                    q.Contains("X-Tos-", StringComparison.OrdinalIgnoreCase) ||
                    q.Contains("Signature", StringComparison.OrdinalIgnoreCase) ||
                    q.Contains("Credential", StringComparison.OrdinalIgnoreCase) ||
                    q.Contains("Expires", StringComparison.OrdinalIgnoreCase) ||
                    q.Contains("x-tos-", StringComparison.OrdinalIgnoreCase);
                if (!hasSig) return u;
                return $"{uri.Scheme}://{uri.Host}{uri.AbsolutePath}?[REDACTED_QUERY]";
            });
    }

    private static bool TryExtractUpstreamErrorMessage(string body, out string message)
    {
        message = string.Empty;
        if (string.IsNullOrWhiteSpace(body)) return false;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var err) && err.ValueKind == JsonValueKind.Object)
            {
                if (err.TryGetProperty("message", out var msgEl) && msgEl.ValueKind == JsonValueKind.String)
                {
                    message = msgEl.GetString() ?? string.Empty;
                    message = message.Trim();
                    return !string.IsNullOrWhiteSpace(message);
                }
            }
        }
        catch
        {
            // ignore
        }
        return false;
    }

    /// <summary>
    /// Volces 对 size 的要求更严格：根据你当前日志，至少需要 3,686,400 pixels（=1920x1920）。
    /// 为了保持前端不变，这里把常见的 OpenAI 尺寸自动升级到可用的最小值。
    /// </summary>
    private static string? NormalizeVolcesSize(string? size)
    {
        var raw = (size ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw)) return "1920x1920";

        // 已经是 2K/4K 等标签则原样透传
        if (raw.EndsWith("K", StringComparison.OrdinalIgnoreCase)) return raw;

        // 解析 WxH
        var m = Regex.Match(raw, @"^\s*(\d+)\s*[xX]\s*(\d+)\s*$");
        if (m.Success &&
            int.TryParse(m.Groups[1].Value, out var w) &&
            int.TryParse(m.Groups[2].Value, out var h) &&
            w > 0 && h > 0)
        {
            var pixels = (long)w * h;
            // 3,686,400 = 1920*1920
            if (pixels < 3686400) return "1920x1920";
            return $"{w}x{h}";
        }

        // 其他未知格式：兜底到最小可用
        return "1920x1920";
    }
}

public class ImageGenResult
{
    public List<ImageGenImage> Images { get; set; } = new();
}

public class ImageGenImage
{
    public int Index { get; set; }
    public string? Base64 { get; set; }
    public string? Url { get; set; }
    public string? RevisedPrompt { get; set; }
}

internal class OpenAIImageRequest
{
    [JsonPropertyName("model")]
    public string Model { get; set; } = string.Empty;

    [JsonPropertyName("prompt")]
    public string Prompt { get; set; } = string.Empty;

    [JsonPropertyName("n")]
    public int N { get; set; } = 1;

    [JsonPropertyName("size")]
    public string? Size { get; set; }

    [JsonPropertyName("response_format")]
    public string? ResponseFormat { get; set; }
}

[JsonSerializable(typeof(OpenAIImageRequest))]
internal partial class OpenAIImageJsonContext : JsonSerializerContext
{
}

internal class VolcesImageRequest
{
    [JsonPropertyName("model")]
    public string Model { get; set; } = string.Empty;

    [JsonPropertyName("prompt")]
    public string Prompt { get; set; } = string.Empty;

    [JsonPropertyName("n")]
    public int N { get; set; } = 1;

    [JsonPropertyName("size")]
    public string? Size { get; set; }

    [JsonPropertyName("response_format")]
    public string? ResponseFormat { get; set; }

    // Volces Ark 扩展字段（OpenAI 标准不包含）
    [JsonPropertyName("sequential_image_generation")]
    public string? SequentialImageGeneration { get; set; }

    [JsonPropertyName("stream")]
    public bool? Stream { get; set; }

    [JsonPropertyName("watermark")]
    public bool? Watermark { get; set; }
}

[JsonSerializable(typeof(VolcesImageRequest))]
internal partial class VolcesImageJsonContext : JsonSerializerContext
{
}

