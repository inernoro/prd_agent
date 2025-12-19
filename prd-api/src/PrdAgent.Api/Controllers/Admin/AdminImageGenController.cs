using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;

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

    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public AdminImageGenController(
        MongoDbContext db,
        IModelDomainService modelDomain,
        OpenAIImageClient imageClient,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<AdminImageGenController> logger)
    {
        _db = db;
        _modelDomain = modelDomain;
        _imageClient = imageClient;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
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

        // 防滥用：限制输入长度（这不是 PRD 上传入口）
        if (text.Length > 8000) text = text[..8000];

        var maxItems = request?.MaxItems ?? 10;
        maxItems = Math.Clamp(maxItems, 1, 20);

        var hasIntentModel = await _db.LLMModels.Find(m => m.IsIntent && m.Enabled).AnyAsync(ct);
        var usedPurpose = hasIntentModel ? "intent" : "fallbackMain";

        var systemPrompt =
            "你是图片生成任务的意图解析模型。\n" +
            "请把用户输入解析成“要生成的图片清单”，并严格只输出 JSON（不要 Markdown，不要解释，不要多余字符）。\n" +
            "JSON 格式：{\"total\":N,\"items\":[{\"prompt\":\"...\",\"count\":1}]}。\n" +
            "规则：\n" +
            $"- items 数量 <= {maxItems}\n" +
            "- prompt 必须可直接用于图片生成（具体、可视化、包含主体/风格/场景/构图等）。\n" +
            "- count 为 1-5 的整数，表示该 prompt 需要生成多少张。\n" +
            "- total 必须等于 items 的 count 之和。\n" +
            "如果用户只描述了一个画面，就返回 1 个 item 且 total=1。\n";

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
            if (plan.Total <= 0)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "解析失败：total 必须 > 0"));
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

        // 单次允许一个提示词生成多张（上限 20；与“批量生图总上限”一致）
        var n = request?.N ?? 1;
        n = Math.Clamp(n, 1, 20);

        var size = string.IsNullOrWhiteSpace(request?.Size) ? "1024x1024" : request!.Size!.Trim();
        var responseFormat = string.IsNullOrWhiteSpace(request?.ResponseFormat) ? "b64_json" : request!.ResponseFormat!.Trim();

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

        var res = await _imageClient.GenerateAsync(prompt, n, size, responseFormat, ct);
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
        await WriteEventAsync("run", new { type = "runStart", runId, adminId, total }, cancellationToken);

        var done = 0;
        var failed = 0;

        for (var itemIndex = 0; itemIndex < items.Count; itemIndex++)
        {
            var prompt = (items[itemIndex].Prompt ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(prompt))
            {
                failed += Math.Max(1, items[itemIndex].Count);
                await WriteEventAsync("image", new { type = "imageError", runId, itemIndex, imageIndex = 0, prompt = "", errorCode = ErrorCodes.INVALID_FORMAT, errorMessage = "prompt 不能为空" }, cancellationToken);
                continue;
            }

            var count = Math.Clamp(items[itemIndex].Count <= 0 ? 1 : items[itemIndex].Count, 1, 5);
            for (var k = 0; k < count; k++)
            {
                if (cancellationToken.IsCancellationRequested) break;

                var imageIndex = k;
                await WriteEventAsync("image", new { type = "imageStart", runId, itemIndex, imageIndex, prompt }, cancellationToken);

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

                    var res = await _imageClient.GenerateAsync(prompt, n: 1, size, responseFormat, cancellationToken);
                    if (!res.Success)
                    {
                        failed++;
                        await WriteEventAsync("image", new
                        {
                            type = "imageError",
                            runId,
                            itemIndex,
                            imageIndex,
                            prompt,
                            errorCode = res.Error?.Code ?? ErrorCodes.LLM_ERROR,
                            errorMessage = res.Error?.Message ?? "生图失败"
                        }, cancellationToken);
                        continue;
                    }

                    var first = res.Data?.Images?.FirstOrDefault();
                    done++;
                    await WriteEventAsync("image", new
                    {
                        type = "imageDone",
                        runId,
                        itemIndex,
                        imageIndex,
                        prompt,
                        base64 = first?.Base64,
                        url = first?.Url,
                        revisedPrompt = first?.RevisedPrompt
                    }, cancellationToken);
                }
                catch (Exception ex)
                {
                    failed++;
                    await WriteEventAsync("image", new
                    {
                        type = "imageError",
                        runId,
                        itemIndex,
                        imageIndex,
                        prompt,
                        errorCode = ErrorCodes.LLM_ERROR,
                        errorMessage = ex.Message
                    }, cancellationToken);
                }
            }
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

                prompt = (prompt ?? string.Empty).Trim();
                if (string.IsNullOrWhiteSpace(prompt)) continue;

                count = Math.Clamp(count <= 0 ? 1 : count, 1, 5);
                items.Add(new ImageGenPlanItem { Prompt = prompt, Count = count });
                total += count;
            }

            // total 以 items 汇总为准（避免模型输出不一致）
            if (items.Count == 0)
            {
                error = "解析失败：items 为空";
                return null;
            }

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
}

public class ImageGenGenerateRequest
{
    public string Prompt { get; set; } = string.Empty;
    public int? N { get; set; }
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
}

public class ImageGenBatchRequest
{
    public List<ImageGenPlanItem> Items { get; set; } = new();
    public string? Size { get; set; }
    public string? ResponseFormat { get; set; } // b64_json | url
}

