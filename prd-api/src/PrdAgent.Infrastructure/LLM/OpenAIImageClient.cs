using System.Net.Http.Headers;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.LLM.Adapters;

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
    private readonly IAssetStorage _assetStorage;
    private readonly WatermarkRenderer _watermarkRenderer;
    private readonly WatermarkFontRegistry _fontRegistry;
    private readonly ILlmRequestLogWriter? _logWriter;
    private readonly ILLMRequestContextAccessor? _ctxAccessor;

    public OpenAIImageClient(
        MongoDbContext db,
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<OpenAIImageClient> logger,
        IAssetStorage assetStorage,
        WatermarkRenderer watermarkRenderer,
        WatermarkFontRegistry fontRegistry,
        ILlmRequestLogWriter? logWriter = null,
        ILLMRequestContextAccessor? ctxAccessor = null)
    {
        _db = db;
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
        _assetStorage = assetStorage;
        _watermarkRenderer = watermarkRenderer;
        _fontRegistry = fontRegistry;
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
        string? modelName = null,
        string? initImageBase64 = null,
        bool initImageProvided = false,
        string? appKey = null)
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
        string? platformIdForLog = null;
        string? platformNameForLog = null;
        if (model != null)
        {
            var cfg = await ResolveApiConfigForModelAsync(model, jwtSecret, ct);
            apiUrl = cfg.apiUrl;
            apiKey = cfg.apiKey;
            platformType = cfg.platformType;
            effectiveModelName = model.ModelName;
            platformIdForLog = model.PlatformId;
            // 查询平台名称用于日志
            if (!string.IsNullOrWhiteSpace(model.PlatformId))
            {
                var plt = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync(ct);
                platformNameForLog = plt?.Name;
            }
        }
        else
        {
            // 平台回退调用：直接用平台 API 配置 + 指定 modelName
            apiUrl = platform!.ApiUrl;
            apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
            platformType = platform.PlatformType?.ToLowerInvariant();
            effectiveModelName = requestedModelName ?? string.Empty;
            platformIdForLog = platform.Id;
            platformNameForLog = platform.Name;
            if (string.IsNullOrWhiteSpace(effectiveModelName))
            {
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "未提供 modelName（平台回退调用需要 modelName）");
            }
        }

        // 开发期 stub：允许 apiKey 为空（Stub 不做鉴权），避免测试时误报“配置不完整”
        if (!string.IsNullOrWhiteSpace(apiUrl) && string.IsNullOrWhiteSpace(apiKey) && IsLocalStubApi(apiUrl))
        {
            apiKey = "stub";
        }

        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图模型 API 配置不完整");
        }

        // 验证 apiUrl 必须是有效的 HTTP(S) URL，避免 file:// 等无效协议
        if (!Uri.TryCreate(apiUrl, UriKind.Absolute, out var apiUrlUri) ||
            (apiUrlUri.Scheme != Uri.UriSchemeHttp && apiUrlUri.Scheme != Uri.UriSchemeHttps))
        {
            _logger.LogError("生图模型 API URL 无效（非 HTTP(S) 协议）: {ApiUrl}", apiUrl);
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, $"生图模型 API URL 无效（必须是 http:// 或 https:// 开头）: {apiUrl}");
        }

        // Anthropic 不支持 images endpoint；避免误配后 500
        if (string.Equals(platformType, "anthropic", StringComparison.OrdinalIgnoreCase) ||
            apiUrl.Contains("anthropic.com", StringComparison.OrdinalIgnoreCase))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图模型不支持 Anthropic 平台（请配置 OpenAI 兼容的 images API）");
        }

        // 获取平台适配器（优先使用模型配置，fallback 到 URL 检测）
        var platformAdapter = ImageGenPlatformAdapterFactory.GetAdapter(apiUrl, effectiveModelName);
        var isVolces = platformAdapter.PlatformType == "volces"; // 保留兼容变量
        initImageBase64 = string.IsNullOrWhiteSpace(initImageBase64) ? null : initImageBase64.Trim();
        // 说明：某些路径（如 Volces 降级）会把 initImageBase64 清空，但我们仍希望日志能追溯“用户是否提供过参考图”
        var initImageProvidedForLog = initImageProvided || initImageBase64 != null;
        if (!platformAdapter.SupportsImageToImage && initImageBase64 != null)
        {
            // 平台不支持图生图，降级为文生图
            initImageBase64 = null;
        }
        var initImageUsedForCall = initImageBase64 != null;
        var endpoint = initImageBase64 == null 
            ? platformAdapter.GetGenerationsEndpoint(apiUrl) 
            : platformAdapter.GetEditsEndpoint(apiUrl);
        if (string.IsNullOrWhiteSpace(endpoint))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "生图模型 API URL 无效");
        }

        // 原始请求尺寸（用于缓存命中与 meta/日志展示）
        var requestedSizeRaw = string.IsNullOrWhiteSpace(size) ? null : size.Trim();
        var requestedSizeNorm = NormalizeSizeString(requestedSizeRaw);
        List<string>? allowedSizesForLog = null;

        // 一站式构建生图请求参数（尺寸适配 + 参数格式转换）
        var reqParams = ImageGenModelAdapterRegistry.BuildRequestParams(
            modelName: effectiveModelName,
            requestedSize: requestedSizeNorm
        );

        ImageGenModelAdapterConfig? adapterConfig = null;
        SizeAdaptationResult? adapterSizeResult = null;

        if (reqParams.HasAdapter)
        {
            adapterConfig = ImageGenModelAdapterRegistry.TryMatch(effectiveModelName);
            adapterSizeResult = reqParams.Adaptation;
            size = adapterSizeResult.Size;

            if (adapterConfig != null)
            {
                var allSizes = ImageGenModelAdapterRegistry.GetAllSizesFromConfig(adapterConfig);
                allowedSizesForLog = allSizes.Count > 0
                    ? allSizes.Take(64).ToList()
                    : null;
            }
        }

        // 非 Volces 且无适配器：尝试命中"允许尺寸白名单"缓存，避免先 400 再重试
        var capsKey = BuildCapsKey(requestedModelId, requestedPlatformId, requestedModelName, effectiveModelName);
        if (!isVolces && adapterConfig == null)
        {
            var caps = await TryGetSizeCapsAsync(capsKey, ct);
            if (caps != null && (caps.AllowedSizes?.Count ?? 0) > 0)
            {
                allowedSizesForLog = (caps.AllowedSizes ?? new List<string>())
                    .Select(NormalizeSizeString)
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .Select(x => x!)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Take(64)
                    .ToList();

                var allowed = new List<Size2D>();
                foreach (var s in caps.AllowedSizes ?? new List<string>())
                {
                    if (TryParseSize(s, out var w, out var h)) allowed.Add(new Size2D(w, h));
                }

                if (allowed.Count > 0)
                {
                    // prefer_medium：若没有可解析的 requested size，则用 1024x1024 作为面积目标
                    var target = TryParseSize(requestedSizeNorm, out var tw, out var th) ? new Size2D(tw, th) : new Size2D(1024, 1024);
                    var chosen = ChooseClosestAllowedSize(target, allowed);
                    var chosenStr = $"{chosen.W}x{chosen.H}";
                    if (!string.Equals(requestedSizeNorm, NormalizeSizeString(chosenStr), StringComparison.OrdinalIgnoreCase))
                    {
                        size = chosenStr;
                    }
                }
            }
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

        var providerForLog = platformAdapter.ProviderNameForLog;
        
        // 确定实际使用的响应格式（某些平台强制 url）
        var effectiveResponseFormat = platformAdapter.ForceUrlResponseFormat ? "url" : responseFormat;
        
        // 归一化尺寸（某些平台有最小尺寸要求）
        var normalizedSize = platformAdapter.NormalizeSize(size);
        
        // 使用平台适配器构建请求
        object reqObj;
        if (initImageBase64 == null)
        {
            // 文生图请求
            var sizeParams = reqParams.HasAdapter && reqParams.SizeParams.Count > 0 
                ? reqParams.SizeParams 
                : null;
            reqObj = platformAdapter.BuildGenerationRequest(
                effectiveModelName, 
                prompt, 
                n, 
                normalizedSize, 
                effectiveResponseFormat,
                sizeParams);
        }
        else
        {
            // 图生图请求（multipart/form-data）
            reqObj = platformAdapter.BuildEditRequest(
                effectiveModelName, 
                prompt, 
                n, 
                normalizedSize, 
                effectiveResponseFormat);
        }

        // 提前保存参考图到 COS 并创建 input artifact（确保即使请求失败也能在日志中预览参考图）
        var createdByAdminId = ctx?.UserId ?? "system";
        var inputArtifactIds = new List<string>();
        string? initImageCosUrl = null;
        if (!string.IsNullOrWhiteSpace(initImageBase64))
        {
            if (TryDecodeDataUrlOrBase64(initImageBase64, out var initBytes, out var initMime) && initBytes.Length > 0)
            {
                var stored = await _assetStorage.SaveAsync(initBytes, initMime, ct, domain: AppDomainPaths.DomainAssets, type: AppDomainPaths.TypeImg);
                var dim = TryParseSize(NormalizeSizeString(size), out var iw, out var ih) ? new { w = iw, h = ih } : null;
                var input = new UploadArtifact
                {
                    Id = Guid.NewGuid().ToString("N"),
                    RequestId = requestId,
                    Kind = "input_image",
                    CreatedByAdminId = createdByAdminId,
                    Prompt = prompt,
                    Sha256 = stored.Sha256,
                    Mime = stored.Mime,
                    Width = dim?.w ?? 0,
                    Height = dim?.h ?? 0,
                    SizeBytes = stored.SizeBytes,
                    CosUrl = stored.Url,
                    CreatedAt = DateTime.UtcNow
                };
                await _db.UploadArtifacts.InsertOneAsync(input, cancellationToken: ct);
                inputArtifactIds.Add(input.Id);
                initImageCosUrl = stored.Url;
            }
        }

        // 写入 LLM 请求日志（生图）
        if (_logWriter != null)
        {
            // 记录请求体：包含参考图 COS URL（若有），便于日志页 curl 复制和调试
            string reqRawJson;
            if (initImageUsedForCall)
            {
                // 图生图请求的日志序列化
                var editSize = reqObj switch
                {
                    VolcesImageEditRequest ver => ver.Size,
                    Adapters.VolcesImageEditRequest ver2 => ver2.Size,
                    OpenAIImageEditRequest oer => oer.Size,
                    Adapters.OpenAIImageEditRequest oer2 => oer2.Size,
                    Dictionary<string, object> dict => dict.TryGetValue("size", out var s) ? s?.ToString() : null,
                    _ => null
                };
                var editRespFormat = reqObj switch
                {
                    VolcesImageEditRequest ver => ver.ResponseFormat,
                    Adapters.VolcesImageEditRequest ver2 => ver2.ResponseFormat,
                    OpenAIImageEditRequest oer => oer.ResponseFormat,
                    Adapters.OpenAIImageEditRequest oer2 => oer2.ResponseFormat,
                    Dictionary<string, object> dict => dict.TryGetValue("response_format", out var rf) ? rf?.ToString() : null,
                    _ => null
                };
                reqRawJson = JsonSerializer.Serialize(new
                {
                    model = effectiveModelName,
                    prompt = prompt.Trim(),
                    n,
                    size = editSize,
                    responseFormat = editRespFormat,
                    initImageProvided = initImageProvidedForLog,
                    initImageUsed = true,
                    image = initImageCosUrl
                });
            }
            else
            {
                // 文生图请求：适配器总是返回 Dictionary<string, object>
                if (reqObj is Dictionary<string, object> reqDict)
                {
                    var logDict = new Dictionary<string, object>(reqDict)
                    {
                        ["initImageProvided"] = initImageProvidedForLog,
                        ["initImageUsed"] = false
                    };
                    reqRawJson = JsonSerializer.Serialize(logDict);
                }
                else
                {
                    // Fallback: 序列化未知对象类型
                    reqRawJson = JsonSerializer.Serialize(new
                    {
                        reqObj,
                        initImageProvided = initImageProvidedForLog,
                        initImageUsed = false
                    });
                }
            }
            var reqLogJson = LlmLogRedactor.RedactJson(reqRawJson);
            logId = await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: requestId,
                    Provider: providerForLog,
                    Model: effectiveModelName,
                    ApiBase: endpointUri != null && endpointUri.IsAbsoluteUri ? $"{endpointUri.Scheme}://{endpointUri.Host}/" : httpClient.BaseAddress?.ToString(),
                    Path: endpointUri != null && endpointUri.IsAbsoluteUri ? endpointUri.AbsolutePath.TrimStart('/') : endpoint.TrimStart('/'),
                    HttpMethod: "POST",
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = initImageBase64 == null ? "application/json" : "multipart/form-data",
                        // 统一使用标准 Header 名，避免某些 curl 生成/回放工具把不同大小写当作"两个头"
                        // 部分脱敏，保留前后4字符便于调试
                        ["Authorization"] = $"Bearer {LlmLogRedactor.RedactApiKey(apiKey)}"
                    },
                    RequestBodyRedacted: reqLogJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(reqLogJson),
                    QuestionText: prompt.Trim(),
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
                    UserPromptChars: prompt.Trim().Length,
                    StartedAt: startedAt,
                    RequestType: (ctx?.RequestType ?? "imageGen"),
                    RequestPurpose: (ctx?.RequestPurpose ?? "prd-agent-web::image-gen.generate"),
                    PlatformId: platformIdForLog,
                    PlatformName: platformNameForLog,
                    ModelResolutionType: ctx?.ModelResolutionType,
                    ModelGroupId: ctx?.ModelGroupId,
                    ModelGroupName: ctx?.ModelGroupName),
                ct);
        }

        HttpResponseMessage resp;
        try
        {
            async Task<HttpResponseMessage> SendOnceAsync(CancellationToken token)
            {
                var targetUriInner = endpointUri != null && endpointUri.IsAbsoluteUri
                    ? endpointUri
                    : new Uri(endpoint.TrimStart('/'), UriKind.Relative);
                if (initImageBase64 == null)
                {
                    // reqObj 可能是 Dictionary<string, object>（文生图）或类型化对象
                    string reqJsonInner;
                    if (reqObj is Dictionary<string, object> dictReq)
                    {
                        reqJsonInner = JsonSerializer.Serialize(dictReq);
                    }
                    else if (isVolces)
                    {
                        reqJsonInner = JsonSerializer.Serialize((VolcesImageRequest)reqObj, VolcesImageJsonContext.Default.VolcesImageRequest);
                    }
                    else
                    {
                        reqJsonInner = JsonSerializer.Serialize((OpenAIImageRequest)reqObj, OpenAIImageJsonContext.Default.OpenAIImageRequest);
                    }

                    // === [DEBUG] Log the full request being sent to image generation API (nanobanana) ===
                    _logger.LogInformation(
                        "[OpenAIImageClient] Sending request to image gen API:\n" +
                        "  Endpoint: {Endpoint}\n" +
                        "  Model: {Model}\n" +
                        "  Provider: {Provider}\n" +
                        "  RequestBody: {RequestBody}",
                        targetUriInner.ToString(),
                        effectiveModelName,
                        providerForLog,
                        reqJsonInner);

                    var contentInner = new StringContent(reqJsonInner, Encoding.UTF8, "application/json");
                    return await httpClient.PostAsync(targetUriInner, contentInner, token);
                }

                if (!TryDecodeDataUrlOrBase64(initImageBase64, out var imgBytes, out var imgMime))
                {
                    return new HttpResponseMessage(HttpStatusCode.BadRequest)
                    {
                        Content = new StringContent("{\"error\":{\"message\":\"initImageBase64 无效\"}}", Encoding.UTF8, "application/json")
                    };
                }
                if (imgBytes.Length > 10 * 1024 * 1024)
                {
                    return new HttpResponseMessage(HttpStatusCode.RequestEntityTooLarge)
                    {
                        Content = new StringContent("{\"error\":{\"message\":\"initImageBase64 图片过大（上限 10MB）\"}}", Encoding.UTF8, "application/json")
                    };
                }

                var mp = new MultipartFormDataContent();
                var imgContent = new ByteArrayContent(imgBytes);
                imgContent.Headers.ContentType = new MediaTypeHeaderValue(string.IsNullOrWhiteSpace(imgMime) ? "image/png" : imgMime);
                mp.Add(imgContent, "image", "init.png");

                // 图生图请求：从 reqObj 提取字段构建 multipart/form-data
                // 支持适配器返回的类型或旧的强类型对象
                void AddEditField(string name, string? value)
                {
                    if (!string.IsNullOrWhiteSpace(value))
                        mp.Add(new StringContent(value), name);
                }
                void AddEditFieldInt(string name, int value) => mp.Add(new StringContent(value.ToString()), name);
                void AddEditFieldBool(string name, bool? value)
                {
                    if (value.HasValue)
                        mp.Add(new StringContent(value.Value ? "true" : "false"), name);
                }

                switch (reqObj)
                {
                    case Adapters.VolcesImageEditRequest ver:
                        AddEditField("model", ver.Model);
                        AddEditField("prompt", ver.Prompt);
                        AddEditFieldInt("n", ver.N);
                        AddEditField("size", ver.Size);
                        AddEditField("response_format", ver.ResponseFormat);
                        AddEditFieldBool("watermark", ver.Watermark);
                        break;
                    case Adapters.OpenAIImageEditRequest oer:
                        AddEditField("model", oer.Model);
                        AddEditField("prompt", oer.Prompt);
                        AddEditFieldInt("n", oer.N);
                        AddEditField("size", oer.Size);
                        AddEditField("response_format", oer.ResponseFormat);
                        break;
                    case VolcesImageEditRequest ver:
                        AddEditField("model", ver.Model);
                        AddEditField("prompt", ver.Prompt);
                        AddEditFieldInt("n", ver.N);
                        AddEditField("size", ver.Size);
                        AddEditField("response_format", ver.ResponseFormat);
                        AddEditFieldBool("watermark", ver.Watermark);
                        break;
                    case OpenAIImageEditRequest oer:
                        AddEditField("model", oer.Model);
                        AddEditField("prompt", oer.Prompt);
                        AddEditFieldInt("n", oer.N);
                        AddEditField("size", oer.Size);
                        AddEditField("response_format", oer.ResponseFormat);
                        break;
                    default:
                        _logger.LogWarning("Unexpected reqObj type for image edit: {Type}", reqObj.GetType().Name);
                        break;
                }

                // === [DEBUG] Log the img2img request being sent to image generation API ===
                _logger.LogInformation(
                    "[OpenAIImageClient] Sending img2img request to image gen API:\n" +
                    "  Endpoint: {Endpoint}\n" +
                    "  Model: {Model}\n" +
                    "  Provider: {Provider}\n" +
                    "  Prompt: {Prompt}\n" +
                    "  InitImage Size: {ImageSize} bytes\n" +
                    "  RequestType: multipart/form-data (img2img)",
                    targetUriInner.ToString(),
                    effectiveModelName,
                    providerForLog,
                    prompt.Length > 200 ? prompt[..200] + "..." : prompt,
                    imgBytes.Length);

                return await httpClient.PostAsync(targetUriInner, mp, token);
            }

            resp = await SendOnceAsync(ct);

            // 平台特定的尺寸错误处理：使用适配器自动修正
            if (initImageBase64 == null && resp.StatusCode == HttpStatusCode.BadRequest)
            {
                var firstBody = await resp.Content.ReadAsStringAsync(ct);
                if (TryExtractUpstreamErrorMessage(firstBody ?? string.Empty, out var errMsg))
                {
                    var currentSize = GetCurrentRequestedSizeForRetry(reqObj, initImageBase64);
                    var suggestedSize = platformAdapter.HandleSizeError(errMsg, currentSize);
                    
                    if (!string.IsNullOrEmpty(suggestedSize))
                    {
                        SetRequestedSizeForRetry(reqObj, initImageBase64, suggestedSize);
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
                else
                {
                    // 无法提取错误消息时，也需要把 body 还回去（避免后续重复读取空内容）
                    resp.Dispose();
                    resp = new HttpResponseMessage(HttpStatusCode.BadRequest)
                    {
                        Content = new StringContent(firstBody ?? string.Empty, Encoding.UTF8, "application/json"),
                        RequestMessage = httpClient.BaseAddress != null ? new HttpRequestMessage(HttpMethod.Post, httpClient.BaseAddress) : null
                    };
                }
            }

            // 非 Volces：某些 OpenAI 兼容网关会对 size 采用“白名单尺寸”校验（例如 1664*928,...），
            // 若命中该错误则自动从错误文案中提取允许尺寸，按目标比例选最近尺寸并重试一次。
            if (!isVolces && resp.StatusCode == HttpStatusCode.BadRequest)
            {
                var firstBody = await resp.Content.ReadAsStringAsync(ct);
                if (TryExtractUpstreamErrorMessage(firstBody ?? string.Empty, out var errMsg2) &&
                    LooksLikeAllowedSizeWhitelistError(errMsg2) &&
                    TryParseAllowedSizes(errMsg2, out var allowed) &&
                    allowed.Count > 0)
                {
                    allowedSizesForLog = allowed
                        .Select(x => $"{x.W}x{x.H}")
                        .Select(NormalizeSizeString)
                        .Where(x => !string.IsNullOrWhiteSpace(x))
                        .Select(x => x!)
                        .Distinct(StringComparer.OrdinalIgnoreCase)
                        .Take(64)
                        .ToList();

                    // 学习并写入缓存（旁路，不影响主流程）
                    _ = TryUpsertSizeCapsAsync(capsKey, allowed.Select(x => $"{x.W}x{x.H}").ToList(), ct);

                    var currentSize = GetCurrentRequestedSizeForRetry(reqObj, initImageBase64);
                    var target = TryParseSize(currentSize, out var tw, out var th) ? new Size2D(tw, th) : (Size2D?)null;
                    target ??= new Size2D(1024, 1024); // prefer_medium 兜底
                    var chosen = ChooseClosestAllowedSize(target, allowed);
                    var chosenStr = $"{chosen.W}x{chosen.H}";
                    if (!string.Equals(NormalizeSizeString(currentSize), NormalizeSizeString(chosenStr), StringComparison.OrdinalIgnoreCase))
                    {
                        // 将第一次响应“还回去”给统一处理前，先尝试一次自动修正重试
                        SetRequestedSizeForRetry(reqObj, initImageBase64, chosenStr);
                        // 注意：不能用 MarkError 写“尺寸替换”，否则会把日志状态置为 failed 并写入 Error 字段。
                        // 真实的“本次替换信息”会在 MarkDone 的 AnswerText（summary）与 API meta 中落库/返回。
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
            // 5xx：优先透出上游错误（含 request id），便于定位“token/鉴权”类问题
            var msg5xx = TryExtractUpstreamErrorMessage(body ?? string.Empty, out var em3)
                ? $"生图失败：{em3}"
                : $"生图失败：HTTP {(int)resp.StatusCode}";
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.LLM_ERROR, msg5xx);
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
            // 强约束：不把 base64 写入 Mongo；输出统一 re-host 到 COS（返回稳定 URL）

            // 根据调用方传入的 appKey 查找水印配置（不传则不打水印）
            var watermarkConfig = string.IsNullOrWhiteSpace(appKey) ? null : await TryGetWatermarkConfigAsync(appKey, ct);
            _logger.LogInformation("ImageGen watermark config resolved: {HasWatermark}", watermarkConfig != null);
            var cosInfos = new List<object>();
            for (var i = 0; i < images.Count; i++)
            {
                byte[]? bytes = null;
                var outMime = "image/png";

                if (!string.IsNullOrWhiteSpace(images[i].Base64))
                {
                    try
                    {
                        bytes = Convert.FromBase64String(images[i].Base64!);
                    }
                    catch
                    {
                        bytes = null;
                    }
                }
                else if (!string.IsNullOrWhiteSpace(images[i].Url))
                {
                    var dl = await TryDownloadImageBytesAsync(images[i].Url!, ct);
                    if (dl.bytes != null && dl.bytes.Length > 0)
                    {
                        bytes = dl.bytes;
                        if (!string.IsNullOrWhiteSpace(dl.mime)) outMime = dl.mime!;
                    }
                }

                if (bytes == null || bytes.Length == 0) continue;

                // 1. 原图保存到 visual-agent 目录（核心数据，不会删除）
                var stored = await _assetStorage.SaveAsync(bytes, outMime, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);

                // 2. 默认展示原图 URL
                var displayUrl = stored.Url;

                // 3. 如果有水印配置，生成水印图保存到 watermark 目录（仅用于展示）
                if (watermarkConfig != null)
                {
                    try
                    {
                        _logger.LogInformation("Applying watermark to image index {Index}. FontKey={FontKey}", images[i].Index, watermarkConfig.FontKey);
                        var rendered = await _watermarkRenderer.ApplyAsync(bytes, outMime, watermarkConfig, ct);
                        var watermarkedStored = await _assetStorage.SaveAsync(rendered.bytes, rendered.mime, ct, domain: AppDomainPaths.DomainWatermark, type: AppDomainPaths.TypeImg);
                        displayUrl = watermarkedStored.Url;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to apply watermark. Using original image for display.");
                    }
                }

                // 4. Url = 展示用（有水印时是 watermark 目录，无水印时是 imagemaster 目录）
                //    OriginalUrl/OriginalSha256 = 原图（imagemaster 目录），用于参考图查找
                images[i].Url = displayUrl;
                images[i].Base64 = null;
                images[i].OriginalUrl = stored.Url;
                images[i].OriginalSha256 = stored.Sha256;

                // 尺寸：优先使用本次请求最终 size（若解析失败则为 0）
                var sizeStr = NormalizeSizeString(size);
                var okDim = TryParseSize(sizeStr, out var w0, out var h0);
                var output = new UploadArtifact
                {
                    Id = Guid.NewGuid().ToString("N"),
                    RequestId = requestId,
                    Kind = "output_image",
                    CreatedByAdminId = createdByAdminId,
                    Prompt = prompt,
                    RelatedInputIds = inputArtifactIds.Count > 0 ? inputArtifactIds.ToList() : null,
                    Sha256 = stored.Sha256,
                    Mime = stored.Mime,
                    Width = okDim ? w0 : 0,
                    Height = okDim ? h0 : 0,
                    SizeBytes = stored.SizeBytes,
                    CosUrl = stored.Url,
                    CreatedAt = DateTime.UtcNow
                };
                await _db.UploadArtifacts.InsertOneAsync(output, cancellationToken: ct);

                // 写一份用于 LLM 日志摘要展示（不宜过大）
                cosInfos.Add(new { index = images[i].Index, url = stored.Url, sha256 = stored.Sha256, mime = stored.Mime, sizeBytes = stored.SizeBytes });
            }

            if (logId != null)
            {
                var endedAt = DateTime.UtcNow;
                    var respContentType = resp.Content.Headers.ContentType?.MediaType;
                // 从请求对象中提取 responseFormat 和 size 用于日志
                string? responseFormatForLog = null;
                string? sizeForLog = null;
                if (reqObj is Dictionary<string, object> logDict)
                {
                    responseFormatForLog = logDict.TryGetValue("response_format", out var rf) ? rf?.ToString() : null;
                    sizeForLog = logDict.TryGetValue("size", out var sz) ? sz?.ToString() : null;
                }
                else
                {
                    // Fallback: 兼容强类型对象
                    responseFormatForLog = reqObj switch
                    {
                        Adapters.VolcesImageEditRequest ver => ver.ResponseFormat,
                        Adapters.OpenAIImageEditRequest oer => oer.ResponseFormat,
                        VolcesImageRequest vr => vr.ResponseFormat,
                        OpenAIImageRequest orr => orr.ResponseFormat,
                        VolcesImageEditRequest ver => ver.ResponseFormat,
                        OpenAIImageEditRequest oer => oer.ResponseFormat,
                        _ => null
                    };
                    sizeForLog = reqObj switch
                    {
                        Adapters.VolcesImageEditRequest ver => ver.Size,
                        Adapters.OpenAIImageEditRequest oer => oer.Size,
                        VolcesImageRequest vr => vr.Size,
                        OpenAIImageRequest orr => orr.Size,
                        VolcesImageEditRequest ver => ver.Size,
                        OpenAIImageEditRequest oer => oer.Size,
                        _ => null
                    };
                }
                var effectiveSizeNormForLog = NormalizeSizeString(sizeForLog);
                var sizeAdjustedForLog = !string.IsNullOrWhiteSpace(requestedSizeNorm) &&
                                         !string.IsNullOrWhiteSpace(effectiveSizeNormForLog) &&
                                         !string.Equals(requestedSizeNorm, effectiveSizeNormForLog, StringComparison.OrdinalIgnoreCase);
                var ratioAdjustedForLog = IsRatioAdjusted(requestedSizeNorm, effectiveSizeNormForLog, threshold: 0.02);
                var sizeAdjustmentNote = (sizeAdjustedForLog && !string.IsNullOrWhiteSpace(requestedSizeRaw) && !string.IsNullOrWhiteSpace(sizeForLog))
                    ? $"本次尺寸替换：{requestedSizeRaw} -> {sizeForLog}"
                    : null;
                    var upstreamBodyPreview = RedactAndTruncateSuccessResponseBody(body ?? string.Empty, respContentType);
                var summary = new
                {
                    images = images.Count,
                    responseFormat = responseFormatForLog,
                    size = sizeForLog,
                    requestedSize = requestedSizeRaw,
                    effectiveSize = sizeForLog,
                    sizeAdjusted = sizeAdjustedForLog,
                    ratioAdjusted = ratioAdjustedForLog,
                    sizeAdjustmentNote,
                    allowedSizes = allowedSizesForLog,
                    initImageProvided = initImageProvidedForLog,
                    initImageUsed = initImageUsedForCall,
                        upstreamBodyPreview,
                        upstreamBodyPreviewHash = LlmLogRedactor.Sha256Hex(upstreamBodyPreview),
                        upstreamBodyChars = body?.Length ?? 0,
                        upstreamContentType = respContentType,
                    // 不记录 base64 内容；仅记录是否返回
                    hasBase64 = false,
                    hasUrl = images.Any(x => !string.IsNullOrWhiteSpace(x.Url)),
                    cos = cosInfos.Take(10).ToArray(),
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

            var finalSize = GetCurrentRequestedSizeForRetry(reqObj, initImageBase64);
            var effectiveSize = string.IsNullOrWhiteSpace(finalSize) ? null : finalSize.Trim();
            var effectiveSizeNorm = NormalizeSizeString(effectiveSize);
            var sizeAdjusted = !string.IsNullOrWhiteSpace(requestedSizeNorm) &&
                               !string.IsNullOrWhiteSpace(effectiveSizeNorm) &&
                               !string.Equals(requestedSizeNorm, effectiveSizeNorm, StringComparison.OrdinalIgnoreCase);
            var ratioAdjusted = IsRatioAdjusted(requestedSizeNorm, effectiveSizeNorm, threshold: 0.02);

            return ApiResponse<ImageGenResult>.Ok(new ImageGenResult
            {
                Images = images,
                Meta = new ImageGenResultMeta
                {
                    RequestedSize = requestedSizeRaw,
                    EffectiveSize = effectiveSize,
                    SizeAdjusted = sizeAdjusted,
                    RatioAdjusted = ratioAdjusted,
                    SizeAdjustmentNote = sizeAdjusted && !string.IsNullOrWhiteSpace(requestedSizeRaw) && !string.IsNullOrWhiteSpace(effectiveSize)
                        ? $"本次尺寸替换：{requestedSizeRaw} -> {effectiveSize}"
                        : null
                }
            });
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

    /// <summary>
    /// 使用 Vision API 生成图片（支持多图参考）
    /// 通过 /v1/chat/completions 端点，发送多张图片给支持 Vision 的模型
    /// </summary>
    /// <param name="prompt">用户提示词（包含 @imgN 引用）</param>
    /// <param name="imageRefs">已加载的图片引用列表（按出现顺序）</param>
    /// <param name="size">期望尺寸（如 1024x1024）</param>
    /// <param name="ct">取消令牌</param>
    /// <param name="modelId">模型 ID（可选）</param>
    /// <param name="platformId">平台 ID（可选）</param>
    /// <param name="modelName">模型名称（平台回退时使用）</param>
    /// <param name="appKey">应用标识</param>
    /// <returns>生成结果</returns>
    public async Task<ApiResponse<ImageGenResult>> GenerateWithVisionAsync(
        string prompt,
        List<Core.Models.MultiImage.ImageRefData> imageRefs,
        string? size,
        CancellationToken ct,
        string? modelId = null,
        string? platformId = null,
        string? modelName = null,
        string? appKey = null)
    {
        if (string.IsNullOrWhiteSpace(prompt))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空");
        }

        if (imageRefs == null || imageRefs.Count == 0)
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.CONTENT_EMPTY, "imageRefs 不能为空（Vision API 需要至少一张图片）");
        }

        // Vision API 限制：最多 6 张图片
        const int MaxImages = 6;
        if (imageRefs.Count > MaxImages)
        {
            _logger.LogWarning("[Vision API] 图片数量超过限制({Max}张)，将只使用前{Max}张", MaxImages, MaxImages);
            imageRefs = imageRefs.Take(MaxImages).ToList();
        }

        var startedAt = DateTime.UtcNow;
        var ctx = _ctxAccessor?.Current;
        var requestId = (ctx?.RequestId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(requestId)) requestId = Guid.NewGuid().ToString("N");

        // 解析模型和平台配置
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
            model = await _db.LLMModels.Find(m => m.Id == requestedModelId && m.Enabled).FirstOrDefaultAsync(ct);
            if (model == null && !string.IsNullOrWhiteSpace(requestedPlatformId))
            {
                platform = await _db.LLMPlatforms.Find(p => p.Id == requestedPlatformId && p.Enabled).FirstOrDefaultAsync(ct);
                if (platform == null)
                {
                    return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "指定的平台不存在或未启用");
                }
                requestedModelName ??= requestedModelId;
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
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "未配置可用的生图模型");
        }

        var jwtSecret = _config["Jwt:Secret"] ?? "DefaultEncryptionKey32Bytes!!!!";
        string? apiUrl;
        string? apiKey;
        string effectiveModelName;
        string? platformIdForLog = null;
        string? platformNameForLog = null;

        if (model != null)
        {
            var cfg = await ResolveApiConfigForModelAsync(model, jwtSecret, ct);
            apiUrl = cfg.apiUrl;
            apiKey = cfg.apiKey;
            effectiveModelName = model.ModelName;
            platformIdForLog = model.PlatformId;
            if (!string.IsNullOrWhiteSpace(model.PlatformId))
            {
                var plt = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync(ct);
                platformNameForLog = plt?.Name;
            }
        }
        else
        {
            apiUrl = platform!.ApiUrl;
            apiKey = string.IsNullOrEmpty(platform.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
            effectiveModelName = requestedModelName ?? string.Empty;
            platformIdForLog = platform.Id;
            platformNameForLog = platform.Name;
            if (string.IsNullOrWhiteSpace(effectiveModelName))
            {
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "未提供 modelName");
            }
        }

        if (string.IsNullOrWhiteSpace(apiUrl) || string.IsNullOrWhiteSpace(apiKey))
        {
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "Vision API 配置不完整");
        }

        // 构建端点 URL（使用 chat/completions）
        var endpoint = OpenAICompatUrl.BuildEndpoint(apiUrl, "chat/completions");
        Uri? endpointUri = null;
        try { endpointUri = new Uri(endpoint); } catch { /* 忽略解析失败 */ }

        // 数据库日志记录
        string? logId = null;
        if (_logWriter != null)
        {
            // 构建日志用的请求体（不含完整 base64）
            var logRequestBody = JsonSerializer.Serialize(new
            {
                model = effectiveModelName,
                max_tokens = 4096,
                image_count = imageRefs.Count,
                image_refs = imageRefs.Select((img, idx) => new
                {
                    position = idx + 1,
                    ref_id = img.RefId,
                    label = img.Label,
                    mime = img.MimeType,
                    base64_length = img.Base64.Length
                }),
                prompt_preview = prompt.Length > 500 ? prompt[..500] + "..." : prompt,
                request_type = "vision-multi-image"
            });
            var reqLogJson = LlmLogRedactor.RedactJson(logRequestBody);

            logId = await _logWriter.StartAsync(
                new LlmLogStart(
                    RequestId: requestId,
                    Provider: "openai-vision",
                    Model: effectiveModelName,
                    ApiBase: endpointUri != null && endpointUri.IsAbsoluteUri ? $"{endpointUri.Scheme}://{endpointUri.Host}/" : null,
                    Path: endpointUri != null && endpointUri.IsAbsoluteUri ? endpointUri.AbsolutePath.TrimStart('/') : "v1/chat/completions",
                    HttpMethod: "POST",
                    RequestHeadersRedacted: new Dictionary<string, string>
                    {
                        ["content-type"] = "application/json",
                        ["Authorization"] = $"Bearer {LlmLogRedactor.RedactApiKey(apiKey)}"
                    },
                    RequestBodyRedacted: reqLogJson,
                    RequestBodyHash: LlmLogRedactor.Sha256Hex(reqLogJson),
                    QuestionText: prompt.Trim(),
                    SystemPromptChars: null,
                    SystemPromptHash: null,
                    SystemPromptText: null,
                    MessageCount: imageRefs.Count,
                    GroupId: ctx?.GroupId,
                    SessionId: ctx?.SessionId,
                    UserId: ctx?.UserId,
                    ViewRole: ctx?.ViewRole,
                    DocumentChars: null,
                    DocumentHash: null,
                    UserPromptChars: prompt.Trim().Length,
                    StartedAt: startedAt,
                    RequestType: "visionImageGen",
                    RequestPurpose: ctx?.RequestPurpose ?? "prd-agent-web::vision-image-gen",
                    PlatformId: platformIdForLog,
                    PlatformName: platformNameForLog,
                    ModelResolutionType: ctx?.ModelResolutionType,
                    ModelGroupId: ctx?.ModelGroupId,
                    ModelGroupName: ctx?.ModelGroupName),
                ct);
        }

        // 构建 Vision API 请求
        var visionRequest = new Core.Models.MultiImage.VisionRequest
        {
            Model = effectiveModelName,
            MaxTokens = 4096,
            Messages = new List<Core.Models.MultiImage.VisionMessage>
            {
                new()
                {
                    Role = "user",
                    Content = BuildVisionContent(prompt, imageRefs)
                }
            }
        };

        // 构建端点 URL（使用 chat/completions）
        var endpoint = OpenAICompatUrl.BuildEndpoint(apiUrl, "chat/completions");

        // 序列化请求体
        var requestJson = JsonSerializer.Serialize(visionRequest, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        });

        // 构建清晰的请求日志（不含 base64，便于调试）
        var imageOrderLog = new StringBuilder();
        imageOrderLog.AppendLine($"  图片总数: {imageRefs.Count}");
        imageOrderLog.AppendLine("  图片顺序 (与 Vision API content 数组顺序一致):");
        for (int i = 0; i < imageRefs.Count; i++)
        {
            var img = imageRefs[i];
            var base64Preview = img.Base64.Length > 50 ? img.Base64[..50] + "..." : img.Base64;
            imageOrderLog.AppendLine($"    [{i + 1}] @img{img.RefId} = \"{img.Label}\" ({img.MimeType}, {img.Base64.Length} chars)");
        }

        // 构建可读的请求结构（不含完整 base64）
        var prettyRequest = new
        {
            model = effectiveModelName,
            max_tokens = 4096,
            messages = new[]
            {
                new
                {
                    role = "user",
                    content_structure = new object[]
                    {
                        new { type = "text", text_preview = prompt.Length > 300 ? prompt[..300] + "..." : prompt }
                    }.Concat(imageRefs.Select((img, idx) => (object)new
                    {
                        type = "image_url",
                        position = idx + 1,
                        ref_id = $"@img{img.RefId}",
                        label = img.Label,
                        mime = img.MimeType,
                        base64_length = img.Base64.Length
                    })).ToArray()
                }
            }
        };
        var prettyRequestJson = JsonSerializer.Serialize(prettyRequest, new JsonSerializerOptions { WriteIndented = true });

        _logger.LogInformation(
            "\n========== [Vision API 多图请求] ==========\n" +
            "【基本信息】\n" +
            "  Endpoint: {Endpoint}\n" +
            "  Model: {Model}\n" +
            "  Platform: {Platform}\n" +
            "\n【图片映射关系】\n{ImageOrder}" +
            "\n【发送给大模型的提示词】\n{Prompt}\n" +
            "\n【请求结构 (不含 base64)】\n{PrettyRequest}\n" +
            "============================================",
            endpoint,
            effectiveModelName,
            platformNameForLog ?? platformIdForLog ?? "unknown",
            imageOrderLog.ToString(),
            prompt,
            prettyRequestJson);

        try
        {
            var httpClient = _httpClientFactory.CreateClient();
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            httpClient.Timeout = TimeSpan.FromSeconds(120); // 多图处理可能需要更长时间

            var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
            var resp = await httpClient.PostAsync(endpoint, content, ct);
            var respBody = await resp.Content.ReadAsStringAsync(ct);

            _logger.LogInformation(
                "[OpenAIImageClient] Vision API response:\n" +
                "  StatusCode: {StatusCode}\n" +
                "  ResponseBody (truncated): {ResponseBody}",
                (int)resp.StatusCode,
                respBody.Length > 500 ? respBody[..500] + "..." : respBody);

            if (!resp.IsSuccessStatusCode)
            {
                var errorMsg = TryExtractUpstreamErrorMessage(respBody, out var errMsg)
                    ? $"Vision API 错误: {errMsg}"
                    : $"Vision API 请求失败: {resp.StatusCode}";
                _logWriter?.MarkError(logId, errorMsg, (int)resp.StatusCode);
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.LLM_ERROR, errorMsg);
            }

            // 解析响应
            var visionResp = JsonSerializer.Deserialize<Core.Models.MultiImage.VisionResponse>(respBody, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });

            if (visionResp?.Choices == null || visionResp.Choices.Count == 0)
            {
                _logWriter?.MarkError(logId, "Vision API 响应无效（无 choices）");
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "Vision API 响应无效（无 choices）");
            }

            var responseContent = visionResp.Choices[0].Message?.Content;
            if (string.IsNullOrWhiteSpace(responseContent))
            {
                _logWriter?.MarkError(logId, "Vision API 响应无效（无内容）");
                return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, "Vision API 响应无效（无内容）");
            }

            // 解析响应中的图片（可能是 base64、URL 或 Markdown 格式）
            var images = new List<ImageGenImage>();
            if (responseContent.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
            {
                // Base64 格式
                images.Add(new ImageGenImage
                {
                    Index = 0,
                    Base64 = responseContent
                });
            }
            else if (responseContent.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                // URL 格式
                images.Add(new ImageGenImage
                {
                    Index = 0,
                    Url = responseContent.Trim()
                });
            }
            else if (TryExtractMarkdownImageUrl(responseContent, out var mdUrl))
            {
                // Markdown 图片格式: ![alt](url)
                _logger.LogInformation("[Vision API] 解析到 Markdown 图片格式，提取 URL: {Url}", mdUrl);
                images.Add(new ImageGenImage
                {
                    Index = 0,
                    Url = mdUrl
                });
            }
            else
            {
                // 尝试从 JSON 响应中提取图片
                try
                {
                    var jsonNode = JsonNode.Parse(responseContent);
                    if (jsonNode?["url"] != null)
                    {
                        images.Add(new ImageGenImage
                        {
                            Index = 0,
                            Url = jsonNode["url"]?.GetValue<string>()
                        });
                    }
                    else if (jsonNode?["b64_json"] != null)
                    {
                        images.Add(new ImageGenImage
                        {
                            Index = 0,
                            Base64 = $"data:image/png;base64,{jsonNode["b64_json"]?.GetValue<string>()}"
                        });
                    }
                    else
                    {
                        // 响应可能是文本描述而非图片
                        var errMsg = $"Vision API 响应不包含图片数据: {(responseContent.Length > 100 ? responseContent[..100] + "..." : responseContent)}";
                        _logger.LogWarning("[Vision API] 响应不包含图片数据，可能是文本响应: {Content}",
                            responseContent.Length > 200 ? responseContent[..200] + "..." : responseContent);
                        _logWriter?.MarkError(logId, errMsg);
                        return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, errMsg);
                    }
                }
                catch
                {
                    // 非 JSON 格式，可能是纯文本响应
                    var errMsg = $"Vision API 响应格式不支持: {(responseContent.Length > 100 ? responseContent[..100] + "..." : responseContent)}";
                    _logger.LogWarning("[Vision API] 无法解析响应为图片: {Content}",
                        responseContent.Length > 200 ? responseContent[..200] + "..." : responseContent);
                    _logWriter?.MarkError(logId, errMsg);
                    return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INVALID_FORMAT, errMsg);
                }
            }

            var endedAt = DateTime.UtcNow;
            var durationMs = (long)(endedAt - startedAt).TotalMilliseconds;

            _logger.LogInformation(
                "[OpenAIImageClient] Vision API 生成成功:\n" +
                "  ImageCount: {ImageCount}\n" +
                "  Duration: {Duration}ms",
                images.Count,
                durationMs);

            // 记录成功日志
            if (logId != null)
            {
                var resultUrl = images.FirstOrDefault()?.Url ?? images.FirstOrDefault()?.Base64?[..Math.Min(100, images.FirstOrDefault()?.Base64?.Length ?? 0)];
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
                        AnswerText: $"[Vision API 生成成功] {images.Count} 张图片, URL: {resultUrl}",
                        AssembledTextChars: respBody.Length,
                        AssembledTextHash: LlmLogRedactor.Sha256Hex(respBody),
                        Status: "succeeded",
                        EndedAt: endedAt,
                        DurationMs: durationMs));
            }

            return ApiResponse<ImageGenResult>.Ok(new ImageGenResult
            {
                Images = images,
                Meta = new ImageGenResultMeta
                {
                    RequestedSize = size,
                    EffectiveSize = size
                }
            });
        }
        catch (HttpRequestException ex)
        {
            _logger.LogError(ex, "[Vision API] 网络请求失败");
            _logWriter?.MarkError(logId, $"Vision API 网络请求失败: {ex.Message}");
            return ApiResponse<ImageGenResult>.Fail("NETWORK_ERROR", ex.Message);
        }
        catch (TaskCanceledException ex) when (ex.CancellationToken == ct)
        {
            _logger.LogWarning("[Vision API] 请求被取消");
            _logWriter?.MarkError(logId, "Vision API 请求被取消");
            return ApiResponse<ImageGenResult>.Fail("CANCELLED", "请求被取消");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[Vision API] 未知错误");
            _logWriter?.MarkError(logId, $"Vision API 未知错误: {ex.Message}");
            return ApiResponse<ImageGenResult>.Fail(ErrorCodes.INTERNAL_ERROR, ex.Message);
        }
    }

    /// <summary>
    /// 构建 Vision API 的 content 数组（text + 多个 image_url）
    /// </summary>
    private static List<Core.Models.MultiImage.VisionContentItem> BuildVisionContent(
        string prompt,
        List<Core.Models.MultiImage.ImageRefData> imageRefs)
    {
        var content = new List<Core.Models.MultiImage.VisionContentItem>
        {
            // 首先添加文本提示词
            new Core.Models.MultiImage.VisionTextContent { Text = prompt }
        };

        // 按传入顺序添加图片（调用方已按 OccurrenceOrder 排序，与【图片对照表】一致）
        foreach (var imgRef in imageRefs)
        {
            content.Add(new Core.Models.MultiImage.VisionImageContent
            {
                ImageUrl = new Core.Models.MultiImage.VisionImageUrl
                {
                    Url = imgRef.Base64 // 完整格式：data:mime;base64,...
                }
            });
        }

        return content;
    }

    /// <summary>
    /// 尝试从 Markdown 图片格式中提取 URL
    /// 支持格式: ![alt](url) 或 ![](url)
    /// </summary>
    private static bool TryExtractMarkdownImageUrl(string content, out string url)
    {
        url = string.Empty;
        if (string.IsNullOrWhiteSpace(content)) return false;

        // 匹配 Markdown 图片格式: ![任意文本](URL)
        var match = Regex.Match(content, @"!\[.*?\]\((https?://[^\s\)]+)\)");
        if (match.Success && match.Groups.Count > 1)
        {
            url = match.Groups[1].Value.Trim();
            return !string.IsNullOrEmpty(url);
        }

        return false;
    }

    private async Task<(string? apiUrl, string? apiKey, string? platformType)> ResolveApiConfigForModelAsync(
        LLMModel model,
        string jwtSecret,
        CancellationToken ct)
    {
        string? apiUrl = model.ApiUrl;
        string? apiKey = string.IsNullOrEmpty(model.ApiKeyEncrypted) ? null : ApiKeyCrypto.Decrypt(model.ApiKeyEncrypted, jwtSecret);
        string? platformType = null;

        if (model.PlatformId != null)
        {
            var platform = await _db.LLMPlatforms.Find(p => p.Id == model.PlatformId).FirstOrDefaultAsync(ct);
            platformType = platform?.PlatformType?.ToLowerInvariant();
            if (platform != null && (string.IsNullOrEmpty(apiUrl) || string.IsNullOrEmpty(apiKey)))
            {
                apiUrl ??= platform.ApiUrl;
                apiKey ??= ApiKeyCrypto.Decrypt(platform.ApiKeyEncrypted, jwtSecret);
            }
        }

        return (apiUrl, apiKey, platformType);
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

    public static string GetImagesEditEndpoint(string apiUrl)
    {
        if (IsVolcesImagesApi(apiUrl))
        {
            return BuildVolcesEndpoint(apiUrl, "images/edits");
        }
        return OpenAICompatUrl.BuildEndpoint(apiUrl, "images/edits");
    }

    private static bool TryDecodeDataUrlOrBase64(string raw, out byte[] bytes, out string mime)
    {
        bytes = Array.Empty<byte>();
        mime = "image/png";
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return false;

        if (s.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = s.IndexOf(',');
            if (comma < 0) return false;
            var header = s.Substring(5, comma - 5);
            var payload = s[(comma + 1)..];
            var semi = header.IndexOf(';');
            var ct = semi >= 0 ? header[..semi] : header;
            if (!string.IsNullOrWhiteSpace(ct)) mime = ct.Trim();
            s = payload.Trim();
        }

        try
        {
            bytes = Convert.FromBase64String(s);
            if (bytes.Length >= 12)
            {
                if (bytes[0] == 0xFF && bytes[1] == 0xD8) mime = "image/jpeg";
                else if (bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) mime = "image/png";
                else if (bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) mime = "image/gif";
                else if (bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 &&
                         bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50) mime = "image/webp";
            }
            return bytes.Length > 0;
        }
        catch
        {
            return false;
        }
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

    private async Task<(byte[]? bytes, string? mime)> TryDownloadImageBytesAsync(string imageUrl, CancellationToken ct)
    {
        if (!Uri.TryCreate((imageUrl ?? string.Empty).Trim(), UriKind.Absolute, out var uri)) return (null, null);
        if (!IsSafeExternalImageUri(uri)) return (null, null);

        var httpClient = _httpClientFactory.CreateClient("LoggedHttpClient");
        var downloadTimeoutSeconds = _config.GetValue<int?>("LLM:ImageGenDownloadTimeoutSeconds") ?? 120;
        downloadTimeoutSeconds = Math.Clamp(downloadTimeoutSeconds, 30, 3600);
        httpClient.Timeout = TimeSpan.FromSeconds(downloadTimeoutSeconds);
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
                return (null, null);
            }

            var contentType = resp.Content.Headers.ContentType?.MediaType;
            var maxBytes = 15 * 1024 * 1024;
            await using var stream = await resp.Content.ReadAsStreamAsync(ct);
            using var ms = new MemoryStream(capacity: 1024 * 1024);
            await CopyToWithLimitAsync(stream, ms, maxBytes, ct);
            var bytes = ms.ToArray();
            if (bytes.Length == 0) return (null, null);
            var mime = GuessImageMimeType(contentType, bytes);
            return (bytes, mime);
        }
        catch (OperationCanceledException)
        {
            return (null, null);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Image url download failed: host={Host}", uri.Host);
            return (null, null);
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
        if (IsStubAssetUri(uri)) return true;
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

    private static bool IsStubAssetUri(Uri uri)
    {
        if (!uri.AbsolutePath.StartsWith("/api/v1/stub/assets/", StringComparison.OrdinalIgnoreCase)) return false;
        if (string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase)) return true;
        return IPAddress.TryParse(uri.Host, out var ip) && IPAddress.IsLoopback(ip);
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

    private static string RedactAndTruncateSuccessResponseBody(string body, string? contentType)
    {
        var raw = body ?? string.Empty;
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;

        // 生图成功响应里最敏感/最巨大的部分是 b64_json/base64；这里做结构化脱敏与截断
        if (!string.IsNullOrWhiteSpace(contentType) && contentType.Contains("json", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                // JsonNode 便于“删除/替换字段”
                var node = JsonNode.Parse(raw);
                if (node != null)
                {
                    RedactImageResponseNode(node);
                    var s0 = node.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
                    s0 = LlmLogRedactor.RedactJson(s0);
                    s0 = RedactSignedUrls(s0);
                    var maxChars0 = 24000; // 成功响应可比 error 多留一些字段，便于排查
                    if (s0.Length > maxChars0) s0 = s0[..maxChars0] + "...[TRUNCATED]";
                    return s0;
                }
            }
            catch
            {
                // fallthrough
            }
        }

        // 非 JSON 或解析失败：仅做签名 URL 脱敏 + 截断
        var s = RedactSignedUrls(raw);
        var maxChars = 24000;
        if (s.Length > maxChars) s = s[..maxChars] + "...[TRUNCATED]";
        return s;
    }

    private static void RedactImageResponseNode(JsonNode node)
    {
        // 递归遍历所有 object/array，替换 b64_json/base64 等字段为占位符，并对 url 做签名 query 脱敏
        if (node is JsonObject obj)
        {
            // 常见字段：data:[{b64_json, url, revised_prompt, ...}]
            foreach (var kv in obj.ToList())
            {
                var key = kv.Key;
                if (string.IsNullOrWhiteSpace(key)) continue;
                var v = kv.Value;
                if (v == null) continue;

                var keyLower = key.Trim().ToLowerInvariant();
                if (keyLower is "b64_json" or "base64" or "image" or "image_base64")
                {
                    var sv = v.GetValue<string?>();
                    var len = string.IsNullOrWhiteSpace(sv) ? 0 : sv!.Length;
                    obj[key] = $"[REDACTED_BASE64 len={len}]";
                    continue;
                }

                if (keyLower is "url")
                {
                    var sv = v.GetValue<string?>();
                    if (!string.IsNullOrWhiteSpace(sv))
                    {
                        obj[key] = RedactSignedUrls(sv!);
                    }
                    continue;
                }

                RedactImageResponseNode(v);
            }
            return;
        }

        if (node is JsonArray arr)
        {
            foreach (var it in arr)
            {
                if (it != null) RedactImageResponseNode(it);
            }
        }
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

    private readonly record struct Size2D(int W, int H)
    {
        public double Ratio => H == 0 ? 1.0 : (double)W / H;
        public long Area => (long)W * H;
    }

    private static bool LooksLikeAllowedSizeWhitelistError(string message)
    {
        var s = (message ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return false;
        // 兼容你提供的错误：The size does not match the allowed size 1664*928,...
        return s.Contains("allowed size", StringComparison.OrdinalIgnoreCase) ||
               s.Contains("does not match", StringComparison.OrdinalIgnoreCase) && s.Contains("size", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryParseAllowedSizes(string message, out List<Size2D> sizes)
    {
        sizes = new List<Size2D>();
        var s = (message ?? string.Empty);
        if (string.IsNullOrWhiteSpace(s)) return false;

        // 支持：1664*928 / 1664x928 / 1664×928 / 1664＊928
        var matches = Regex.Matches(s, @"(\d{2,5})\s*[*xX×＊]\s*(\d{2,5})");
        foreach (Match m in matches)
        {
            if (!m.Success) continue;
            if (!int.TryParse(m.Groups[1].Value, out var w)) continue;
            if (!int.TryParse(m.Groups[2].Value, out var h)) continue;
            if (w <= 0 || h <= 0) continue;
            // 过滤异常超大值（避免把 request id 等误匹配进去）
            if (w > 16384 || h > 16384) continue;
            sizes.Add(new Size2D(w, h));
        }

        // 去重
        sizes = sizes
            .GroupBy(x => $"{x.W}x{x.H}")
            .Select(g => g.First())
            .OrderBy(x => x.W)
            .ThenBy(x => x.H)
            .ToList();
        return sizes.Count > 0;
    }

    private static string? NormalizeSizeString(string? size)
    {
        if (string.IsNullOrWhiteSpace(size)) return null;
        var s = size.Trim();
        // 统一分隔符
        s = Regex.Replace(s, @"\s*[xX×＊*]\s*", "x");
        return s;
    }

    private static bool TryParseSize(string? size, out int w, out int h)
    {
        w = 0;
        h = 0;
        var s = NormalizeSizeString(size);
        if (string.IsNullOrWhiteSpace(s)) return false;
        var m = Regex.Match(s, @"^\s*(\d{2,5})\s*[xX]\s*(\d{2,5})\s*$");
        if (!m.Success) return false;
        if (!int.TryParse(m.Groups[1].Value, out w)) return false;
        if (!int.TryParse(m.Groups[2].Value, out h)) return false;
        return w > 0 && h > 0;
    }

    private static Size2D ChooseClosestAllowedSize(Size2D? target, List<Size2D> allowed)
    {
        if (allowed == null || allowed.Count == 0) return new Size2D(1024, 1024);
        if (target == null) return allowed[0];

        var tr = target.Value.Ratio;
        var ta = target.Value.Area;

        // 先按比例最接近，其次按面积最接近，其次按 |w-w0|+|h-h0|
        return allowed
            .OrderBy(a => Math.Abs(a.Ratio - tr))
            .ThenBy(a => Math.Abs(a.Area - ta))
            .ThenBy(a => Math.Abs(a.W - target.Value.W) + Math.Abs(a.H - target.Value.H))
            .First();
    }

    private static bool IsRatioAdjusted(string? requestedSizeNorm, string? effectiveSizeNorm, double threshold)
    {
        if (!TryParseSize(requestedSizeNorm, out var rw, out var rh)) return false;
        if (!TryParseSize(effectiveSizeNorm, out var ew, out var eh)) return false;
        if (rw <= 0 || rh <= 0 || ew <= 0 || eh <= 0) return false;
        var r1 = (double)rw / rh;
        var r2 = (double)ew / eh;
        if (!double.IsFinite(r1) || !double.IsFinite(r2)) return false;
        if (r1 <= 0) return false;
        return Math.Abs(r1 - r2) / r1 > threshold;
    }

    private readonly record struct SizeCapsKey(string? ModelId, string? PlatformId, string? ModelNameLower);

    private static SizeCapsKey BuildCapsKey(string? modelId, string? platformId, string? modelName, string effectiveModelName)
    {
        var mid = string.IsNullOrWhiteSpace(modelId) ? null : modelId.Trim();
        if (!string.IsNullOrWhiteSpace(mid)) return new SizeCapsKey(mid, null, null);

        var pid = string.IsNullOrWhiteSpace(platformId) ? null : platformId.Trim();
        var name = string.IsNullOrWhiteSpace(modelName) ? null : modelName.Trim();
        name ??= string.IsNullOrWhiteSpace(effectiveModelName) ? null : effectiveModelName.Trim();
        var lower = string.IsNullOrWhiteSpace(name) ? null : name.ToLowerInvariant();
        return new SizeCapsKey(null, pid, lower);
    }

    private async Task<ImageGenSizeCaps?> TryGetSizeCapsAsync(SizeCapsKey key, CancellationToken ct)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(key.ModelId))
            {
                return await _db.ImageGenSizeCaps.Find(x => x.ModelId == key.ModelId).FirstOrDefaultAsync(ct);
            }
            if (!string.IsNullOrWhiteSpace(key.PlatformId) && !string.IsNullOrWhiteSpace(key.ModelNameLower))
            {
                // 说明：我们在落库时把 ModelName 规范化为 lower，因此这里直接等值匹配
                return await _db.ImageGenSizeCaps.Find(x => x.PlatformId == key.PlatformId && x.ModelName == key.ModelNameLower).FirstOrDefaultAsync(ct);
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private async Task TryUpsertSizeCapsAsync(SizeCapsKey key, List<string> allowedSizes, CancellationToken ct)
    {
        try
        {
            var cleaned = (allowedSizes ?? new List<string>())
                .Select(NormalizeSizeString)
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(64)
                .ToList();
            if (cleaned.Count == 0) return;

            var now = DateTime.UtcNow;
            if (!string.IsNullOrWhiteSpace(key.ModelId))
            {
                // 不依赖 unique：以确定性 Id 写入（仅依赖 _id 唯一）
                var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"mid|{key.ModelId}"))).ToLowerInvariant();
                var doc = new ImageGenSizeCaps
                {
                    Id = id,
                    ModelId = key.ModelId,
                    AllowedSizes = cleaned,
                    Source = "upstream-error",
                    CreatedAt = now,
                    UpdatedAt = now
                };
                await _db.ImageGenSizeCaps.ReplaceOneAsync(x => x.Id == id, doc, new ReplaceOptions { IsUpsert = true }, ct);
                return;
            }

            if (!string.IsNullOrWhiteSpace(key.PlatformId) && !string.IsNullOrWhiteSpace(key.ModelNameLower))
            {
                var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"pid|{key.PlatformId}|mn|{key.ModelNameLower}"))).ToLowerInvariant();
                var doc = new ImageGenSizeCaps
                {
                    Id = id,
                    PlatformId = key.PlatformId,
                    ModelName = key.ModelNameLower,
                    AllowedSizes = cleaned,
                    Source = "upstream-error",
                    CreatedAt = now,
                    UpdatedAt = now
                };
                await _db.ImageGenSizeCaps.ReplaceOneAsync(x => x.Id == id, doc, new ReplaceOptions { IsUpsert = true }, ct);
            }
        }
        catch
        {
            // ignore
        }
    }

    private async Task<WatermarkConfig?> TryGetWatermarkConfigAsync(string appKey, CancellationToken ct)
    {
        _logger.LogInformation("[Watermark Debug] Starting watermark config lookup with appKey={AppKey}", appKey ?? "(null)");

        var userId = (_ctxAccessor?.Current?.UserId ?? string.Empty).Trim();
        _logger.LogInformation("[Watermark Debug] Retrieved userId from context: {UserId}", userId);

        if (string.IsNullOrWhiteSpace(userId))
        {
            _logger.LogWarning("Watermark skipped: missing userId in LLM request context.");
            return null;
        }

        if (string.IsNullOrWhiteSpace(appKey))
        {
            _logger.LogWarning("Watermark skipped: missing appKey.");
            return null;
        }

        _logger.LogInformation("[Watermark Debug] Querying database: UserId={UserId}, AppKey={AppKey}", userId, appKey);

        // 先查询所有该用户的水印配置，用于诊断
        var allConfigs = await _db.WatermarkConfigs
            .Find(x => x.UserId == userId)
            .ToListAsync(ct);

        _logger.LogInformation("[Watermark Debug] Found {Count} watermark configs for user {UserId}", allConfigs.Count, userId);
        foreach (var cfg in allConfigs)
        {
            var appKeysStr = cfg.AppKeys == null ? "null" : string.Join(", ", cfg.AppKeys);
            _logger.LogInformation("[Watermark Debug] Config {ConfigId}: AppKeys=[{AppKeys}]", cfg.Id, appKeysStr);
        }

        var config = await _db.WatermarkConfigs
            .Find(x => x.UserId == userId && x.AppKeys.Contains(appKey))
            .FirstOrDefaultAsync(ct);

        if (config == null)
        {
            _logger.LogWarning("[Watermark Debug] No matching config found! Query was: UserId={UserId} AND AppKeys contains '{AppKey}'", userId, appKey);
            return null;
        }

        _logger.LogInformation("[Watermark Debug] Found matching config: {ConfigId}", config.Id);

        config.FontKey = _fontRegistry.NormalizeFontKey(config.FontKey);
        var (ok, message) = WatermarkSpecValidator.Validate(config, _fontRegistry.FontKeys);
        if (!ok)
        {
            _logger.LogWarning("Invalid watermark config for user {UserId}: {Message}", userId, message);
            return null;
        }

        _logger.LogInformation("Watermark enabled for user {UserId}, app {AppKey}. FontKey={FontKey}", userId, appKey, config.FontKey);
        return config;
    }

    private static string? GetCurrentRequestedSizeForRetry(object reqObj, string? initImageBase64)
    {
        if (initImageBase64 == null)
        {
            // 支持 Dictionary<string, object> 类型（适配器返回的请求对象）
            if (reqObj is Dictionary<string, object> dict)
            {
                if (dict.TryGetValue("size", out var sizeVal) && sizeVal is string sizeStr)
                    return sizeStr;
                return null;
            }
            // Fallback: 兼容旧的强类型请求对象
            return reqObj switch
            {
                OpenAIImageRequest r => r.Size,
                VolcesImageRequest r => r.Size,
                _ => null
            };
        }
        // 图生图请求
        return reqObj switch
        {
            Adapters.VolcesImageEditRequest ver => ver.Size,
            Adapters.OpenAIImageEditRequest oer => oer.Size,
            VolcesImageEditRequest r => r.Size,
            OpenAIImageEditRequest r => r.Size,
            _ => null
        };
    }

    private static void SetRequestedSizeForRetry(object reqObj, string? initImageBase64, string? newSize)
    {
        if (initImageBase64 == null)
        {
            // 支持 Dictionary<string, object> 类型（适配器返回的请求对象）
            if (reqObj is Dictionary<string, object> dict)
            {
                dict["size"] = newSize ?? string.Empty;
                return;
            }
            // Fallback: 兼容旧的强类型请求对象
            switch (reqObj)
            {
                case VolcesImageRequest vr: vr.Size = newSize; break;
                case OpenAIImageRequest orr: orr.Size = newSize; break;
            }
            return;
        }
        // 图生图请求（强类型对象）
        switch (reqObj)
        {
            case Adapters.VolcesImageEditRequest ver: ver.Size = newSize; break;
            case Adapters.OpenAIImageEditRequest oer: oer.Size = newSize; break;
            case VolcesImageEditRequest ver: ver.Size = newSize; break;
            case OpenAIImageEditRequest oer: oer.Size = newSize; break;
        }
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

    private static bool IsLocalStubApi(string apiUrl)
    {
        try
        {
            var raw = (apiUrl ?? string.Empty).Trim().TrimEnd('/');
            if (!Uri.TryCreate(raw, UriKind.Absolute, out var u)) return false;
            var host = (u.Host ?? string.Empty).Trim().ToLowerInvariant();
            if (host != "localhost" && host != "127.0.0.1") return false;
            var path = (u.AbsolutePath ?? string.Empty).Trim().ToLowerInvariant();
            return path.Contains("/api/v1/stub", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }
}

public class ImageGenResult
{
    public List<ImageGenImage> Images { get; set; } = new();
    public ImageGenResultMeta? Meta { get; set; }
}

public class ImageGenImage
{
    public int Index { get; set; }
    public string? Base64 { get; set; }
    public string? Url { get; set; }
    public string? RevisedPrompt { get; set; }
    /// <summary>原图 URL（无水印）。用于作为参考图时避免水印叠加。</summary>
    public string? OriginalUrl { get; set; }
    /// <summary>原图 SHA256。用于参考图查询。</summary>
    public string? OriginalSha256 { get; set; }
}

public class ImageGenResultMeta
{
    public string? RequestedSize { get; set; }
    public string? EffectiveSize { get; set; }
    public bool SizeAdjusted { get; set; }
    public bool RatioAdjusted { get; set; }
    public string? SizeAdjustmentNote { get; set; }
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

internal class OpenAIImageEditRequest
{
    public string? Model { get; set; }
    public string? Prompt { get; set; }
    public int N { get; set; } = 1;
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; }
}

internal class VolcesImageEditRequest
{
    public string? Model { get; set; }
    public string? Prompt { get; set; }
    public int N { get; set; } = 1;
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; }
    public bool? Watermark { get; set; }
}
