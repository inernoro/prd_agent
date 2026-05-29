using System.IO.Compression;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

public class HostedSiteService : IHostedSiteService
{
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly IShortLinkService _shortLinks;
    private readonly ISharePasswordService _sharePwd;
    private readonly ITeamService _teams;
    private readonly ITeamActivityService _teamActivity;
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

    public HostedSiteService(
        MongoDbContext db,
        IAssetStorage storage,
        IShortLinkService shortLinks,
        ISharePasswordService sharePwd,
        ITeamService teams,
        ITeamActivityService teamActivity,
        ILogger<HostedSiteService> logger)
    {
        _db = db;
        _storage = storage;
        _shortLinks = shortLinks;
        _sharePwd = sharePwd;
        _teams = teams;
        _teamActivity = teamActivity;
        _logger = logger;
    }

    /// <summary>
    /// 站点访问过滤：自己拥有的，或分享到「我所在团队」的。
    /// myTeamIds 为空时退化为纯 owner 过滤（个人路径零回退）。
    /// </summary>
    private static FilterDefinition<HostedSite> OwnerOrMemberFilter(string userId, List<string> myTeamIds)
    {
        var fb = Builders<HostedSite>.Filter;
        var owner = fb.Eq(x => x.OwnerUserId, userId);
        if (myTeamIds.Count == 0) return owner;
        return fb.Or(owner, fb.AnyIn(x => x.SharedTeamIds, myTeamIds));
    }

    /// <summary>
    /// 解析用户对单个站点的网页托管有效角色（owner/editor/viewer），返回 null 表示完全不可访问
    /// （既非站点创建者，也不在任何「站点已共享到」的团队里）。这是「能看到哪些站点」隔离铁律
    /// 与「在站点上能做什么」角色门控的统一入口：role==null ⇔ 不可见；role!=null 时交 WebHostingPermission.Can。
    /// </summary>
    private async Task<string?> ResolveSiteRoleAsync(HostedSite site, string userId, CancellationToken ct)
    {
        if (site.OwnerUserId == userId) return WebHostingRoles.Owner;
        if (site.SharedTeamIds is not { Count: > 0 }) return null;
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId, ct);
        return WebHostingPermission.ResolveSiteRole(isSiteOwner: false, site.SharedTeamIds, roles);
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
        // 角色门控：editor / owner / 站点创建者可重传内容；viewer 与非成员一律拒绝
        var site = await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct);
        if (site == null)
            throw new KeyNotFoundException("站点不存在");
        var role = await ResolveSiteRoleAsync(site, userId, ct);
        if (!WebHostingPermission.Can(role, WebHostingAction.Edit, site.OwnerUserId == userId))
            throw new KeyNotFoundException("站点不存在"); // 不可见/无编辑权一并按不存在处理，不泄露存在性

        // P1 + URL 稳定 + 无孤儿：先在内存里完整校验（ZIP 元数据校验 / HTML 直接可用），
        // 校验通过前绝不写任何 COS 对象。校验失败直接抛错——旧 siteId 前缀文件零改动、
        // DB 未动、也没有任何 staging 残留，原页面与既有 web-hosting/sites/{siteId}/... URL
        // 继续可用。校验通过后才写入「稳定的 siteId 前缀」（覆盖同名、URL 不变）。
        var oldFiles = site.Files ?? new List<HostedSiteFile>();

        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        List<HostedSiteFile> siteFiles;
        string entryFile;
        long totalSize;

        if (ext == ".zip")
        {
            var validationError = ValidateZip(fileBytes);
            if (validationError != null)
                throw new InvalidOperationException(validationError);
            // 校验已通过，此处仅可能因基础设施异常失败（与改动前行为一致）
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

        // siteId 前缀保持不变 → SiteUrl 稳定，既有书签 / 公开主页 / 知识库引用不会 404
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

        // 清理旧文件中不再被新文件集复用的 key。同 key（如 index.html）已被新内容
        // 原地覆盖，不能删——否则会删掉刚写入的文件。
        var newKeys = siteFiles.Select(f => f.CosKey).ToHashSet();
        foreach (var f in oldFiles)
        {
            if (newKeys.Contains(f.CosKey)) continue;
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "删除旧文件失败: {CosKey}", f.CosKey); }
        }

        return (await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct))!;
    }

    // ─────────────────────────────────────────────
    // 查询
    // ─────────────────────────────────────────────

    public async Task<HostedSite?> GetByIdAsync(string siteId, string userId, CancellationToken ct)
    {
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        var fb = Builders<HostedSite>.Filter;
        var filter = fb.And(fb.Eq(x => x.Id, siteId), OwnerOrMemberFilter(userId, myTeamIds));
        return await _db.HostedSites.Find(filter).FirstOrDefaultAsync(ct);
    }

    public async Task<(List<HostedSite> Items, long Total)> ListAsync(
        string userId, string? keyword, string? folder,
        string? tag, string? sourceType, string sort,
        int skip, int limit, string? scope, string? teamId, CancellationToken ct)
    {
        var fb = Builders<HostedSite>.Filter;
        FilterDefinition<HostedSite> filter;

        if (string.Equals(scope, "team", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(teamId))
        {
            // 团队作用域：必须是我所在的团队，且站点已分享到该团队
            var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
            if (!myTeamIds.Contains(teamId))
                return (new List<HostedSite>(), 0);
            filter = fb.AnyEq(x => x.SharedTeamIds, teamId);
        }
        else
        {
            // 个人作用域：与改动前字节一致
            filter = fb.Eq(x => x.OwnerUserId, userId);
        }

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

        // 角色门控：editor / owner / 站点创建者可编辑元信息；viewer 与非成员拒绝
        var site = await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct);
        if (site == null) return null;
        var role = await ResolveSiteRoleAsync(site, userId, ct);
        if (!WebHostingPermission.Can(role, WebHostingAction.Edit, site.OwnerUserId == userId))
            return null;

        var result = await _db.HostedSites.UpdateOneAsync(x => x.Id == siteId, ub.Combine(updates), cancellationToken: ct);
        if (result.MatchedCount == 0) return null;

        var updated = await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct);
        if (updated != null && updated.SharedTeamIds.Count > 0)
        {
            await _teamActivity.LogForTeamsAsync(
                updated.SharedTeamIds, TeamAppKey.WebHosting, userId,
                TeamActivityAction.SiteUpdated, "site", updated.Id, updated.Title, ct);
        }
        return updated;
    }

    public async Task<bool> DeleteAsync(string siteId, string userId, CancellationToken ct)
    {
        // 角色门控：删除只给文件夹所有者(owner)或站点创建者；editor 不能删别人的站点，viewer 全拒
        var site = await _db.HostedSites.Find(x => x.Id == siteId).FirstOrDefaultAsync(ct);
        if (site == null) return false;
        var role = await ResolveSiteRoleAsync(site, userId, ct);
        if (!WebHostingPermission.Can(role, WebHostingAction.Delete, site.OwnerUserId == userId))
            return false;

        foreach (var f in site.Files)
        {
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "删除 COS 文件失败: {CosKey}", f.CosKey); }
        }

        await _db.HostedSites.DeleteOneAsync(x => x.Id == siteId, ct);
        // 个人分享链接清理仍按创建者本人（团队成员不应删别人的分享链接）
        await _db.WebPageShareLinks.DeleteManyAsync(x => x.SiteId == siteId && x.CreatedBy == userId, ct);

        if (site.SharedTeamIds.Count > 0)
        {
            await _teamActivity.LogForTeamsAsync(
                site.SharedTeamIds, TeamAppKey.WebHosting, userId,
                TeamActivityAction.SiteDeleted, "site", site.Id, site.Title, ct);
        }
        return true;
    }

    public async Task<long> BatchDeleteAsync(List<string> siteIds, string userId, CancellationToken ct)
    {
        // 角色门控：仅保留「文件夹所有者或站点创建者」可删除的站点；editor/viewer 删别人的会被静默跳过
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId, ct);
        var fb = Builders<HostedSite>.Filter;
        var candidates = await _db.HostedSites.Find(fb.In(x => x.Id, siteIds)).ToListAsync(ct);
        var sites = candidates.Where(s =>
        {
            var isOwner = s.OwnerUserId == userId;
            var role = WebHostingPermission.ResolveSiteRole(isOwner, s.SharedTeamIds, roles);
            return WebHostingPermission.Can(role, WebHostingAction.Delete, isOwner);
        }).ToList();

        foreach (var site in sites)
        foreach (var f in site.Files)
        {
            try { await _storage.DeleteByKeyAsync(f.CosKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "批量删除 COS 文件失败: {CosKey}", f.CosKey); }
        }

        var deletableIds = sites.Select(s => s.Id).ToList();
        if (deletableIds.Count == 0) return 0;

        var result = await _db.HostedSites.DeleteManyAsync(fb.In(x => x.Id, deletableIds), ct);
        await _db.WebPageShareLinks.DeleteManyAsync(
            x => deletableIds.Contains(x.SiteId!) && x.CreatedBy == userId, ct);

        return result.DeletedCount;
    }

    public async Task<HostedSite?> SetSharedTeamsAsync(string siteId, string userId, List<string> teamIds, CancellationToken ct)
    {
        // 只有 owner 能改「分享到哪些团队」（分享出去是所有权动作）
        var site = await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (site == null) return null;

        // 只保留我确实所属的团队，避免分享到不存在 / 越权的团队
        var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
        var sanitized = teamIds.Where(t => myTeamIds.Contains(t)).Distinct().ToList();
        var added = sanitized.Except(site.SharedTeamIds).ToList();

        await _db.HostedSites.UpdateOneAsync(
            x => x.Id == siteId,
            Builders<HostedSite>.Update
                .Set(x => x.SharedTeamIds, sanitized)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        if (added.Count > 0)
        {
            await _teamActivity.LogForTeamsAsync(
                added, TeamAppKey.WebHosting, userId,
                TeamActivityAction.SiteShared, "site", site.Id, site.Title, ct);
        }

        site.SharedTeamIds = sanitized;
        return site;
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
        CancellationToken ct = default,
        string purpose = "share",
        bool forceNew = false,
        string visibility = "owner-only")
    {
        // 规范化 visibility 入参（白名单），缺省回退 owner-only
        var normalizedVisibility = visibility?.ToLowerInvariant() switch
        {
            "public" => "public",
            "logged-in" => "logged-in",
            _ => "owner-only",
        };
        var allIds = shareType == "collection" ? (siteIds ?? new()) : new List<string>();
        if (shareType != "collection")
        {
            if (string.IsNullOrWhiteSpace(siteId))
                throw new ArgumentException("单站点分享需提供 siteId");
            allIds = new List<string> { siteId };
        }

        if (allIds.Count == 0)
            throw new ArgumentException("至少选择一个站点");

        // 角色门控：editor / owner / 站点创建者可建分享链接；viewer 与非成员拒绝。
        // 所有目标站点都必须有 CreateShare 权限，否则整笔拒绝（与原「全部可访问才放行」一致）。
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId, ct);
        var fbShare = Builders<HostedSite>.Filter;
        var shareSites = await _db.HostedSites.Find(fbShare.In(x => x.Id, allIds)).ToListAsync(ct);
        var sharableIds = shareSites.Where(s =>
        {
            var isOwner = s.OwnerUserId == userId;
            var role = WebHostingPermission.ResolveSiteRole(isOwner, s.SharedTeamIds, roles);
            return WebHostingPermission.Can(role, WebHostingAction.CreateShare, isOwner);
        }).Select(s => s.Id).ToHashSet();
        if (!allIds.All(sharableIds.Contains))
            throw new UnauthorizedAccessException("包含无分享权限或非团队的站点");

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
        var wantPassword = string.IsNullOrWhiteSpace(password) ? null : password.Trim();
        var nowUtc = DateTime.UtcNow;
        var newExpiresAt = expiresInDays > 0 ? nowUtc.AddDays(expiresInDays) : (DateTime?)null;

        // forceNew=true（PR 2026-05-28 起，用户在分享面板显式点新建）：跳过复用直接新建。
        // visit 便捷链恒走复用路径（避免每次进入页面都创建一条便捷链污染列表）。
        WebPageShareLink? reusable = null;
        if (!forceNew || effPurpose == "visit")
        {
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
        }

        // 标题/描述在复用与新建两条路径上必须一致，且复用时也要刷新——
        // 否则站点改名或调用方传了新 title/description 后，ViewShareAsync 仍渲染旧值。
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
        var effDescription = description?.Trim();

        if (reusable is { } reuse)
        {
            // 复用时把有效期 + 密码 + 标题/描述刷新为本次请求/最新值（单链接模型下
            // "改密码=轮换"）：否则用户重设新密码却被静默丢弃、旧密码仍可用——既是展示
            // 错误也是安全隐患；标题/描述不刷新则站点改名后展示陈旧元数据。
            var ups = new List<UpdateDefinition<WebPageShareLink>>();
            // 保留 mutate 前的 ExpiresAt，供下方审计 RenewalHistory.OldExpiresAt 使用
            var oldExpiresAtForAudit = reuse.ExpiresAt;
            if (reuse.ExpiresAt != newExpiresAt)
            {
                ups.Add(Builders<WebPageShareLink>.Update.Set(x => x.ExpiresAt, newExpiresAt));
                reuse.ExpiresAt = newExpiresAt;
            }
            if (wantAccess == "password" && reuse.Password != wantPassword)
            {
                // 密码变更：明文（去重 + 展示给分享者）+ Hash/Salt（校验）一并刷新
                var h = _sharePwd.Hash(wantPassword!);
                ups.Add(Builders<WebPageShareLink>.Update.Set(x => x.Password, wantPassword));
                ups.Add(Builders<WebPageShareLink>.Update.Set(x => x.PasswordHash, h.Hash));
                ups.Add(Builders<WebPageShareLink>.Update.Set(x => x.PasswordSalt, h.Salt));
                ups.Add(Builders<WebPageShareLink>.Update.Set(x => x.RecentAttempts, new List<DateTime>()));
                reuse.Password = wantPassword;
                reuse.PasswordHash = h.Hash;
                reuse.PasswordSalt = h.Salt;
                reuse.RecentAttempts = new List<DateTime>();
            }
            if (reuse.Title != shareTitle)
            {
                ups.Add(Builders<WebPageShareLink>.Update.Set(x => x.Title, shareTitle));
                reuse.Title = shareTitle;
            }
            if (reuse.Description != effDescription)
            {
                ups.Add(Builders<WebPageShareLink>.Update.Set(x => x.Description, effDescription));
                reuse.Description = effDescription;
            }
            // 复用即视为续期事件 —— 写一条审计记录，便于事后排查"为什么过期时间变了"
            if (oldExpiresAtForAudit != newExpiresAt || ups.Count > 0)
            {
                var renewEvent = new ShareRenewalEvent
                {
                    Action = "reused",
                    ByUserId = userId,
                    OldExpiresAt = oldExpiresAtForAudit,
                    NewExpiresAt = newExpiresAt,
                    Note = oldExpiresAtForAudit != newExpiresAt
                        ? $"create-share reused link, ExpiresAt {oldExpiresAtForAudit?.ToString("o") ?? "null"} -> {newExpiresAt?.ToString("o") ?? "null"}"
                        : "create-share reused link (metadata refreshed, expiry unchanged)",
                };
                ups.Add(Builders<WebPageShareLink>.Update.Push(x => x.RenewalHistory, renewEvent));
                reuse.RenewalHistory ??= new List<ShareRenewalEvent>();
                reuse.RenewalHistory.Add(renewEvent);
            }

            if (ups.Count > 0)
            {
                await _db.WebPageShareLinks.UpdateOneAsync(
                    x => x.Id == reuse.Id,
                    Builders<WebPageShareLink>.Update.Combine(ups),
                    cancellationToken: ct);
            }
            _logger.LogInformation("用户 {UserId} 复用站点分享 {ShareId}, type={Type}",
                userId, reuse.Id, reuse.ShareType);
            return reuse;
        }

        // 新分享：同时写明文（去重 + 展示给分享者）和 Hash/Salt（校验主路径）
        var pwdHash = wantPassword != null ? (SharePasswordHash?)_sharePwd.Hash(wantPassword) : null;
        // visit 链恒为 public（站点访问便捷链），其余按调用方传入的 visibility
        var effVisibility = effPurpose == "visit" ? "public" : normalizedVisibility;
        var share = new WebPageShareLink
        {
            SiteId = shareType != "collection" ? siteId : null,
            SiteIds = allIds,
            ShareType = shareType ?? "single",
            Purpose = effPurpose,
            Title = shareTitle,
            Description = effDescription,
            AccessLevel = wantAccess,
            Password = wantPassword,
            PasswordHash = pwdHash?.Hash,
            PasswordSalt = pwdHash?.Salt,
            ExpiresAt = newExpiresAt,
            Visibility = effVisibility,
            CreatedBy = userId,
            CreatedByName = displayName,
            RenewalHistory = new List<ShareRenewalEvent>
            {
                new()
                {
                    Action = "created",
                    ByUserId = userId,
                    NewExpiresAt = newExpiresAt,
                    Note = forceNew ? "force-new create" : "create",
                },
            },
        };

        await _db.WebPageShareLinks.InsertOneAsync(share, cancellationToken: ct);

        // visit 便捷链只通过不可猜测的 /s/wp/{token} 暴露，绝不分配数字短链 /s/{seq}：
        // /api/short-links/{seq} 匿名且可枚举，若给 visit 链分配 seq，攻击者枚举数字即可
        // 访问到从未被主动分享的私有站点。仅 share 用户主动分享才分配数字短链。
        if (effPurpose != "visit")
        {
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
        }

        _logger.LogInformation("用户 {UserId} 创建站点分享 {ShareId}, type={Type}, shortSeq={Seq}",
            userId, share.Id, share.ShareType, share.ShortSeq);

        return share;
    }

    public async Task<List<WebPageShareLink>> ListSharesAsync(string userId, CancellationToken ct)
    {
        // 排除 visit 便捷链（自动创建，非用户主动分享，不应污染分享管理列表）；
        // 排除已撤销链接（用户主动取消后立即从列表消失）；
        // 时间过滤：未设过期 / 未过期 / 过期 ≤ 7 天（宽限期，允许续期，避免链接突然失效）；
        // 过期 > 7 天的链接保留 DB 行用于审计 (diagnostics)，但不返回给用户列表。
        var graceCutoff = DateTime.UtcNow.AddDays(-7);
        var fb = Builders<WebPageShareLink>.Filter;
        var filter = fb.Eq(x => x.CreatedBy, userId)
            & fb.Eq(x => x.IsRevoked, false)
            & fb.Ne(x => x.Purpose, "visit")
            & (fb.Eq(x => x.ExpiresAt, (DateTime?)null) | fb.Gt(x => x.ExpiresAt, graceCutoff));

        var items = await _db.WebPageShareLinks
            .Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);

        // 异步刷新 UniqueIpCount 缓存（仅当 ViewCount 与缓存严重偏离时）
        // 不阻塞列表返回主路径；后续可独立做后台聚合任务
        await RefreshUniqueIpCacheAsync(items, ct);
        return items;
    }

    /// <summary>
    /// 对一批分享链接刷新 UniqueIpCount 缓存。
    /// 仅当 ViewCount > UniqueIpCount + 5（缓存严重落后）时才走聚合，避免对静态数据反复打 ShareViewLogs。
    /// </summary>
    private async Task RefreshUniqueIpCacheAsync(List<WebPageShareLink> shares, CancellationToken ct)
    {
        var stale = shares.Where(s => s.ViewCount > s.UniqueIpCount + 5 && s.ViewCount > 0).ToList();
        if (stale.Count == 0) return;

        foreach (var share in stale)
        {
            try
            {
                var fb = Builders<ShareViewLog>.Filter;
                var distinctIps = await _db.ShareViewLogs
                    .Distinct<string>("IpAddress",
                        fb.Eq(x => x.ShareId, share.Id) & fb.Ne(x => x.IpAddress, null),
                        cancellationToken: ct)
                    .ToListAsync(ct);
                var uniqueCount = distinctIps.Count(s => !string.IsNullOrWhiteSpace(s));
                if (uniqueCount != share.UniqueIpCount)
                {
                    await _db.WebPageShareLinks.UpdateOneAsync(
                        x => x.Id == share.Id,
                        Builders<WebPageShareLink>.Update.Set(x => x.UniqueIpCount, uniqueCount),
                        cancellationToken: ct);
                    share.UniqueIpCount = uniqueCount;
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "刷新 UniqueIpCount 失败: share={ShareId}", share.Id);
            }
        }
    }

    public async Task<bool> RevokeShareAsync(string shareId, string userId, CancellationToken ct)
    {
        var result = await _db.WebPageShareLinks.UpdateOneAsync(
            x => x.Id == shareId && x.CreatedBy == userId,
            Builders<WebPageShareLink>.Update.Set(x => x.IsRevoked, true),
            cancellationToken: ct);
        return result.MatchedCount > 0;
    }

    /// <summary>
    /// 分享 Visibility 校验（防盗：owner-only / logged-in / public）。
    /// 抽成独立方法供 ViewShareAsync + SaveSharedSiteAsync 共享，避免 /save 端点绕过 /view 防盗。
    /// 返回 null 表示通过；返回 tuple 时调用方应 short-circuit。
    /// owner-only 合集分享时按【每个目标站点】单独校验，避免跨团队成员越权拿到非己团队站点。
    /// </summary>
    private async Task<(string Error, int HttpStatus, string ErrorCode)?> EnforceShareVisibilityAsync(
        WebPageShareLink share, string? viewerUserId, CancellationToken ct)
    {
        // 旧记录 / visit 链 / 默认 public 都识别为可公开访问（不阻断历史链路）
        var effVisibility = string.IsNullOrEmpty(share.Visibility) ? "public" : share.Visibility;

        if (effVisibility == "owner-only")
        {
            if (string.IsNullOrEmpty(viewerUserId))
                return ("此链接仅限创建者访问，请登录后再试", 403, "visibility_denied");

            // 创建者本人直接通过
            if (viewerUserId == share.CreatedBy) return null;

            // 团队成员：每个目标站点都要单独验证（合集场景防跨团队越权）
            var ownerCheckIds = share.SiteIds.Count > 0 ? share.SiteIds : new List<string>();
            if (share.SiteId != null && !ownerCheckIds.Contains(share.SiteId))
                ownerCheckIds.Insert(0, share.SiteId);
            var targetSites = await _db.HostedSites.Find(x => ownerCheckIds.Contains(x.Id)).ToListAsync(ct);
            var myRoles = await _teams.GetMyWebHostingTeamRolesAsync(viewerUserId, ct);
            var allAuthorized = targetSites.All(s =>
                s.OwnerUserId == viewerUserId
                || (s.SharedTeamIds ?? new List<string>()).Any(tid => myRoles.ContainsKey(tid)));

            if (!allAuthorized)
                return ("此链接含一个或多个你无权访问的站点", 403, "visibility_denied");
            return null;
        }

        if (effVisibility == "logged-in")
        {
            if (string.IsNullOrEmpty(viewerUserId))
                return ("此链接需要登录后访问", 403, "visibility_denied");
            return null;
        }

        // "public": 任何人通过；密码校验由 EnforceShareAccessAsync 单独处理
        return null;
    }

    /// <summary>
    /// 分享访问统一关卡：滑动窗口速率限制 + Hash 优先校验 + 持久化窗口状态。
    /// 返回 null 表示通过；返回 tuple 时调用方应直接 short-circuit 用对应 HttpStatus 回客户端。
    /// 不绑定 IP：容器反代下 IP 不可靠，NAT 局域网下会一锅端 —— 改按 shareLink 全局限速。
    /// </summary>
    private async Task<(string Error, int HttpStatus, int? RetryAfter)?> EnforceShareAccessAsync(
        WebPageShareLink share, string? password, CancellationToken ct)
    {
        if (share.AccessLevel != "password") return null;

        var rl = _sharePwd.CheckRateLimit(share.RecentAttempts);
        if (!rl.Allowed)
        {
            // 即使被拒，也把过期条目清掉一并写回，避免列表无限膨胀
            await _db.WebPageShareLinks.UpdateOneAsync(
                x => x.Id == share.Id,
                Builders<WebPageShareLink>.Update.Set(x => x.RecentAttempts, rl.PrunedAttempts),
                cancellationToken: ct);
            var sec = (int)Math.Ceiling(rl.RetryAfter.TotalSeconds);
            return ($"尝试过于频繁，请 {sec} 秒后再试", 429, sec);
        }

        // 记录本次尝试时间戳（无论对错）—— 攻击者要破解就只能 10 次/分钟慢慢凿
        await _db.WebPageShareLinks.UpdateOneAsync(
            x => x.Id == share.Id,
            Builders<WebPageShareLink>.Update.Set(x => x.RecentAttempts, rl.PrunedAttempts),
            cancellationToken: ct);

        var provided = (password ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(provided))
            return ("需要提供正确的访问密码", 401, null);

        bool ok;
        if (!string.IsNullOrEmpty(share.PasswordHash) && !string.IsNullOrEmpty(share.PasswordSalt))
        {
            // 新分享：PBKDF2 + FixedTimeEquals
            ok = _sharePwd.Verify(provided, share.PasswordHash, share.PasswordSalt);
        }
        else
        {
            // 旧分享回退：明文恒时比对（避免按字符短路泄露前缀长度）
            ok = _sharePwd.ConstantTimeStringEquals(provided, share.Password ?? string.Empty);
        }

        if (!ok) return ("需要提供正确的访问密码", 401, null);

        // 密码正确：清空窗口让合法用户不被自己的历史失败拖累；攻击者一旦撞对就进去了，
        // 清空对安全性无伤
        if (rl.PrunedAttempts.Count > 0)
        {
            await _db.WebPageShareLinks.UpdateOneAsync(
                x => x.Id == share.Id,
                Builders<WebPageShareLink>.Update.Set(x => x.RecentAttempts, new List<DateTime>()),
                cancellationToken: ct);
        }
        return null;
    }

    public async Task<ShareViewResult?> ViewShareAsync(string token, string? password,
        string? viewerUserId = null, string? viewerName = null,
        string? ipAddress = null, string? userAgent = null,
        CancellationToken ct = default)
    {
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token).FirstOrDefaultAsync(ct);
        if (share == null || share.IsRevoked)
            return new ShareViewResult { Error = "分享链接不存在或已失效", HttpStatus = 404, ErrorCode = "not_found" };

        if (share.ExpiresAt.HasValue && share.ExpiresAt.Value < DateTime.UtcNow)
            return new ShareViewResult { Error = "分享链接已过期", HttpStatus = 400, ErrorCode = "expired" };

        // Visibility 校验抽成共享方法 EnforceShareVisibilityAsync，
        // SaveSharedSiteAsync 等其他访问入口也走同一关卡（PR #685 Codex P2 反馈：
        // 不要让 /save 端点绕过 /view 的 owner-only 防盗）。
        var visGate = await EnforceShareVisibilityAsync(share, viewerUserId, ct);
        if (visGate is { } vg)
            return new ShareViewResult { Error = vg.Error, HttpStatus = vg.HttpStatus, ErrorCode = vg.ErrorCode };
        // "public" + 通过 visibility 校验后：下面 password gate 仍然生效

        var gate = await EnforceShareAccessAsync(share, password, ct);
        if (gate is { } g)
            return new ShareViewResult { Error = g.Error, HttpStatus = g.HttpStatus, RetryAfterSeconds = g.RetryAfter, ErrorCode = g.HttpStatus == 429 ? "rate_limited" : "wrong_password" };

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

    public async Task<List<ShareViewLog>> ListShareViewLogsForSiteAsync(
        string siteId, string userId, int limit = 50, CancellationToken ct = default)
    {
        // 仅站点 owner 可查；按站点的所有分享链接聚合日志
        var site = await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(ct);
        if (site == null) return new List<ShareViewLog>();

        var fbLink = Builders<WebPageShareLink>.Filter;
        var linkFilter = fbLink.Eq(x => x.CreatedBy, userId) &
            (fbLink.Eq(x => x.SiteId, siteId) | fbLink.AnyEq(x => x.SiteIds, siteId));
        var tokens = await _db.WebPageShareLinks.Find(linkFilter)
            .Project(x => x.Token).ToListAsync(ct);
        if (tokens.Count == 0) return new List<ShareViewLog>();

        var fbLog = Builders<ShareViewLog>.Filter;
        return await _db.ShareViewLogs
            .Find(fbLog.In(x => x.ShareToken, tokens))
            .SortByDescending(x => x.ViewedAt)
            .Limit(Math.Clamp(limit, 1, 500))
            .ToListAsync(ct);
    }

    // ─────────────────────────────────────────────
    // 续期 / 统计 / 诊断
    // ─────────────────────────────────────────────

    public async Task<RenewShareResult> RenewShareAsync(string shareId, string userId, int extendDays, CancellationToken ct = default)
    {
        if (extendDays <= 0 || extendDays > 365)
            return new RenewShareResult { Error = "续期天数必须在 1 到 365 之间" };

        var share = await _db.WebPageShareLinks.Find(x => x.Id == shareId && x.CreatedBy == userId)
            .FirstOrDefaultAsync(ct);
        if (share == null)
            return new RenewShareResult { Error = "分享不存在或无权操作" };
        if (share.IsRevoked)
            return new RenewShareResult { Error = "链接已撤销，无法续期" };

        var now = DateTime.UtcNow;
        var graceCutoff = now.AddDays(-7);
        if (share.ExpiresAt.HasValue && share.ExpiresAt.Value < graceCutoff)
            return new RenewShareResult { Error = "链接已过期超过 7 天，请新建分享" };

        // 续期基准：未过期时从当前 ExpiresAt 累加；过期 ≤ 7d 时以 now 为起点
        var basis = share.ExpiresAt.HasValue && share.ExpiresAt.Value > now ? share.ExpiresAt.Value : now;
        var newExpiresAt = basis.AddDays(extendDays);

        var renewEvent = new ShareRenewalEvent
        {
            Action = "renewed",
            ByUserId = userId,
            OldExpiresAt = share.ExpiresAt,
            NewExpiresAt = newExpiresAt,
            Note = $"manual renew +{extendDays}d",
        };

        await _db.WebPageShareLinks.UpdateOneAsync(
            x => x.Id == shareId,
            Builders<WebPageShareLink>.Update
                .Set(x => x.ExpiresAt, newExpiresAt)
                .Push(x => x.RenewalHistory, renewEvent),
            cancellationToken: ct);

        _logger.LogInformation("用户 {UserId} 续期分享 {ShareId} 至 {ExpiresAt}", userId, shareId, newExpiresAt);
        return new RenewShareResult { Ok = true, NewExpiresAt = newExpiresAt };
    }

    public async Task<ShareAnalyticsResult> GetShareAnalyticsAsync(string userId, int rangeDays, string? siteId = null, CancellationToken ct = default)
    {
        if (rangeDays <= 0 || rangeDays > 365) rangeDays = 7;
        var rangeStart = DateTime.UtcNow.AddDays(-rangeDays);

        // 全量 shares（含已过期、不含 visit 链）
        var fbLink = Builders<WebPageShareLink>.Filter;
        var siteScopedFilter = string.IsNullOrEmpty(siteId)
            ? fbLink.Empty
            : (fbLink.Eq(x => x.SiteId, siteId) | fbLink.AnyEq(x => x.SiteIds, siteId));
        var allShares = await _db.WebPageShareLinks
            .Find(fbLink.Eq(x => x.CreatedBy, userId) & fbLink.Ne(x => x.Purpose, "visit") & siteScopedFilter)
            .ToListAsync(ct);

        var now = DateTime.UtcNow;
        var totalShares = allShares.Count;
        var activeShares = allShares.Count(s => !s.IsRevoked && (!s.ExpiresAt.HasValue || s.ExpiresAt.Value > now));
        var expiredShares = allShares.Count(s => s.ExpiresAt.HasValue && s.ExpiresAt.Value <= now);

        var tokens = allShares.Select(s => s.Token).ToList();
        var fbLog = Builders<ShareViewLog>.Filter;
        var recentLogs = tokens.Count == 0
            ? new List<ShareViewLog>()
            : await _db.ShareViewLogs
                .Find(fbLog.In(x => x.ShareToken, tokens) & fbLog.Gte(x => x.ViewedAt, rangeStart))
                .SortByDescending(x => x.ViewedAt)
                .Limit(500)
                .ToListAsync(ct);

        var totalViews = recentLogs.Count;
        var uniqueIps = recentLogs.Where(l => !string.IsNullOrEmpty(l.IpAddress))
            .Select(l => l.IpAddress!).Distinct().Count();

        // 时间线（脱敏 IP：前两段保留，后两段打码，避免泄露给非 admin）
        var titleByToken = allShares.ToDictionary(s => s.Token, s => s.Title);
        var timeline = recentLogs.Take(100).Select(l => new ShareAnalyticsTimelineEntry
        {
            ViewedAt = l.ViewedAt,
            ShareToken = l.ShareToken,
            ShareTitle = titleByToken.TryGetValue(l.ShareToken, out var t) ? t : null,
            ViewerName = l.ViewerName,
            IpAddress = MaskIp(l.IpAddress),
            UserAgent = l.UserAgent,
        }).ToList();

        // Top 链接（按 ViewCount 排序，最多 10 条）
        var topLinks = allShares
            .Where(s => !s.IsRevoked)
            .OrderByDescending(s => s.ViewCount)
            .Take(10)
            .Select(s => new ShareAnalyticsLinkSummary
            {
                ShareId = s.Id,
                Token = s.Token,
                Title = s.Title,
                ViewCount = s.ViewCount,
                UniqueIpCount = s.UniqueIpCount,
                LastViewedAt = s.LastViewedAt,
                CreatedAt = s.CreatedAt,
                ExpiresAt = s.ExpiresAt,
                Visibility = s.Visibility ?? "owner-only",
            })
            .ToList();

        return new ShareAnalyticsResult
        {
            TotalShares = totalShares,
            ActiveShares = activeShares,
            ExpiredShares = expiredShares,
            TotalViews = totalViews,
            UniqueIpCount = uniqueIps,
            Timeline = timeline,
            TopLinks = topLinks,
        };
    }

    /// <summary>
    /// 简单 IP 脱敏：v4 保留前两段 (a.b.*.*)，v6 截断为前 3 段。仅用于面向所有者的统计 UI。
    /// </summary>
    private static string? MaskIp(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip)) return ip;
        if (ip.Contains('.'))
        {
            var parts = ip.Split('.');
            return parts.Length >= 2 ? $"{parts[0]}.{parts[1]}.*.*" : ip;
        }
        if (ip.Contains(':'))
        {
            var parts = ip.Split(':');
            return parts.Length >= 3 ? $"{parts[0]}:{parts[1]}:{parts[2]}::*" : ip;
        }
        return ip;
    }

    public async Task<ShareDiagnosticsResult?> GetShareDiagnosticsAsync(string token, CancellationToken ct = default)
    {
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token).FirstOrDefaultAsync(ct);
        if (share == null) return null;

        var recentViews = await _db.ShareViewLogs
            .Find(x => x.ShareId == share.Id)
            .SortByDescending(x => x.ViewedAt)
            .Limit(10)
            .ToListAsync(ct);

        var summary = BuildDiagnosticsSummary(share);

        return new ShareDiagnosticsResult
        {
            Token = share.Token,
            Id = share.Id,
            CreatedAt = share.CreatedAt,
            CreatedBy = share.CreatedBy,
            CreatedByName = share.CreatedByName,
            ExpiresAt = share.ExpiresAt,
            IsRevoked = share.IsRevoked,
            Visibility = share.Visibility ?? "owner-only",
            AccessLevel = share.AccessLevel,
            ViewCount = share.ViewCount,
            LastViewedAt = share.LastViewedAt,
            RenewalHistory = share.RenewalHistory ?? new List<ShareRenewalEvent>(),
            RecentViews = recentViews,
            DiagnosisSummary = summary,
        };
    }

    private static string BuildDiagnosticsSummary(WebPageShareLink share)
    {
        var now = DateTime.UtcNow;
        if (share.IsRevoked)
            return "链接已被创建者主动撤销，无法访问。";
        if (share.ExpiresAt.HasValue && share.ExpiresAt.Value < now)
        {
            var daysExpired = (now - share.ExpiresAt.Value).TotalDays;
            return daysExpired <= 7
                ? $"链接已过期 {daysExpired:F1} 天，仍在 7 天宽限期内，创建者可续期。"
                : $"链接已过期 {daysExpired:F1} 天，超出 7 天宽限期，须新建。";
        }
        if (share.Visibility == "owner-only")
            return "链接当前仅限创建者或所属团队成员访问。";
        if (share.Visibility == "logged-in")
            return "链接当前仅限登录用户访问。";
        return "链接当前可正常访问。";
    }

    public async Task<int> BackfillShareVisibilityAsync(CancellationToken ct = default)
    {
        // 操作性 backfill（非功能必需）：把仍是空 / 缺字段的存量分享显式写为 "public"。
        // 功能上 ViewShareAsync 已把空 Visibility 当 public 兼容；这里写实值让 admin diagnostics
        // 和列表 UI 不再展示"未设置"，纯粹清理。新建链接已显式赋值（owner-only/logged-in/public），
        // 不在过滤范围内；visit 链已写 "public"，也不需要重复。
        var cutoff = DateTime.UtcNow;
        var fb = Builders<WebPageShareLink>.Filter;
        var filter = fb.Lt(x => x.CreatedAt, cutoff)
            & fb.Ne(x => x.Purpose, "visit")
            & (fb.Eq(x => x.Visibility, "")
                | fb.Eq(x => x.Visibility, (string?)null)
                | fb.Exists(x => x.Visibility, false));

        var result = await _db.WebPageShareLinks.UpdateManyAsync(
            filter,
            Builders<WebPageShareLink>.Update.Set(x => x.Visibility, "public"),
            cancellationToken: ct);

        var modified = result.ModifiedCount;
        if (modified > 0)
        {
            _logger.LogInformation("BackfillShareVisibility: 把 {Count} 条空 Visibility 的存量分享显式写为 public（清理性 backfill）", modified);
        }
        return (int)modified;
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

        // Visibility 校验（PR #685 Codex P2 反馈：/save 不能绕过 /view 的 owner-only 防盗）
        var visGate = await EnforceShareVisibilityAsync(share, userId, ct);
        if (visGate is { } vg)
            return new SaveSharedSiteResult { Error = vg.Error, HttpStatus = vg.HttpStatus };

        var gate = await EnforceShareAccessAsync(share, password, ct);
        if (gate is { } g)
            return new SaveSharedSiteResult { Error = g.Error, HttpStatus = g.HttpStatus, RetryAfterSeconds = g.RetryAfter };

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

    private sealed class ZipPlan
    {
        public string? Error;
        public List<(ZipArchiveEntry Entry, string RelativePath, string Mime)> Items = new();
    }

    /// <summary>
    /// ZIP 过滤/计数/限额逻辑的唯一来源（路径穿越、__MACOSX、黑名单后缀、文件数、
    /// 解压总大小、空文件处理、≥1 有效文件）。ValidateZip 与 ExtractAndUploadZip 都走它，
    /// 结构上保证「校验通过」⇔「上传阶段产出 ≥1 文件且不超限」，杜绝两份逻辑各自漂移。
    /// 返回的 Entry 仅在传入 archive 的生命周期内有效。
    /// </summary>
    private ZipPlan PlanZipEntries(ZipArchive archive)
    {
        var plan = new ZipPlan();

        if (archive.Entries.Count > MaxFileCount)
        {
            plan.Error = $"ZIP 包含的文件数超过限制 ({MaxFileCount})";
            return plan;
        }

        var rootPrefix = DetectRootPrefix(archive);
        long totalSize = 0;

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
            {
                plan.Error = $"解压后总大小超过限制 ({MaxExtractedSize / 1024 / 1024}MB)";
                return plan;
            }

            if (entry.Length == 0) continue;

            plan.Items.Add((entry, relativePath, GetMimeType(fileExt)));
        }

        if (plan.Items.Count == 0)
            plan.Error = "ZIP 中没有有效文件";

        return plan;
    }

    private async Task<ZipExtractResult> ExtractAndUploadZip(string siteId, byte[] zipBytes)
    {
        try
        {
            using var zipStream = new MemoryStream(zipBytes);
            using var archive = new ZipArchive(zipStream, ZipArchiveMode.Read);

            var plan = PlanZipEntries(archive);
            if (plan.Error != null)
                return new ZipExtractResult { Error = plan.Error };

            var files = new List<HostedSiteFile>();
            long totalSize = 0;

            foreach (var (entry, relativePath, mimeType) in plan.Items)
            {
                using var entryStream = entry.Open();
                using var entryMs = new MemoryStream();
                await entryStream.CopyToAsync(entryMs);
                var entryBytes = entryMs.ToArray();

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
                totalSize += entryBytes.Length;
            }

            var entryFile = files.FirstOrDefault(f => f.Path.Equals("index.html", StringComparison.OrdinalIgnoreCase))?.Path
                ?? files.FirstOrDefault(f => f.Path.Equals("index.htm", StringComparison.OrdinalIgnoreCase))?.Path
                ?? files.FirstOrDefault(f => f.MimeType == "text/html")?.Path
                ?? files[0].Path;

            return new ZipExtractResult { Files = files, EntryFile = entryFile, TotalSize = totalSize };
        }
        catch (InvalidDataException)
        {
            return new ZipExtractResult { Error = "无效的 ZIP 文件" };
        }
    }

    /// <summary>
    /// 纯元数据校验 ZIP（不解压内容、不写任何 COS）。与 ExtractAndUploadZip 共用
    /// PlanZipEntries，条件结构上一致。用于重传替换：先校验后写入，失败时零副作用。
    /// </summary>
    private string? ValidateZip(byte[] zipBytes)
    {
        try
        {
            using var zipStream = new MemoryStream(zipBytes);
            using var archive = new ZipArchive(zipStream, ZipArchiveMode.Read);
            return PlanZipEntries(archive).Error;
        }
        catch (InvalidDataException)
        {
            return "无效的 ZIP 文件";
        }
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
