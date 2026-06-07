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
/// 三个端点：
///   POST convert  — LLM 流式生成 PPT 大纲（SSE）
///   POST render   — 将结构化大纲渲染为 reveal.js HTML 字符串
///   POST publish  — 将 HTML 发布为网页托管站点
/// </summary>
[ApiController]
[Route("api/md-to-ppt")]
[Authorize]
[AdminController("ai-toolbox", AdminPermissionCatalog.AiToolboxUse)]
public class MdToPptController : ControllerBase
{
    private const string AppKey = "md-to-ppt-agent";
    private const string ConvertCallerCode = AppCallerRegistry.MdToPptAgent.Generation.Convert;

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
    // POST /api/md-to-ppt/convert  — 流式生成 PPT 大纲
    // =========================================================================

    /// <summary>
    /// 将 Markdown / 纯文本通过 LLM 流式生成 PPT 大纲。
    /// 返回 SSE 流，每个 delta 事件携带增量文本；done 事件携带完整大纲。
    /// 大纲格式：每页用 --- 分隔，页内第一行为标题，其余行为要点。
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
            SystemPromptRedacted: "md-to-ppt-convert",
            RequestType: "chat",
            AppCallerCode: ConvertCallerCode));

        var slideCount = Math.Clamp(request.SlideCount ?? 8, 3, 20);

        var systemPrompt =
            $"你是一位专业的演示文稿设计师。请将用户提供的内容转换成 PPT 大纲结构。\n" +
            $"要求：\n" +
            $"- 生成 {slideCount} 页幻灯片\n" +
            $"- 每页用 --- 单独一行分隔\n" +
            $"- 每页第一行为该页标题（不超过 20 字）\n" +
            $"- 标题之后每行一个要点（每页 3-5 个要点，每个要点不超过 30 字）\n" +
            $"- 第一页为封面页（标题 + 副标题）\n" +
            $"- 直接输出大纲内容，不要 markdown 代码围栏，不要额外解释\n" +
            $"示例格式：\n" +
            $"产品介绍\n" +
            $"革命性的用户体验设计\n" +
            $"---\n" +
            $"核心功能\n" +
            $"支持多格式文件导入\n" +
            $"AI 驱动的智能排版";

        var requestBody = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = request.Content.Length > 12000
                    ? string.Concat(request.Content.AsSpan(0, 12000), "\n...(内容已截断)")
                    : request.Content },
            },
            ["temperature"] = 0.5,
            ["max_tokens"] = 2400,
        };

        try
        {
            await WriteSseEventAsync("start", JsonSerializer.Serialize(new { slideCount }, JsonOptions), ct);

            var fullText = new StringBuilder();

            await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
            {
                AppCallerCode = ConvertCallerCode,
                ModelType = ModelTypes.Chat,
                RequestBody = requestBody,
            }, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    fullText.Append(chunk.Content);
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

            var outline = fullText.ToString().Trim();
            var slides = ParseOutline(outline);

            try
            {
                await WriteSseEventAsync("done", JsonSerializer.Serialize(new { outline, slides }, JsonOptions), ct);
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
    // POST /api/md-to-ppt/render  — 将大纲渲染为 reveal.js HTML
    // =========================================================================

    /// <summary>
    /// 接受结构化 PPT 大纲，返回完整的 reveal.js HTML 字符串（CDN，可直接嵌入 iframe）。
    /// 不调用 LLM，为纯同步转换。
    /// </summary>
    [HttpPost("render")]
    public IActionResult RenderAsync([FromBody] MdToPptRenderRequest request)
    {
        if (request.Slides == null || request.Slides.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "slides 不能为空"));
        }

        var theme = string.IsNullOrWhiteSpace(request.Theme) ? "black" : request.Theme.Trim().ToLowerInvariant();
        var validThemes = new HashSet<string> { "black", "white", "league", "beige", "sky", "night", "serif", "simple", "solarized", "blood", "moon" };
        if (!validThemes.Contains(theme)) theme = "black";

        var html = BuildRevealHtml(request.Slides, theme, request.Title);
        return Ok(ApiResponse<object>.Ok(new { html }));
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

    private async Task WriteSseEventAsync(string eventName, string data, CancellationToken ct)
    {
        await Response.WriteAsync($"event: {eventName}\ndata: {data}\n\n", ct).ConfigureAwait(false);
        await Response.Body.FlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>
    /// 将 LLM 返回的大纲文本（--- 分页）解析为结构化幻灯片列表。
    /// 每页第一行为标题，后续行为要点。
    /// </summary>
    private static List<PptSlide> ParseOutline(string outline)
    {
        var slides = new List<PptSlide>();
        if (string.IsNullOrWhiteSpace(outline)) return slides;

        var pages = outline.Split(new[] { "\n---\n", "\r\n---\r\n", "\n---\r\n", "\r\n---\n" },
            StringSplitOptions.RemoveEmptyEntries);

        foreach (var page in pages)
        {
            var lines = page.Trim().Split('\n', StringSplitOptions.RemoveEmptyEntries);
            if (lines.Length == 0) continue;

            var title = lines[0].Trim().TrimStart('#').Trim();
            var bullets = lines.Skip(1)
                .Select(l => l.Trim().TrimStart('-', '*', '•').Trim())
                .Where(l => !string.IsNullOrWhiteSpace(l))
                .ToList();

            slides.Add(new PptSlide { Title = title, Bullets = bullets });
        }

        return slides;
    }

    /// <summary>
    /// 生成完整的 reveal.js HTML 字符串，所有资源均走 CDN。
    /// </summary>
    private static string BuildRevealHtml(List<PptSlide> slides, string theme, string? title)
    {
        var sectionsBuilder = new StringBuilder();
        foreach (var slide in slides)
        {
            sectionsBuilder.AppendLine("<section>");
            sectionsBuilder.AppendLine($"  <h2>{EscapeHtml(slide.Title)}</h2>");
            if (slide.Bullets.Count > 0)
            {
                sectionsBuilder.AppendLine("  <ul>");
                foreach (var bullet in slide.Bullets)
                {
                    sectionsBuilder.AppendLine($"    <li>{EscapeHtml(bullet)}</li>");
                }
                sectionsBuilder.AppendLine("  </ul>");
            }
            sectionsBuilder.AppendLine("</section>");
        }

        var pageTitle = string.IsNullOrWhiteSpace(title) ? "网页 PPT" : title;

        return $$"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{EscapeHtml(pageTitle)}}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reset.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/theme/{{theme}}.css">
  <style>
    .reveal ul { list-style: disc; text-align: left; padding-left: 1.5em; }
    .reveal li { margin: 0.4em 0; font-size: 0.85em; line-height: 1.5; }
    .reveal h2 { font-size: 1.4em; margin-bottom: 0.6em; }
  </style>
</head>
<body>
  <div class="reveal">
    <div class="slides">
{{sectionsBuilder}}    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@4/dist/reveal.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      slideNumber: true,
      transition: 'slide',
      plugins: []
    });
  </script>
</body>
</html>
""";
    }

    private static string EscapeHtml(string text)
    {
        return text
            .Replace("&", "&amp;")
            .Replace("<", "&lt;")
            .Replace(">", "&gt;")
            .Replace("\"", "&quot;")
            .Replace("'", "&#39;");
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
}

/// <summary>render 端点请求体</summary>
public class MdToPptRenderRequest
{
    /// <summary>结构化幻灯片列表（来自 convert 的解析结果）</summary>
    public List<PptSlide> Slides { get; set; } = new();

    /// <summary>reveal.js 主题名（black/white/league 等，默认 black）</summary>
    public string? Theme { get; set; }

    /// <summary>HTML title 标签内容</summary>
    public string? Title { get; set; }
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

/// <summary>单页幻灯片结构</summary>
public class PptSlide
{
    /// <summary>页面标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>要点列表</summary>
    public List<string> Bullets { get; set; } = new();
}
