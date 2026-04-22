using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.Poster;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 周报海报 — 登录后主页轮播弹窗。
/// - GET /current 任何登录用户可读(取最新一篇 published)
/// - 其余写操作需要周报模板管理权限
/// 用户是否已读在前端 sessionStorage 内记录(奥卡姆剃刀:无需再开一张表)
/// </summary>
[ApiController]
[Route("api/weekly-posters")]
[AdminController(
    "report-agent",
    AdminPermissionCatalog.Access,
    WritePermission = AdminPermissionCatalog.ReportAgentTemplateManage)]
public sealed class WeeklyPosterController : ControllerBase
{
    private static readonly string ImageGenAppCallerCode = AppCallerRegistry.ReportAgent.WeeklyPoster.Image;

    private readonly MongoDbContext _db;
    private readonly ILogger<WeeklyPosterController> _logger;
    private readonly IPosterAutopilotService _autopilot;
    private readonly OpenAIImageClient _imageClient;
    private readonly ILLMRequestContextAccessor _llmRequestContext;

    public WeeklyPosterController(
        MongoDbContext db,
        ILogger<WeeklyPosterController> logger,
        IPosterAutopilotService autopilot,
        OpenAIImageClient imageClient,
        ILLMRequestContextAccessor llmRequestContext)
    {
        _db = db;
        _logger = logger;
        _autopilot = autopilot;
        _imageClient = imageClient;
        _llmRequestContext = llmRequestContext;
    }

    // ────────────────────────────────────────────────────────────
    // 用户侧:拉取当前待展示海报
    // ────────────────────────────────────────────────────────────

    [HttpGet("current")]
    public async Task<IActionResult> GetCurrent(CancellationToken ct = default)
    {
        var poster = await _db.WeeklyPosters
            .Find(x => x.Status == WeeklyPosterStatus.Published)
            .SortByDescending(x => x.PublishedAt)
            .ThenByDescending(x => x.CreatedAt)
            .FirstOrDefaultAsync(ct);

        if (poster == null)
        {
            return Ok(ApiResponse<WeeklyPosterDto?>.Ok(null));
        }

        return Ok(ApiResponse<WeeklyPosterDto?>.Ok(ToDto(poster)));
    }

    // ────────────────────────────────────────────────────────────
    // 管理端:列表 / 详情 / 增删改 / 发布
    // ────────────────────────────────────────────────────────────

    [HttpGet("")]
    public async Task<IActionResult> List(
        [FromQuery] string? status,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30,
        CancellationToken ct = default)
    {
        if (page < 1) page = 1;
        if (pageSize < 1 || pageSize > 100) pageSize = 30;

        var filter = Builders<WeeklyPosterAnnouncement>.Filter.Empty;
        if (!string.IsNullOrWhiteSpace(status))
        {
            filter &= Builders<WeeklyPosterAnnouncement>.Filter.Eq(x => x.Status, status.Trim().ToLowerInvariant());
        }

        var total = await _db.WeeklyPosters.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.WeeklyPosters
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            total,
            page,
            pageSize,
            items = items.Select(ToDto).ToList(),
        }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get([FromRoute] string id, CancellationToken ct = default)
    {
        var poster = await _db.WeeklyPosters.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (poster == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "海报不存在"));
        }
        return Ok(ApiResponse<WeeklyPosterDto>.Ok(ToDto(poster)));
    }

    [HttpPost("")]
    public async Task<IActionResult> Create([FromBody] WeeklyPosterUpsert input, CancellationToken ct = default)
    {
        if (input == null || string.IsNullOrWhiteSpace(input.Title) || string.IsNullOrWhiteSpace(input.WeekKey))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "title 和 weekKey 必填"));
        }
        if (input.Pages == null || input.Pages.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少需要一页"));
        }

        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;
        var poster = new WeeklyPosterAnnouncement
        {
            WeekKey = input.WeekKey.Trim(),
            Title = input.Title.Trim(),
            Subtitle = string.IsNullOrWhiteSpace(input.Subtitle) ? null : input.Subtitle!.Trim(),
            Status = WeeklyPosterStatus.Draft,
            TemplateKey = string.IsNullOrWhiteSpace(input.TemplateKey) ? "release" : input.TemplateKey!.Trim(),
            PresentationMode = string.IsNullOrWhiteSpace(input.PresentationMode) ? "static" : input.PresentationMode!.Trim(),
            SourceType = string.IsNullOrWhiteSpace(input.SourceType) ? null : input.SourceType!.Trim(),
            SourceRef = string.IsNullOrWhiteSpace(input.SourceRef) ? null : input.SourceRef!.Trim(),
            Pages = NormalizePages(input.Pages),
            CtaText = string.IsNullOrWhiteSpace(input.CtaText) ? "阅读完整周报" : input.CtaText!.Trim(),
            CtaUrl = string.IsNullOrWhiteSpace(input.CtaUrl) ? "/changelog" : input.CtaUrl!.Trim(),
            CreatedBy = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await _db.WeeklyPosters.InsertOneAsync(poster, cancellationToken: ct);
        return Ok(ApiResponse<WeeklyPosterDto>.Ok(ToDto(poster)));
    }

    [HttpPatch("{id}")]
    public async Task<IActionResult> Update(
        [FromRoute] string id,
        [FromBody] WeeklyPosterUpsert input,
        CancellationToken ct = default)
    {
        var poster = await _db.WeeklyPosters.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (poster == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "海报不存在"));
        }

        if (!string.IsNullOrWhiteSpace(input.WeekKey)) poster.WeekKey = input.WeekKey.Trim();
        if (!string.IsNullOrWhiteSpace(input.Title)) poster.Title = input.Title.Trim();
        if (input.Subtitle != null) poster.Subtitle = string.IsNullOrWhiteSpace(input.Subtitle) ? null : input.Subtitle.Trim();
        if (!string.IsNullOrWhiteSpace(input.TemplateKey)) poster.TemplateKey = input.TemplateKey.Trim();
        if (!string.IsNullOrWhiteSpace(input.PresentationMode)) poster.PresentationMode = input.PresentationMode.Trim();
        if (input.SourceType != null) poster.SourceType = string.IsNullOrWhiteSpace(input.SourceType) ? null : input.SourceType.Trim();
        if (input.SourceRef != null) poster.SourceRef = string.IsNullOrWhiteSpace(input.SourceRef) ? null : input.SourceRef.Trim();
        if (input.Pages != null && input.Pages.Count > 0) poster.Pages = NormalizePages(input.Pages);
        if (!string.IsNullOrWhiteSpace(input.CtaText)) poster.CtaText = input.CtaText.Trim();
        if (!string.IsNullOrWhiteSpace(input.CtaUrl)) poster.CtaUrl = input.CtaUrl.Trim();
        poster.UpdatedAt = DateTime.UtcNow;

        await _db.WeeklyPosters.ReplaceOneAsync(x => x.Id == id, poster, cancellationToken: ct);
        return Ok(ApiResponse<WeeklyPosterDto>.Ok(ToDto(poster)));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete([FromRoute] string id, CancellationToken ct = default)
    {
        var res = await _db.WeeklyPosters.DeleteOneAsync(x => x.Id == id, ct);
        if (res.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "海报不存在"));
        }
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    [HttpPost("{id}/publish")]
    public async Task<IActionResult> Publish([FromRoute] string id, CancellationToken ct = default)
    {
        var poster = await _db.WeeklyPosters.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (poster == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "海报不存在"));
        }
        if (poster.Pages == null || poster.Pages.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少需要一页才能发布"));
        }

        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;

        // 同一 WeekKey 旧 published 归档,保证 /current 总是返回最新一篇
        await _db.WeeklyPosters.UpdateManyAsync(
            Builders<WeeklyPosterAnnouncement>.Filter.And(
                Builders<WeeklyPosterAnnouncement>.Filter.Eq(x => x.WeekKey, poster.WeekKey),
                Builders<WeeklyPosterAnnouncement>.Filter.Eq(x => x.Status, WeeklyPosterStatus.Published),
                Builders<WeeklyPosterAnnouncement>.Filter.Ne(x => x.Id, id)),
            Builders<WeeklyPosterAnnouncement>.Update
                .Set(x => x.Status, WeeklyPosterStatus.Archived)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        await _db.WeeklyPosters.UpdateOneAsync(
            x => x.Id == id,
            Builders<WeeklyPosterAnnouncement>.Update
                .Set(x => x.Status, WeeklyPosterStatus.Published)
                .Set(x => x.PublishedAt, now)
                .Set(x => x.PublishedBy, userId)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        poster.Status = WeeklyPosterStatus.Published;
        poster.PublishedAt = now;
        poster.PublishedBy = userId;
        poster.UpdatedAt = now;
        _logger.LogInformation("WeeklyPoster {Id} published by {User}", id, userId);
        return Ok(ApiResponse<WeeklyPosterDto>.Ok(ToDto(poster)));
    }

    [HttpPost("{id}/unpublish")]
    public async Task<IActionResult> Unpublish([FromRoute] string id, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var res = await _db.WeeklyPosters.UpdateOneAsync(
            x => x.Id == id,
            Builders<WeeklyPosterAnnouncement>.Update
                .Set(x => x.Status, WeeklyPosterStatus.Draft)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);
        if (res.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "海报不存在"));
        }
        return Ok(ApiResponse<object>.Ok(new { unpublished = true }));
    }

    // ────────────────────────────────────────────────────────────
    // AI 向导:一键生成草稿
    // ────────────────────────────────────────────────────────────

    /// <summary>
    /// 前端渲染模板选择器用的元数据列表。任何登录用户可读(不做权限拦截)。
    /// </summary>
    [HttpGet("templates")]
    public IActionResult ListTemplates()
    {
        var items = PosterTemplateRegistry.All.Select(t => new
        {
            key = t.Key,
            label = t.Label,
            description = t.Description,
            emoji = t.Emoji,
            defaultPages = t.DefaultPages,
            accentPalette = t.AccentPalette,
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    public sealed class AutopilotRequest
    {
        public string? TemplateKey { get; set; }
        public string? SourceType { get; set; }
        public string? FreeformContent { get; set; }
        public string? SourceRef { get; set; }
        public string? WeekKey { get; set; }
        public int? PageCount { get; set; }
        public string? CtaUrl { get; set; }
    }

    // ────────────────────────────────────────────────────────────
    // 知识库:列出可选的文档条目(给向导页的 knowledge-base 选择器用)
    // ────────────────────────────────────────────────────────────
    [HttpGet("knowledge-entries")]
    public async Task<IActionResult> ListKnowledgeEntries(
        [FromQuery] string? keyword,
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
    {
        if (limit < 1 || limit > 100) limit = 50;
        var filter = Builders<DocumentEntry>.Filter.Eq(x => x.IsFolder, false);
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = keyword.Trim();
            filter &= Builders<DocumentEntry>.Filter.Or(
                Builders<DocumentEntry>.Filter.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                Builders<DocumentEntry>.Filter.Regex(x => x.ContentIndex, new MongoDB.Bson.BsonRegularExpression(kw, "i")));
        }
        var items = await _db.DocumentEntries
            .Find(filter)
            .SortByDescending(x => x.UpdatedBy)
            .Limit(limit)
            .Project(x => new
            {
                id = x.Id,
                title = x.Title,
                summary = x.Summary,
                contentChars = (x.ContentIndex ?? string.Empty).Length,
                storeId = x.StoreId,
            })
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 一键生成草稿:读取数据源 → 调 LLM → 解析页面 → 落库为 draft 返回。
    /// 图片尚未生成,由前端后续并行调用 /:id/pages/:order/generate-image。
    /// </summary>
    [HttpPost("autopilot")]
    public async Task<IActionResult> Autopilot([FromBody] AutopilotRequest req, CancellationToken ct)
    {
        req ??= new AutopilotRequest();
        var userId = this.GetRequiredUserId();
        var templateKey = string.IsNullOrWhiteSpace(req.TemplateKey) ? "release" : req.TemplateKey!.Trim();
        var sourceType = string.IsNullOrWhiteSpace(req.SourceType) ? "changelog-current-week" : req.SourceType!.Trim();
        var weekKey = string.IsNullOrWhiteSpace(req.WeekKey) ? IsoWeekKey(DateTime.UtcNow) : req.WeekKey!.Trim();

        PosterAutopilotResult pages;
        try
        {
            pages = await _autopilot.GeneratePagesAsync(
                new PosterAutopilotInput
                {
                    TemplateKey = templateKey,
                    SourceType = sourceType,
                    FreeformContent = req.FreeformContent,
                    SourceRef = req.SourceRef,
                    ForcePageCount = req.PageCount,
                },
                userId,
                ct);
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail("AUTOPILOT_FAILED", ex.Message));
        }

        var template = PosterTemplateRegistry.FindOrDefault(templateKey);
        var now = DateTime.UtcNow;
        var poster = new WeeklyPosterAnnouncement
        {
            WeekKey = weekKey,
            Title = string.IsNullOrWhiteSpace(pages.Title)
                ? $"{template.Emoji} {template.Label} · {weekKey}"
                : pages.Title,
            Subtitle = pages.Subtitle,
            Status = WeeklyPosterStatus.Draft,
            TemplateKey = template.Key,
            PresentationMode = "static",
            SourceType = sourceType,
            SourceRef = pages.SourceSummary,
            Pages = pages.Pages.Select(p => new WeeklyPosterPage
            {
                Order = p.Order,
                Title = p.Title,
                Body = p.Body,
                ImagePrompt = p.ImagePrompt,
                AccentColor = p.AccentColor,
                ImageUrl = null,
            }).ToList(),
            CtaText = template.Key switch
            {
                "hotfix" => "查看完整修复清单",
                "promo" => "立即体验",
                "sale" => "马上参与",
                _ => "阅读完整周报",
            },
            CtaUrl = string.IsNullOrWhiteSpace(req.CtaUrl) ? "/changelog" : req.CtaUrl!.Trim(),
            CreatedBy = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };

        await _db.WeeklyPosters.InsertOneAsync(poster, cancellationToken: ct);
        _logger.LogInformation(
            "WeeklyPoster autopilot drafted {Id} template={Template} source={Source} pages={Count} model={Model}",
            poster.Id, template.Key, sourceType, poster.Pages.Count, pages.Model ?? "-");

        return Ok(ApiResponse<object>.Ok(new
        {
            poster = ToDto(poster),
            model = pages.Model,
            platform = pages.Platform,
            sourceSummary = pages.SourceSummary,
        }));
    }

    // ────────────────────────────────────────────────────────────
    // AI 向导 · SSE 流式(满足 CLAUDE.md #6 禁止空白等待)
    // 事件序列:phase(reading-source) → source → phase(writing) → model
    //         → page × N(交错推送) → done
    // ────────────────────────────────────────────────────────────
    [HttpPost("autopilot/stream")]
    [Produces("text/event-stream")]
    public async Task AutopilotStream([FromBody] AutopilotRequest? req, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no"; // 关闭 nginx 缓冲

        async Task Emit(string evt, object data)
        {
            var json = JsonSerializer.Serialize(data);
            var frame = $"event: {evt}\ndata: {json}\n\n";
            await Response.WriteAsync(frame, Encoding.UTF8, ct);
            await Response.Body.FlushAsync(ct);
        }

        async Task EmitError(string message)
        {
            try { await Emit("error", new { message }); } catch { /* ignore */ }
        }

        try
        {
            req ??= new AutopilotRequest();
            var userId = this.GetRequiredUserId();
            var templateKey = string.IsNullOrWhiteSpace(req.TemplateKey) ? "release" : req.TemplateKey!.Trim();
            var sourceType = string.IsNullOrWhiteSpace(req.SourceType) ? "changelog-current-week" : req.SourceType!.Trim();
            var weekKey = string.IsNullOrWhiteSpace(req.WeekKey) ? IsoWeekKey(DateTime.UtcNow) : req.WeekKey!.Trim();

            await Emit("phase", new { phase = "reading-source", label = "正在读取数据源…" });

            (string markdown, string summary) src;
            try
            {
                src = await _autopilot.LoadSourceAsync(
                    new PosterAutopilotInput
                    {
                        TemplateKey = templateKey,
                        SourceType = sourceType,
                        FreeformContent = req.FreeformContent,
                        SourceRef = req.SourceRef,
                        ForcePageCount = req.PageCount,
                    }, ct);
            }
            catch (InvalidOperationException ex)
            {
                await EmitError(ex.Message);
                return;
            }

            await Emit("source", new { summary = src.summary });
            await Emit("phase", new { phase = "writing", label = "AI 正在编排 4-6 页文案…" });

            PosterAutopilotResult result;
            try
            {
                result = await _autopilot.InvokeLlmAsync(
                    templateKey, req.PageCount, src.markdown, src.summary, userId, ct);
            }
            catch (InvalidOperationException ex)
            {
                await EmitError(ex.Message);
                return;
            }

            if (!string.IsNullOrWhiteSpace(result.Model))
            {
                await Emit("model", new { model = result.Model, platform = result.Platform });
            }

            // 落库成 draft
            var template = PosterTemplateRegistry.FindOrDefault(templateKey);
            var now = DateTime.UtcNow;
            var poster = new WeeklyPosterAnnouncement
            {
                WeekKey = weekKey,
                Title = string.IsNullOrWhiteSpace(result.Title)
                    ? $"{template.Emoji} {template.Label} · {weekKey}"
                    : result.Title,
                Subtitle = result.Subtitle,
                Status = WeeklyPosterStatus.Draft,
                TemplateKey = template.Key,
                PresentationMode = "static",
                SourceType = sourceType,
                SourceRef = result.SourceSummary,
                Pages = result.Pages.Select(p => new WeeklyPosterPage
                {
                    Order = p.Order,
                    Title = p.Title,
                    Body = p.Body,
                    ImagePrompt = p.ImagePrompt,
                    AccentColor = p.AccentColor,
                    ImageUrl = null,
                }).ToList(),
                CtaText = template.Key switch
                {
                    "hotfix" => "查看完整修复清单",
                    "promo" => "立即体验",
                    "sale" => "马上参与",
                    _ => "阅读完整周报",
                },
                CtaUrl = string.IsNullOrWhiteSpace(req.CtaUrl) ? "/changelog" : req.CtaUrl!.Trim(),
                CreatedBy = userId,
                CreatedAt = now,
                UpdatedAt = now,
            };
            await _db.WeeklyPosters.InsertOneAsync(poster, cancellationToken: ct);

            // 交错推送每一页 — 用户视觉上看到卡片一张张冒出来
            var dto = ToDto(poster);
            await Emit("phase", new { phase = "emitting-pages", label = "页面材质化…" });
            foreach (var pageDto in dto.Pages)
            {
                await Emit("page", new { page = pageDto, total = dto.Pages.Count });
                await Task.Delay(120, ct);
            }

            await Emit("done", new { poster = dto });
        }
        catch (OperationCanceledException)
        {
            // 客户端断开,静默
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AutopilotStream crashed");
            await EmitError(ex.Message);
        }
    }

    // ────────────────────────────────────────────────────────────
    // 单页生图
    // ────────────────────────────────────────────────────────────

    /// <summary>
    /// 为指定页生成配图。同步调用(约 10-30s),返回更新后的 poster。
    /// prompt 复用 page.ImagePrompt,也允许 body 中传入 overrides.prompt 覆盖(重生场景)。
    /// </summary>
    [HttpPost("{id}/pages/{order:int}/generate-image")]
    public async Task<IActionResult> GeneratePageImage(
        [FromRoute] string id,
        [FromRoute] int order,
        [FromBody] GenerateImageRequest? req,
        CancellationToken ct)
    {
        var poster = await _db.WeeklyPosters.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (poster == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "海报不存在"));
        }
        var page = poster.Pages.FirstOrDefault(p => p.Order == order);
        if (page == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "页不存在"));
        }

        var prompt = !string.IsNullOrWhiteSpace(req?.OverridePrompt) ? req!.OverridePrompt!.Trim() : page.ImagePrompt;
        if (string.IsNullOrWhiteSpace(prompt))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "该页没有 imagePrompt"));
        }

        var userId = this.GetRequiredUserId();
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: prompt.Length,
            DocumentHash: null,
            SystemPromptRedacted: "weekly-poster-image-gen",
            RequestType: "imageGen",
            AppCallerCode: ImageGenAppCallerCode));

        var res = await _imageClient.GenerateUnifiedAsync(
            prompt: prompt,
            n: 1,
            size: "1024x1024",
            responseFormat: "url",
            ct: ct,
            appCallerCode: ImageGenAppCallerCode);
        if (!res.Success || res.Data?.Images == null || res.Data.Images.Count == 0)
        {
            return StatusCode(502, ApiResponse<object>.Fail(
                res.Error?.Code ?? ErrorCodes.LLM_ERROR,
                res.Error?.Message ?? "生图未返回结果"));
        }
        var img = res.Data.Images[0];
        var url = !string.IsNullOrWhiteSpace(img.Url)
            ? img.Url!
            : !string.IsNullOrWhiteSpace(img.Base64)
                ? $"data:image/png;base64,{img.Base64}"
                : null;
        if (string.IsNullOrWhiteSpace(url))
        {
            return StatusCode(502, ApiResponse<object>.Fail(ErrorCodes.LLM_ERROR, "生图结果无 url/base64"));
        }

        page.ImageUrl = url;
        if (!string.IsNullOrWhiteSpace(req?.OverridePrompt))
        {
            page.ImagePrompt = prompt;
        }
        poster.UpdatedAt = DateTime.UtcNow;
        await _db.WeeklyPosters.ReplaceOneAsync(x => x.Id == id, poster, cancellationToken: ct);
        return Ok(ApiResponse<WeeklyPosterDto>.Ok(ToDto(poster)));
    }

    public sealed class GenerateImageRequest
    {
        public string? OverridePrompt { get; set; }
    }

    private static string IsoWeekKey(DateTime dt)
    {
        // ISO 8601 week: Thursday rule
        var day = (int)dt.DayOfWeek;
        if (day == 0) day = 7;
        var thursday = dt.AddDays(4 - day);
        var isoYear = thursday.Year;
        var jan1 = new DateTime(isoYear, 1, 1);
        var jan1Day = (int)jan1.DayOfWeek;
        if (jan1Day == 0) jan1Day = 7;
        var week = (int)Math.Floor((thursday.DayOfYear + jan1Day - 2) / 7.0) + 1;
        return $"{isoYear}-W{week:D2}";
    }

    // ────────────────────────────────────────────────────────────
    // DTO & helpers
    // ────────────────────────────────────────────────────────────

    private static List<WeeklyPosterPage> NormalizePages(List<WeeklyPosterPageInput> inputs)
    {
        var list = new List<WeeklyPosterPage>();
        var ordered = inputs
            .Where(p => p != null)
            .OrderBy(p => p.Order)
            .ToList();
        for (int i = 0; i < ordered.Count; i++)
        {
            var p = ordered[i];
            list.Add(new WeeklyPosterPage
            {
                Order = i,
                Title = (p.Title ?? string.Empty).Trim(),
                Body = (p.Body ?? string.Empty).Trim(),
                ImagePrompt = (p.ImagePrompt ?? string.Empty).Trim(),
                ImageUrl = string.IsNullOrWhiteSpace(p.ImageUrl) ? null : p.ImageUrl!.Trim(),
                AccentColor = string.IsNullOrWhiteSpace(p.AccentColor) ? null : p.AccentColor!.Trim(),
            });
        }
        return list;
    }

    private static WeeklyPosterDto ToDto(WeeklyPosterAnnouncement poster) => new()
    {
        Id = poster.Id,
        WeekKey = poster.WeekKey,
        Title = poster.Title,
        Subtitle = poster.Subtitle,
        Status = poster.Status,
        TemplateKey = string.IsNullOrWhiteSpace(poster.TemplateKey) ? "release" : poster.TemplateKey,
        PresentationMode = string.IsNullOrWhiteSpace(poster.PresentationMode) ? "static" : poster.PresentationMode,
        SourceType = poster.SourceType,
        SourceRef = poster.SourceRef,
        Pages = poster.Pages?
            .OrderBy(p => p.Order)
            .Select(p => new WeeklyPosterPageDto
            {
                Order = p.Order,
                Title = p.Title,
                Body = p.Body,
                ImagePrompt = p.ImagePrompt,
                ImageUrl = p.ImageUrl,
                AccentColor = p.AccentColor,
            }).ToList() ?? new List<WeeklyPosterPageDto>(),
        CtaText = poster.CtaText,
        CtaUrl = poster.CtaUrl,
        PublishedAt = poster.PublishedAt,
        UpdatedAt = poster.UpdatedAt,
    };

    public sealed class WeeklyPosterUpsert
    {
        public string? WeekKey { get; set; }
        public string? Title { get; set; }
        public string? Subtitle { get; set; }
        public string? TemplateKey { get; set; }
        public string? PresentationMode { get; set; }
        public string? SourceType { get; set; }
        public string? SourceRef { get; set; }
        public List<WeeklyPosterPageInput>? Pages { get; set; }
        public string? CtaText { get; set; }
        public string? CtaUrl { get; set; }
    }

    public sealed class WeeklyPosterPageInput
    {
        public int Order { get; set; }
        public string? Title { get; set; }
        public string? Body { get; set; }
        public string? ImagePrompt { get; set; }
        public string? ImageUrl { get; set; }
        public string? AccentColor { get; set; }
    }

    public sealed class WeeklyPosterDto
    {
        public string Id { get; set; } = string.Empty;
        public string WeekKey { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string? Subtitle { get; set; }
        public string Status { get; set; } = string.Empty;
        public string TemplateKey { get; set; } = "release";
        public string PresentationMode { get; set; } = "static";
        public string? SourceType { get; set; }
        public string? SourceRef { get; set; }
        public List<WeeklyPosterPageDto> Pages { get; set; } = new();
        public string CtaText { get; set; } = string.Empty;
        public string CtaUrl { get; set; } = string.Empty;
        public DateTime? PublishedAt { get; set; }
        public DateTime UpdatedAt { get; set; }
    }

    public sealed class WeeklyPosterPageDto
    {
        public int Order { get; set; }
        public string Title { get; set; } = string.Empty;
        public string Body { get; set; } = string.Empty;
        public string ImagePrompt { get; set; } = string.Empty;
        public string? ImageUrl { get; set; }
        public string? AccentColor { get; set; }
    }
}
