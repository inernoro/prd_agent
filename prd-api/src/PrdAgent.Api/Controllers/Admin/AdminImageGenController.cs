using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.Prompts.Templates;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 生图 / 批量生图
/// </summary>
[ApiController]
[Route("api/v1/admin/image-gen")]
[Authorize(Roles = "ADMIN")]
public class AdminImageGenController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IModelDomainService _modelDomain;
    private readonly OpenAIImageClient _imageClient;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<AdminImageGenController> _logger;
    private readonly IAppSettingsService _settingsService;

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AdminImageGenController(
        MongoDbContext db,
        IModelDomainService modelDomain,
        OpenAIImageClient imageClient,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<AdminImageGenController> logger,
        IAppSettingsService settingsService)
    {
        _db = db;
        _modelDomain = modelDomain;
        _imageClient = imageClient;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
        _settingsService = settingsService;
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

        var systemPrompt = ImageGenPlanPrompt.Build(maxItems);

        try
        {
            var adminId = GetAdminId();
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: adminId,
                ViewRole: "ADMIN",
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: "[IMAGE_GEN_PLAN]",
                RequestType: "intent",
                RequestPurpose: "imageGen.plan"));

            var client = await _modelDomain.GetClientAsync(ModelPurpose.Intent, ct);
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

        // 单次允许一个提示词生成多张（上限 20；与“批量生图总上限”一致）
        var n = request?.N ?? 1;
        n = Math.Clamp(n, 1, 20);

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();
        var initImageBase64 = (request?.InitImageBase64 ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(initImageBase64)) initImageBase64 = null;

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
            RequestPurpose: "imageGen.generate"));

        var res = await _imageClient.GenerateAsync(prompt, n, size, responseFormat, ct, modelId, platformId, modelName, initImageBase64);
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
            var client = await _modelDomain.GetClientAsync(ModelPurpose.Vision, ct);

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
                                RequestPurpose: "imageGen.batch.generate"));

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

