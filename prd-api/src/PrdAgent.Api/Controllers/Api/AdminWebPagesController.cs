using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 全部网页审计（高级权限）—— 查看所有用户的托管网页 + 阅读量 + 访客 ID。
///
/// 与 <see cref="WebPagesController"/> 的区别：那边只查"我的"站点；本控制器
/// 跨所有用户读取（不按 OwnerUserId 过滤），整体由 web-pages.viewAll 权限门控。
/// 只读：不提供任何写/删操作。访客记录来源于 site_view_events 集合（由站点访问
/// 路径写入，本控制器仅读取）。
/// </summary>
[ApiController]
[Route("api/admin-web-pages")]
[Authorize]
[AdminController("admin-web-pages", AdminPermissionCatalog.WebPagesViewAll, WritePermission = AdminPermissionCatalog.WebPagesViewAll)]
public class AdminWebPagesController : ControllerBase
{
    private readonly PrdAgent.Infrastructure.Database.MongoDbContext _db;
    private readonly IConfiguration _cfg;
    private readonly ILogger<AdminWebPagesController> _logger;
    private readonly IHostedSiteService _siteService;

    public AdminWebPagesController(
        PrdAgent.Infrastructure.Database.MongoDbContext db,
        IConfiguration cfg,
        ILogger<AdminWebPagesController> logger,
        IHostedSiteService siteService)
    {
        _db = db;
        _cfg = cfg;
        _logger = logger;
        _siteService = siteService;
    }

    /// <summary>
    /// 分享诊断（admin）—— 用于排查"链接为什么过期/不能访问"投诉。
    /// 返回链接完整状态、续期审计历史、最近 10 条访问、一句话诊断结论。
    /// </summary>
    [HttpGet("share-diagnostics/{token}")]
    public async Task<IActionResult> GetShareDiagnostics(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "token 必填"));

        var result = await _siteService.GetShareDiagnosticsAsync(token);
        if (result == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));
        return Ok(ApiResponse<object>.Ok(result));
    }

    private string GetUserId() => this.GetRequiredUserId();

    // ─────────────────────────────────────────────
    // 全部站点列表（跨所有用户）
    // ─────────────────────────────────────────────

    /// <summary>
    /// 列出所有用户的托管站点。可选关键词（标题/描述正则）、ownerUserId 过滤，
    /// sort = newest（默认）| most-viewed。返回 items + total + owners 映射。
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? keyword,
        [FromQuery] string? ownerUserId,
        [FromQuery] string sort = "newest",
        [FromQuery] int skip = 0,
        [FromQuery] int limit = 50)
    {
        // 访问门控由 [AdminController] + 中间件按 web-pages.viewAll 权限完成；
        // 此处仅记录调用方便于审计。
        _logger.LogInformation("[AdminWebPages] List by {UserId} keyword={Keyword} owner={Owner}",
            GetUserId(), keyword, ownerUserId);

        if (skip < 0) skip = 0;
        if (limit <= 0 || limit > 200) limit = 50;

        var filters = new List<FilterDefinition<HostedSite>>();
        var fb = Builders<HostedSite>.Filter;

        if (!string.IsNullOrWhiteSpace(ownerUserId))
            filters.Add(fb.Eq(s => s.OwnerUserId, ownerUserId.Trim()));

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            // 关键词正则：转义用户输入避免无效正则/注入，镜像 HostedSiteService.ListAsync 的过滤风格
            var escaped = System.Text.RegularExpressions.Regex.Escape(keyword.Trim());
            var rx = new MongoDB.Bson.BsonRegularExpression(escaped, "i");
            filters.Add(fb.Or(
                fb.Regex(s => s.Title, rx),
                fb.Regex(s => s.Description, rx)));
        }

        var filter = filters.Count > 0 ? fb.And(filters) : fb.Empty;

        var sortDef = string.Equals(sort, "most-viewed", StringComparison.OrdinalIgnoreCase)
            ? Builders<HostedSite>.Sort.Descending(s => s.ViewCount).Descending(s => s.CreatedAt)
            : Builders<HostedSite>.Sort.Descending(s => s.CreatedAt);

        var total = await _db.HostedSites.CountDocumentsAsync(filter);

        var sites = await _db.HostedSites
            .Find(filter)
            .Sort(sortDef)
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        var items = sites.Select(s => new
        {
            id = s.Id,
            title = s.Title,
            description = s.Description,
            ownerUserId = s.OwnerUserId,
            viewCount = s.ViewCount,
            visibility = s.Visibility,
            sourceType = s.SourceType,
            tags = s.Tags,
            folder = s.Folder,
            createdAt = s.CreatedAt,
            updatedAt = s.UpdatedAt,
        }).ToList();

        var owners = await BuildOwnerMapAsync(sites.Select(s => s.OwnerUserId));

        return Ok(ApiResponse<object>.Ok(new { items, total, owners }));
    }

    // ─────────────────────────────────────────────
    // 单站点访客记录
    // ─────────────────────────────────────────────

    /// <summary>
    /// 列出某站点的访客痕迹（site_view_events），按访问时间倒序分页。
    /// 返回 items + total + uniqueViewers（去重登录访客数）。
    /// </summary>
    [HttpGet("{id}/viewers")]
    public async Task<IActionResult> Viewers(string id, [FromQuery] int skip = 0, [FromQuery] int limit = 50)
    {
        _logger.LogInformation("[AdminWebPages] Viewers of site {SiteId} by {UserId}", id, GetUserId());

        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "站点 ID 不能为空"));

        if (skip < 0) skip = 0;
        if (limit <= 0 || limit > 200) limit = 50;

        var filter = Builders<SiteViewEvent>.Filter.Eq(e => e.SiteId, id.Trim());

        var total = await _db.SiteViewEvents.CountDocumentsAsync(filter);

        var events = await _db.SiteViewEvents
            .Find(filter)
            .Sort(Builders<SiteViewEvent>.Sort.Descending(e => e.ViewedAt))
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        // 去重登录访客数（匿名访问 ViewerUserId 为空，不计入唯一访客）
        var uniqueViewers = await _db.SiteViewEvents
            .Distinct<string?>("ViewerUserId", Builders<SiteViewEvent>.Filter.And(
                filter,
                Builders<SiteViewEvent>.Filter.Ne(e => e.ViewerUserId, null)))
            .ToListAsync();
        var uniqueCount = uniqueViewers.Count(v => !string.IsNullOrWhiteSpace(v));

        var items = events.Select(e => new
        {
            id = e.Id,
            siteId = e.SiteId,
            siteTitle = e.SiteTitle,
            viewerUserId = e.ViewerUserId,
            viewerName = e.ViewerName,
            viewerAvatarFileName = e.ViewerAvatarFileName,
            viewedAt = e.ViewedAt,
            ipAddress = e.IpAddress,
            userAgent = e.UserAgent,
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, uniqueViewers = uniqueCount }));
    }

    // ─────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────

    /// <summary>
    /// 批量加载站点 owner 展示卡（userId → 昵称 + 头像文件名）。
    /// 前端用 resolveAvatarUrl(avatarFileName) 拼出可渲染 URL，故此处只返回文件名。
    /// </summary>
    private async Task<Dictionary<string, object>> BuildOwnerMapAsync(IEnumerable<string> userIds)
    {
        var ids = userIds.Where(u => !string.IsNullOrWhiteSpace(u)).Distinct().ToList();
        var map = new Dictionary<string, object>();
        if (ids.Count == 0) return map;

        var users = await _db.Users.Find(u => ids.Contains(u.UserId)).ToListAsync();
        foreach (var u in users)
        {
            map[u.UserId] = new
            {
                userId = u.UserId,
                displayName = !string.IsNullOrWhiteSpace(u.DisplayName) ? u.DisplayName : u.Username,
                avatarFileName = u.AvatarFileName,
            };
        }
        return map;
    }
}
