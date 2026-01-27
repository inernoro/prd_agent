using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Prompts.Templates;
using PrdAgent.Infrastructure.Services.AssetStorage;
using System.Text.RegularExpressions;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 生图 / 批量生图
/// </summary>
[ApiController]
[Route("api/visual-agent/image-gen")]
[Authorize]
[AdminController("visual-agent", AdminPermissionCatalog.VisualAgentUse)]
public class ImageGenController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IModelDomainService _modelDomain;
    private readonly OpenAIImageClient _imageClient;
    private readonly ISmartModelScheduler _modelScheduler;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<ImageGenController> _logger;
    private readonly IAppSettingsService _settingsService;
    private readonly IAssetStorage _assetStorage;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IRunEventStore _runStore;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public ImageGenController(
        MongoDbContext db,
        IModelDomainService modelDomain,
        OpenAIImageClient imageClient,
        ISmartModelScheduler modelScheduler,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<ImageGenController> logger,
        IAppSettingsService settingsService,
        IAssetStorage assetStorage,
        IHttpClientFactory httpClientFactory,
        IRunEventStore runStore)
    {
        _db = db;
        _modelDomain = modelDomain;
        _imageClient = imageClient;
        _modelScheduler = modelScheduler;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
        _settingsService = settingsService;
        _assetStorage = assetStorage;
        _httpClientFactory = httpClientFactory;
        _runStore = runStore;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    /// <summary>
    /// 批量生图：先用意图模型解析“将生成多少张 + 每张的 prompt”
    /// </summary>
    [HttpPost("plan")]
    [ProducesResponseType(typeof(ApiResponse<ImageGenPlanResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> Plan([FromBody] ImageGenPlanRequest request, CancellationToken ct)
    {
        var text = (request?.Text ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "text 不能为空"));
        }

        // 使用系统配置的字符限制（默认 200k，所有大模型请求输入的字符限制统一来源）
        var settings = await _settingsService.GetSettingsAsync(ct);
        var maxChars = LlmLogLimits.GetRequestBodyMaxChars(settings);
        if (text.Length > maxChars)
        {
            _logger.LogWarning("ImageGen plan text truncated: {OriginalLength} -> {MaxChars}", text.Length, maxChars);
            text = text[..maxChars];
        }

        var maxItems = request?.MaxItems ?? 10;
        maxItems = Math.Clamp(maxItems, 1, 20);

        var hasIntentModel = await _db.LLMModels.Find(m => m.IsIntent && m.Enabled).AnyAsync(ct);
        var usedPurpose = hasIntentModel ? "intent" : "fallbackMain";

        var adminId = GetAdminId();
        var systemPromptOverride = (request?.SystemPromptOverride ?? string.Empty).Trim();
        if (systemPromptOverride.Length > 20_000)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "systemPromptOverride 过长（最多 20000 字符）"));
        }

        var systemPrompt = string.Empty;
        if (!string.IsNullOrWhiteSpace(systemPromptOverride))
        {
            systemPrompt = systemPromptOverride;
        }
        else
        {
            // 读取管理员已保存的覆盖提示词（若存在则优先使用）
            var saved = await _db.AdminPromptOverrides
                .Find(x => x.OwnerAdminId == adminId && x.Key == "imageGenPlan")
                .FirstOrDefaultAsync(ct);
            systemPrompt = !string.IsNullOrWhiteSpace(saved?.PromptText) ? saved!.PromptText : ImageGenPlanPrompt.Build(maxItems);
        }

        try
        {
            var appCallerCode = "prd-agent-web::image-gen.plan";
            var scheduledResult = await _modelScheduler.GetClientWithGroupInfoAsync(appCallerCode, "intent", ct);
            var requestContext = new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: adminId,
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[IMAGE_GEN_PLAN]",
                RequestType: "intent",
                RequestPurpose: appCallerCode,
                ModelResolutionType: scheduledResult.ResolutionType,
                ModelGroupId: scheduledResult.ModelGroupId,
                ModelGroupName: scheduledResult.ModelGroupName);
            
            _logger.LogInformation("ImageGen.Plan: BeginScope with RequestType={RequestType}, RequestPurpose={RequestPurpose}", 
                requestContext.RequestType, requestContext.RequestPurpose);
            
            using var _ = _llmRequestContext.BeginScope(requestContext);

            var client = scheduledResult.Client;
            var messages = new List<LLMMessage> { new() { Role = "user", Content = text } };

            var raw = await CollectToTextAsync(client, systemPrompt, messages, ct);
            var plan = TryParsePlan(raw, maxItems, out var err);
            if (plan == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, err ?? "解析失败"));
            }

            // 统一限制：最多 20 张
            // 允许空清单：当文档中未识别到任何插图提示词时，返回 total=0 items=[]
            if (plan.Total < 0)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "解析失败：total 不合法"));
            }
            if (plan.Total > 20)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, $"单次最多生成 20 张（当前 {plan.Total} 张）"));
            }

            return Ok(ApiResponse<ImageGenPlanResponse>.Ok(new ImageGenPlanResponse
            {
                Total = plan.Total,
                Items = plan.Items,
                UsedPurpose = usedPurpose
            }));
        }
        catch (OperationCanceledException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请求已取消"));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Image plan failed");
            return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "意图模型调用失败"));
        }
    }

    /// <summary>
    /// 生图尺寸白名单缓存（用于前端展示“智能尺寸替换”状态）
    /// </summary>
    [HttpGet("size-caps")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetSizeCaps([FromQuery] bool includeFallback = false, CancellationToken ct = default)
    {
        var filter = includeFallback
            ? Builders<ImageGenSizeCaps>.Filter.Empty
            : Builders<ImageGenSizeCaps>.Filter.Ne(x => x.ModelId, null);

        var items = await _db.ImageGenSizeCaps
            .Find(filter)
            .Project(x => new
            {
                x.ModelId,
                x.PlatformId,
                x.ModelName,
                allowedSizes = x.AllowedSizes,
                allowedCount = x.AllowedSizes.Count,
                x.UpdatedAt
            })
            .SortByDescending(x => x.UpdatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 单张生图（将 prompt 一次性丢给生图模型生成）
    /// </summary>
    [HttpPost("generate")]
    [ProducesResponseType(typeof(ApiResponse<ImageGenResult>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    public async Task<IActionResult> Generate([FromBody] ImageGenGenerateRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var prompt = (request?.Prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(prompt))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "prompt 不能为空"));
        }

        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var modelName = (request?.ModelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelName)) modelName = null;
        var appCallerCode = "prd-agent-web::image-gen.generate";
        ResolvedModelInfo? resolved = null;
        if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(platformId))
        {
            resolved = await _modelScheduler.ResolveModelAsync(appCallerCode, "generation", ct);
            if (resolved != null)
            {
                platformId = resolved.PlatformId;
                modelId = resolved.ModelId;
                if (string.IsNullOrWhiteSpace(modelName)) modelName = resolved.ModelDisplayName;
            }
        }

        // 单次允许一个提示词生成多张（上限 20；与“批量生图总上限”一致）
        var n = request?.N ?? 1;
        n = Math.Clamp(n, 1, 20);

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();
        var initImageBase64 = (request?.InitImageBase64 ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(initImageBase64)) initImageBase64 = null;
        var initImageUrl = (request?.InitImageUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(initImageUrl)) initImageUrl = null;
        var initImageAssetSha256 = (request?.InitImageAssetSha256 ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(initImageAssetSha256)) initImageAssetSha256 = null;

        // 说明：即使后续因“Volces 降级”或其它原因把 initImageBase64 清空，也希望日志能追溯“用户是否提供过参考图”
        var initImageProvided = !string.IsNullOrWhiteSpace(initImageBase64)
                                || !string.IsNullOrWhiteSpace(initImageUrl)
                                || !string.IsNullOrWhiteSpace(initImageAssetSha256);

        // 兼容：允许前端只传 URL / sha，服务端负责下载/读取并转为 base64（避免浏览器 CORS 与性能问题）
        if (initImageBase64 == null && !string.IsNullOrWhiteSpace(initImageAssetSha256))
        {
            var sha = initImageAssetSha256.Trim().ToLowerInvariant();
            if (sha.Length != 64 || !Regex.IsMatch(sha, "^[0-9a-f]{64}$"))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "initImageAssetSha256 格式不正确"));
            }

            // 权限：仅允许使用当前管理员自己的资产 sha
            var owned = await _db.ImageAssets.Find(x => x.OwnerUserId == adminId && x.Sha256 == sha).FirstOrDefaultAsync(ct);
            if (owned == null)
            {
                return StatusCode(StatusCodes.Status403Forbidden, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权使用该参考图"));
            }

            var found = await _assetStorage.TryReadByShaAsync(sha, ct, domain: AppDomainPaths.DomainVisualAgent, type: AppDomainPaths.TypeImg);
            if (found == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "参考图文件不存在或不可用"));
            }
            if (found.Value.bytes.Length > 10 * 1024 * 1024)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "参考图过大（上限 10MB）"));
            }
            var b64 = Convert.ToBase64String(found.Value.bytes);
            var mime = string.IsNullOrWhiteSpace(found.Value.mime) ? "image/png" : found.Value.mime.Trim();
            initImageBase64 = $"data:{mime};base64,{b64}";
        }

        if (initImageBase64 == null && !string.IsNullOrWhiteSpace(initImageUrl))
        {
            if (!TryValidateExternalImageUrl(initImageUrl, out var uri) || uri == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "initImageUrl 不合法（仅允许 https 外链）"));
            }
            if (!await IsPublicHostAsync(uri, ct))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "initImageUrl 不合法（禁止内网/本机地址）"));
            }
            try
            {
                var (bytes, mime) = await DownloadExternalAsync(uri, ct);
                if (bytes.Length > 10 * 1024 * 1024)
                {
                    return StatusCode(StatusCodes.Status413PayloadTooLarge, ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_TOO_LARGE, "参考图过大（上限 10MB）"));
                }
                var b64 = Convert.ToBase64String(bytes);
                var ctMime = string.IsNullOrWhiteSpace(mime) ? "image/png" : mime.Trim();
                initImageBase64 = $"data:{ctMime};base64,{b64}";
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "ImageGen initImageUrl download failed: {Url}", uri.ToString());
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "参考图下载失败"));
            }
        }

        // seedream/volces：多数情况下不支持 OpenAI 标准 images/edits 的“首帧图生图”语义。
        // 策略：检测到 volces API 时，将首帧图交给 Vision 模型提取风格描述，拼进 prompt，再走 images/generations。
        if (!string.IsNullOrWhiteSpace(initImageBase64))
        {
            var apiUrlForDetect = await TryResolveImageGenApiUrlAsync(modelId, platformId, ct);
            if (IsVolcesApiUrl(apiUrlForDetect))
            {
                var styleHint = await TryExtractStyleHintAsync(initImageBase64, ct);
                if (!string.IsNullOrWhiteSpace(styleHint))
                {
                    prompt = $"{prompt}\n\n【参考首帧风格】\n{styleHint}";
                    // 不再走 edits（避免“看似支持但实际忽略”的错觉）
                    initImageBase64 = null;
                }
                else
                {
                    // 无法提取风格：仍降级为纯文生图（并让前端通过提示告知用户）
                    initImageBase64 = null;
                }
            }
        }

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: adminId,
            ViewRole: "ADMIN",
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "[IMAGE_GEN_GENERATE]",
            RequestType: "imageGen",
            RequestPurpose: appCallerCode,
            ModelResolutionType: resolved?.ResolutionType ?? ModelResolutionType.DirectModel,
            ModelGroupId: resolved?.ModelGroupId,
            ModelGroupName: resolved?.ModelGroupName));

        var res = await _imageClient.GenerateAsync(prompt, n, size, responseFormat, ct, modelId, platformId, modelName, initImageBase64, initImageProvided);
        if (!res.Success)
        {
            // 将 LLM_ERROR 映射为 502，其他保持 400
            var code = res.Error?.Code ?? ErrorCodes.INTERNAL_ERROR;
            if (code == ErrorCodes.LLM_ERROR)
            {
                return StatusCode(StatusCodes.Status502BadGateway, ApiResponse<object>.Fail(code, res.Error?.Message ?? "生图失败"));
            }
            return BadRequest(ApiResponse<object>.Fail(code, res.Error?.Message ?? "生图失败"));
        }

        return Ok(ApiResponse<ImageGenResult>.Ok(res.Data!));
    }

    private static bool TryValidateExternalImageUrl(string raw, out Uri? uri)
    {
        uri = null;
        if (!Uri.TryCreate((raw ?? string.Empty).Trim(), UriKind.Absolute, out var u)) return false;
        if (!string.Equals(u.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return false;
        if (string.IsNullOrWhiteSpace(u.Host)) return false;
        if (string.Equals(u.Host, "localhost", StringComparison.OrdinalIgnoreCase)) return false;
        uri = u;
        return true;
    }

    private static bool IsBlockedIp(IPAddress ip)
    {
        if (IPAddress.IsLoopback(ip)) return true;

        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var b = ip.GetAddressBytes();
            // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10
            if (b[0] == 0) return true;
            if (b[0] == 10) return true;
            if (b[0] == 127) return true;
            if (b[0] == 169 && b[1] == 254) return true;
            if (b[0] == 192 && b[1] == 168) return true;
            if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
            if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return true;
        }
        else if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (ip.IsIPv6LinkLocal) return true;
            if (ip.IsIPv6SiteLocal) return true;
            if (ip.IsIPv6Multicast) return true;
            // Unique local fc00::/7
            var b = ip.GetAddressBytes();
            if ((b[0] & 0xFE) == 0xFC) return true;
        }

        return false;
    }

    private static async Task<bool> IsPublicHostAsync(Uri uri, CancellationToken ct)
    {
        // Host 是 IP 时直接判断
        if (IPAddress.TryParse(uri.Host, out var ip))
        {
            return !IsBlockedIp(ip);
        }

        try
        {
            var ips = await Dns.GetHostAddressesAsync(uri.DnsSafeHost, ct);
            if (ips == null || ips.Length == 0) return false;
            // 任意一个解析到内网/保留地址 => 拒绝（防止 DNS rebinding）
            return ips.All(x => !IsBlockedIp(x));
        }
        catch
        {
            return false;
        }
    }

    private async Task<(byte[] bytes, string mime)> DownloadExternalAsync(Uri uri, CancellationToken ct)
    {
        var http = _httpClientFactory.CreateClient("LoggedHttpClient");
        http.Timeout = TimeSpan.FromSeconds(60);
        http.DefaultRequestHeaders.Remove("Authorization");
        using var req = new HttpRequestMessage(HttpMethod.Get, uri);
        using var resp = await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!resp.IsSuccessStatusCode)
        {
            _logger.LogWarning("ImageGen download failed: HTTP {Status} host={Host}", (int)resp.StatusCode, uri.Host);
            throw new InvalidOperationException("下载失败");
        }
        var mime = resp.Content.Headers.ContentType?.MediaType ?? "image/png";
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var ms = new MemoryStream(capacity: 1024 * 1024);
        await stream.CopyToAsync(ms, ct);
        return (ms.ToArray(), mime);
    }

    private async Task<string?> TryResolveImageGenApiUrlAsync(string? modelId, string? platformId, CancellationToken ct)
    {
        // 优先模型配置
        if (!string.IsNullOrWhiteSpace(modelId))
        {
            var m = await _db.LLMModels.Find(x => x.Id == modelId && x.Enabled).FirstOrDefaultAsync(ct);
            if (m != null)
            {
                if (!string.IsNullOrWhiteSpace(m.ApiUrl)) return m.ApiUrl;
                if (!string.IsNullOrWhiteSpace(m.PlatformId))
                {
                    var p = await _db.LLMPlatforms.Find(x => x.Id == m.PlatformId && x.Enabled).FirstOrDefaultAsync(ct);
                    if (p != null && !string.IsNullOrWhiteSpace(p.ApiUrl)) return p.ApiUrl;
                }
            }
        }

        // 平台回退调用
        if (!string.IsNullOrWhiteSpace(platformId))
        {
            var p = await _db.LLMPlatforms.Find(x => x.Id == platformId && x.Enabled).FirstOrDefaultAsync(ct);
            if (p != null && !string.IsNullOrWhiteSpace(p.ApiUrl)) return p.ApiUrl;
        }
        return null;
    }

    private static bool IsVolcesApiUrl(string? apiUrl)
    {
        var raw = (apiUrl ?? string.Empty).Trim().TrimEnd('#');
        if (string.IsNullOrWhiteSpace(raw)) return false;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var u)) return false;
        return u.Host.EndsWith("volces.com", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<string?> TryExtractStyleHintAsync(string initImageBase64, CancellationToken ct)
    {
        if (!TryParseDataUrlOrBase64(initImageBase64, out var mime, out var b64)) return null;
        if (string.IsNullOrWhiteSpace(b64)) return null;

        try
        {
            var appCallerCode = "prd-agent-web::image-gen.extract-style";
            var scheduledResult = await _modelScheduler.GetClientWithGroupInfoAsync(appCallerCode, "vision", ct);
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: GetAdminId(),
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[IMAGE_GEN_EXTRACT_STYLE]",
                RequestType: "vision",
                RequestPurpose: appCallerCode,
                ModelResolutionType: scheduledResult.ResolutionType,
                ModelGroupId: scheduledResult.ModelGroupId,
                ModelGroupName: scheduledResult.ModelGroupName));
            var client = scheduledResult.Client;

            var systemPrompt =
                "你是“图片风格提取器”。你的任务：根据输入图片，提取可直接用于生图模型的风格描述。\n" +
                "要求：\n" +
                "- 只输出风格描述，不要解释过程\n" +
                "- 输出中文，80-160字\n" +
                "- 关注：构图、光照、色彩、材质、镜头感、景深、氛围、画面风格（写实/插画/3D/胶片等）\n" +
                "- 不要出现“这张图里有……”的叙述口吻；用“风格指令”写法\n";

            var msg = new LLMMessage
            {
                Role = "user",
                Content = "请提取该图片的风格指令。",
                Attachments = new List<LLMAttachment>
                {
                    new()
                    {
                        Type = "image",
                        MimeType = mime,
                        Base64Data = b64
                    }
                }
            };

            var raw = await CollectToTextAsync(client, systemPrompt, new List<LLMMessage> { msg }, ct);
            var s = NormalizeStyleHint(raw);
            return string.IsNullOrWhiteSpace(s) ? null : s;
        }
        catch
        {
            return null;
        }
    }

    private static string NormalizeStyleHint(string raw)
    {
        var s = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(s)) return string.Empty;
        // 取第一段，避免模型输出多段
        s = Regex.Replace(s, @"\n{3,}", "\n\n");
        if (s.Length > 220) s = s[..220].Trim();
        return s;
    }

    private static bool TryParseDataUrlOrBase64(string raw, out string mime, out string base64)
    {
        mime = "image/png";
        base64 = string.Empty;
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
        // 仅保留 base64 内容
        base64 = s;
        return !string.IsNullOrWhiteSpace(base64);
    }

    /// <summary>
    /// 批量生图（SSE）：前端在确认 total 后才会调用
    /// </summary>
    [HttpPost("batch/stream")]
    [Produces("text/event-stream")]
    public async Task BatchStream([FromBody] ImageGenBatchRequest request, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var adminId = GetAdminId();
        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var modelName = (request?.ModelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelName)) modelName = null;
        var appCallerCode = "prd-agent-web::image-gen.batch-generate";
        ResolvedModelInfo? resolved = null;
        if (string.IsNullOrWhiteSpace(modelId) || string.IsNullOrWhiteSpace(platformId))
        {
            resolved = await _modelScheduler.ResolveModelAsync(appCallerCode, "generation", cancellationToken);
            if (resolved != null)
            {
                platformId = resolved.PlatformId;
                modelId = resolved.ModelId;
                if (string.IsNullOrWhiteSpace(modelName)) modelName = resolved.ModelDisplayName;
            }
        }
        var items = request?.Items ?? new List<ImageGenPlanItem>();
        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();

        if (items.Count == 0)
        {
            await WriteEventAsync("run", new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "items 不能为空" }, cancellationToken);
            return;
        }

        // 统一限制：最多 20 张
        var total = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var c = items[i].Count <= 0 ? 1 : items[i].Count;
            total += c;
        }
        if (total > 20)
        {
            await WriteEventAsync("run", new { type = "error", errorCode = ErrorCodes.RATE_LIMITED, errorMessage = $"单次最多生成 20 张（当前 {total} 张）" }, cancellationToken);
            return;
        }

        var runId = Guid.NewGuid().ToString("N");
        await WriteEventAsync("run", new { type = "runStart", runId, adminId, total, modelId, platformId, modelName }, cancellationToken);

        var done = 0;
        var failed = 0;

        // 使用 SemaphoreSlim 控制并发数
        var maxConc = Math.Clamp(request?.MaxConcurrency ?? 3, 1, 10);
        var sem = new SemaphoreSlim(maxConc, maxConc);
        var writeLock = new SemaphoreSlim(1, 1);
        var tasks = new List<Task>();

        // 收集所有需要生成的图片任务
        for (var itemIndex = 0; itemIndex < items.Count; itemIndex++)
        {
            var prompt = (items[itemIndex].Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(prompt))
            {
                failed += Math.Max(1, items[itemIndex].Count);
                await WriteEventAsync("image", new { type = "imageError", runId, itemIndex, imageIndex = 0, prompt = "", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "prompt 不能为空" }, cancellationToken);
                continue;
            }

            var itemSize = string.IsNullOrWhiteSpace(items[itemIndex].Size) ? size : items[itemIndex].Size!.Trim();
            var count = Math.Clamp(items[itemIndex].Count <= 0 ? 1 : items[itemIndex].Count, 1, 5);
            for (var k = 0; k < count; k++)
            {
                if (cancellationToken.IsCancellationRequested) break;

                var currentItemIndex = itemIndex;
                var imageIndex = k;
                var currentPrompt = prompt;
                var currentSize = itemSize;

                // 创建并发任务
                tasks.Add(Task.Run(async () =>
                {
                    await sem.WaitAsync(cancellationToken);
                    try
                    {
                        // 发送开始事件
                        await writeLock.WaitAsync(cancellationToken);
                        try
                        {
                            await WriteEventAsync("image", new { type = "imageStart", runId, itemIndex = currentItemIndex, imageIndex, prompt = currentPrompt, size = currentSize }, cancellationToken);
                        }
                        finally
                        {
                            writeLock.Release();
                        }

                        try
                        {
                            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                                RequestId: Guid.NewGuid().ToString("N"),
                                GroupId: null,
                                SessionId: null,
                                UserId: adminId,
                                ViewRole: "ADMIN",
                                DocumentChars: null,
                                DocumentHash: null,
                                SystemPromptRedacted: "[IMAGE_GEN_BATCH_GENERATE]",
                                RequestType: "imageGen",
                                RequestPurpose: appCallerCode,
                                ModelResolutionType: resolved?.ResolutionType ?? ModelResolutionType.DirectModel,
                                ModelGroupId: resolved?.ModelGroupId,
                                ModelGroupName: resolved?.ModelGroupName));

                            var res = await _imageClient.GenerateAsync(currentPrompt, n: 1, currentSize, responseFormat, cancellationToken, modelId, platformId, modelName);
                            
                            await writeLock.WaitAsync(cancellationToken);
                            try
                            {
                                if (!res.Success)
                                {
                                    Interlocked.Increment(ref failed);
                                    await WriteEventAsync("image", new
                                    {
                                        type = "imageError",
                                        runId,
                                        itemIndex = currentItemIndex,
                                        imageIndex,
                                        prompt = currentPrompt,
                                        requestedSize = currentSize,
                                        modelId,
                                        platformId,
                                        modelName,
                                        errorCode = res.Error?.Code ?? ErrorCodes.LLM_ERROR,
                                        errorMessage = res.Error?.Message ?? "生图失败"
                                    }, cancellationToken);
                                    return;
                                }

                                var first = res.Data?.Images?.FirstOrDefault();
                                var meta = res.Data?.Meta;
                                Interlocked.Increment(ref done);
                                await WriteEventAsync("image", new
                                {
                                    type = "imageDone",
                                    runId,
                                    itemIndex = currentItemIndex,
                                    imageIndex,
                                    prompt = currentPrompt,
                                    requestedSize = currentSize,
                                    effectiveSize = meta?.EffectiveSize,
                                    sizeAdjusted = meta?.SizeAdjusted ?? false,
                                    ratioAdjusted = meta?.RatioAdjusted ?? false,
                                    modelId,
                                    platformId,
                                    modelName,
                                    base64 = first?.Base64,
                                    url = first?.Url,
                                    revisedPrompt = first?.RevisedPrompt
                                }, cancellationToken);
                            }
                            finally
                            {
                                writeLock.Release();
                            }
                        }
                        catch (Exception ex)
                        {
                            await writeLock.WaitAsync(cancellationToken);
                            try
                            {
                                Interlocked.Increment(ref failed);
                                await WriteEventAsync("image", new
                                {
                                    type = "imageError",
                                    runId,
                                    itemIndex = currentItemIndex,
                                    imageIndex,
                                    prompt = currentPrompt,
                                    requestedSize = currentSize,
                                    modelId,
                                    platformId,
                                    modelName,
                                    errorCode = ErrorCodes.LLM_ERROR,
                                    errorMessage = ex.Message
                                }, cancellationToken);
                            }
                            finally
                            {
                                writeLock.Release();
                            }
                        }
                    }
                    finally
                    {
                        sem.Release();
                    }
                }, cancellationToken));
            }
        }

        // 等待所有任务完成
        try
        {
            await Task.WhenAll(tasks);
        }
        catch (OperationCanceledException)
        {
            // 取消时忽略异常
        }

        await WriteEventAsync("run", new { type = "runDone", runId, total, done, failed, endedAt = DateTime.UtcNow }, cancellationToken);
    }

    /// <summary>
    /// 创建生图任务（runId）：用于断线可恢复的批量/单张生图
    /// </summary>
    [HttpPost("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateRun([FromBody] CreateImageGenRunRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var idemKey = (Request.Headers["Idempotency-Key"].FirstOrDefault() ?? string.Empty).Trim();
        if (idemKey.Length > 200) idemKey = idemKey[..200];

        if (!string.IsNullOrWhiteSpace(idemKey))
        {
            var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
            if (existed != null)
            {
                return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
            }
        }

        var cfgModelId = (request?.ConfigModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(cfgModelId)) cfgModelId = null;
        var platformId = (request?.PlatformId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(platformId)) platformId = null;
        var modelId = (request?.ModelId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = null;
        var modelNameLegacy = (request?.ModelName ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(modelNameLegacy)) modelNameLegacy = null;
        modelId ??= modelNameLegacy;

        if (!string.IsNullOrWhiteSpace(cfgModelId))
        {
            var m = await _db.LLMModels.Find(x => x.Id == cfgModelId && x.Enabled).FirstOrDefaultAsync(ct);
            if (m == null)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "指定的模型不存在或未启用"));
            }
            platformId = m.PlatformId;
            modelId = m.ModelName;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(platformId) || string.IsNullOrWhiteSpace(modelId))
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "必须提供 configModelId，或提供 platformId + modelId"));
            }
        }

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();
        var maxConc = Math.Clamp(request?.MaxConcurrency ?? 3, 1, 10);

        var items = request?.Items ?? new List<ImageGenRunPlanItemInput>();
        if (items.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "items 不能为空"));
        }
        // 清洗与限制：单条最多 5 张，总计最多 20 张
        var plan = new List<ImageGenRunPlanItem>();
        var total = 0;
        for (var i = 0; i < items.Count; i++)
        {
            var p = (items[i].Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(p)) continue;
            var c = Math.Clamp(items[i].Count <= 0 ? 1 : items[i].Count, 1, 5);
            var s = (items[i].Size ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(s)) s = null;
            plan.Add(new ImageGenRunPlanItem { Prompt = p, Count = c, Size = s });
            total += c;
            if (total > 20) break;
        }
        if (plan.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "items 不能为空（无有效 prompt）"));
        }
        if (total > 20)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.RATE_LIMITED, $"单次最多生成 20 张（当前 {total} 张）"));
        }

        // 可选：绑定 WorkspaceId（若提供，生成的图片会自动保存到 COS）
        var workspaceId = (request?.WorkspaceId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(workspaceId)) workspaceId = null;

        // AppKey（用于水印等功能隔离）
        // 优先从请求体读取，如果没有则从请求头 X-App-Name 读取
        var appKey = (request?.AppKey ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(appKey))
        {
            appKey = (Request.Headers["X-App-Name"].ToString() ?? string.Empty).Trim();
        }
        if (string.IsNullOrWhiteSpace(appKey)) appKey = null;

        // 模型池调度逻辑统一在 ImageGenRunWorker 中处理

        var run = new ImageGenRun
        {
            OwnerAdminId = adminId,
            Status = ImageGenRunStatus.Queued,
            ConfigModelId = cfgModelId,
            PlatformId = platformId,
            ModelId = modelId,
            Size = size,
            ResponseFormat = responseFormat,
            MaxConcurrency = maxConc,
            Items = plan,
            Total = total,
            Done = 0,
            Failed = 0,
            CancelRequested = false,
            LastSeq = 0,
            IdempotencyKey = string.IsNullOrWhiteSpace(idemKey) ? null : idemKey,
            WorkspaceId = workspaceId,
            // 格式: {app}.{feature}::modelType（符合 doc/12.app-feature-naming-convention.md）
            AppCallerCode = string.IsNullOrWhiteSpace(appKey) ? null : $"{appKey}.image::generation",
            AppKey = appKey,
            CreatedAt = DateTime.UtcNow
        };

        try
        {
            await _db.ImageGenRuns.InsertOneAsync(run, cancellationToken: ct);
        }
        catch (MongoWriteException mw) when (mw.WriteError?.Category == ServerErrorCategory.DuplicateKey && !string.IsNullOrWhiteSpace(idemKey))
        {
            // 幂等键并发冲突：返回已存在的 run
            var existed = await _db.ImageGenRuns.Find(x => x.OwnerAdminId == adminId && x.IdempotencyKey == idemKey).FirstOrDefaultAsync(ct);
            if (existed != null) return Ok(ApiResponse<object>.Ok(new { runId = existed.Id }));
            throw;
        }

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
    }

    /// <summary>
    /// 查询生图任务状态/进度（可选返回 items）
    /// </summary>
    [HttpGet("runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetRun(string runId, [FromQuery] bool includeItems = true, [FromQuery] bool includeImages = false, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        }

        var run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId).FirstOrDefaultAsync(ct);
        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, "run 不存在"));
        }

        object? items = null;
        if (includeItems)
        {
            var list = await _db.ImageGenRunItems
                .Find(x => x.RunId == runId && x.OwnerAdminId == adminId)
                .SortBy(x => x.ItemIndex).ThenBy(x => x.ImageIndex)
                .ToListAsync(ct);
            items = list.Select(x => new
            {
                x.RunId,
                x.ItemIndex,
                x.ImageIndex,
                x.Prompt,
                x.RequestedSize,
                x.EffectiveSize,
                x.SizeAdjusted,
                x.RatioAdjusted,
                status = x.Status.ToString(),
                base64 = includeImages ? x.Base64 : null,
                url = includeImages ? x.Url : null,
                x.RevisedPrompt,
                x.ErrorCode,
                x.ErrorMessage,
                x.CreatedAt,
                x.StartedAt,
                x.EndedAt
            });
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            run = new
            {
                run.Id,
                run.OwnerAdminId,
                status = run.Status.ToString(),
                run.ConfigModelId,
                run.PlatformId,
                run.ModelId,
                run.Size,
                run.ResponseFormat,
                run.MaxConcurrency,
                run.Total,
                run.Done,
                run.Failed,
                run.CancelRequested,
                run.LastSeq,
                run.CreatedAt,
                run.StartedAt,
                run.EndedAt
            },
            items
        }));
    }

    /// <summary>
    /// 订阅生图任务事件（SSE）：支持 afterSeq 断线续传
    /// </summary>
    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task RunStream(string runId, [FromQuery] long afterSeq = 0, CancellationToken cancellationToken = default)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            await WriteSseAsync(id: null, eventName: "run", dataJson: JsonSerializer.Serialize(new { type = "error", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "runId 不能为空" }, JsonOptions), cancellationToken);
            return;
        }

        var run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId).FirstOrDefaultAsync(cancellationToken);
        if (run == null)
        {
            await WriteSseAsync(id: null, eventName: "run", dataJson: JsonSerializer.Serialize(new { type = "error", errorCode = ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, errorMessage = "run 不存在" }, JsonOptions), cancellationToken);
            return;
        }

        // snapshot（可选）：用于断线恢复时快速拿到当前进度
        var snap = await _runStore.GetSnapshotAsync(RunKinds.ImageGen, runId, cancellationToken);
        if (snap != null && snap.Seq > afterSeq)
        {
            await WriteSseAsync(id: snap.Seq.ToString(), eventName: "run", dataJson: snap.SnapshotJson, cancellationToken);
            afterSeq = snap.Seq;
        }

        var lastKeepAliveAt = DateTime.UtcNow;
        while (!cancellationToken.IsCancellationRequested)
        {
            // 取一批事件，避免一次性刷太多
            var evts = await _runStore.GetEventsAsync(RunKinds.ImageGen, runId, afterSeq, limit: 120, cancellationToken);

            if (evts.Count > 0)
            {
                foreach (var e in evts)
                {
                    await WriteSseAsync(id: e.Seq.ToString(), eventName: e.EventName, dataJson: e.PayloadJson, cancellationToken);
                    afterSeq = e.Seq;
                }
                lastKeepAliveAt = DateTime.UtcNow;
            }
            else
            {
                // keepalive：避免代理/浏览器超时关闭连接
                if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
                {
                    await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                }

                // 如果 run 已结束且已追到最新 seq，则关闭 SSE
                run = await _db.ImageGenRuns.Find(x => x.Id == runId && x.OwnerAdminId == adminId).FirstOrDefaultAsync(cancellationToken);
                if (run == null) break;
                if (run.Status is ImageGenRunStatus.Completed or ImageGenRunStatus.Failed or ImageGenRunStatus.Cancelled)
                {
                    // run.LastSeq 不再按事件频率更新（避免 Mongo 写放大）；改为“run 已结束且一段时间无新事件”就退出
                    if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 2) break;
                }

                await Task.Delay(650, cancellationToken);
            }
        }
    }

    /// <summary>
    /// 请求取消生图任务（后台会尽量停止继续派发新的生成）
    /// </summary>
    [HttpPost("runs/{runId}/cancel")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> CancelRun(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(runId))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "runId 不能为空"));
        }

        var res = await _db.ImageGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.OwnerAdminId == adminId,
            Builders<ImageGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        if (res.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.IMAGE_GEN_RUN_NOT_FOUND, "run 不存在"));
        }

        return Ok(ApiResponse<object>.Ok(true));
    }

    private async Task WriteSseAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            await Response.WriteAsync($"id: {id}\n", ct);
        }
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    private static async Task<string> CollectToTextAsync(ILLMClient client, string systemPrompt, List<LLMMessage> messages, CancellationToken ct)
    {
        var sb = new StringBuilder(capacity: 1024);
        await foreach (var chunk in client.StreamGenerateAsync(systemPrompt, messages, ct).WithCancellation(ct))
        {
            if (chunk.Type == "delta" && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
            }
            else if (chunk.Type == "error")
            {
                throw new InvalidOperationException(chunk.ErrorMessage ?? ErrorCodes.LLM_ERROR);
            }
        }
        return sb.ToString();
    }

    private static ParsedPlan? TryParsePlan(string raw, int maxItems, out string? error)
    {
        error = null;
        var text = (raw ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(text))
        {
            error = "意图模型未返回内容";
            return null;
        }

        // 容错：截取最外层 JSON 对象
        var first = text.IndexOf('{');
        var last = text.LastIndexOf('}');
        if (first >= 0 && last > first)
        {
            text = text.Substring(first, last - first + 1);
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            var root = doc.RootElement;

            var itemsEl = root.TryGetProperty("items", out var ie) ? ie : default;
            if (itemsEl.ValueKind != JsonValueKind.Array)
            {
                error = "解析失败：items 必须为数组";
                return null;
            }

            var items = new List<ImageGenPlanItem>();
            var total = 0;
            foreach (var it in itemsEl.EnumerateArray())
            {
                if (items.Count >= maxItems) break;

                var prompt = it.TryGetProperty("prompt", out var pEl) && pEl.ValueKind == JsonValueKind.String ? pEl.GetString() : null;
                var count = it.TryGetProperty("count", out var cEl) && cEl.ValueKind == JsonValueKind.Number ? cEl.GetInt32() : 1;
                var size = it.TryGetProperty("size", out var sEl) && sEl.ValueKind == JsonValueKind.String ? sEl.GetString() : null;

                prompt = (prompt ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(prompt)) continue;

                count = Math.Clamp(count <= 0 ? 1 : count, 1, 5);
                size = (size ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(size)) size = null;
                items.Add(new ImageGenPlanItem { Prompt = prompt, Count = count, Size = size });
                total += count;
            }

            // total 以 items 汇总为准（避免模型输出不一致）
            return new ParsedPlan { Total = total, Items = items };
        }
        catch
        {
            error = "解析失败：返回不是合法 JSON";
            return null;
        }
    }

    private async Task WriteEventAsync(string eventName, object payload, CancellationToken ct)
    {
        var data = JsonSerializer.Serialize(payload, JsonOptions);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {data}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }

    private class ParsedPlan
    {
        public int Total { get; set; }
        public List<ImageGenPlanItem> Items { get; set; } = new();
    }
}

public class ImageGenPlanRequest
{
    public string Text { get; set; } = string.Empty;
    public int? MaxItems { get; set; }
    /// <summary>
    /// 可选：仅本次请求覆盖 system prompt（用于“生图意图解析”）。
    /// 不传时将优先使用管理员已保存的覆盖提示词；两者都无则回退默认模板。
    /// </summary>
    public string? SystemPromptOverride { get; set; }
}

public class ImageGenPlanResponse
{
    public int Total { get; set; }
    public List<ImageGenPlanItem> Items { get; set; } = new();
    public string UsedPurpose { get; set; } = "intent";
}

public class ImageGenPlanItem
{
    public string Prompt { get; set; } = string.Empty;
    public int Count { get; set; } = 1;
    /// <summary>
    /// 可选：单条覆盖的生图尺寸（如 "1024x1024"）。为空时回退到批量请求的 Size。
    /// </summary>
    public string? Size { get; set; }
}

public class ImageGenGenerateRequest
{
    public string Prompt { get; set; } = string.Empty;
    public string? ModelId { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelName { get; set; }
    public int? N { get; set; }
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
    /// <summary>
    /// 图生图首帧（DataURL 或纯 base64）。当传入时，将优先走 images/edits（若上游支持）
    /// </summary>
    public string? InitImageBase64 { get; set; }
    /// <summary>
    /// 图生图首帧 URL（服务端下载并转 base64；用于规避浏览器 CORS）
    /// </summary>
    public string? InitImageUrl { get; set; }
    /// <summary>
    /// 图生图首帧：已上传到系统资产的 sha256（服务端读取文件；用于规避浏览器 CORS）
    /// </summary>
    public string? InitImageAssetSha256 { get; set; }
}

public class ImageGenBatchRequest
{
    public string? ModelId { get; set; }
    public string? PlatformId { get; set; }
    public string? ModelName { get; set; }
    public List<ImageGenPlanItem> Items { get; set; } = new();
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
    public int? MaxConcurrency { get; set; } // 最大并发数
}

public class CreateImageGenRunRequest
{
    /// <summary>
    /// 可选：内部配置模型 ID（LLMModel.Id）。若提供，则会自动解析 platformId + modelId。
    /// </summary>
    public string? ConfigModelId { get; set; }

    /// <summary>
    /// 平台 ID（LLMPlatform.Id）。
    /// </summary>
    public string? PlatformId { get; set; }

    /// <summary>
    /// 平台侧模型 ID（业务语义 modelId）。
    /// </summary>
    public string? ModelId { get; set; }

    /// <summary>
    /// 兼容字段：历史接口使用；语义等同于 ModelId。
    /// </summary>
    public string? ModelName { get; set; }

    public List<ImageGenRunPlanItemInput> Items { get; set; } = new();

    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
    public int? MaxConcurrency { get; set; }

    /// <summary>
    /// 可选：绑定的 WorkspaceId。若提供，生成的图片会自动保存到 COS 并关联到该 Workspace。
    /// </summary>
    public string? WorkspaceId { get; set; }

    /// <summary>
    /// 可选：应用标识（如 "literary-agent"）。用于水印等功能的隔离。
    /// </summary>
    public string? AppKey { get; set; }
}

public class ImageGenRunPlanItemInput
{
    public string Prompt { get; set; } = string.Empty;
    public int Count { get; set; } = 1;
    public string? Size { get; set; }
}
