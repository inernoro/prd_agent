using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

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
    private readonly MongoDbContext _db;
    private readonly ILogger<WeeklyPosterController> _logger;

    public WeeklyPosterController(MongoDbContext db, ILogger<WeeklyPosterController> logger)
    {
        _db = db;
        _logger = logger;
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
