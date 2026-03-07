using System.IO.Compression;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 网页托管与分享 — 用户上传 HTML/ZIP 并托管运行
/// </summary>
[ApiController]
[Route("api/web-pages")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public class WebPagesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly ILogger<WebPagesController> _logger;

    private const long MaxSingleFileSize = 50 * 1024 * 1024; // 50MB
    private const long MaxExtractedSize = 200 * 1024 * 1024; // 200MB
    private const int MaxFileCount = 500;

    private static readonly HashSet<string> BlockedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".dll", ".sh", ".bat", ".cmd", ".ps1", ".msi", ".com", ".scr", ".pif",
        ".vbs", ".vbe", ".wsf", ".wsh", ".jar", ".class", ".py", ".rb", ".php",
    };

    private static readonly Dictionary<string, string> MimeMap = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html",
        [".htm"] = "text/html",
        [".css"] = "text/css",
        [".js"] = "application/javascript",
        [".mjs"] = "application/javascript",
        [".json"] = "application/json",
        [".xml"] = "application/xml",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".jpg"] = "image/png",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".ico"] = "image/x-icon",
        [".woff"] = "font/woff",
        [".woff2"] = "font/woff2",
        [".ttf"] = "font/ttf",
        [".otf"] = "font/otf",
        [".eot"] = "application/vnd.ms-fontobject",
        [".mp4"] = "video/mp4",
        [".webm"] = "video/webm",
        [".mp3"] = "audio/mpeg",
        [".wav"] = "audio/wav",
        [".pdf"] = "application/pdf",
        [".txt"] = "text/plain",
        [".md"] = "text/markdown",
        [".map"] = "application/json",
    };

    public WebPagesController(MongoDbContext db, IAssetStorage storage, ILogger<WebPagesController> logger)
    {
        _db = db;
        _storage = storage;
        _logger = logger;
    }

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private string GetDisplayName()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst("display_name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value
           ?? "用户";

    // ─────────────────────────────────────────────
    // 上传 / 创建
    // ─────────────────────────────────────────────

    /// <summary>上传 HTML 文件或 ZIP 压缩包，解压并托管</summary>
    [HttpPost("upload")]
    [RequestSizeLimit(MaxSingleFileSize)]
    public async Task<IActionResult> Upload(
        IFormFile file,
        [FromForm] string? title,
        [FromForm] string? description,
        [FromForm] string? folder,
        [FromForm] string? tags)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));

        if (file.Length > MaxSingleFileSize)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"文件大小不能超过 {MaxSingleFileSize / 1024 / 1024}MB"));

        var userId = GetUserId();
        var siteId = Guid.NewGuid().ToString("N");
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();

        List<HostedSiteFile> siteFiles;
        string entryFile;
        long totalSize;

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var fileBytes = ms.ToArray();

        if (ext == ".zip")
        {
            var result = await ExtractAndUploadZip(siteId, fileBytes);
            if (result.Error != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Error));
            siteFiles = result.Files;
            entryFile = result.EntryFile;
            totalSize = result.TotalSize;
        }
        else if (ext is ".html" or ".htm")
        {
            var cosKey = _storage.BuildSiteKey(siteId, "index.html");
            await _storage.UploadToKeyAsync(cosKey, fileBytes, "text/html", CancellationToken.None);

            siteFiles = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = fileBytes.Length, MimeType = "text/html" }
            };
            entryFile = "index.html";
            totalSize = fileBytes.Length;
        }
        else
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持 .html/.htm/.zip 文件"));
        }

        var cosPrefix = $"web-hosting/sites/{siteId}/";
        var siteUrl = _storage.BuildUrlForKey(_storage.BuildSiteKey(siteId, entryFile));

        var tagList = string.IsNullOrWhiteSpace(tags)
            ? new List<string>()
            : tags.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

        var site = new HostedSite
        {
            Id = siteId,
            Title = title?.Trim() ?? Path.GetFileNameWithoutExtension(file.FileName),
            Description = description?.Trim(),
            SourceType = "upload",
            CosPrefix = cosPrefix,
            EntryFile = entryFile,
            SiteUrl = siteUrl,
            Files = siteFiles,
            TotalSize = totalSize,
            Tags = tagList,
            Folder = folder?.Trim(),
            OwnerUserId = userId,
        };

        await _db.HostedSites.InsertOneAsync(site);
        _logger.LogInformation("用户 {UserId} 上传托管站点 {SiteId}: {Title}, {FileCount} 个文件, {TotalSize} bytes",
            userId, siteId, site.Title, siteFiles.Count, totalSize);

        return Ok(ApiResponse<object>.Ok(site));
    }

    /// <summary>从 HTML 内容直接创建站点（供工作流/API 调用）</summary>
    [HttpPost("from-content")]
    public async Task<IActionResult> CreateFromContent([FromBody] CreateFromContentRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.HtmlContent))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "htmlContent 不能为空"));

        var userId = GetUserId();
        var siteId = Guid.NewGuid().ToString("N");
        var htmlBytes = System.Text.Encoding.UTF8.GetBytes(req.HtmlContent);

        var cosKey = _storage.BuildSiteKey(siteId, "index.html");
        await _storage.UploadToKeyAsync(cosKey, htmlBytes, "text/html; charset=utf-8", CancellationToken.None);

        var siteUrl = _storage.BuildUrlForKey(cosKey);
        var cosPrefix = $"web-hosting/sites/{siteId}/";

        var site = new HostedSite
        {
            Id = siteId,
            Title = req.Title?.Trim() ?? "未命名站点",
            Description = req.Description?.Trim(),
            SourceType = req.SourceType ?? "api",
            SourceRef = req.SourceRef?.Trim(),
            CosPrefix = cosPrefix,
            EntryFile = "index.html",
            SiteUrl = siteUrl,
            Files = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = htmlBytes.Length, MimeType = "text/html" }
            },
            TotalSize = htmlBytes.Length,
            Tags = req.Tags ?? new List<string>(),
            Folder = req.Folder?.Trim(),
            OwnerUserId = userId,
        };

        await _db.HostedSites.InsertOneAsync(site);
        _logger.LogInformation("用户 {UserId} 通过 {SourceType} 创建托管站点 {SiteId}: {Title}",
            userId, site.SourceType, siteId, site.Title);

        return Ok(ApiResponse<object>.Ok(site));
    }

    // ─────────────────────────────────────────────
    // CRUD
    // ─────────────────────────────────────────────

    /// <summary>获取当前用户的站点列表</summary>
    [HttpGet]
    public async Task<IActionResult> List(
        [FromQuery] string? keyword,
        [FromQuery] string? folder,
        [FromQuery] string? tag,
        [FromQuery] string? sourceType,
        [FromQuery] string sort = "newest",
        [FromQuery] int skip = 0,
        [FromQuery] int limit = 50)
    {
        var userId = GetUserId();
        var fb = Builders<HostedSite>.Filter;
        var filter = fb.Eq(x => x.OwnerUserId, userId);

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = keyword.Trim();
            filter &= fb.Or(
                fb.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                fb.Regex(x => x.Description, new MongoDB.Bson.BsonRegularExpression(kw, "i"))
            );
        }

        if (!string.IsNullOrWhiteSpace(folder))
            filter &= fb.Eq(x => x.Folder, folder.Trim());

        if (!string.IsNullOrWhiteSpace(tag))
            filter &= fb.AnyEq(x => x.Tags, tag.Trim());

        if (!string.IsNullOrWhiteSpace(sourceType))
            filter &= fb.Eq(x => x.SourceType, sourceType.Trim());

        limit = Math.Clamp(limit, 1, 200);

        var sortDef = sort switch
        {
            "oldest" => Builders<HostedSite>.Sort.Ascending(x => x.CreatedAt),
            "title" => Builders<HostedSite>.Sort.Ascending(x => x.Title),
            "most-viewed" => Builders<HostedSite>.Sort.Descending(x => x.ViewCount),
            "largest" => Builders<HostedSite>.Sort.Descending(x => x.TotalSize),
            _ => Builders<HostedSite>.Sort.Descending(x => x.CreatedAt),
        };

        var total = await _db.HostedSites.CountDocumentsAsync(filter);
        var items = await _db.HostedSites.Find(filter)
            .Sort(sortDef)
            .Skip(skip)
            .Limit(limit)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items, total }));
    }

    /// <summary>获取站点详情</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var userId = GetUserId();
        var site = await _db.HostedSites.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync();
        if (site == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        return Ok(ApiResponse<object>.Ok(site));
    }

    /// <summary>更新站点元信息</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateHostedSiteRequest req)
    {
        var userId = GetUserId();
        var ub = Builders<HostedSite>.Update;
        var updates = new List<UpdateDefinition<HostedSite>>();

        if (req.Title != null) updates.Add(ub.Set(x => x.Title, req.Title.Trim()));
        if (req.Description != null) updates.Add(ub.Set(x => x.Description, req.Description.Trim()));
        if (req.Tags != null) updates.Add(ub.Set(x => x.Tags, req.Tags));
        if (req.Folder != null) updates.Add(ub.Set(x => x.Folder, req.Folder.Trim()));
        if (req.CoverImageUrl != null) updates.Add(ub.Set(x => x.CoverImageUrl, req.CoverImageUrl.Trim()));

        if (updates.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有需要更新的字段"));

        updates.Add(ub.Set(x => x.UpdatedAt, DateTime.UtcNow));

        var result = await _db.HostedSites.UpdateOneAsync(
            x => x.Id == id && x.OwnerUserId == userId,
            ub.Combine(updates));

        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));

        var updated = await _db.HostedSites.Find(x => x.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>重新上传站点内容（覆盖原有文件）</summary>
    [HttpPost("{id}/reupload")]
    [RequestSizeLimit(MaxSingleFileSize)]
    public async Task<IActionResult> Reupload(string id, IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传文件"));

        var userId = GetUserId();
        var site = await _db.HostedSites.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync();
        if (site == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));

        // 清理旧 COS 文件
        foreach (var f in site.Files)
        {
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "删除旧文件失败: {CosKey}", f.CosKey); }
        }

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var fileBytes = ms.ToArray();

        List<HostedSiteFile> siteFiles;
        string entryFile;
        long totalSize;

        if (ext == ".zip")
        {
            var result = await ExtractAndUploadZip(id, fileBytes);
            if (result.Error != null)
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, result.Error));
            siteFiles = result.Files;
            entryFile = result.EntryFile;
            totalSize = result.TotalSize;
        }
        else if (ext is ".html" or ".htm")
        {
            var cosKey = _storage.BuildSiteKey(id, "index.html");
            await _storage.UploadToKeyAsync(cosKey, fileBytes, "text/html", CancellationToken.None);
            siteFiles = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = fileBytes.Length, MimeType = "text/html" }
            };
            entryFile = "index.html";
            totalSize = fileBytes.Length;
        }
        else
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持 .html/.htm/.zip 文件"));
        }

        var siteUrl = _storage.BuildUrlForKey(_storage.BuildSiteKey(id, entryFile));

        await _db.HostedSites.UpdateOneAsync(
            x => x.Id == id,
            Builders<HostedSite>.Update
                .Set(x => x.EntryFile, entryFile)
                .Set(x => x.SiteUrl, siteUrl)
                .Set(x => x.Files, siteFiles)
                .Set(x => x.TotalSize, totalSize)
                .Set(x => x.UpdatedAt, DateTime.UtcNow));

        var updated = await _db.HostedSites.Find(x => x.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(updated));
    }

    /// <summary>删除站点（含 COS 文件清理）</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        var userId = GetUserId();
        var site = await _db.HostedSites.Find(x => x.Id == id && x.OwnerUserId == userId).FirstOrDefaultAsync();
        if (site == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));

        // 删除 COS 文件
        foreach (var f in site.Files)
        {
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "删除 COS 文件失败: {CosKey}", f.CosKey); }
        }

        await _db.HostedSites.DeleteOneAsync(x => x.Id == id);
        await _db.WebPageShareLinks.DeleteManyAsync(x => x.SiteId == id && x.CreatedBy == userId);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>批量删除站点</summary>
    [HttpPost("batch-delete")]
    public async Task<IActionResult> BatchDelete([FromBody] BatchDeleteRequest req)
    {
        if (req.Ids == null || req.Ids.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请提供要删除的 ID 列表"));

        var userId = GetUserId();
        var sites = await _db.HostedSites.Find(
            x => req.Ids.Contains(x.Id) && x.OwnerUserId == userId).ToListAsync();

        // 删除 COS 文件
        foreach (var site in sites)
        {
            foreach (var f in site.Files)
            {
                try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
                catch (Exception ex) { _logger.LogWarning(ex, "批量删除 COS 文件失败: {CosKey}", f.CosKey); }
            }
        }

        var result = await _db.HostedSites.DeleteManyAsync(
            x => req.Ids.Contains(x.Id) && x.OwnerUserId == userId);

        await _db.WebPageShareLinks.DeleteManyAsync(
            x => req.Ids.Contains(x.SiteId!) && x.CreatedBy == userId);

        return Ok(ApiResponse<object>.Ok(new { deletedCount = result.DeletedCount }));
    }

    /// <summary>获取用户所有文件夹列表</summary>
    [HttpGet("folders")]
    public async Task<IActionResult> ListFolders()
    {
        var userId = GetUserId();
        var sites = await _db.HostedSites.Find(x => x.OwnerUserId == userId && x.Folder != null)
            .Project(x => x.Folder)
            .ToListAsync();

        var folders = sites.Where(f => !string.IsNullOrWhiteSpace(f)).Distinct().OrderBy(f => f).ToList();
        return Ok(ApiResponse<object>.Ok(new { folders }));
    }

    /// <summary>获取用户所有标签列表（含计数）</summary>
    [HttpGet("tags")]
    public async Task<IActionResult> ListTags()
    {
        var userId = GetUserId();
        var tagLists = await _db.HostedSites.Find(x => x.OwnerUserId == userId)
            .Project(x => x.Tags)
            .ToListAsync();

        var tagCounts = tagLists
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

    /// <summary>创建分享链接</summary>
    [HttpPost("share")]
    public async Task<IActionResult> CreateShare([FromBody] CreateWebPageShareRequest req)
    {
        var userId = GetUserId();

        var siteIds = req.ShareType == "collection" ? (req.SiteIds ?? new()) : new List<string>();
        if (req.ShareType != "collection")
        {
            if (string.IsNullOrWhiteSpace(req.SiteId))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "单站点分享需提供 siteId"));
            siteIds = new List<string> { req.SiteId };
        }

        if (siteIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "至少选择一个站点"));

        var ownedCount = await _db.HostedSites.CountDocumentsAsync(
            x => siteIds.Contains(x.Id) && x.OwnerUserId == userId);

        if (ownedCount != siteIds.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "包含非自己的站点"));

        // 自动生成分享标题：{displayName} 分享给你的 {siteTitle}
        var title = req.Title?.Trim();
        if (string.IsNullOrWhiteSpace(title))
        {
            var displayName = GetDisplayName();
            var firstSite = await _db.HostedSites.Find(x => x.Id == siteIds[0])
                .Project(Builders<HostedSite>.Projection.Expression(s => s.Title))
                .FirstOrDefaultAsync();
            title = req.ShareType == "collection"
                ? $"{displayName} 分享给你的 {siteIds.Count} 个站点合集"
                : $"{displayName} 分享给你的「{firstSite ?? "站点"}」";
        }

        var share = new WebPageShareLink
        {
            SiteId = req.ShareType != "collection" ? req.SiteId : null,
            SiteIds = siteIds,
            ShareType = req.ShareType ?? "single",
            Title = title,
            Description = req.Description?.Trim(),
            AccessLevel = string.IsNullOrWhiteSpace(req.Password) ? "public" : "password",
            Password = req.Password,
            ExpiresAt = req.ExpiresInDays > 0 ? DateTime.UtcNow.AddDays(req.ExpiresInDays) : null,
            CreatedBy = userId,
        };

        await _db.WebPageShareLinks.InsertOneAsync(share);
        _logger.LogInformation("用户 {UserId} 创建站点分享 {ShareId}, type={Type}", userId, share.Id, share.ShareType);

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
    [HttpGet("shares/view/{token}")]
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

        // 获取关联的站点
        var siteIds = share.SiteIds.Count > 0 ? share.SiteIds : new List<string>();
        if (share.SiteId != null && !siteIds.Contains(share.SiteId))
            siteIds.Insert(0, share.SiteId);

        var sites = await _db.HostedSites.Find(x => siteIds.Contains(x.Id))
            .Project(Builders<HostedSite>.Projection.Expression(s => new
            {
                s.Id,
                s.Title,
                s.Description,
                s.SiteUrl,
                s.EntryFile,
                s.TotalSize,
                FileCount = s.Files.Count,
                s.CoverImageUrl,
            }))
            .ToListAsync();

        // 增加站点浏览量
        await _db.HostedSites.UpdateManyAsync(
            x => siteIds.Contains(x.Id),
            Builders<HostedSite>.Update.Inc(x => x.ViewCount, 1));

        return Ok(ApiResponse<object>.Ok(new
        {
            share.Title,
            share.Description,
            share.ShareType,
            share.CreatedAt,
            sites,
        }));
    }

    // ─────────────────────────────────────────────
    // ZIP 解压上传
    // ─────────────────────────────────────────────

    private async Task<ZipExtractResult> ExtractAndUploadZip(string siteId, byte[] zipBytes)
    {
        var files = new List<HostedSiteFile>();
        long totalSize = 0;
        string? entryFile = null;

        try
        {
            using var zipStream = new MemoryStream(zipBytes);
            using var archive = new ZipArchive(zipStream, ZipArchiveMode.Read);

            if (archive.Entries.Count > MaxFileCount)
                return new ZipExtractResult { Error = $"ZIP 包含的文件数超过限制 ({MaxFileCount})" };

            // 检测根目录前缀（有些 ZIP 整个内容在一个文件夹下）
            var rootPrefix = DetectRootPrefix(archive);

            foreach (var entry in archive.Entries)
            {
                // 跳过目录条目
                if (string.IsNullOrEmpty(entry.Name)) continue;

                var relativePath = entry.FullName;
                // 去掉根目录前缀
                if (!string.IsNullOrEmpty(rootPrefix) && relativePath.StartsWith(rootPrefix))
                    relativePath = relativePath[rootPrefix.Length..];

                // 安全检查：防止路径遍历
                if (relativePath.Contains("..") || Path.IsPathRooted(relativePath))
                    continue;

                // 跳过隐藏文件和 macOS 元数据
                if (relativePath.StartsWith('.') || relativePath.Contains("/__MACOSX/") || relativePath.StartsWith("__MACOSX/"))
                    continue;

                var fileExt = Path.GetExtension(entry.Name);
                if (BlockedExtensions.Contains(fileExt))
                    continue;

                // 大小检查
                totalSize += entry.Length;
                if (totalSize > MaxExtractedSize)
                    return new ZipExtractResult { Error = $"解压后总大小超过限制 ({MaxExtractedSize / 1024 / 1024}MB)" };

                // 读取文件内容
                using var entryStream = entry.Open();
                using var entryMs = new MemoryStream();
                await entryStream.CopyToAsync(entryMs);
                var entryBytes = entryMs.ToArray();

                var mimeType = GetMimeType(fileExt);
                var cosKey = _storage.BuildSiteKey(siteId, relativePath);

                await _storage.UploadToKeyAsync(cosKey, entryBytes, mimeType, CancellationToken.None);

                files.Add(new HostedSiteFile
                {
                    Path = relativePath,
                    CosKey = cosKey,
                    Size = entryBytes.Length,
                    MimeType = mimeType,
                });
            }
        }
        catch (InvalidDataException)
        {
            return new ZipExtractResult { Error = "无效的 ZIP 文件" };
        }

        if (files.Count == 0)
            return new ZipExtractResult { Error = "ZIP 中没有有效文件" };

        // 检测入口文件
        entryFile = files.FirstOrDefault(f => f.Path.Equals("index.html", StringComparison.OrdinalIgnoreCase))?.Path
            ?? files.FirstOrDefault(f => f.Path.Equals("index.htm", StringComparison.OrdinalIgnoreCase))?.Path
            ?? files.FirstOrDefault(f => f.MimeType == "text/html")?.Path
            ?? files[0].Path;

        return new ZipExtractResult
        {
            Files = files,
            EntryFile = entryFile,
            TotalSize = totalSize,
        };
    }

    private static string? DetectRootPrefix(ZipArchive archive)
    {
        // 如果所有文件都在同一个顶层目录下，返回该目录前缀
        string? commonPrefix = null;
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue; // 目录条目
            var slashIdx = entry.FullName.IndexOf('/');
            if (slashIdx < 0) return null; // 有文件在根目录，不需要去前缀
            var prefix = entry.FullName[..(slashIdx + 1)];
            if (commonPrefix == null) commonPrefix = prefix;
            else if (commonPrefix != prefix) return null; // 不同的顶层目录
        }
        return commonPrefix;
    }

    private static string GetMimeType(string ext)
    {
        if (string.IsNullOrEmpty(ext)) return "application/octet-stream";
        return MimeMap.TryGetValue(ext, out var mime) ? mime : "application/octet-stream";
    }

    private sealed class ZipExtractResult
    {
        public List<HostedSiteFile> Files { get; set; } = new();
        public string EntryFile { get; set; } = "index.html";
        public long TotalSize { get; set; }
        public string? Error { get; set; }
    }
}

// ─────────────────────────────────────────────
// Request DTOs
// ─────────────────────────────────────────────

public class CreateFromContentRequest
{
    public string HtmlContent { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? SourceType { get; set; }
    public string? SourceRef { get; set; }
    public List<string>? Tags { get; set; }
    public string? Folder { get; set; }
}

public class UpdateHostedSiteRequest
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public List<string>? Tags { get; set; }
    public string? Folder { get; set; }
    public string? CoverImageUrl { get; set; }
}

public class BatchDeleteRequest
{
    public List<string> Ids { get; set; } = new();
}

public class CreateWebPageShareRequest
{
    public string? SiteId { get; set; }
    public List<string>? SiteIds { get; set; }
    public string? ShareType { get; set; }
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string? Password { get; set; }
    public int ExpiresInDays { get; set; }
}
