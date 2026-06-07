using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// Markdown / 文件 转 网页版 PPT 智能体
/// appKey = md-to-ppt-agent
/// 端点：
///   POST convert  — LLM 流式生成完整 reveal.js HTML PPT（SSE）
///   POST patch    — 对已有 PPT 的局部页面进行修改（SSE）
///   POST publish  — 将 HTML 发布为网页托管站点
/// </summary>
[ApiController]
[Route("api/md-to-ppt")]
[Authorize]
[AdminController("ai-toolbox", AdminPermissionCatalog.AiToolboxUse)]
public class MdToPptController : ControllerBase
{
    private const string AppKey = "md-to-ppt-agent";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IHostedSiteService _hostedSiteService;
    private readonly ILogger<MdToPptController> _logger;

    public MdToPptController(
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        IHostedSiteService hostedSiteService,
        ILogger<MdToPptController> logger)
    {
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _hostedSiteService = hostedSiteService;
        _logger = logger;
    }

    // =========================================================================
    // POST /api/md-to-ppt/convert  — 流式生成完整 reveal.js HTML PPT
    // =========================================================================

    /// <summary>
    /// 将 Markdown / 纯文本通过 LLM 流式直接生成完整 reveal.js HTML PPT。
    /// 返回 SSE 流，delta 事件携带 HTML 增量文本；done 事件携带 { html } 完整 HTML。
    /// LLM 被要求直接输出富设计 HTML，包含多样版式、inline CSS、视觉层级。
    /// </summary>
    [HttpPost("convert")]
    [Produces("text/event-stream")]
    public async Task ConvertAsync([FromBody] MdToPptConvertRequest request, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        if (string.IsNullOrWhiteSpace(request.Content))
        {
            await WriteSseEventAsync("error",
                JsonSerializer.Serialize(new { code = "INVALID_FORMAT", message = "content 不能为空" }, JsonOptions), ct);
            return;
        }

        var userId = this.GetRequiredUserId();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: request.Content.Length,
            DocumentHash: null,
            SystemPromptRedacted: "md-to-ppt-html-generate",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate));

        var slideCount = Math.Clamp(request.SlideCount ?? 8, 3, 20);
        var theme = NormalizeTheme(request.Theme);

        var systemPrompt = BuildHtmlGenerateSystemPrompt(slideCount, theme);

        var userContent = request.Content.Length > 16000
            ? string.Concat(request.Content.AsSpan(0, 16000), "\n...(内容已截断)")
            : request.Content;

        var requestBody = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userContent },
            },
            ["temperature"] = 0.6,
            ["max_tokens"] = 8000,
        };

        try
        {
            await WriteSseEventAsync("start", JsonSerializer.Serialize(new { slideCount, theme }, JsonOptions), ct);

            var fullHtml = new StringBuilder();

            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.MdToPptAgent.Generation.HtmlGenerate,
                ModelType = ModelTypes.Chat,
                RequestBody = requestBody,
            }, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullHtml.Append(chunk.Content);
                    try
                    {
                        await WriteSseEventAsync("delta",
                            JsonSerializer.Serialize(new { text = chunk.Content }, JsonOptions), ct);
                    }
                    catch (OperationCanceledException) { break; }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    try
                    {
                        await WriteSseEventAsync("model", JsonSerializer.Serialize(new
                        {
                            model = chunk.Resolution.ActualModel,
                            platform = chunk.Resolution.ActualPlatformId,
                        }, JsonOptions), ct);
                    }
                    catch (OperationCanceledException) { break; }
                    catch (ObjectDisposedException) { break; }
                }
            }

            var html = StripCodeFences(fullHtml.ToString().Trim());

            try
            {
                await WriteSseEventAsync("done", JsonSerializer.Serialize(new { html }, JsonOptions), ct);
            }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "[MdToPpt] convert failed for user={UserId}", userId);
            try
            {
                await WriteSseEventAsync("error",
                    JsonSerializer.Serialize(new { code = "LLM_ERROR", message = "AI 生成失败，请稍后重试" }, JsonOptions), ct);
            }
            catch { /* ignore write errors when client disconnected */ }
        }
    }

    // =========================================================================
    // POST /api/md-to-ppt/patch  — 局部修改指定页面
    // =========================================================================

    /// <summary>
    /// 对已有 reveal.js HTML PPT 的指定页面进行局部修改。
    /// 返回 SSE 流，delta 事件携带修改后的 HTML 增量；done 事件携带 { html } 完整 HTML。
    /// </summary>
    [HttpPost("patch")]
    [Produces("text/event-stream")]
    public async Task PatchAsync([FromBody] MdToPptPatchRequest request, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        if (string.IsNullOrWhiteSpace(request.CurrentHtml))
        {
            await WriteSseEventAsync("error",
                JsonSerializer.Serialize(new { code = "INVALID_FORMAT", message = "currentHtml 不能为空" }, JsonOptions), ct);
            return;
        }
        if (string.IsNullOrWhiteSpace(request.SlideRequest))
        {
            await WriteSseEventAsync("error",
                JsonSerializer.Serialize(new { code = "INVALID_FORMAT", message = "slideRequest 不能为空" }, JsonOptions), ct);
            return;
        }

        var userId = this.GetRequiredUserId();

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: request.CurrentHtml.Length,
            DocumentHash: null,
            SystemPromptRedacted: "md-to-ppt-patch",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.MdToPptAgent.Generation.Patch));

        var systemPrompt =
            "你是一位专业的 reveal.js HTML PPT 编辑助手。用户会提供当前完整的 reveal.js HTML PPT 代码以及修改要求。" +
            "你的任务是根据修改要求，对指定页面进行局部修改，返回修改后的**完整** HTML 文件。\n" +
            "要求：\n" +
            "- 只修改用户指定的内容，其余部分保持不变\n" +
            "- 保持原有的整体风格、主题和设计语言\n" +
            "- 直接输出完整 HTML，不要 markdown 代码围栏，不要额外解释\n" +
            "- 输出必须是能在浏览器直接运行的完整 HTML 文件";

        var slideInfo = request.SlideIndex.HasValue
            ? $"第 {request.SlideIndex.Value + 1} 页（0-indexed: {request.SlideIndex.Value}）"
            : "相关页面";

        var userContent =
            $"当前 PPT HTML 代码如下：\n\n{request.CurrentHtml}\n\n" +
            $"修改要求（针对{slideInfo}）：{request.SlideRequest}";

        if (userContent.Length > 20000)
        {
            userContent = userContent[..20000] + "\n...(已截断)";
        }

        var requestBody = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userContent },
            },
            ["temperature"] = 0.4,
            ["max_tokens"] = 8000,
        };

        try
        {
            await WriteSseEventAsync("start", JsonSerializer.Serialize(new { slideIndex = request.SlideIndex }, JsonOptions), ct);

            var fullHtml = new StringBuilder();

            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.MdToPptAgent.Generation.Patch,
                ModelType = ModelTypes.Chat,
                RequestBody = requestBody,
            }, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullHtml.Append(chunk.Content);
                    try
                    {
                        await WriteSseEventAsync("delta",
                            JsonSerializer.Serialize(new { text = chunk.Content }, JsonOptions), ct);
                    }
                    catch (OperationCanceledException) { break; }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null)
                {
                    try
                    {
                        await WriteSseEventAsync("model", JsonSerializer.Serialize(new
                        {
                            model = chunk.Resolution.ActualModel,
                            platform = chunk.Resolution.ActualPlatformId,
                        }, JsonOptions), ct);
                    }
                    catch (OperationCanceledException) { break; }
                    catch (ObjectDisposedException) { break; }
                }
            }

            var html = StripCodeFences(fullHtml.ToString().Trim());

            try
            {
                await WriteSseEventAsync("done", JsonSerializer.Serialize(new { html }, JsonOptions), ct);
            }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "[MdToPpt] patch failed for user={UserId}", userId);
            try
            {
                await WriteSseEventAsync("error",
                    JsonSerializer.Serialize(new { code = "LLM_ERROR", message = "AI 修改失败，请稍后重试" }, JsonOptions), ct);
            }
            catch { /* ignore write errors when client disconnected */ }
        }
    }

    // =========================================================================
    // POST /api/md-to-ppt/publish  — 发布为网页托管站点
    // =========================================================================

    /// <summary>
    /// 将 reveal.js HTML 发布到网页托管，可选分享到团队。
    /// 返回站点 URL。
    /// </summary>
    [HttpPost("publish")]
    public async Task<IActionResult> PublishAsync([FromBody] MdToPptPublishRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.HtmlContent))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "htmlContent 不能为空"));
        }

        var userId = this.GetRequiredUserId();
        var title = string.IsNullOrWhiteSpace(request.Title) ? "网页 PPT" : request.Title.Trim();

        try
        {
            var site = await _hostedSiteService.CreateFromContentAsync(
                userId: userId,
                htmlContent: request.HtmlContent,
                title: title,
                description: request.Description?.Trim(),
                sourceType: AppKey,
                sourceRef: null,
                tags: request.Tags?.Where(t => !string.IsNullOrWhiteSpace(t)).ToList(),
                folder: null,
                ct: ct).ConfigureAwait(false);

            if (request.TeamIds is { Count: > 0 })
            {
                await _hostedSiteService.SetSharedTeamsAsync(site.Id, userId, request.TeamIds, ct).ConfigureAwait(false);
            }

            _logger.LogInformation("[MdToPpt] site published: {SiteId} '{Title}' by {UserId}", site.Id, title, userId);

            return Ok(ApiResponse<object>.Ok(new
            {
                siteId = site.Id,
                siteUrl = site.SiteUrl,
                title = site.Title,
            }));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[MdToPpt] publish failed for user={UserId}", userId);
            return StatusCode(500, ApiResponse<object>.Fail("PUBLISH_ERROR", "发布失败，请稍后重试"));
        }
    }

    // =========================================================================
    // 私有工具方法
    // =========================================================================

    private static string NormalizeTheme(string? theme)
    {
        if (string.IsNullOrWhiteSpace(theme)) return "black";
        var t = theme.Trim().ToLowerInvariant();
        var valid = new HashSet<string> { "black", "white", "league", "beige", "sky", "night", "serif", "simple", "solarized", "blood", "moon" };
        return valid.Contains(t) ? t : "black";
    }

    private static string BuildHtmlGenerateSystemPrompt(int slideCount, string theme)
    {
        return
            $"你是一位顶级的演示文稿设计师，精通 reveal.js@4 和 HTML/CSS 设计。\n" +
            $"请将用户提供的内容转换成一份完整的、视觉设计精良的 reveal.js 网页 PPT。\n\n" +
            $"设计要求：\n" +
            $"- 生成 {slideCount} 页幻灯片\n" +
            $"- reveal.js 主题：{theme}（通过 CDN 加载）\n" +
            $"- 必须使用多样化的版式布局（不能全是纯文字列表），包括：\n" +
            $"  * 封面页：大标题 + 副标题 + 背景装饰元素\n" +
            $"  * 双栏对比页：左右两栏并排展示信息\n" +
            $"  * 数字亮点页：大数字统计卡片（如 90%、3x、1000+）\n" +
            $"  * 要点列表页：带视觉前缀的要点（非单调 <ul>）\n" +
            $"  * 图文混合页（用 CSS 色块/几何形状替代真实图片）\n" +
            $"  * 引用/金句页：居中大字引用\n" +
            $"  * 总结/行动号召页\n" +
            $"- 使用 inline CSS 增强视觉效果：渐变背景、圆角卡片、阴影、色彩强调\n" +
            $"- 字体大小层级分明：标题 > 副标题 > 正文\n" +
            $"- 配色和谐，与主题 {theme} 相配\n" +
            $"- 每页信息密度适中，不过于拥挤\n\n" +
            $"技术要求：\n" +
            $"- 输出完整的 HTML 文件，包含 <!DOCTYPE html> 到 </html>\n" +
            $"- 通过 jsdelivr CDN 加载 reveal.js@4（不要本地文件）：\n" +
            $"  * https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reset.css\n" +
            $"  * https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.css\n" +
            $"  * https://cdn.jsdelivr.net/npm/reveal.js@4/dist/theme/{theme}.css\n" +
            $"  * https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js\n" +
            $"- Reveal.initialize 配置必须包含 hash: false（避免 iframe srcdoc 场景的 History API 错误）\n" +
            $"- 配置 controls: true, progress: true, slideNumber: true, transition: 'slide'\n" +
            $"- 直接输出 HTML 代码，不要包裹在 markdown 代码围栏（```html）中\n" +
            $"- 不要输出任何解释文字，只输出 HTML";
    }

    /// <summary>
    /// 剥除 LLM 可能在 HTML 内容前后附加的 markdown 代码围栏。
    /// </summary>
    private static string StripCodeFences(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return text;

        // 去除开头的 ```html 或 ``` 行
        if (text.StartsWith("```html", StringComparison.OrdinalIgnoreCase))
        {
            var firstNewline = text.IndexOf('\n');
            if (firstNewline >= 0) text = text[(firstNewline + 1)..];
        }
        else if (text.StartsWith("```"))
        {
            var firstNewline = text.IndexOf('\n');
            if (firstNewline >= 0) text = text[(firstNewline + 1)..];
        }

        // 去除结尾的 ``` 行
        if (text.TrimEnd().EndsWith("```"))
        {
            var lastFence = text.LastIndexOf("```");
            if (lastFence > 0) text = text[..lastFence].TrimEnd();
        }

        return text.Trim();
    }

    private async Task WriteSseEventAsync(string eventName, string data, CancellationToken ct)
    {
        await Response.WriteAsync($"event: {eventName}\ndata: {data}\n\n", ct).ConfigureAwait(false);
        await Response.Body.FlushAsync(ct).ConfigureAwait(false);
    }
}

// =========================================================================
// Request / Response DTOs
// =========================================================================

/// <summary>convert 端点请求体</summary>
public class MdToPptConvertRequest
{
    /// <summary>Markdown 或纯文本内容</summary>
    public string Content { get; set; } = string.Empty;

    /// <summary>期望生成的幻灯片页数（3-20，默认 8）</summary>
    public int? SlideCount { get; set; }

    /// <summary>reveal.js 主题（black/white/league 等，默认 black）</summary>
    public string? Theme { get; set; }
}

/// <summary>patch 端点请求体</summary>
public class MdToPptPatchRequest
{
    /// <summary>当前完整的 reveal.js HTML</summary>
    public string CurrentHtml { get; set; } = string.Empty;

    /// <summary>修改要求描述</summary>
    public string SlideRequest { get; set; } = string.Empty;

    /// <summary>要修改的幻灯片索引（0-based，可选，不传则让 LLM 自行判断）</summary>
    public int? SlideIndex { get; set; }
}

/// <summary>publish 端点请求体</summary>
public class MdToPptPublishRequest
{
    /// <summary>完整的 reveal.js HTML 字符串</summary>
    public string HtmlContent { get; set; } = string.Empty;

    /// <summary>站点标题</summary>
    public string? Title { get; set; }

    /// <summary>站点描述</summary>
    public string? Description { get; set; }

    /// <summary>标签列表</summary>
    public List<string>? Tags { get; set; }

    /// <summary>分享到的团队 ID 列表（可选）</summary>
    public List<string>? TeamIds { get; set; }
}
