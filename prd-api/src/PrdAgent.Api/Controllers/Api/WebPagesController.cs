using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页收藏与分享管理
/// </summary>
[ApiController]
[Route("api/web-pages")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public class WebPagesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<WebPagesController> _logger;

    public WebPagesController(MongoDbContext db, ILogger<WebPagesController> logger)
    {
        _db = db;
        _logger = logger;
    }

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    // ─────────────────────────────────────────────
    // 网页 CRUD
    // ─────────────────────────────────────────────

    /// <summary>获取当前用户的网页列表</summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? keyword,
        [FromQuery] string? folder,
        [FromQuery] string? tag,
        [FromQuery] bool? isFavorite,
        [FromQuery] string sort = "newest",
        [FromQuery] int skip = 0,
        [FromQuery] int limit = 50)
    {
        var userId = GetUserId();
        var fb = Builders<WebPage>.Filter;
        var filter = fb.Eq(x => x.OwnerUserId, userId);

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = keyword.Trim();
            filter &= fb.Or(
                fb.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                fb.Regex(x => x.Url, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                fb.Regex(x => x.Description, new MongoDB.Bson.BsonRegularExpression(kw, "i"))
            );
        }

        if (!string.IsNullOrWhiteSpace(folder))
            filter &= fb.Eq(x => x.Folder, folder.Trim());

        if (!string.IsNullOrWhiteSpace(tag))
            filter &= fb.AnyEq(x => x.Tags, tag.Trim());

        if (isFavorite == true)
            filter &= fb.Eq(x => x.IsFavorite, true);

        limit = Math.Clamp(limit, 1, 200);

        var sortDef = sort switch
        {
            "oldest" => Builders<WebPage>.Sort.Ascending(x => x.CreatedAt),
            "title" => Builders<WebPage>.Sort.Ascending(x => x.Title),
            "most-viewed" => Builders<WebPage>.Sort.Descending(x => x.ViewCount),
            _ => Builders<WebPage>.Sort.Descending(x => x.CreatedAt),
        };

        var total = await _db.WebPages.CountDocumentsAsync(filter);
        var items = await _db.WebPages.Find(filter)
            .Sort(sortDef)
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>获取单个网页详情</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var userId = GetUserId();
        var page = await _db.WebPages.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync();
        if (page == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "网页不存在"));
        return Ok(ApiResponse<object>.Ok(page));
    }

    /// <summary>创建网页收藏</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateWebPageRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Url))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "URL 不能为空"));

        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题不能为空"));

        var userId = GetUserId();
        var page = new WebPage
        {
            Url = req.Url.Trim(),
            Title = req.Title.Trim(),
            Description = req.Description?.Trim(),
            FaviconUrl = req.FaviconUrl?.Trim(),
            CoverImageUrl = req.CoverImageUrl?.Trim(),
            Tags = req.Tags ?? new List<string>(),
            Folder = req.Folder?.Trim(),
            Note = req.Note?.Trim(),
            IsFavorite = req.IsFavorite,
            IsPublic = req.IsPublic,
            OwnerUserId = userId,
        };

        await _db.WebPages.InsertOneAsync(page);
        _logger.LogInformation("用户 {UserId} 创建网页收藏 {PageId}: {Title}", userId, page.Id, page.Title);
        return Ok(ApiResponse<object>.Ok(page));
    }

    /// <summary>更新网页收藏</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateWebPageRequest req)
    {
        var userId = GetUserId();
        var ub = Builders<WebPage>.Update;
        var updates = new List<UpdateDefinition<WebPage>>();

        if (req.Title != null) updates.Add(ub.Set(x => x.Title, req.Title.Trim()));
        if (req.Description != null) updates.Add(ub.Set(x => x.Description, req.Description.Trim()));
        if (req.Url != null) updates.Add(ub.Set(x => x.Url, req.Url.Trim()));
        if (req.FaviconUrl != null) updates.Add(ub.Set(x => x.FaviconUrl, req.FaviconUrl.Trim()));
        if (req.CoverImageUrl != null) updates.Add(ub.Set(x => x.CoverImageUrl, req.CoverImageUrl.Trim()));
        if (req.Tags != null) updates.Add(ub.Set(x => x.Tags, req.Tags));
        if (req.Folder != null) updates.Add(ub.Set(x => x.Folder, req.Folder.Trim()));
        if (req.Note != null) updates.Add(ub.Set(x => x.Note, req.Note.Trim()));
        if (req.IsFavorite.HasValue) updates.Add(ub.Set(x => x.IsFavorite, req.IsFavorite.Value));
        if (req.IsPublic.HasValue) updates.Add(ub.Set(x => x.IsPublic, req.IsPublic.Value));

        if (updates.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有需要更新的字段"));

        updates.Add(ub.Set(x => x.UpdatedAt, DateTime.UtcNow));

        var result = await _db.WebPages.UpdateOneAsync(
            x => x.Id == id && x.OwnerUserId == userId,
            ub.Combine(updates));

        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "网页不存在"));

        var updated = await _db.WebPages.Find(x => x.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除网页收藏</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        var userId = GetUserId();
        var result = await _db.WebPages.DeleteOneAsync(x => x.Id == id && x.OwnerUserId == userId);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "网页不存在"));

        // 同时清理关联的分享链接
        await _db.WebPageShareLinks.DeleteManyAsync(x => x.WebPageId == id && x.CreatedBy == userId);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>批量删除网页收藏</summary>
    [HttpPost("batch-delete")]
    public async Task<IActionResult> BatchDelete([FromBody] BatchDeleteRequest req)
    {
        if (req.Ids == null || req.Ids.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请提供要删除的 ID 列表"));

        var userId = GetUserId();
        var result = await _db.WebPages.DeleteManyAsync(
            x => req.Ids.Contains(x.Id) && x.OwnerUserId == userId);

        await _db.WebPageShareLinks.DeleteManyAsync(
            x => req.Ids.Contains(x.WebPageId!) && x.CreatedBy == userId);

        return Ok(ApiResponse<object>.Ok(new { deletedCount = result.DeletedCount }));
    }

    /// <summary>切换收藏/置顶状态</summary>
    [HttpPost("{id}/toggle-favorite")]
    public async Task<IActionResult> ToggleFavorite(string id)
    {
        var userId = GetUserId();
        var page = await _db.WebPages.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync();
        if (page == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "网页不存在"));

        await _db.WebPages.UpdateOneAsync(
            x => x.Id == id,
            Builders<WebPage>.Update
                .Set(x => x.IsFavorite, !page.IsFavorite)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { isFavorite = !page.IsFavorite }));
    }

    /// <summary>获取用户所有文件夹列表</summary>
    [HttpGet("folders")]
    public async Task<IActionResult> ListFolders()
    {
        var userId = GetUserId();
        var pages = await _db.WebPages.Find(x => x.OwnerUserId == userId && x.Folder != null)
            .Project(x => x.Folder)
            .ToListAsync();

        var folders = pages.Where(f => !string.IsNullOrWhiteSpace(f)).Distinct().OrderBy(f => f).ToList();
        return Ok(ApiResponse<object>.Ok(new { folders }));
    }

    /// <summary>获取用户所有标签列表（含计数）</summary>
    [HttpGet("tags")]
    public async Task<IActionResult> ListTags()
    {
        var userId = GetUserId();
        var pages = await _db.WebPages.Find(x => x.OwnerUserId == userId)
            .Project(x => x.Tags)
            .ToListAsync();

        var tagCounts = pages
            .SelectMany(t => t)
            .GroupBy(t => t)
            .Select(g => new { tag = g.Key, count = g.Count() })
            .OrderByDescending(x => x.count)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { tags = tagCounts }));
    }

    // ─────────────────────────────────────────────
    // 分享功能
    // ─────────────────────────────────────────────

    /// <summary>创建分享链接（单页或合集）</summary>
    [HttpPost("share")]
    public async Task<IActionResult> CreateShare([FromBody] CreateWebPageShareRequest req)
    {
        var userId = GetUserId();

        // 校验网页归属
        var pageIds = req.ShareType == "collection" ? (req.WebPageIds ?? new()) : new List<string>();
        if (req.ShareType == "single")
        {
            if (string.IsNullOrWhiteSpace(req.WebPageId))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "单页分享需提供 webPageId"));
            pageIds = new List<string> { req.WebPageId };
        }

        if (pageIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少选择一个网页"));

        var ownedCount = await _db.WebPages.CountDocumentsAsync(
            x => pageIds.Contains(x.Id) && x.OwnerUserId == userId);

        if (ownedCount != pageIds.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "包含非自己的网页"));

        var share = new WebPageShareLink
        {
            WebPageId = req.ShareType == "single" ? req.WebPageId : null,
            WebPageIds = pageIds,
            ShareType = req.ShareType ?? "single",
            Title = req.Title?.Trim(),
            Description = req.Description?.Trim(),
            AccessLevel = string.IsNullOrWhiteSpace(req.Password) ? "public" : "password",
            Password = req.Password,
            ExpiresAt = req.ExpiresInDays > 0 ? DateTime.UtcNow.AddDays(req.ExpiresInDays) : null,
            CreatedBy = userId,
        };

        await _db.WebPageShareLinks.InsertOneAsync(share);
        _logger.LogInformation("用户 {UserId} 创建网页分享 {ShareId}, type={Type}", userId, share.Id, share.ShareType);

        return Ok(ApiResponse<object>.Ok(new
        {
            share.Id,
            share.Token,
            share.ShareType,
            share.AccessLevel,
            share.ExpiresAt,
            shareUrl = $"/s/wp/{share.Token}",
        }));
    }

    /// <summary>获取当前用户的分享链接列表</summary>
    [HttpGet("shares")]
    public async Task<IActionResult> ListShares()
    {
        var userId = GetUserId();
        var shares = await _db.WebPageShareLinks.Find(x => x.CreatedBy == userId && !x.IsRevoked)
            .SortByDescending(x => x.CreatedAt)
            .Limit(100)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = shares }));
    }

    /// <summary>撤销分享链接</summary>
    [HttpDelete("shares/{shareId}")]
    public async Task<IActionResult> RevokeShare(string shareId)
    {
        var userId = GetUserId();
        var result = await _db.WebPageShareLinks.UpdateOneAsync(
            x => x.Id == shareId && x.CreatedBy == userId,
            Builders<WebPageShareLink>.Update.Set(x => x.IsRevoked, true));

        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在"));

        return Ok(ApiResponse<object>.Ok(new { revoked = true }));
    }

    /// <summary>公开访问分享链接（无需登录）</summary>
    [HttpGet("/s/wp/{token}")]
    [AllowAnonymous]
    public async Task<IActionResult> ViewShare(string token, [FromQuery] string? password)
    {
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token).FirstOrDefaultAsync();
        if (share == null || share.IsRevoked)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "分享链接不存在或已失效"));

        if (share.ExpiresAt.HasValue && share.ExpiresAt.Value < DateTime.UtcNow)
            return BadRequest(ApiResponse<object>.Fail("EXPIRED", "分享链接已过期"));

        if (share.AccessLevel == "password")
        {
            if (string.IsNullOrWhiteSpace(password) || password != share.Password)
                return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "需要提供正确的访问密码"));
        }

        // 更新浏览量
        await _db.WebPageShareLinks.UpdateOneAsync(
            x => x.Id == share.Id,
            Builders<WebPageShareLink>.Update
                .Inc(x => x.ViewCount, 1)
                .Set(x => x.LastViewedAt, DateTime.UtcNow));

        // 获取关联的网页
        var pageIds = share.WebPageIds.Count > 0 ? share.WebPageIds : new List<string>();
        if (share.WebPageId != null && !pageIds.Contains(share.WebPageId))
            pageIds.Insert(0, share.WebPageId);

        var pages = await _db.WebPages.Find(x => pageIds.Contains(x.Id))
            .Project(Builders<WebPage>.Projection.Expression(p => new
            {
                p.Id,
                p.Url,
                p.Title,
                p.Description,
                p.FaviconUrl,
                p.CoverImageUrl,
                p.Tags,
            }))
            .ToListAsync();

        // 增加源网页浏览量
        await _db.WebPages.UpdateManyAsync(
            x => pageIds.Contains(x.Id),
            Builders<WebPage>.Update.Inc(x => x.ViewCount, 1));

        return Ok(ApiResponse<object>.Ok(new
        {
            share.Title,
            share.Description,
            share.ShareType,
            share.CreatedAt,
            pages,
        }));
    }
}

// ─────────────────────────────────────────────
// Request DTOs
// ─────────────────────────────────────────────

public class CreateWebPageRequest
{
    public string Url { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string? FaviconUrl { get; set; }
    public string? CoverImageUrl { get; set; }
    public List<string>? Tags { get; set; }
    public string? Folder { get; set; }
    public string? Note { get; set; }
    public bool IsFavorite { get; set; }
    public bool IsPublic { get; set; }
}

public class UpdateWebPageRequest
{
    public string? Url { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? FaviconUrl { get; set; }
    public string? CoverImageUrl { get; set; }
    public List<string>? Tags { get; set; }
    public string? Folder { get; set; }
    public string? Note { get; set; }
    public bool? IsFavorite { get; set; }
    public bool? IsPublic { get; set; }
}

public class BatchDeleteRequest
{
    public List<string> Ids { get; set; } = new();
}

public class CreateWebPageShareRequest
{
    public string? WebPageId { get; set; }
    public List<string>? WebPageIds { get; set; }
    public string? ShareType { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Password { get; set; }
    public int ExpiresInDays { get; set; }
}
