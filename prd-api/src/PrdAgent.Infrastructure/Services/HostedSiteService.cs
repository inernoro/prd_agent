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
    private readonly ILogger<HostedSiteService> _logger;

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

    public HostedSiteService(MongoDbContext db, IAssetStorage storage, ILogger<HostedSiteService> logger)
    {
        _db = db;
        _storage = storage;
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
        CancellationToken ct)
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
        CancellationToken ct)
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

        await _db.HostedSites.UpdateOneAsync(
            x => x.Id == siteId,
            Builders<HostedSite>.Update
                .Set(x => x.EntryFile, entryFile)
                .Set(x => x.SiteUrl, siteUrl)
                .Set(x => x.Files, siteFiles)
                .Set(x => x.TotalSize, totalSize)
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
    // 分享
    // ─────────────────────────────────────────────

    public async Task<WebPageShareLink> CreateShareAsync(
        string userId, string displayName,
        string? siteId, List<string>? siteIds, string shareType,
        string? title, string? description,
        string? password, int expiresInDays,
        CancellationToken ct)
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
            Title = shareTitle,
            Description = description?.Trim(),
            AccessLevel = string.IsNullOrWhiteSpace(password) ? "public" : "password",
            Password = password?.Trim(),
            ExpiresAt = expiresInDays > 0 ? DateTime.UtcNow.AddDays(expiresInDays) : null,
            CreatedBy = userId,
        };

        await _db.WebPageShareLinks.InsertOneAsync(share, cancellationToken: ct);
        _logger.LogInformation("用户 {UserId} 创建站点分享 {ShareId}, type={Type}", userId, share.Id, share.ShareType);

        return share;
    }

    public async Task<List<WebPageShareLink>> ListSharesAsync(string userId, CancellationToken ct)
    {
        return await _db.WebPageShareLinks.Find(x => x.CreatedBy == userId && !x.IsRevoked)
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

    public async Task<ShareViewResult?> ViewShareAsync(string token, string? password, CancellationToken ct)
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

        var siteIds = share.SiteIds.Count > 0 ? share.SiteIds : new List<string>();
        if (share.SiteId != null && !siteIds.Contains(share.SiteId))
            siteIds.Insert(0, share.SiteId);

        var sites = await _db.HostedSites.Find(x => siteIds.Contains(x.Id))
            .Project(Builders<HostedSite>.Projection.Expression(s => new SharedSiteInfo
            {
                Id = s.Id,
                Title = s.Title,
                Description = s.Description,
                SiteUrl = s.SiteUrl,
                EntryFile = s.EntryFile,
                TotalSize = s.TotalSize,
                FileCount = s.Files.Count,
                CoverImageUrl = s.CoverImageUrl,
            }))
            .ToListAsync(ct);

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
            Sites = sites,
        };
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
