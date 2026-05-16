using System.IO.Compression;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

public class HostedSiteService : IHostedSiteService
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly IShortLinkService _shortLinks;
    private readonly ILogger<HostedSiteService> _logger;

    // 与 WebPagesController.MaxSingleFileSize (500MB) 对齐：视频/PDF 单文件上传上限提到 500MB
    // 后，控制器会把媒体包装成 ZIP 走这条路径，解压上限若仍是 200MB 会让 200-500MB 的上传
    // "过了控制器、却被服务层拒收"。该值同时保留 zip bomb 防御（停止解压超出此总大小的归档）。
    private const long MaxExtractedSize = 500L * 1024 * 1024; // 500MB
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

    public HostedSiteService(MongoDbContext db, IAssetStorage storage, IShortLinkService shortLinks, ILogger<HostedSiteService> logger)
    {
        _db = db;
        _storage = storage;
        _shortLinks = shortLinks;
        _logger = logger;
    }

    // ─────────────────────────────────────────────
    // 创建
    // ─────────────────────────────────────────────

    public async Task<HostedSite> CreateFromHtmlAsync(
        string userId, byte[] htmlBytes, string fileName,
        string? title, string? description, string? folder, List<string>? tags,
        CancellationToken ct)
    {
        var siteId = Guid.NewGuid().ToString("N");
        var rewritten = RewriteAbsolutePathsInHtml(htmlBytes, "index.html");
        var cosKey = _storage.BuildSiteKey(siteId, "index.html");
        await _storage.UploadToKeyAsync(cosKey, rewritten, "text/html; charset=utf-8", CancellationToken.None);

        var site = new HostedSite
        {
            Id = siteId,
            Title = title?.Trim() ?? Path.GetFileNameWithoutExtension(fileName),
            Description = description?.Trim(),
            SourceType = "upload",
            CosPrefix = $"web-hosting/sites/{siteId}/",
            EntryFile = "index.html",
            SiteUrl = _storage.BuildUrlForKey(cosKey),
            Files = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = rewritten.Length, MimeType = "text/html" }
            },
            TotalSize = rewritten.Length,
            Tags = tags ?? new(),
            Folder = folder?.Trim(),
            OwnerUserId = userId,
        };

        await _db.HostedSites.InsertOneAsync(site, cancellationToken: ct);
        _logger.LogInformation("用户 {UserId} 上传托管站点 {SiteId}: {Title}, 1 个文件, {TotalSize} bytes",
            userId, siteId, site.Title, site.TotalSize);

        return site;
    }

    public async Task<HostedSite> CreateFromZipAsync(
        string userId, byte[] zipBytes,
        string? title, string? description, string? folder, List<string>? tags,
        string? wrappedAssetType = null,
        CancellationToken ct = default)
    {
        var siteId = Guid.NewGuid().ToString("N");
        var result = await ExtractAndUploadZip(siteId, zipBytes);
        if (result.Error != null)
            throw new InvalidOperationException(result.Error);

        var cosPrefix = $"web-hosting/sites/{siteId}/";
        var siteUrl = _storage.BuildUrlForKey(_storage.BuildSiteKey(siteId, result.EntryFile));

        var site = new HostedSite
        {
            Id = siteId,
            Title = title?.Trim() ?? "未命名站点",
            Description = description?.Trim(),
            SourceType = "upload",
            CosPrefix = cosPrefix,
            EntryFile = result.EntryFile,
            SiteUrl = siteUrl,
            Files = result.Files,
            TotalSize = result.TotalSize,
            Tags = tags ?? new(),
            Folder = folder?.Trim(),
            OwnerUserId = userId,
            WrappedAssetType = string.IsNullOrWhiteSpace(wrappedAssetType) ? null : wrappedAssetType.Trim().ToLowerInvariant(),
        };

        await _db.HostedSites.InsertOneAsync(site, cancellationToken: ct);
        _logger.LogInformation("用户 {UserId} 上传托管站点 {SiteId}: {Title}, {FileCount} 个文件, {TotalSize} bytes",
            userId, siteId, site.Title, result.Files.Count, result.TotalSize);

        return site;
    }

    public async Task<HostedSite> CreateFromContentAsync(
        string userId, string htmlContent,
        string? title, string? description,
        string sourceType, string? sourceRef,
        List<string>? tags, string? folder,
        CancellationToken ct)
    {
        var siteId = Guid.NewGuid().ToString("N");
        var htmlBytes = RewriteAbsolutePathsInHtml(
            System.Text.Encoding.UTF8.GetBytes(htmlContent), "index.html");

        var cosKey = _storage.BuildSiteKey(siteId, "index.html");
        await _storage.UploadToKeyAsync(cosKey, htmlBytes, "text/html; charset=utf-8", CancellationToken.None);

        var site = new HostedSite
        {
            Id = siteId,
            Title = title?.Trim() ?? "未命名站点",
            Description = description?.Trim(),
            SourceType = sourceType ?? "api",
            SourceRef = sourceRef?.Trim(),
            CosPrefix = $"web-hosting/sites/{siteId}/",
            EntryFile = "index.html",
            SiteUrl = _storage.BuildUrlForKey(cosKey),
            Files = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = htmlBytes.Length, MimeType = "text/html" }
            },
            TotalSize = htmlBytes.Length,
            Tags = tags ?? new(),
            Folder = folder?.Trim(),
            OwnerUserId = userId,
        };

        await _db.HostedSites.InsertOneAsync(site, cancellationToken: ct);
        _logger.LogInformation("用户 {UserId} 通过 {SourceType} 创建托管站点 {SiteId}: {Title}",
            userId, site.SourceType, siteId, site.Title);

        return site;
    }

    // ─────────────────────────────────────────────
    // 重新上传
    // ─────────────────────────────────────────────

    public async Task<HostedSite> ReuploadAsync(
        string siteId, string userId,
        byte[] fileBytes, string fileName,
        string? wrappedAssetType = null,
        CancellationToken ct = default)
    {
        var site = await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (site == null)
            throw new KeyNotFoundException("站点不存在");

        // 清理旧 COS 文件
        foreach (var f in site.Files)
        {
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "删除旧文件失败: {CosKey}", f.CosKey); }
        }

        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        List<HostedSiteFile> siteFiles;
        string entryFile;
        long totalSize;

        if (ext == ".zip")
        {
            var result = await ExtractAndUploadZip(siteId, fileBytes);
            if (result.Error != null)
                throw new InvalidOperationException(result.Error);
            siteFiles = result.Files;
            entryFile = result.EntryFile;
            totalSize = result.TotalSize;
        }
        else if (ext is ".html" or ".htm")
        {
            var rewritten = RewriteAbsolutePathsInHtml(fileBytes, "index.html");
            var cosKey = _storage.BuildSiteKey(siteId, "index.html");
            await _storage.UploadToKeyAsync(cosKey, rewritten, "text/html; charset=utf-8", CancellationToken.None);
            siteFiles = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = rewritten.Length, MimeType = "text/html" }
            };
            entryFile = "index.html";
            totalSize = rewritten.Length;
        }
        else
        {
            throw new InvalidOperationException("仅支持 .html/.htm/.zip 文件");
        }

        var siteUrl = _storage.BuildUrlForKey(_storage.BuildSiteKey(siteId, entryFile));

        // wrappedAssetType 必须显式覆盖（包括清空）：
        // - 用户把 PDF 重传到原 HTML 站，应写入 "pdf" 让分享/缩略走 PDF 路径
        // - 用户把 HTML 重传覆盖原 PDF 包装站，应清空 marker，避免前端继续渲染 PDF 占位
        var normalizedType = string.IsNullOrWhiteSpace(wrappedAssetType)
            ? null : wrappedAssetType.Trim().ToLowerInvariant();

        await _db.HostedSites.UpdateOneAsync(
            x => x.Id == siteId,
            Builders<HostedSite>.Update
                .Set(x => x.EntryFile, entryFile)
                .Set(x => x.SiteUrl, siteUrl)
                .Set(x => x.Files, siteFiles)
                .Set(x => x.TotalSize, totalSize)
                .Set(x => x.WrappedAssetType, normalizedType)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        return (await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct))!;
    }

    // ─────────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────────

    public async Task<HostedSite?> GetByIdAsync(string siteId, string userId, CancellationToken ct)
    {
        return await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
    }

    public async Task<(List<HostedSite> Items, long Total)> ListAsync(
        string userId, string? keyword, string? folder,
        string? tag, string? sourceType, string sort,
        int skip, int limit, CancellationToken ct)
    {
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

        var total = await _db.HostedSites.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.HostedSites.Find(filter)
            .Sort(sortDef).Skip(skip).Limit(limit)
            .ToListAsync(ct);

        return (items, total);
    }

    public async Task<List<string>> ListFoldersAsync(string userId, CancellationToken ct)
    {
        var sites = await _db.HostedSites.Find(x => x.OwnerUserId == userId && x.Folder != null)
            .Project(x => x.Folder)
            .ToListAsync(ct);

        return sites.Where(f => !string.IsNullOrWhiteSpace(f)).Distinct().OrderBy(f => f).ToList()!;
    }

    public async Task<List<TagCountResult>> ListTagsAsync(string userId, CancellationToken ct)
    {
        var tagLists = await _db.HostedSites.Find(x => x.OwnerUserId == userId)
            .Project(x => x.Tags)
            .ToListAsync(ct);

        return tagLists
            .SelectMany(t => t)
            .GroupBy(t => t)
            .Select(g => new TagCountResult { Tag = g.Key, Count = g.Count() })
            .OrderByDescending(x => x.Count)
            .ToList();
    }

    // ─────────────────────────────────────────────
    // 更新 / 删除
    // ─────────────────────────────────────────────

    public async Task<HostedSite?> UpdateAsync(
        string siteId, string userId,
        string? title, string? description,
        List<string>? tags, string? folder, string? coverImageUrl,
        CancellationToken ct)
    {
        var ub = Builders<HostedSite>.Update;
        var updates = new List<UpdateDefinition<HostedSite>>();

        if (title != null) updates.Add(ub.Set(x => x.Title, title.Trim()));
        if (description != null) updates.Add(ub.Set(x => x.Description, description.Trim()));
        if (tags != null) updates.Add(ub.Set(x => x.Tags, tags));
        if (folder != null) updates.Add(ub.Set(x => x.Folder, folder.Trim()));
        if (coverImageUrl != null) updates.Add(ub.Set(x => x.CoverImageUrl, coverImageUrl.Trim()));

        if (updates.Count == 0) return null;

        updates.Add(ub.Set(x => x.UpdatedAt, DateTime.UtcNow));

        var result = await _db.HostedSites.UpdateOneAsync(
            x => x.Id == siteId && x.OwnerUserId == userId,
            ub.Combine(updates), cancellationToken: ct);

        if (result.MatchedCount == 0) return null;

        return await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct);
    }

    public async Task<bool> DeleteAsync(string siteId, string userId, CancellationToken ct)
    {
        var site = await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (site == null) return false;

        foreach (var f in site.Files)
        {
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "删除 COS 文件失败: {CosKey}", f.CosKey); }
        }

        await _db.HostedSites.DeleteOneAsync(x => x.Id == siteId, ct);
        await _db.WebPageShareLinks.DeleteManyAsync(x => x.SiteId == siteId && x.CreatedBy == userId, ct);

        return true;
    }

    public async Task<long> BatchDeleteAsync(List<string> siteIds, string userId, CancellationToken ct)
    {
        var sites = await _db.HostedSites.Find(
            x => siteIds.Contains(x.Id) && x.OwnerUserId == userId).ToListAsync(ct);

        foreach (var site in sites)
        foreach (var f in site.Files)
        {
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "批量删除 COS 文件失败: {CosKey}", f.CosKey); }
        }

        var result = await _db.HostedSites.DeleteManyAsync(
            x => siteIds.Contains(x.Id) && x.OwnerUserId == userId, ct);
        await _db.WebPageShareLinks.DeleteManyAsync(
            x => siteIds.Contains(x.SiteId!) && x.CreatedBy == userId, ct);

        return result.DeletedCount;
    }

    // ─────────────────────────────────────────────
    // 可见性
    // ─────────────────────────────────────────────

    public async Task<HostedSite?> SetVisibilityAsync(string siteId, string userId, string visibility, CancellationToken ct)
    {
        var normalized = visibility?.Trim().ToLowerInvariant();
        if (normalized != "public" && normalized != "private")
            throw new ArgumentException("visibility 必须是 public 或 private");

        var site = await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (site == null) return null;

        var now = DateTime.UtcNow;
        var update = Builders<HostedSite>.Update
            .Set(x => x.Visibility, normalized)
            .Set(x => x.UpdatedAt, now);

        if (normalized == "public" && site.PublishedAt == null)
            update = update.Set(x => x.PublishedAt, now);

        await _db.HostedSites.UpdateOneAsync(x => x.Id == siteId, update, cancellationToken: ct);
        return await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct);
    }

    public async Task<List<HostedSite>> ListPublicByUserIdAsync(string ownerUserId, int limit, CancellationToken ct)
    {
        if (limit <= 0 || limit > 200) limit = 60;
        return await _db.HostedSites
            .Find(x => x.OwnerUserId == ownerUserId && x.Visibility == "public")
            .Sort(Builders<HostedSite>.Sort.Descending(x => x.PublishedAt).Descending(x => x.UpdatedAt))
            .Limit(limit)
            .ToListAsync(ct);
    }

    // ─────────────────────────────────────────────
    // 分享
    // ─────────────────────────────────────────────

    public async Task<WebPageShareLink> CreateShareAsync(
        string userId, string displayName,
        string? siteId, List<string>? siteIds, string shareType,
        string? title, string? description,
        string? password, int expiresInDays,
        string purpose = "share",
        CancellationToken ct = default)
    {
        var allIds = shareType == "collection" ? (siteIds ?? new()) : new List<string>();
        if (shareType != "collection")
        {
            if (string.IsNullOrWhiteSpace(siteId))
                throw new ArgumentException("单站点分享需提供 siteId");
            allIds = new List<string> { siteId };
        }

        if (allIds.Count == 0)
            throw new ArgumentException("至少选择一个站点");

        var ownedCount = await _db.HostedSites.CountDocumentsAsync(
            x => allIds.Contains(x.Id) && x.OwnerUserId == userId, cancellationToken: ct);
        if (ownedCount != allIds.Count)
            throw new UnauthorizedAccessException("包含非自己的站点");

        // 复用优先（服务端唯一判定，不依赖前端列表/分页，杜绝"链接数 > 分页上限后去重失效"）：
        // 同用户 + 同站点/合集 + 同访问级别 + 未吊销的链接直接复用，避免无限创建；
        // 复用时把有效期刷新为本次所选窗口，保证返回链接的寿命恰好等于用户本次所选
        // （既不会因旧链接即将过期而"开盖即废"，也不会超出所选窗口而绕过有效期管控）。
        // Purpose 隔离：visit（站点访问便捷链）与 share（用户分享）是两个独立池，
        // 复用判定按 Purpose 严格分流——访问流程绝不会匹配/篡改用户主动创建的限期分享。
        // 旧记录无 Purpose 字段（Mongo 中缺字段），按 share 对待：Ne("visit") 能命中缺字段文档。
        var effShareType = shareType ?? "single";
        var effPurpose = string.IsNullOrWhiteSpace(purpose) ? "share" : purpose;
        var wantAccess = string.IsNullOrWhiteSpace(password) ? "public" : "password";
        var nowUtc = DateTime.UtcNow;
        var newExpiresAt = expiresInDays > 0 ? nowUtc.AddDays(expiresInDays) : (DateTime?)null;

        var fb = Builders<WebPageShareLink>.Filter;
        var reuseFilter = fb.Eq(x => x.CreatedBy, userId)
            & fb.Eq(x => x.IsRevoked, false)
            & fb.Eq(x => x.AccessLevel, wantAccess)
            // 已过期的链接不得复用，否则覆盖 ExpiresAt 会"复活"旧 token，
            // 持有过期 URL 的人凭旧链接重新获得访问权——必须新建（换新 token）。
            & (fb.Eq(x => x.ExpiresAt, (DateTime?)null) | fb.Gt(x => x.ExpiresAt, nowUtc))
            & (effShareType == "collection"
                ? fb.Eq(x => x.ShareType, "collection")
                : fb.Eq(x => x.ShareType, effShareType) & fb.Eq(x => x.SiteId, siteId))
            & (effPurpose == "visit"
                ? fb.Eq(x => x.Purpose, "visit")
                : fb.Ne(x => x.Purpose, "visit"));

        var reuseCandidates = await _db.WebPageShareLinks.Find(reuseFilter)
            .SortByDescending(x => x.CreatedAt).ToListAsync(ct);

        WebPageShareLink? reusable;
        if (effShareType == "collection")
        {
            var want = allIds.OrderBy(s => s).ToList();
            reusable = reuseCandidates.FirstOrDefault(s =>
            {
                var have = (s.SiteIds ?? new List<string>()).OrderBy(v => v).ToList();
                return have.Count == want.Count && have.SequenceEqual(want);
            });
        }
        else
        {
            reusable = reuseCandidates.FirstOrDefault();
        }

        if (reusable is { } reuse)
        {
            if (reuse.ExpiresAt != newExpiresAt)
            {
                await _db.WebPageShareLinks.UpdateOneAsync(
                    x => x.Id == reuse.Id,
                    Builders<WebPageShareLink>.Update.Set(x => x.ExpiresAt, newExpiresAt),
                    cancellationToken: ct);
                reuse.ExpiresAt = newExpiresAt;
            }
            _logger.LogInformation("用户 {UserId} 复用站点分享 {ShareId}, type={Type}",
                userId, reuse.Id, reuse.ShareType);
            return reuse;
        }

        // 自动生成分享标题
        var shareTitle = title?.Trim();
        if (string.IsNullOrWhiteSpace(shareTitle))
        {
            var firstSite = await _db.HostedSites.Find(x => x.Id == allIds[0])
                .Project(Builders<HostedSite>.Projection.Expression(s => s.Title))
                .FirstOrDefaultAsync(ct);
            shareTitle = shareType == "collection"
                ? $"{displayName} 分享给你的 {allIds.Count} 个站点合集"
                : $"{displayName} 分享给你的「{firstSite ?? "站点"}」";
        }

        var share = new WebPageShareLink
        {
            SiteId = shareType != "collection" ? siteId : null,
            SiteIds = allIds,
            ShareType = shareType ?? "single",
            Purpose = effPurpose,
            Title = shareTitle,
            Description = description?.Trim(),
            AccessLevel = string.IsNullOrWhiteSpace(password) ? "public" : "password",
            Password = password?.Trim(),
            ExpiresAt = expiresInDays > 0 ? DateTime.UtcNow.AddDays(expiresInDays) : null,
            CreatedBy = userId,
            CreatedByName = displayName,
        };

        await _db.WebPageShareLinks.InsertOneAsync(share, cancellationToken: ct);

        // 分配统一短链 Seq（/s/{seq}）；失败不影响主流程（用户仍可用 /s/wp/{token}）
        try
        {
            var seq = await _shortLinks.AllocateAsync(ShortLinkTargetTypes.WebPage, share.Token, ct);
            await _db.WebPageShareLinks.UpdateOneAsync(
                x => x.Id == share.Id,
                Builders<WebPageShareLink>.Update.Set(x => x.ShortSeq, seq),
                cancellationToken: ct);
            share.ShortSeq = seq;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "为分享 {ShareId} 分配短链失败，将仅提供旧链接", share.Id);
        }

        _logger.LogInformation("用户 {UserId} 创建站点分享 {ShareId}, type={Type}, shortSeq={Seq}",
            userId, share.Id, share.ShareType, share.ShortSeq);

        return share;
    }

    public async Task<List<WebPageShareLink>> ListSharesAsync(string userId, CancellationToken ct)
    {
        // 排除 visit 便捷链（自动创建，非用户主动分享，不应污染分享管理列表）；
        // Ne("visit") 能命中无 Purpose 字段的旧记录，旧分享照常列出。
        return await _db.WebPageShareLinks
            .Find(x => x.CreatedBy == userId && !x.IsRevoked && x.Purpose != "visit")
            .SortByDescending(x => x.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);
    }

    public async Task<bool> RevokeShareAsync(string shareId, string userId, CancellationToken ct)
    {
        var result = await _db.WebPageShareLinks.UpdateOneAsync(
            x => x.Id == shareId && x.CreatedBy == userId,
            Builders<WebPageShareLink>.Update.Set(x => x.IsRevoked, true),
            cancellationToken: ct);
        return result.MatchedCount > 0;
    }

    public async Task<ShareViewResult?> ViewShareAsync(string token, string? password,
        string? viewerUserId = null, string? viewerName = null,
        string? ipAddress = null, string? userAgent = null,
        CancellationToken ct = default)
    {
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token).FirstOrDefaultAsync(ct);
        if (share == null || share.IsRevoked)
            return new ShareViewResult { Error = "分享链接不存在或已失效", HttpStatus = 404 };

        if (share.ExpiresAt.HasValue && share.ExpiresAt.Value < DateTime.UtcNow)
            return new ShareViewResult { Error = "分享链接已过期", HttpStatus = 400 };

        if (share.AccessLevel == "password" && (string.IsNullOrWhiteSpace(password) || password.Trim() != share.Password))
            return new ShareViewResult { Error = "需要提供正确的访问密码", HttpStatus = 401 };

        // 更新浏览量
        await _db.WebPageShareLinks.UpdateOneAsync(
            x => x.Id == share.Id,
            Builders<WebPageShareLink>.Update
                .Inc(x => x.ViewCount, 1)
                .Set(x => x.LastViewedAt, DateTime.UtcNow),
            cancellationToken: ct);

        // 记录观看日志
        try
        {
            await _db.ShareViewLogs.InsertOneAsync(new ShareViewLog
            {
                ShareToken = token,
                ShareId = share.Id,
                ViewerUserId = viewerUserId,
                ViewerName = viewerName,
                ShareOwnerUserId = share.CreatedBy,
                IpAddress = ipAddress,
                UserAgent = userAgent,
            }, cancellationToken: ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "记录分享观看日志失败: {ShareId}", share.Id);
        }

        var siteIds = share.SiteIds.Count > 0 ? share.SiteIds : new List<string>();
        if (share.SiteId != null && !siteIds.Contains(share.SiteId))
            siteIds.Insert(0, share.SiteId);

        var rawSites = await _db.HostedSites.Find(x => siteIds.Contains(x.Id)).ToListAsync(ct);
        var sites = rawSites.Select(s => new SharedSiteInfo
        {
            Id = s.Id,
            Title = s.Title,
            Description = s.Description,
            SiteUrl = s.SiteUrl,
            EntryFile = s.EntryFile,
            TotalSize = s.TotalSize,
            FileCount = s.Files.Count,
            CoverImageUrl = s.CoverImageUrl,
            PdfAssetUrl = TryBuildPdfAssetUrl(s),
        }).ToList();

        await _db.HostedSites.UpdateManyAsync(
            x => siteIds.Contains(x.Id),
            Builders<HostedSite>.Update.Inc(x => x.ViewCount, 1),
            cancellationToken: ct);

        return new ShareViewResult
        {
            Title = share.Title,
            Description = share.Description,
            ShareType = share.ShareType,
            CreatedAt = share.CreatedAt,
            CreatedBy = share.CreatedBy,
            CreatedByName = share.CreatedByName ?? await LookupDisplayNameAsync(share.CreatedBy, ct),
            Sites = sites,
        };
    }

    // PDF 包装站识别：上传 .pdf 时控制器会把它打包成「index.html 壳子 + 原 PDF」
    // 的 ZIP，并在 site.WrappedAssetType 写入 "pdf" marker（见 WebPagesController.Upload）。
    // 壳子里的 `<iframe src="xxx.pdf">` 在被 ShareViewPage 的 sandbox iframe 二次嵌套时，
    // Chrome PDF Viewer 会被屏蔽（"此页面已被 Chrome 屏蔽"）。这里把真实 PDF 文件
    // 的 URL 暴露给前端，前端检测到后绕过壳子直接 iframe，让浏览器原生 PDF Viewer 接管。
    //
    // 只看 marker，不依赖 ZIP 文件形状——避免把"用户上传的 custom landing.html + report.pdf"
    // 这种 2 文件普通 ZIP 误判为包装站（Codex P2 反复抓到，PR #612）。
    private string? TryBuildPdfAssetUrl(HostedSite site)
        => IsPdfWrapperSite(site, out var pdf) ? _storage.BuildUrlForKey(pdf!.CosKey) : null;

    public static bool IsPdfWrapperSite(HostedSite site, out HostedSiteFile? pdf)
    {
        pdf = null;
        if (!string.Equals(site.WrappedAssetType, "pdf", StringComparison.OrdinalIgnoreCase)) return false;
        if (site.Files == null) return false;

        var candidate = site.Files.FirstOrDefault(f =>
            !string.IsNullOrEmpty(f.Path) &&
            !f.Path.Contains('/') &&
            f.Path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase));
        if (candidate == null || string.IsNullOrEmpty(candidate.CosKey)) return false;

        pdf = candidate;
        return true;
    }

    // 老数据回填：本 PR 引入 WrappedAssetType marker 之前，所有 PDF 包装站
    // marker 都是 null。这里扫描"形状疑似 PDF 包装站"的存量数据：
    //   - WrappedAssetType is null
    //   - EntryFile == "index.html"
    //   - 恰好 2 个文件，一个 index.html、一个根目录 .pdf
    // 然后下载 index.html，匹配 BuildPdfWrapper 模板独有的特征字符串，命中
    // 才回填 marker。特征字符串选了"浏览器不支持内嵌 PDF"——只有该模板会有，
    // 用户自己写的 landing.html 几乎不会撞。返回成功回填的站点数。
    private const string PdfWrapperSignature = "浏览器不支持内嵌 PDF";

    public async Task<int> BackfillPdfWrapperMarkersAsync(CancellationToken ct = default)
    {
        var fb = Builders<HostedSite>.Filter;
        // Mongo 的 {field: null} 同时匹配 null 与字段缺失，覆盖未升级的存量数据
        var filter = fb.And(
            fb.Eq(x => x.WrappedAssetType, (string?)null),
            fb.Eq(x => x.EntryFile, "index.html"),
            fb.Size(x => x.Files, 2));

        var candidates = await _db.HostedSites.Find(filter).ToListAsync(ct);
        var backfilled = 0;

        foreach (var site in candidates)
        {
            if (ct.IsCancellationRequested) break;

            var pdf = site.Files.FirstOrDefault(f =>
                !string.IsNullOrEmpty(f.Path) &&
                !f.Path.Contains('/') &&
                f.Path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase));
            var index = site.Files.FirstOrDefault(f =>
                string.Equals(f.Path, "index.html", StringComparison.OrdinalIgnoreCase));
            if (pdf == null || index == null || string.IsNullOrEmpty(index.CosKey)) continue;

            try
            {
                var bytes = await _storage.TryDownloadBytesAsync(index.CosKey, ct);
                if (bytes == null || bytes.Length == 0) continue;
                var html = System.Text.Encoding.UTF8.GetString(bytes);
                if (!html.Contains(PdfWrapperSignature, StringComparison.Ordinal)) continue;

                await _db.HostedSites.UpdateOneAsync(
                    x => x.Id == site.Id,
                    Builders<HostedSite>.Update
                        .Set(x => x.WrappedAssetType, "pdf"),
                    cancellationToken: ct);
                backfilled++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "PDF wrapper marker 回填失败: site={SiteId}", site.Id);
            }
        }

        if (backfilled > 0 || candidates.Count > 0)
        {
            _logger.LogInformation("PDF wrapper marker 回填完成: candidates={Candidates} backfilled={Backfilled}",
                candidates.Count, backfilled);
        }
        return backfilled;
    }

    // ─────────────────────────────────────────────
    // 观看记录
    // ─────────────────────────────────────────────

    public async Task<List<ShareViewLog>> ListShareViewLogsAsync(
        string userId, string? shareToken, int limit = 100, CancellationToken ct = default)
    {
        var fb = Builders<ShareViewLog>.Filter;
        var filter = fb.Eq(x => x.ShareOwnerUserId, userId);
        if (!string.IsNullOrWhiteSpace(shareToken))
            filter &= fb.Eq(x => x.ShareToken, shareToken);

        return await _db.ShareViewLogs.Find(filter)
            .SortByDescending(x => x.ViewedAt)
            .Limit(Math.Clamp(limit, 1, 500))
            .ToListAsync(ct);
    }

    // ─────────────────────────────────────────────
    // 用户名查找（兼容旧分享没有 CreatedByName 的情况）
    // ─────────────────────────────────────────────

    private async Task<string?> LookupDisplayNameAsync(string userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(userId)) return null;
        var user = await _db.Users.Find(x => x.UserId == userId)
            .Project(Builders<User>.Projection.Expression(u => u.DisplayName))
            .FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(user) ? null : user;
    }

    // ─────────────────────────────────────────────
    // 保存分享站点
    // ─────────────────────────────────────────────

    public async Task<SaveSharedSiteResult> SaveSharedSiteAsync(
        string token, string? password, string userId, CancellationToken ct)
    {
        // 1. 验证分享链接
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token).FirstOrDefaultAsync(ct);
        if (share == null || share.IsRevoked)
            return new SaveSharedSiteResult { Error = "分享链接不存在或已失效", HttpStatus = 404 };

        if (share.ExpiresAt.HasValue && share.ExpiresAt.Value < DateTime.UtcNow)
            return new SaveSharedSiteResult { Error = "分享链接已过期", HttpStatus = 400 };

        if (share.AccessLevel == "password" && (string.IsNullOrWhiteSpace(password) || password.Trim() != share.Password))
            return new SaveSharedSiteResult { Error = "需要提供正确的访问密码", HttpStatus = 401 };

        // 2. 禁止保存自己的分享
        if (share.CreatedBy == userId)
            return new SaveSharedSiteResult { Error = "不能保存自己创建的分享", HttpStatus = 400 };

        // 3. 去重：检查是否已经保存过此分享
        var alreadyExists = await _db.HostedSites.CountDocumentsAsync(
            x => x.OwnerUserId == userId && x.SourceType == "saved-share" && x.SourceRef == token,
            cancellationToken: ct);

        if (alreadyExists > 0)
            return new SaveSharedSiteResult { AlreadySaved = true };

        // 3. 获取原始站点
        var siteIds = share.SiteIds.Count > 0 ? share.SiteIds : new List<string>();
        if (share.SiteId != null && !siteIds.Contains(share.SiteId))
            siteIds.Insert(0, share.SiteId);

        var originalSites = await _db.HostedSites.Find(x => siteIds.Contains(x.Id)).ToListAsync(ct);
        if (originalSites.Count == 0)
            return new SaveSharedSiteResult { Error = "分享的站点已被删除", HttpStatus = 404 };

        // 4. 为用户创建引用副本（复用 COS 文件，不重复上传）
        var savedSites = new List<HostedSite>();
        foreach (var original in originalSites)
        {
            var saved = new HostedSite
            {
                Title = original.Title,
                Description = original.Description,
                SourceType = "saved-share",
                SourceRef = token,
                CosPrefix = original.CosPrefix,
                EntryFile = original.EntryFile,
                SiteUrl = original.SiteUrl,
                Files = original.Files.Select(f => new HostedSiteFile
                {
                    Path = f.Path,
                    CosKey = f.CosKey,
                    Size = f.Size,
                    MimeType = f.MimeType,
                }).ToList(),
                TotalSize = original.TotalSize,
                Tags = original.Tags.ToList(),
                Folder = original.Folder,
                CoverImageUrl = original.CoverImageUrl,
                WrappedAssetType = original.WrappedAssetType,
                OwnerUserId = userId,
            };
            savedSites.Add(saved);
        }

        await _db.HostedSites.InsertManyAsync(savedSites, cancellationToken: ct);
        _logger.LogInformation("用户 {UserId} 保存了分享 {Token} 的 {Count} 个站点",
            userId, token, savedSites.Count);

        return new SaveSharedSiteResult { Saved = true, Sites = savedSites };
    }

    // ─────────────────────────────────────────────
    // 内部工具方法
    // ─────────────────────────────────────────────

    private async Task<ZipExtractResult> ExtractAndUploadZip(string siteId, byte[] zipBytes)
    {
        var files = new List<HostedSiteFile>();
        long totalSize = 0;

        try
        {
            using var zipStream = new MemoryStream(zipBytes);
            using var archive = new ZipArchive(zipStream, ZipArchiveMode.Read);

            if (archive.Entries.Count > MaxFileCount)
                return new ZipExtractResult { Error = $"ZIP 包含的文件数超过限制 ({MaxFileCount})" };

            var rootPrefix = DetectRootPrefix(archive);

            foreach (var entry in archive.Entries)
            {
                if (string.IsNullOrEmpty(entry.Name)) continue;

                var relativePath = entry.FullName;
                if (!string.IsNullOrEmpty(rootPrefix) && relativePath.StartsWith(rootPrefix))
                    relativePath = relativePath[rootPrefix.Length..];

                if (relativePath.Contains("..") || Path.IsPathRooted(relativePath))
                    continue;
                if (relativePath.StartsWith('.') || relativePath.Contains("/__MACOSX/") || relativePath.StartsWith("__MACOSX/"))
                    continue;

                var fileExt = Path.GetExtension(entry.Name);
                if (BlockedExtensions.Contains(fileExt))
                    continue;

                totalSize += entry.Length;
                if (totalSize > MaxExtractedSize)
                    return new ZipExtractResult { Error = $"解压后总大小超过限制 ({MaxExtractedSize / 1024 / 1024}MB)" };

                if (entry.Length == 0)
                    continue;

                using var entryStream = entry.Open();
                using var entryMs = new MemoryStream();
                await entryStream.CopyToAsync(entryMs);
                var entryBytes = entryMs.ToArray();

                var mimeType = GetMimeType(fileExt);
                if (mimeType == "text/html")
                    entryBytes = RewriteAbsolutePathsInHtml(entryBytes, relativePath);

                var cosKey = _storage.BuildSiteKey(siteId, relativePath);
                await _storage.UploadToKeyAsync(cosKey, entryBytes,
                    mimeType == "text/html" ? "text/html; charset=utf-8" : mimeType, CancellationToken.None);

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

        var entryFile = files.FirstOrDefault(f => f.Path.Equals("index.html", StringComparison.OrdinalIgnoreCase))?.Path
            ?? files.FirstOrDefault(f => f.Path.Equals("index.htm", StringComparison.OrdinalIgnoreCase))?.Path
            ?? files.FirstOrDefault(f => f.MimeType == "text/html")?.Path
            ?? files[0].Path;

        return new ZipExtractResult { Files = files, EntryFile = entryFile, TotalSize = totalSize };
    }

    private static string? DetectRootPrefix(ZipArchive archive)
    {
        string? commonPrefix = null;
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue;
            var slashIdx = entry.FullName.IndexOf('/');
            if (slashIdx < 0) return null;
            var prefix = entry.FullName[..(slashIdx + 1)];
            if (commonPrefix == null) commonPrefix = prefix;
            else if (commonPrefix != prefix) return null;
        }
        return commonPrefix;
    }

    private static string GetMimeType(string ext)
    {
        if (string.IsNullOrEmpty(ext)) return "application/octet-stream";
        return MimeMap.TryGetValue(ext, out var mime) ? mime : "application/octet-stream";
    }

    private static byte[] RewriteAbsolutePathsInHtml(byte[] htmlBytes, string entryFile)
    {
        var html = System.Text.Encoding.UTF8.GetString(htmlBytes);
        var depth = entryFile.Count(c => c == '/');
        var prefix = depth > 0 ? string.Concat(Enumerable.Repeat("../", depth)) : "./";
        html = Regex.Replace(html, """(?<attr>(?:src|href|action)\s*=\s*["'])\/(?!\/)""",
            m => m.Groups["attr"].Value + prefix,
            RegexOptions.IgnoreCase);
        return System.Text.Encoding.UTF8.GetBytes(html);
    }

    private sealed class ZipExtractResult
    {
        public List<HostedSiteFile> Files { get; set; } = new();
        public string EntryFile { get; set; } = "index.html";
        public long TotalSize { get; set; }
        public string? Error { get; set; }
    }
}
