using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text.Json.Serialization;
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
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(prompt))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空");
        }

        if (n <= 0) n = 1;
        if (n > 10) n = 10;

        // 日志上下文：若上游未设置 scope，则使用默认值兜底（仍保证“任何生图调用都有日志”）
        var ctx = _ctxAccessor?.Current;
        var requestId = (ctx?.RequestId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestId)) requestId = Guid.NewGuid().ToString("N");
        var startedAt = DateTime.UtcNow;
        string? logId = null;

        // 选择生图模型（不存在则失败）
        var model = await _db.LLMModels.Find(m => m.IsImageGen && m.Enabled).FirstOrDefaultAsync(ct);
        if (model == null)
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "未配置可用的生图模型（请在模型管理中设置“生图”）");
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        var (apiUrl, apiKey, platformType) = await ResolveApiConfigForModelAsync(model, jwtSecret, ct);

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

        var endpoint = GetImagesEndpoint(apiUrl);
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图模型 API URL 无效");
        }

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        httpClient.Timeout = TimeSpan.FromSeconds(60);

        // Authorization 头不允许多值：覆盖写法
        httpClient.DefaultRequestHeaders.Remove("Authorization");
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

        // 允许 endpoint 为绝对 URL；否则以 BaseAddress 拼接
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var endpointUri))
        {
            httpClient.BaseAddress = new Uri(apiUrl.TrimEnd('/').TrimEnd('#') + "/");
        }

        var req = new OpenAIImageRequest
        {
            Model = model.ModelName,
            Prompt = prompt.Trim(),
            N = n,
            Size = string.IsNullOrWhiteSpace(size) ? null : size.Trim(),
            ResponseFormat = string.IsNullOrWhiteSpace(responseFormat) ? null : responseFormat.Trim()
        };

        // 写入 LLM 请求日志（生图）
        if (_logWriter != null)
        {
            var reqLogJson = LlmLogRedactor.RedactJson(JsonSerializer.Serialize(req, OpenAIImageJsonContext.Default.OpenAIImageRequest));
            logId = await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: requestId,
                    Provider: "OpenAI",
                    Model: model.ModelName,
                    ApiBase: endpointUri != null && endpointUri.IsAbsoluteUri ? $"{endpointUri.Scheme}://{endpointUri.Host}/" : httpClient.BaseAddress?.ToString(),
                    Path: endpointUri != null && endpointUri.IsAbsoluteUri ? endpointUri.AbsolutePath.TrimStart('/') : endpoint.TrimStart('/'),
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json",
                        ["authorization"] = "Bearer ***"
                    },
                    RequestBodyRedacted: reqLogJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(reqLogJson),
                    QuestionText: req.Prompt,
                    SystemPromptChars: null,
                    SystemPromptHash: null,
                    MessageCount: null,
                    GroupId: ctx?.GroupId,
                    SessionId: ctx?.SessionId,
                    UserId: ctx?.UserId,
                    ViewRole: ctx?.ViewRole,
                    DocumentChars: null,
                    DocumentHash: null,
                    StartedAt: startedAt,
                    RequestType: (ctx?.RequestType ?? "imageGen"),
                    RequestPurpose: (ctx?.RequestPurpose ?? "imageGen.generate")),
                ct);
        }

        HttpResponseMessage resp;
        try
        {
            var content = new StringContent(JsonSerializer.Serialize(req, OpenAIImageJsonContext.Default.OpenAIImageRequest), Encoding.UTF8, "application/json");
            var targetUri = endpointUri != null && endpointUri.IsAbsoluteUri
                ? endpointUri
                : new Uri(endpoint.TrimStart('/'), UriKind.Relative);
            resp = await httpClient.PostAsync(targetUri, content, ct);
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
            _logger.LogWarning("Image generate failed: {Status} {Body}", (int)resp.StatusCode, body.Length > 500 ? body[..500] : body);
            if (logId != null)
            {
                _logWriter?.MarkError(logId, $"Image generate failed: HTTP {(int)resp.StatusCode}", (int)resp.StatusCode);
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

                if (it.TryGetProperty("b64_json", out var b64El) && b64El.ValueKind == JsonValueKind.String)
                {
                    b64 = b64El.GetString();
                }
                if (it.TryGetProperty("url", out var urlEl) && urlEl.ValueKind == JsonValueKind.String)
                {
                    url = urlEl.GetString();
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

            if (logId != null)
            {
                var endedAt = DateTime.UtcNow;
                var summary = new
                {
                    images = images.Count,
                    responseFormat = req.ResponseFormat,
                    size = req.Size,
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
    /// 兼容 apiUrl：
    /// - 以 # 结尾：视为“完整 endpoint”，trim 掉 # 直接使用
    /// - 已包含 /images/generations：直接使用
    /// - 包含 /v1：拼接 /images/generations
    /// - 其他：拼接 /v1/images/generations
    /// </summary>
    public static string GetImagesEndpoint(string apiUrl)
    {
        if (string.IsNullOrWhiteSpace(apiUrl)) return string.Empty;
        var raw = apiUrl.Trim();
        if (raw.EndsWith("#"))
        {
            return raw.TrimEnd('#');
        }

        var u = raw.TrimEnd('/');
        if (u.EndsWith("/images/generations", StringComparison.OrdinalIgnoreCase))
        {
            return u;
        }

        if (u.Contains("/v1", StringComparison.OrdinalIgnoreCase))
        {
            // 若刚好以 /v1 结尾
            if (u.EndsWith("/v1", StringComparison.OrdinalIgnoreCase))
            {
                return u + "/images/generations";
            }
            return u + "/images/generations";
        }

        return u + "/v1/images/generations";
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

