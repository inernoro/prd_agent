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
    public const int MaxZipFileCount = 5000;

    // 网页托管对象的 Cache-Control。配合 SiteUrl 上的 ?v={UpdatedAt.Ticks} 版本指纹形成
    // 「内容指纹缓存」：内容不变 → URL 不变 → 命中浏览器/CDN 缓存（满足"没更新就用缓存"）；
    // 重新上传 → UpdatedAt 变化 → ?v 变化 → URL 变化 → 击穿缓存拿到新内容。
    // max-age=3600 是兜底——万一某些 CDN 配置忽略查询串，最长 1 小时后也会回源刷新。
    private const string SiteCacheControl = "public, max-age=3600";

    // 给入口 URL 追加版本指纹。version 取站点的 ContentVersion：只在创建 / 重新上传
    // （内容真正变化）时改变；改标题、改可见性等元数据操作不动它。因此"没更新"的站点
    // URL 恒定可缓存，符合用户要求"没更新还要缓存"。
    internal static string AppendVersion(string url, DateTime version)
    {
        if (string.IsNullOrWhiteSpace(url)) return url;
        var sep = url.Contains('?') ? '&' : '?';
        return $"{url}{sep}v={version.Ticks}";
    }

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

        // 站点挂在受限分组下时，分组所属团队那一路的角色按授权规则裁剪/升格
        // （其他共享团队的角色不受影响），解析逻辑见 WebPageGroupAccess。
        WebPageGroup? group = null;
        List<string>? myLabels = null;
        if (!string.IsNullOrWhiteSpace(site.GroupId))
        {
            group = await _db.WebPageGroups.Find(g => g.Id == site.GroupId).FirstOrDefaultAsync(ct);
            if (WebPageGroupAccess.IsRestricted(group))
            {
                var member = await _db.TeamMembers
                    .Find(m => m.TeamId == group!.TeamId && m.UserId == userId)
                    .FirstOrDefaultAsync(ct);
                myLabels = member?.Labels ?? new List<string>();
            }
        }
        return WebPageGroupAccess.ResolveSiteRoleWithGroup(
            isSiteOwner: false, site.SharedTeamIds, roles, group, userId, myLabels);
    }

    /// <summary>
    /// 计算这些团队里「对我不可见」的受限分组 ID（用于列表过滤）。
    /// 注意：列表过滤是分组粒度的近似 —— 站点同时共享给多个团队时，单站点的精确判定
    /// 以 ResolveSiteRoleAsync 为准（见 doc/debt 记录的已知边界）。
    /// </summary>
    private async Task<List<string>> GetInvisibleGroupIdsAsync(string userId, List<string> teamIds, CancellationToken ct)
    {
        if (teamIds.Count == 0) return new List<string>();
        var restricted = await _db.WebPageGroups
            .Find(g => teamIds.Contains(g.TeamId) && g.Visibility == WebPageGroupVisibility.Restricted)
            .ToListAsync(ct);
        if (restricted.Count == 0) return new List<string>();

        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId, ct);
        var memberTeamIds = restricted.Select(g => g.TeamId).Distinct().ToList();
        var members = await _db.TeamMembers
            .Find(m => memberTeamIds.Contains(m.TeamId) && m.UserId == userId)
            .ToListAsync(ct);
        var labelsByTeam = members.ToDictionary(m => m.TeamId, m => (IReadOnlyCollection<string>)(m.Labels ?? new List<string>()));

        var invisible = new List<string>();
        foreach (var g in restricted)
        {
            roles.TryGetValue(g.TeamId, out var spaceRole);
            labelsByTeam.TryGetValue(g.TeamId, out var labels);
            if (WebPageGroupAccess.ResolveGroupRole(spaceRole, g, userId, labels) == null)
                invisible.Add(g.Id);
        }
        return invisible;
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
        var now = DateTime.UtcNow;
        var rewritten = InjectSlideNavCompat(RewriteAbsolutePathsInHtml(htmlBytes, "index.html"));
        var cosKey = _storage.BuildSiteKey(siteId, "index.html");
        await _storage.UploadToKeyAsync(cosKey, rewritten, "text/html; charset=utf-8", CancellationToken.None, SiteCacheControl);

        var site = new HostedSite
        {
            Id = siteId,
            Title = title?.Trim() ?? Path.GetFileNameWithoutExtension(fileName),
            Description = description?.Trim(),
            SourceType = "upload",
            CosPrefix = $"web-hosting/sites/{siteId}/",
            EntryFile = "index.html",
            SiteUrl = AppendVersion(_storage.BuildUrlForKey(cosKey), now),
            CreatedAt = now,
            UpdatedAt = now,
            ContentVersion = now,
            Files = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = rewritten.Length, MimeType = "text/html" }
            },
            TotalSize = rewritten.Length,
            Tags = tags ?? new(),
            Folder = folder?.Trim(),
            OwnerUserId = userId,
            SlideNavCompatVersion = SlideNavVersion, // 上传即注入当前版垫片
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
        var now = DateTime.UtcNow;
        var result = await ExtractAndUploadZip(siteId, zipBytes);
        if (result.Error != null)
            throw new InvalidOperationException(result.Error);

        var cosPrefix = $"web-hosting/sites/{siteId}/";
        var siteUrl = AppendVersion(_storage.BuildUrlForKey(_storage.BuildSiteKey(siteId, result.EntryFile)), now);

        var site = new HostedSite
        {
            Id = siteId,
            Title = title?.Trim() ?? "未命名站点",
            Description = description?.Trim(),
            SourceType = "upload",
            CosPrefix = cosPrefix,
            EntryFile = result.EntryFile,
            SiteUrl = siteUrl,
            CreatedAt = now,
            UpdatedAt = now,
            ContentVersion = now,
            Files = result.Files,
            TotalSize = result.TotalSize,
            Tags = tags ?? new(),
            Folder = folder?.Trim(),
            OwnerUserId = userId,
            WrappedAssetType = string.IsNullOrWhiteSpace(wrappedAssetType) ? null : wrappedAssetType.Trim().ToLowerInvariant(),
            SlideNavCompatVersion = SlideNavVersion, // 上传即注入当前版垫片（ZIP 内 HTML 条目已注入）
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
        var now = DateTime.UtcNow;
        // API/工作流/工作空间发布的页面同样要注入当前版翻页垫片（与 CreateFromHtml/Reupload 一致），
        // 否则这类站点要等下次服务重启的 backfill 才有 shim。
        var htmlBytes = InjectSlideNavCompat(RewriteAbsolutePathsInHtml(
            System.Text.Encoding.UTF8.GetBytes(htmlContent), "index.html"));

        var cosKey = _storage.BuildSiteKey(siteId, "index.html");
        await _storage.UploadToKeyAsync(cosKey, htmlBytes, "text/html; charset=utf-8", CancellationToken.None, SiteCacheControl);

        var site = new HostedSite
        {
            Id = siteId,
            Title = title?.Trim() ?? "未命名站点",
            Description = description?.Trim(),
            SourceType = sourceType ?? "api",
            SourceRef = sourceRef?.Trim(),
            CosPrefix = $"web-hosting/sites/{siteId}/",
            EntryFile = "index.html",
            SiteUrl = AppendVersion(_storage.BuildUrlForKey(cosKey), now),
            CreatedAt = now,
            UpdatedAt = now,
            ContentVersion = now,
            Files = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = cosKey, Size = htmlBytes.Length, MimeType = "text/html" }
            },
            TotalSize = htmlBytes.Length,
            Tags = tags ?? new(),
            Folder = folder?.Trim(),
            OwnerUserId = userId,
            SlideNavCompatVersion = SlideNavVersion, // 创建即注入当前版垫片
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
            var rewritten = InjectSlideNavCompat(RewriteAbsolutePathsInHtml(fileBytes, "index.html"));
            var cosKey = _storage.BuildSiteKey(siteId, "index.html");
            await _storage.UploadToKeyAsync(cosKey, rewritten, "text/html; charset=utf-8", CancellationToken.None, SiteCacheControl);
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

        // siteId 前缀保持不变 → COS key 稳定，既有书签 / 公开主页 / 知识库引用不会 404。
        // 但 index.html 是原地覆盖（同 key），URL 字符串若也保持不变，浏览器/CDN 会继续吐
        // 旧缓存 →「替换网页不生效」。因此在 URL 上追加 ?v={UpdatedAt.Ticks} 版本指纹：
        // 重新上传 → UpdatedAt 变化 → URL 变化 → 击穿缓存；没有重新上传则 URL 恒定 → 命中缓存。
        var now = DateTime.UtcNow;
        var siteUrl = AppendVersion(_storage.BuildUrlForKey(_storage.BuildSiteKey(siteId, entryFile)), now);

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
                .Set(x => x.UpdatedAt, now)
                .Set(x => x.ContentVersion, now)
                .Set(x => x.SlideNavCompatVersion, SlideNavVersion), // 重传内容已注入当前版垫片
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
        var site = await _db.HostedSites.Find(filter).FirstOrDefaultAsync(ct);
        if (site == null) return null;

        // 受限分组隔离：站点挂在我无权访问的受限分组下时，直查单站点同样不可见
        if (site.OwnerUserId != userId && !string.IsNullOrWhiteSpace(site.GroupId))
        {
            var role = await ResolveSiteRoleAsync(site, userId, ct);
            if (role == null) return null;
        }
        return site;
    }

    public async Task<(List<HostedSite> Items, long Total)> ListAsync(
        string userId, string? keyword, string? folder,
        string? tag, string? sourceType, string sort,
        int skip, int limit, string? scope, string? teamId, CancellationToken ct)
    {
        var fb = Builders<HostedSite>.Filter;
        FilterDefinition<HostedSite> filter;

        if (string.Equals(scope, "team", StringComparison.OrdinalIgnoreCase))
        {
            var myTeamIds = await _teams.GetMyTeamIdsAsync(userId, ct);
            List<string> scopeTeamIds;
            if (!string.IsNullOrWhiteSpace(teamId))
            {
                // 团队作用域：必须是我所在的团队，且站点已分享到该团队
                if (!myTeamIds.Contains(teamId))
                    return (new List<HostedSite>(), 0);
                filter = fb.AnyEq(x => x.SharedTeamIds, teamId);
                scopeTeamIds = new List<string> { teamId };
            }
            else
            {
                // 团队聚合视图：不传 teamId = 我加入的所有团队的共享站点（知识库团队空间消费）
                if (myTeamIds.Count == 0)
                    return (new List<HostedSite>(), 0);
                filter = fb.AnyIn(x => x.SharedTeamIds, myTeamIds);
                scopeTeamIds = myTeamIds;
            }

            // 受限分组隔离：挂在「对我不可见的受限分组」下的站点不进列表（我自己创建的除外）
            var invisibleGroupIds = await GetInvisibleGroupIdsAsync(userId, scopeTeamIds, ct);
            if (invisibleGroupIds.Count > 0)
            {
                filter &= fb.Or(
                    fb.Eq(x => x.OwnerUserId, userId),
                    fb.Not(fb.In(x => x.GroupId, invisibleGroupIds.Cast<string?>())));
            }
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

        // 角色门控：要求「我在目标团队有网页托管编辑权限（owner/editor）」才能分享进去。
        // GetMyWebHostingTeamRolesAsync 仅返回我所属团队（已含成员校验），并解析出有效角色。
        // 关键：不能用 WebHostingPermission.Can(role, …, isSiteOwner) —— 上传者本身就是站点 owner，
        // isSiteOwner=true 会短路放行，导致只读 viewer 直调 API 把自己上传的站点分享进团队（越权）。
        //
        // 不再「静默剔除」越权团队：那样会返回 200 + 空/残缺 SharedTeamIds，前端只看 HTTP 成功，
        // 会误报「投放/移动成功」而站点实际仍在个人空间。改为：请求里只要含一个我无编辑权的团队，
        // 直接抛错让 controller 返回 403。空请求（取消全部分享/退出团队空间）属合法操作，不校验。
        var requested = teamIds.Where(t => !string.IsNullOrWhiteSpace(t)).Distinct().ToList();
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId, ct);
        // 仅对「新增的目标团队」做编辑权校验：保留已分享团队（即便我已被降级为 viewer）属合法 no-op，
        // 移除团队也始终允许（move 对话框仅改文件夹时会把当前团队原样回传，不应 403）。
        // 只有把站点投进一个我无编辑权的新团队才需要拦截。
        var newlyAdded = requested.Where(t => !site.SharedTeamIds.Contains(t)).ToList();
        var forbidden = newlyAdded
            .Where(t => !(roles.TryGetValue(t, out var r)
                          && (r == WebHostingRoles.Owner || r == WebHostingRoles.Editor)))
            .ToList();
        if (forbidden.Count > 0)
            throw new UnauthorizedAccessException("无权将网页分享到部分团队：你在这些团队是只读或非成员角色");
        var sanitized = requested;
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

    public async Task<HostedSite> CopyToTeamAsync(string siteId, string userId, string teamId, string? groupId, CancellationToken ct)
    {
        // 只能复制自己拥有的站点（「复用个人空间的网页」是所有权动作）
        var source = await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (source == null)
            throw new KeyNotFoundException("站点不存在或无权限");

        // 目标团队必须有网页托管编辑权限（与 SetSharedTeamsAsync 同款门控，viewer 不可投放）
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(userId, ct);
        if (!(roles.TryGetValue(teamId, out var role)
              && (role == WebHostingRoles.Owner || role == WebHostingRoles.Editor)))
            throw new UnauthorizedAccessException("无权将网页复制到该团队：你在该团队是只读或非成员角色");

        // 分组归属（可选）：必须是目标团队下的分组，防止跨团队挂靠
        if (!string.IsNullOrWhiteSpace(groupId))
        {
            var group = await _db.WebPageGroups.Find(g => g.Id == groupId && g.TeamId == teamId).FirstOrDefaultAsync(ct);
            if (group == null)
                throw new KeyNotFoundException("目标分组不存在或不属于该团队");
        }

        // 物理复制 COS 文件：副本与原件彻底独立（删除/重传互不影响），
        // 与 SaveSharedSiteAsync 的「引用复用」刻意不同 —— 团队副本的规则与团队内新建站点一致。
        var newSiteId = Guid.NewGuid().ToString("N");
        var now = DateTime.UtcNow;
        var newFiles = new List<HostedSiteFile>();
        long totalSize = 0;
        foreach (var f in source.Files)
        {
            var bytes = await _storage.TryDownloadBytesAsync(f.CosKey, ct);
            if (bytes == null)
            {
                _logger.LogWarning("复制站点 {SiteId} 时源文件缺失，跳过: {CosKey}", siteId, f.CosKey);
                continue;
            }
            var newKey = _storage.BuildSiteKey(newSiteId, f.Path);
            await _storage.UploadToKeyAsync(newKey, bytes, f.MimeType, CancellationToken.None, SiteCacheControl);
            newFiles.Add(new HostedSiteFile { Path = f.Path, CosKey = newKey, Size = bytes.Length, MimeType = f.MimeType });
            totalSize += bytes.Length;
        }
        if (newFiles.Count == 0)
            throw new InvalidOperationException("源站点文件已不可读，无法复制");
        if (!newFiles.Any(f => string.Equals(f.Path, source.EntryFile, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("源站点入口文件缺失，无法复制");

        var copy = new HostedSite
        {
            Id = newSiteId,
            Title = source.Title,
            Description = source.Description,
            SourceType = "team-copy",
            SourceRef = source.Id,
            CosPrefix = $"web-hosting/sites/{newSiteId}/",
            EntryFile = source.EntryFile,
            SiteUrl = AppendVersion(_storage.BuildUrlForKey(_storage.BuildSiteKey(newSiteId, source.EntryFile)), now),
            Files = newFiles,
            TotalSize = totalSize,
            Tags = source.Tags.ToList(),
            CoverImageUrl = source.CoverImageUrl,
            WrappedAssetType = source.WrappedAssetType,
            OwnerUserId = userId,
            SharedTeamIds = new List<string> { teamId },
            GroupId = string.IsNullOrWhiteSpace(groupId) ? null : groupId,
            CreatedAt = now,
            UpdatedAt = now,
            ContentVersion = now,
            SlideNavCompatVersion = source.SlideNavCompatVersion,
        };

        await _db.HostedSites.InsertOneAsync(copy, cancellationToken: ct);
        await _teamActivity.LogForTeamsAsync(
            new List<string> { teamId }, TeamAppKey.WebHosting, userId,
            TeamActivityAction.SiteShared, "site", copy.Id, copy.Title, ct);

        _logger.LogInformation("用户 {UserId} 将站点 {SourceId} 复制进团队 {TeamId} 为新站点 {NewId}（{FileCount} 个文件, {TotalSize} bytes）",
            userId, siteId, teamId, newSiteId, newFiles.Count, totalSize);
        return copy;
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

    public async Task<List<HostedSite>> ListAllByUserIdAsync(string ownerUserId, int limit, CancellationToken ct)
    {
        if (limit <= 0 || limit > 200) limit = 60;
        return await _db.HostedSites
            .Find(x => x.OwnerUserId == ownerUserId)
            .Sort(Builders<HostedSite>.Sort.Descending(x => x.UpdatedAt))
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
        string visibility = "owner-only",
        bool allocateShortLink = false)
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
        // visit 链恒 public；其余按调用方传入的 visibility（已在方法开头 normalize）
        var effVisibility = effPurpose == "visit" ? "public" : normalizedVisibility;

        // forceNew=true（PR 2026-05-28 起，用户在分享面板显式点新建）：跳过复用直接新建。
        // visit 便捷链恒走复用路径（避免每次进入页面都创建一条便捷链污染列表）。
        WebPageShareLink? reusable = null;
        if (!forceNew || effPurpose == "visit")
        {
            var fb = Builders<WebPageShareLink>.Filter;
            var reuseFilter = fb.Eq(x => x.CreatedBy, userId)
                & fb.Eq(x => x.IsRevoked, false)
                & fb.Eq(x => x.AccessLevel, wantAccess)
                // Visibility 必须进 reuse key（PR #685 Bugbot High / Codex P2）：
                // 否则请求 public 却复用到旧的 owner-only 链接，reuse 路径又不更新 Visibility，
                // 导致工作流自动分享(visibility=public)返回 owner-only token → 外部访问 403。
                // 空 Visibility（legacy）按 public 兼容，与 effVisibility=public 时一并匹配。
                & (effVisibility == "public"
                    ? (fb.Eq(x => x.Visibility, "public") | fb.Eq(x => x.Visibility, "") | fb.Eq(x => x.Visibility, (string?)null))
                    : fb.Eq(x => x.Visibility, effVisibility))
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
            // 不再加「{用户} 分享给你的」前缀，直接用站点名/合集名作为标题
            shareTitle = shareType == "collection"
                ? $"{allIds.Count} 个站点合集"
                : (firstSite ?? "站点");
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
            // 复用旧分享时若用户本次显式要数字短链、而旧链还没分配过 seq，则补分配
            // （AllocateAsync 幂等：已有则返回原 seq，不会重复占号）。
            if (allocateShortLink && reuse.Purpose != "visit" && reuse.ShortSeq <= 0)
                await TryAllocateShortSeqAsync(reuse, ct);
            _logger.LogInformation("用户 {UserId} 复用站点分享 {ShareId}, type={Type}",
                userId, reuse.Id, reuse.ShareType);
            return reuse;
        }

        // 新分享：同时写明文（去重 + 展示给分享者）和 Hash/Salt（校验主路径）
        // effVisibility 已在 reuse 块前声明（visit 恒 public，其余按 normalizedVisibility）
        var pwdHash = wantPassword != null ? (SharePasswordHash?)_sharePwd.Hash(wantPassword) : null;
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

        // 数字短链 /s/{seq} 改为「按需懒分配」（2026-06-11）：用户意图里没有短链就不强制
        // 生成，否则 short_links 集合被每条分享污染、管理员页面冒出几百条用户从没要过的短链。
        // 默认创建的分享 ShortSeq=0，对外只用不可枚举的 /s/wp/{token} 长链即可独立访问
        // （ViewShareAsync 直接按 token 查 WebPageShareLink，不依赖 short_links）。
        // 仅当调用方显式 allocateShortLink=true（用户在分享面板主动选「数字短链」或事后点
        // 「生成数字短链」）才分配 seq。
        // visit 便捷链恒不分配：/api/short-links/{seq} 匿名且可枚举，给 visit 链分配 seq
        // 会让攻击者枚举数字即可访问从未被主动分享的私有站点。
        if (effPurpose != "visit" && allocateShortLink)
            await TryAllocateShortSeqAsync(share, ct);

        _logger.LogInformation("用户 {UserId} 创建站点分享 {ShareId}, type={Type}, shortSeq={Seq}",
            userId, share.Id, share.ShareType, share.ShortSeq);

        return share;
    }

    /// <summary>
    /// 为指定分享按需分配统一短链 Seq（/s/{seq}），并回写 ShortSeq。
    /// AllocateAsync 幂等（同一 token 已有则返回原 seq）；失败不抛出，只记日志——
    /// 因为分享主路径不依赖 short_links，用户仍可用 /s/wp/{token} 长链访问。
    /// </summary>
    private async Task TryAllocateShortSeqAsync(WebPageShareLink share, CancellationToken ct)
    {
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
            _logger.LogWarning(ex, "为分享 {ShareId} 分配短链失败，将仅提供长链 /s/wp/{Token}", share.Id, share.Token);
        }
    }

    /// <summary>
    /// 事后为某条已存在的分享分配数字短链（用户在分享面板点「生成数字短链」时调用）。
    /// 返回分配后的 ShortSeq（&gt;0 成功）；找不到 / 无权 / visit 链返回 0 或抛权限异常。
    /// </summary>
    public async Task<long> EnsureShortLinkAsync(string userId, string shareId, CancellationToken ct = default)
    {
        var share = await _db.WebPageShareLinks.Find(x => x.Id == shareId).FirstOrDefaultAsync(ct);
        if (share == null)
            throw new KeyNotFoundException("分享不存在");
        if (share.CreatedBy != userId)
            throw new UnauthorizedAccessException("只能为自己创建的分享生成短链");
        if (share.Purpose == "visit")
            throw new InvalidOperationException("访问便捷链不支持数字短链");
        if (share.ShortSeq > 0)
            return share.ShortSeq; // 已有则幂等返回
        await TryAllocateShortSeqAsync(share, ct);
        return share.ShortSeq;
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
            // 复制成新 list 再 Insert，避免原地 mutate share.SiteIds 污染下游读取（PR #685 Bugbot Low）
            var ownerCheckIds = new List<string>(share.SiteIds ?? new List<string>());
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
    /// 团队内部人判定：登录用户对分享指向的全部站点都具备成员关系
    /// （分享创建者本人 / 站点创建者 / 站点已共享到我所在的团队）。
    /// 合集分享按「全部站点」判定，防止混入他团队站点时被部分成员免密带过。
    /// </summary>
    private async Task<bool> IsTeamInsiderForShareAsync(WebPageShareLink share, string viewerUserId, CancellationToken ct)
    {
        if (share.CreatedBy == viewerUserId) return true;

        var targetIds = new List<string>(share.SiteIds ?? new List<string>());
        if (share.SiteId != null && !targetIds.Contains(share.SiteId))
            targetIds.Insert(0, share.SiteId);
        if (targetIds.Count == 0) return false;

        var sites = await _db.HostedSites.Find(x => targetIds.Contains(x.Id)).ToListAsync(ct);
        if (sites.Count == 0) return false;

        var myTeamIds = await _teams.GetMyTeamIdsAsync(viewerUserId, ct);
        return sites.All(s =>
            s.OwnerUserId == viewerUserId
            || (s.SharedTeamIds ?? new List<string>()).Any(myTeamIds.Contains));
    }

    /// <summary>
    /// 分享访问统一关卡：滑动窗口速率限制 + Hash 优先校验 + 持久化窗口状态。
    /// 返回 null 表示通过；返回 tuple 时调用方应直接 short-circuit 用对应 HttpStatus 回客户端。
    /// 不绑定 IP：容器反代下 IP 不可靠，NAT 局域网下会一锅端 —— 改按 shareLink 全局限速。
    /// 团队成员免密：登录用户若是分享目标站点的团队内部人（IsTeamInsiderForShareAsync），
    /// 视同内部访问直接放行密码门控；外部访客（未登录 / 非成员）仍需密码。
    /// </summary>
    private async Task<(string Error, int HttpStatus, int? RetryAfter)?> EnforceShareAccessAsync(
        WebPageShareLink share, string? password, string? viewerUserId, CancellationToken ct)
    {
        if (share.AccessLevel != "password") return null;

        if (!string.IsNullOrEmpty(viewerUserId) && await IsTeamInsiderForShareAsync(share, viewerUserId, ct))
            return null;

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

        var gate = await EnforceShareAccessAsync(share, password, viewerUserId, ct);
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
            var viewerAvatarFileName = !string.IsNullOrWhiteSpace(viewerUserId)
                ? await LookupAvatarFileNameAsync(viewerUserId, ct)
                : null;

            await _db.ShareViewLogs.InsertOneAsync(new ShareViewLog
            {
                ShareToken = token,
                ShareId = share.Id,
                ViewerUserId = viewerUserId,
                ViewerName = viewerName,
                ViewerAvatarFileName = viewerAvatarFileName,
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
            Title = StripLegacySharePrefix(share.Title),
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
        => IsPdfWrapperSite(site, out var pdf)
            ? AppendVersion(_storage.BuildUrlForKey(pdf!.CosKey), EffectiveContentVersion(site))
            : null;

    // 计算缓存指纹用的内容版本：老文档无 ContentVersion（default）时回退到 CreatedAt
    // （创建后恒定不变）→ 保证 ?v 稳定、缓存命中。禁止回退到 UpdatedAt，那会被
    // 改标题 / 改可见性等元数据操作顶变，导致没改内容却击穿缓存。
    internal static DateTime EffectiveContentVersion(HostedSite site)
        => site.ContentVersion == default ? site.CreatedAt : site.ContentVersion;

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

    /// <summary>
    /// 存量站点回填「幻灯片翻页方向兼容垫片」：把 SlideNavCompatVersion &lt; 当前版本的站点
    /// 的 HTML 文件从 COS 拉回、重新注入当前版垫片、原地覆盖回 COS，并升级版本号。
    /// 让用户上传该功能之前的旧 PPT、以及垫片代码升级后的存量站点都自动获得最新垫片，
    /// 无需用户重新上传。注入保持在隔离的对象存储域名上（不改变 iframe 跨域隔离的安全模型）。
    /// 幂等：内容无变化不重写 COS；处理成功才升级版本号（下载瞬时失败则保持旧版下次重试）。
    /// saved-share 引用副本只升级版本号、不重写其指向原站的 COS key / SiteUrl（由原站回填覆盖）。
    /// </summary>
    public async Task<int> BackfillSlideNavCompatAsync(CancellationToken ct = default)
    {
        var fb = Builders<HostedSite>.Filter;
        // 版本 < 当前的站点要升级；外加字段缺失的存量文档（$lt 不匹配缺失字段，需 Exists(false) 兜住）
        var filter = fb.Or(
            fb.Lt(x => x.SlideNavCompatVersion, SlideNavVersion),
            fb.Exists(x => x.SlideNavCompatVersion, false));

        var candidates = await _db.HostedSites.Find(filter).ToListAsync(ct);

        // 先处理原站(非 saved-share)、后处理引用副本：保证副本刷新 ?v= 时共享 COS 对象已是当前版，
        // 避免「副本先于原站被刷新 → 客户端/CDN 在窗口内把旧字节缓存到新版本号下，而原站后续重写
        // 不会再 bump 已标记当前版的副本」这一竞态（Codex P2 反馈）。
        candidates = candidates
            .OrderBy(s => string.Equals(s.SourceType, "saved-share", StringComparison.OrdinalIgnoreCase) ? 1 : 0)
            .ToList();
        var injectedSites = 0;

        foreach (var site in candidates)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                // saved-share 是引用副本：Files/SiteUrl/EntryFile 全部照搬原站（CosKey 指向 {originalId}），
                // 自身 Id 是新 GUID。绝不下载后回写 COS（避免跨租户写 + 按 savedId 重建 404）——共享对象由原站回填升级。
                // 这里只在「读取共享对象、确认它确实已含当前版 shim」之后，才给副本刷 ?v= + 标版本：检验地面真值
                // （直接比对对象字节），而非靠版本号 / 处理顺序推断。这样对任意回填顺序、原站 deferred / 下载失败都正确，
                // 杜绝「副本被提前标当前版后再不刷新」的整类竞态；确认不了就 defer（不标版本），下次启动重试。
                if (string.Equals(site.SourceType, "saved-share", StringComparison.OrdinalIgnoreCase))
                {
                    var savedEntryKey = (site.Files ?? new List<HostedSiteFile>())
                        .FirstOrDefault(f => !string.IsNullOrEmpty(f.CosKey) &&
                            string.Equals(f.Path, site.EntryFile, StringComparison.OrdinalIgnoreCase))?.CosKey;
                    if (string.IsNullOrEmpty(savedEntryKey))
                    {
                        // 无 HTML 入口（纯 PDF/图片副本），无 shim 可享 → 直接标版本防重复扫描
                        await _db.HostedSites.UpdateOneAsync(x => x.Id == site.Id,
                            Builders<HostedSite>.Update.Set(x => x.SlideNavCompatVersion, SlideNavVersion),
                            cancellationToken: ct);
                        continue;
                    }
                    var sharedBytes = await _storage.TryDownloadBytesAsync(savedEntryKey, ct);
                    if (sharedBytes == null || sharedBytes.Length == 0)
                        continue; // 读不到共享对象（瞬时失败 / 原站未就绪）→ defer，保旧版本下次重试
                    var reinjected = InjectSlideNavCompat(sharedBytes);
                    if (reinjected.Length != sharedBytes.Length || !reinjected.SequenceEqual(sharedBytes))
                        continue; // 共享对象尚未被原站升级到当前版 → defer，等原站先升级，下次再刷副本
                    // 已确认共享对象含当前版 shim → 安全刷 ?v= 击穿缓存 + 标版本。URL 取入口真实 CosKey（指向原站对象），
                    // 不动 UpdatedAt 以免被动回填重排用户收藏列表。
                    var savedNow = DateTime.UtcNow;
                    await _db.HostedSites.UpdateOneAsync(x => x.Id == site.Id,
                        Builders<HostedSite>.Update
                            .Set(x => x.SlideNavCompatVersion, SlideNavVersion)
                            .Set(x => x.SiteUrl, AppendVersion(_storage.BuildUrlForKey(savedEntryKey), savedNow))
                            .Set(x => x.ContentVersion, savedNow),
                        cancellationToken: ct);
                    continue;
                }

                var htmlFiles = (site.Files ?? new List<HostedSiteFile>())
                    .Where(f => !string.IsNullOrEmpty(f.CosKey) &&
                                string.Equals(f.MimeType, "text/html", StringComparison.OrdinalIgnoreCase))
                    .ToList();

                var anyChanged = false;
                var deferred = false;          // 有 HTML 下载失败/为空（可能瞬时）→ 本轮不升级版本，下次启动重试
                HostedSiteFile? entryHtml = null;
                foreach (var f in htmlFiles)
                {
                    var bytes = await _storage.TryDownloadBytesAsync(f.CosKey, ct);
                    if (bytes == null || bytes.Length == 0) { deferred = true; continue; }
                    if (string.Equals(f.Path, site.EntryFile, StringComparison.OrdinalIgnoreCase))
                        entryHtml = f;
                    var injected = InjectSlideNavCompat(bytes);
                    if (injected.Length == bytes.Length && injected.SequenceEqual(bytes))
                        continue; // 已是当前版垫片，无需重写
                    await _storage.UploadToKeyAsync(f.CosKey, injected, "text/html; charset=utf-8",
                        CancellationToken.None, SiteCacheControl);
                    anyChanged = true;
                }

                // 下载存在失败：保持旧版本号，下次启动重试，避免把「未真正处理」的站点永久排除在回填之外
                if (deferred) continue;

                // 升级版本号；内容有变则同时 bump ContentVersion + SiteUrl（?v 击穿 CDN/浏览器缓存）
                var now = DateTime.UtcNow;
                var update = Builders<HostedSite>.Update.Set(x => x.SlideNavCompatVersion, SlideNavVersion);
                if (anyChanged)
                {
                    // URL 一律取入口 HTML 的真实 CosKey 构造，绝不依据 site.Id 推断 key（saved-share 上面已 return）
                    var entryKey = entryHtml?.CosKey
                        ?? (string.IsNullOrEmpty(site.EntryFile) ? null : _storage.BuildSiteKey(site.Id, site.EntryFile));
                    if (!string.IsNullOrEmpty(entryKey))
                    {
                        var newUrl = AppendVersion(_storage.BuildUrlForKey(entryKey), now);
                        update = update.Set(x => x.SiteUrl, newUrl)
                                       .Set(x => x.ContentVersion, now)
                                       .Set(x => x.UpdatedAt, now);
                    }
                    injectedSites++;
                }
                await _db.HostedSites.UpdateOneAsync(x => x.Id == site.Id, update, cancellationToken: ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "翻页垫片回填失败: site={SiteId}", site.Id);
            }
        }

        if (injectedSites > 0 || candidates.Count > 0)
        {
            _logger.LogInformation("翻页垫片回填完成: candidates={Candidates} injectedSites={Injected} version={Version}",
                candidates.Count, injectedSites, SlideNavVersion);
        }
        return injectedSites;
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
        var now = DateTime.UtcNow;
        var rangeStart = now.Date.AddDays(-(rangeDays - 1));

        // 全量 shares（含已过期、不含 visit 链）
        var fbLink = Builders<WebPageShareLink>.Filter;
        var siteScopedFilter = string.IsNullOrEmpty(siteId)
            ? fbLink.Empty
            : (fbLink.Eq(x => x.SiteId, siteId) | fbLink.AnyEq(x => x.SiteIds, siteId));
        var allShares = await _db.WebPageShareLinks
            .Find(fbLink.Eq(x => x.CreatedBy, userId) & fbLink.Ne(x => x.Purpose, "visit") & siteScopedFilter)
            .ToListAsync(ct);

        var totalShares = allShares.Count;
        var activeShares = allShares.Count(s => !s.IsRevoked && (!s.ExpiresAt.HasValue || s.ExpiresAt.Value > now));
        var expiredShares = allShares.Count(s => s.ExpiresAt.HasValue && s.ExpiresAt.Value <= now);

        var tokens = allShares.Select(s => s.Token).ToList();
        var shareSiteIds = string.IsNullOrWhiteSpace(siteId)
            ? allShares
                .SelectMany(s =>
                {
                    var ids = s.SiteIds.Count > 0 ? s.SiteIds : new List<string>();
                    if (!string.IsNullOrWhiteSpace(s.SiteId) && !ids.Contains(s.SiteId)) ids.Insert(0, s.SiteId);
                    return ids;
                })
                .Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct()
                .ToList()
            : new List<string> { siteId };
        var fbLog = Builders<ShareViewLog>.Filter;
        var logFilter = tokens.Count == 0
            ? fbLog.Eq(x => x.ShareToken, "__none__")
            : fbLog.In(x => x.ShareToken, tokens) & fbLog.Gte(x => x.ViewedAt, rangeStart);
        var windowLogs = tokens.Count == 0
            ? new List<ShareViewLog>()
            : await _db.ShareViewLogs
                .Find(logFilter)
                .SortByDescending(x => x.ViewedAt)
                .Limit(5000)
                .ToListAsync(ct);
        var recentLogs = windowLogs.Take(500).ToList();

        var tokenViewStats = tokens.Count == 0
            ? new List<ShareTokenViewAggregate>()
            : await _db.ShareViewLogs.Aggregate()
                .Match(logFilter)
                .Group(l => l.ShareToken, g => new ShareTokenViewAggregate
                {
                    Token = g.Key,
                    ViewCount = g.Count(),
                    LastViewedAt = g.Max(x => x.ViewedAt),
                })
                .ToListAsync(ct);
        var totalViews = tokenViewStats.Sum(s => s.ViewCount);
        var uniqueVisitors = windowLogs
            .Select(ViewerDedupeKey)
            .Where(k => !string.IsNullOrWhiteSpace(k))
            .Distinct()
            .Count();

        var viewerUserIds = windowLogs
            .Select(l => l.ViewerUserId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id!)
            .Distinct()
            .ToList();
        var viewerUsers = viewerUserIds.Count == 0
            ? new List<User>()
            : await _db.Users.Find(Builders<User>.Filter.In(u => u.UserId, viewerUserIds))
                .Project(Builders<User>.Projection.Expression(u => new User
                {
                    UserId = u.UserId,
                    Username = u.Username,
                    DisplayName = u.DisplayName,
                    AvatarFileName = u.AvatarFileName,
                }))
                .ToListAsync(ct);
        var viewerMap = viewerUsers.ToDictionary(u => u.UserId, u => u);

        // 时间线（脱敏 IP：前两段保留，后两段打码，避免泄露给非 admin；UI 不再把 IP 作为主指标）
        var shareByToken = allShares.ToDictionary(s => s.Token, s => s);
        var timeline = recentLogs.Take(100).Select(l => new ShareAnalyticsTimelineEntry
        {
            ViewedAt = l.ViewedAt,
            ShareToken = l.ShareToken,
            ShareTitle = StripLegacySharePrefix(shareByToken.TryGetValue(l.ShareToken, out var s) ? s.Title : null),
            ShareUrl = shareByToken.TryGetValue(l.ShareToken, out var s2) ? BuildSharePreviewPath(s2) : $"/s/wp/{l.ShareToken}",
            ViewerUserId = l.ViewerUserId,
            ViewerName = ResolveViewerName(l, viewerMap),
            ViewerAvatarFileName = ResolveViewerAvatar(l, viewerMap),
            IpAddress = MaskIp(l.IpAddress),
            UserAgent = l.UserAgent,
            ClientSummary = BuildClientSummary(l.UserAgent, l.IpAddress),
        }).ToList();

        var visitorsByToken = windowLogs
            .GroupBy(l => l.ShareToken)
            .ToDictionary(
                g => g.Key,
                g => g.GroupBy(ViewerDedupeKey)
                    .Select(vg =>
                    {
                        var latest = vg.OrderByDescending(x => x.ViewedAt).First();
                        return new ShareAnalyticsVisitorSummary
                        {
                            ViewerUserId = latest.ViewerUserId,
                            ViewerName = ResolveViewerName(latest, viewerMap),
                            ViewerAvatarFileName = ResolveViewerAvatar(latest, viewerMap),
                            ViewCount = vg.LongCount(),
                        };
                    })
                    .OrderByDescending(v => v.ViewCount)
                    .ThenBy(v => v.ViewerName == "匿名访客" ? 1 : 0)
                    .Take(5)
                    .ToList());
        var visitorCountsByToken = windowLogs
            .GroupBy(l => l.ShareToken)
            .ToDictionary(g => g.Key, g => g.Select(ViewerDedupeKey).Distinct().LongCount());
        var viewCountsByToken = tokenViewStats.ToDictionary(s => s.Token, s => s.ViewCount);
        var lastViewedAtByToken = tokenViewStats.ToDictionary(s => s.Token, s => s.LastViewedAt);

        var siteTitleMap = shareSiteIds.Count == 0
            ? new Dictionary<string, string>()
            : (await _db.HostedSites.Find(Builders<HostedSite>.Filter.In(s => s.Id, shareSiteIds))
                .Project(Builders<HostedSite>.Projection.Expression(s => new HostedSite
                {
                    Id = s.Id,
                    Title = s.Title,
                }))
                .ToListAsync(ct))
                .ToDictionary(s => s.Id, s => s.Title);

        var comments = shareSiteIds.Count == 0
            ? new List<HostedSiteComment>()
            : await _db.HostedSiteComments
                .Find(Builders<HostedSiteComment>.Filter.In(c => c.SiteId, shareSiteIds)
                    & Builders<HostedSiteComment>.Filter.Eq(c => c.IsDeleted, false)
                    & Builders<HostedSiteComment>.Filter.Gte(c => c.CreatedAt, rangeStart))
                .SortByDescending(c => c.CreatedAt)
                .ToListAsync(ct);

        var trend = new List<ShareAnalyticsTrendPoint>();
        for (var offset = 0; offset < rangeDays; offset++)
        {
            var date = rangeStart.Date.AddDays(offset);
            var nextDate = date.AddDays(1);
            var key = date.ToString("yyyy-MM-dd");
            var views = tokens.Count == 0
                ? 0
                : await _db.ShareViewLogs.CountDocumentsAsync(
                    logFilter & fbLog.Gte(x => x.ViewedAt, date) & fbLog.Lt(x => x.ViewedAt, nextDate),
                    cancellationToken: ct);
            trend.Add(new ShareAnalyticsTrendPoint
            {
                Date = key,
                Views = views,
                Comments = comments.LongCount(c => c.CreatedAt >= date && c.CreatedAt < nextDate),
            });
        }

        var hourly = Enumerable.Range(0, 24)
            .Select(hour => new ShareAnalyticsHourlyPoint
            {
                Hour = hour,
                Views = windowLogs.LongCount(l => l.ViewedAt.Hour == hour),
            })
            .ToList();

        var topVisitors = windowLogs
            .GroupBy(ViewerDedupeKey)
            .Select(g =>
            {
                var latest = g.OrderByDescending(x => x.ViewedAt).First();
                return new ShareAnalyticsVisitorStats
                {
                    ViewerUserId = latest.ViewerUserId,
                    ViewerName = ResolveViewerName(latest, viewerMap),
                    ViewerAvatarFileName = ResolveViewerAvatar(latest, viewerMap),
                    ViewCount = g.LongCount(),
                    LastViewedAt = latest.ViewedAt,
                };
            })
            .OrderByDescending(v => v.ViewCount)
            .ThenByDescending(v => v.LastViewedAt)
            .Take(8)
            .ToList();

        var recentComments = comments.Take(20).Select(c => new ShareAnalyticsCommentEntry
        {
            Id = c.Id,
            SiteId = c.SiteId,
            SiteTitle = siteTitleMap.TryGetValue(c.SiteId, out var title) ? title : "网页",
            ShareToken = c.ShareToken,
            AuthorName = c.AuthorName,
            AuthorAvatarFileName = c.AuthorAvatarFileName,
            Content = TruncateComment(c.Content),
            CreatedAt = c.CreatedAt,
        }).ToList();

        // Top 链接（按当前时间窗 PV 排序，最多 10 条）
        var topLinks = allShares
            .Where(s => !s.IsRevoked)
            .OrderByDescending(s => viewCountsByToken.TryGetValue(s.Token, out var viewCount) ? viewCount : 0)
            .ThenByDescending(s => lastViewedAtByToken.TryGetValue(s.Token, out var lastViewedAt) ? lastViewedAt : DateTime.MinValue)
            .Take(10)
            .Select(s => new ShareAnalyticsLinkSummary
            {
                ShareId = s.Id,
                Token = s.Token,
                Title = StripLegacySharePrefix(s.Title),
                ShareUrl = BuildSharePreviewPath(s),
                ViewCount = viewCountsByToken.TryGetValue(s.Token, out var viewCount) ? viewCount : 0,
                UniqueIpCount = visitorCountsByToken.TryGetValue(s.Token, out var visitorCount) ? visitorCount : 0,
                LastViewedAt = lastViewedAtByToken.TryGetValue(s.Token, out var lastViewedAt) ? lastViewedAt : null,
                CreatedAt = s.CreatedAt,
                ExpiresAt = s.ExpiresAt,
                Visibility = s.Visibility ?? "owner-only",
                Visitors = visitorsByToken.TryGetValue(s.Token, out var visitors) ? visitors : new List<ShareAnalyticsVisitorSummary>(),
            })
            .ToList();

        return new ShareAnalyticsResult
        {
            TotalShares = totalShares,
            ActiveShares = activeShares,
            ExpiredShares = expiredShares,
            TotalViews = totalViews,
            UniqueIpCount = uniqueVisitors,
            CommentCount = comments.Count,
            Timeline = timeline,
            TopLinks = topLinks,
            Trend = trend,
            Hourly = hourly,
            TopVisitors = topVisitors,
            RecentComments = recentComments,
        };
    }

    /// <summary>
    /// 简单 IP 脱敏：v4 保留前两段 (a.b.*.*)，v6 截断为前 3 段。仅用于面向所有者的统计 UI。
    /// </summary>
    private static string? MaskIp(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip)) return ip;
        // 历史数据可能存了 IPv4-mapped IPv6（::ffff:1.2.3.4），先规整回点分十进制再脱敏
        if (ip.StartsWith("::ffff:", StringComparison.OrdinalIgnoreCase) && ip.Contains('.'))
            ip = ip["::ffff:".Length..];
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

    // 历史遗留：旧分享链接的 Title 里 baked 了「{用户} 分享给你的「站点名」」/「… N 个站点合集」前缀。
    // 新链接已不再写入前缀；此处在展示侧剥掉旧前缀，老数据无需迁移即可干净显示。
    //
    // 只匹配后端当年生成的「精确两种形状」，避免误伤用户自定义标题：
    //   单站点： {名字} 分享给你的「{站点名}」  → 返回 站点名
    //   合集：   {名字} 分享给你的 {N} 个站点合集 → 返回 N 个站点合集
    // 形如「客户 分享给你的方案」这种普通标题（无「」、非合集格式）一律原样保留，不剥离。
    private static readonly Regex LegacySingleSharePrefix =
        new(@"^.+? 分享给你的「(?<t>.+)」$", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex LegacyCollectionSharePrefix =
        new(@"^.+? 分享给你的 (?<c>\d+ 个站点合集)$", RegexOptions.Compiled);

    private static string? StripLegacySharePrefix(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return title;
        var single = LegacySingleSharePrefix.Match(title);
        if (single.Success) return single.Groups["t"].Value;
        var collection = LegacyCollectionSharePrefix.Match(title);
        if (collection.Success) return collection.Groups["c"].Value;
        return title;
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

    private async Task<string?> LookupAvatarFileNameAsync(string userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(userId)) return null;
        var avatar = await _db.Users.Find(x => x.UserId == userId)
            .Project(Builders<User>.Projection.Expression(u => u.AvatarFileName))
            .FirstOrDefaultAsync(ct);
        return string.IsNullOrWhiteSpace(avatar) ? null : avatar;
    }

    private static string BuildSharePreviewPath(WebPageShareLink share)
        => share.ShortSeq > 0 ? $"/s/{share.ShortSeq}" : $"/s/wp/{share.Token}";

    private static string ViewerDedupeKey(ShareViewLog log)
    {
        if (!string.IsNullOrWhiteSpace(log.ViewerUserId))
            return $"u:{log.ViewerUserId}";
        if (!string.IsNullOrWhiteSpace(log.IpAddress))
            return $"ip:{log.IpAddress}";
        if (!string.IsNullOrWhiteSpace(log.UserAgent))
            return $"ua:{log.UserAgent}";
        return "anonymous";
    }

    private static string ResolveViewerName(ShareViewLog log, IReadOnlyDictionary<string, User> viewerMap)
    {
        if (!string.IsNullOrWhiteSpace(log.ViewerUserId) && viewerMap.TryGetValue(log.ViewerUserId, out var user))
        {
            if (!string.IsNullOrWhiteSpace(user.DisplayName)) return user.DisplayName;
            if (!string.IsNullOrWhiteSpace(user.Username)) return user.Username;
        }
        if (!string.IsNullOrWhiteSpace(log.ViewerName)) return log.ViewerName;
        return "匿名访客";
    }

    private static string? ResolveViewerAvatar(ShareViewLog log, IReadOnlyDictionary<string, User> viewerMap)
    {
        if (!string.IsNullOrWhiteSpace(log.ViewerUserId)
            && viewerMap.TryGetValue(log.ViewerUserId, out var user)
            && !string.IsNullOrWhiteSpace(user.AvatarFileName))
            return user.AvatarFileName;
        return string.IsNullOrWhiteSpace(log.ViewerAvatarFileName) ? null : log.ViewerAvatarFileName;
    }

    private static string BuildClientSummary(string? userAgent, string? ipAddress)
    {
        var parts = new List<string>();
        var ua = userAgent ?? string.Empty;
        if (ua.Contains("Mobile", StringComparison.OrdinalIgnoreCase) ||
            ua.Contains("Android", StringComparison.OrdinalIgnoreCase) ||
            ua.Contains("iPhone", StringComparison.OrdinalIgnoreCase))
            parts.Add("移动端");
        else if (!string.IsNullOrWhiteSpace(ua))
            parts.Add("桌面端");

        var browser =
            ua.Contains("Edg/", StringComparison.OrdinalIgnoreCase) ? "Edge" :
            ua.Contains("Chrome/", StringComparison.OrdinalIgnoreCase) ? "Chrome" :
            ua.Contains("Safari/", StringComparison.OrdinalIgnoreCase) ? "Safari" :
            ua.Contains("Firefox/", StringComparison.OrdinalIgnoreCase) ? "Firefox" :
            null;
        if (browser != null) parts.Add(browser);

        var maskedIp = MaskIp(ipAddress);
        if (!string.IsNullOrWhiteSpace(maskedIp)) parts.Add(maskedIp);
        return parts.Count == 0 ? "未知来源" : string.Join(" · ", parts);
    }

    private static string TruncateComment(string? content)
    {
        var text = (content ?? string.Empty).Trim();
        return text.Length <= 80 ? text : text[..80] + "…";
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

        var gate = await EnforceShareAccessAsync(share, password, userId, ct);
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
                // 复用原站 COS 文件，内容版本也照搬，保证 pdfAssetUrl 的 ?v 与原站一致（缓存命中）
                ContentVersion = original.ContentVersion,
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

        if (archive.Entries.Count > MaxZipFileCount)
        {
            plan.Error = $"ZIP 包含的文件数超过限制 ({MaxZipFileCount})";
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
                    entryBytes = InjectSlideNavCompat(RewriteAbsolutePathsInHtml(entryBytes, relativePath));

                var cosKey = _storage.BuildSiteKey(siteId, relativePath);
                await _storage.UploadToKeyAsync(cosKey, entryBytes,
                    mimeType == "text/html" ? "text/html; charset=utf-8" : mimeType, CancellationToken.None, SiteCacheControl);

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

    // ─────────────────────────────────────────────
    // 幻灯片翻页方向兼容垫片
    // ─────────────────────────────────────────────

    // 垫片版本号：垫片脚本逻辑每次实质修改都要 +1。上传时把站点 SlideNavCompatVersion
    // 标为此值；startup backfill 把 < 此值的存量站点重新注入升级（无需用户重传）。
    // v1：框架感知 + 合成左右键兜底（对忽略 isTrusted 的自定义 deck 无效）
    // v2：改「可靠驱动优先」，新增任意带 next()/prev() 的自定义元素（如 deck-stage）直驱
    // v3：分档 + 透明可控 —— 高可信自动开（角落提示条可关）、低可信(.slide≥2)仅邀请不劫持
    // v4：一律邀请式 —— 任何情况都不自动劫持键盘，必须用户点角落「开启」才生效（会话内记住）
    // v5：幻灯片判定后主动聚焦页面主体，避免新窗口/iframe 预览必须先点内容区才接收快捷键。
    // v6：所有托管 HTML 都在加载后尝试聚焦内部文档；幻灯片判断只决定是否启用翻页兼容 UI。
    private const int SlideNavVersion = 6;

    // 注入块起始标记。注入块形如 {marker}<script>...</script>，剥离时从 marker 找到其后
    // 第一个 </script> 一并删除，因此升级垫片版本时旧块会被整体替换而非被「幂等跳过」。
    private const string SlideNavMarker = "<!--map-slide-nav-compat-->";

    /// <summary>
    /// 给幻灯片类 HTML 注入翻页方向兼容垫片，让只认左右方向键的 PPT 导出页也能用
    /// 上下方向键 / 空格 / PageUp-Down / 滚轮 / 触摸滑动翻页（反之亦然）。
    ///
    /// 设计要点：
    /// - 跨域 iframe 无法从父页面拦截键盘，垫片必须随内容下发、在 iframe 内部运行。
    /// - 保守接管：运行时判定是幻灯片（reveal/Swiper/impress/slidev、带 next-prev 的自定义元素、
    ///   .slide ≥2、scroll-snap）才接管，普通滚动网页不碰。
    /// - 可靠驱动优先：调 deck 自身导航 API（规避合成事件 isTrusted=false 被忽略）。
    /// - 升级安全：先剥离任何旧版本注入块（从 marker 到其后第一个 &lt;/script&gt;），再插入当前版本，
    ///   因此垫片代码升级后重跑会把旧块换成新块，而不是被旧 marker 幂等跳过。
    /// - 上传路径即时注入；startup backfill 对存量站点补注入（HostedSiteBackfillService）。
    /// </summary>
    private static byte[] InjectSlideNavCompat(byte[] htmlBytes)
    {
        var html = System.Text.Encoding.UTF8.GetString(htmlBytes);

        // 没有任何 HTML 结构信号（既无 </body> 也无 </html> 也无 <html）的内容不处理，
        // 避免把脚本塞进纯文本/JSON 等被误判为 text/html 的文件。
        if (html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase) < 0 &&
            html.LastIndexOf("</html>", StringComparison.OrdinalIgnoreCase) < 0 &&
            html.IndexOf("<html", StringComparison.OrdinalIgnoreCase) < 0)
            return htmlBytes;

        // 1) 剥离已有注入块（任何旧版本）：从 marker 到其后第一个 </script>
        var start = html.IndexOf(SlideNavMarker, StringComparison.Ordinal);
        if (start >= 0)
        {
            var close = html.IndexOf("</script>", start, StringComparison.OrdinalIgnoreCase);
            html = close >= 0
                ? html.Remove(start, (close + "</script>".Length) - start)
                : html.Remove(start, SlideNavMarker.Length); // 只有裸 marker 没脚本，删掉 marker
        }

        // 2) 插入当前版本注入块（剥离后重新定位锚点）
        var bodyIdx = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        var htmlIdx = html.LastIndexOf("</html>", StringComparison.OrdinalIgnoreCase);
        string injected = bodyIdx >= 0
            ? html[..bodyIdx] + SlideNavCompatScript + html[bodyIdx..]
            : (htmlIdx >= 0 ? html[..htmlIdx] + SlideNavCompatScript + html[htmlIdx..]
                            : html + SlideNavCompatScript);

        return System.Text.Encoding.UTF8.GetBytes(injected);
    }

    // 注入的运行时脚本：自包含 IIFE，全部用单引号避免 C# verbatim 字符串的双引号转义。
    private const string SlideNavCompatScript = SlideNavMarker + @"<script>
(function(){
  if (window.__mapSlideNavCompat) return;
  window.__mapSlideNavCompat = true;
  var SNAP_AXIS = null, scroller = null, driver = null;
  var navOn = false, decided = false, pill = null;
  // 记住用户对「本 deck」的选择（on/off）。用 sessionStorage（随标签页关闭清空，符合 no-localStorage 约定）
  var KEY = 'mapSlideNav:' + (location.pathname || '');
  function getPref(){ try { return sessionStorage.getItem(KEY); } catch(e){ return null; } }
  function setPref(v){ try { sessionStorage.setItem(KEY, v); } catch(e){} }
  function gcs(el, p){ try { return getComputedStyle(el)[p] || ''; } catch(e){ return ''; } }
  function findSnapScroller(){
    var cands = [document.scrollingElement, document.documentElement, document.body];
    var main = document.querySelector('.slides, .reveal .slides, .swiper-wrapper, [class*=slides], main, #app');
    if (main) cands.push(main);
    for (var i=0;i<cands.length;i++){
      var el = cands[i]; if (!el) continue;
      var st = gcs(el, 'scrollSnapType') || gcs(el, 'scroll-snap-type');
      if (st && /mandatory|proximity/.test(st)){
        scroller = el;
        SNAP_AXIS = /(^|\s)x(\s|$)|inline/.test(st) ? 'x' : ((/(^|\s)y(\s|$)|block/.test(st)) ? 'y' : null);
        return true;
      }
    }
    return false;
  }
  function snap(dir){
    if (!scroller) return;
    if ((SNAP_AXIS||'y') === 'x') scroller.scrollBy({ left: dir*scroller.clientWidth, behavior:'smooth' });
    else scroller.scrollBy({ top: dir*scroller.clientHeight, behavior:'smooth' });
  }
  // 自定义元素（标签含 '-'）且同时暴露 next()/prev() 方法 —— 覆盖 web component 类 deck
  function findDeckElement(){
    var all = document.getElementsByTagName('*');
    for (var i=0;i<all.length;i++){
      var el = all[i];
      if (el.tagName.indexOf('-') > 0 && typeof el.next === 'function' && typeof el.prev === 'function') return el;
    }
    return null;
  }
  // 「可靠驱动」= 高可信信号：直接调 deck 自身导航 API（规避合成事件 isTrusted=false 被忽略）
  function resolveDriver(){
    try {
      if (window.Reveal && typeof window.Reveal.next === 'function')
        return { next: function(){ window.Reveal.next(); }, prev: function(){ window.Reveal.prev(); } };
      var sw = document.querySelector('.swiper, .swiper-container');
      if (sw && sw.swiper)
        return { next: function(){ sw.swiper.slideNext(); }, prev: function(){ sw.swiper.slidePrev(); } };
      if (window.impress){ var im = window.impress(); if (im) return { next: function(){ im.next(); }, prev: function(){ im.prev(); } }; }
      var deck = findDeckElement();
      if (deck) return { next: function(){ deck.next(); }, prev: function(){ deck.prev(); } };
      if (findSnapScroller()) return { next: function(){ snap(1); }, prev: function(){ snap(-1); } };
    } catch(e){}
    return null;
  }
  // 低可信信号：仅靠 .slide 类元素 ≥2（最易误判，故只用于「邀请」不自动劫持）
  function looseSlides(){
    return document.querySelectorAll('.swiper-slide, .reveal .slides > section, section.slide, .slide, [data-slide], .step, .slidev-page').length >= 2;
  }
  var SYN = '__mapSyn';
  function synthArrow(dir){
    var ev = new KeyboardEvent('keydown', { key: dir>0?'ArrowRight':'ArrowLeft', code: dir>0?'ArrowRight':'ArrowLeft', keyCode: dir>0?39:37, which: dir>0?39:37, bubbles:true, cancelable:true });
    ev[SYN] = true;
    (document.activeElement || document.body || document).dispatchEvent(ev);
  }
  function inEditable(t){ return !!(t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)); }
  function focusDeck(){
    try {
      if (inEditable(document.activeElement)) return;
      var t = document.body || document.documentElement;
      if (!t) return;
      if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
      if (typeof t.focus === 'function') t.focus({ preventScroll:true });
      if (typeof window.focus === 'function') window.focus();
    } catch(e){}
  }
  function bootFocus(){
    focusDeck();
    setTimeout(focusDeck, 80);
    setTimeout(focusDeck, 240);
  }
  function onKey(e){
    if (e[SYN] || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (inEditable(e.target)) return;
    var k = e.key;
    var isVert = (k === 'ArrowDown' || k === 'ArrowUp');
    var isSpace = (k === ' ' || k === 'Spacebar');
    var dir = (k === 'ArrowDown' || k === 'PageDown' || (isSpace && !e.shiftKey)) ? 1
            : ((k === 'ArrowUp' || k === 'PageUp' || (isSpace && e.shiftKey)) ? -1 : 0);
    if (!dir) return; // 左右键交给页面原生处理
    if (!driver) driver = resolveDriver();
    if (driver){ dir>0 ? driver.next() : driver.prev(); e.preventDefault(); e.stopPropagation(); return; }
    if (isVert) synthArrow(dir); // 无可靠驱动：仅上下键尽力合成，不抑制原生
  }
  var wheelLock = 0;
  function onWheel(e){
    if (!(scroller && SNAP_AXIS === 'x')) return;
    if (Date.now() < wheelLock) return;
    var dy = e.deltaY||0, dx = e.deltaX||0;
    if (Math.abs(dy) <= Math.abs(dx) || dy === 0) return;
    snap(dy > 0 ? 1 : -1); e.preventDefault(); wheelLock = Date.now() + 600;
  }
  var tsx=0, tsy=0;
  function onTouchStart(e){ var t=e.touches&&e.touches[0]; if (t){ tsx=t.clientX; tsy=t.clientY; } }
  function onTouchEnd(e){
    if (!(scroller && SNAP_AXIS === 'x')) return;
    var t = e.changedTouches && e.changedTouches[0]; if (!t) return;
    var dx = t.clientX - tsx, dy = t.clientY - tsy;
    if (Math.abs(dy) < 40 || Math.abs(dy) < Math.abs(dx)) return;
    snap(dy < 0 ? 1 : -1);
  }
  function bindNav(){
    if (navOn) return; navOn = true;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, { passive:false, capture:true });
    window.addEventListener('touchstart', onTouchStart, { passive:true });
    window.addEventListener('touchend', onTouchEnd, { passive:true });
  }
  function unbindNav(){
    if (!navOn) return; navOn = false;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchend', onTouchEnd);
  }
  // ── 角落提示条（透明可控）：on=已开启可关，off=邀请开启 ──
  function mk(tag, css, txt){ var e=document.createElement(tag); if(css)e.setAttribute('style',css); if(txt!=null)e.textContent=txt; return e; }
  function removePill(){ if (pill && pill.parentNode) pill.parentNode.removeChild(pill); pill=null; }
  function renderPill(on){
    removePill();
    var box = mk('div', 'position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;font:500 12px/1.4 -apple-system,system-ui,sans-serif;background:rgba(20,20,28,0.74);color:#fff;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:1;transition:opacity .4s;user-select:none;');
    box.appendChild(mk('span', 'width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:'+(on?'#34d399':'#9ca3af')+';'));
    box.appendChild(mk('span', 'white-space:nowrap;', on ? '上下键翻页 已开启' : '幻灯片：上下键翻页?'));
    var btn = mk('button', 'border:none;border-radius:6px;padding:3px 8px;font:inherit;cursor:pointer;white-space:nowrap;background:'+(on?'rgba(255,255,255,.16)':'rgba(52,211,153,.92)')+';color:'+(on?'#fff':'#06281d')+';', on ? '关闭' : '开启');
    btn.addEventListener('click', function(ev){ ev.stopPropagation(); ev.preventDefault(); if (on) disable(true); else enable(true); });
    box.appendChild(btn);
    (document.documentElement || document.body).appendChild(box);
    pill = box;
    setTimeout(function(){ if (pill === box) box.style.opacity = '0.32'; }, 4500);
    box.addEventListener('mouseenter', function(){ box.style.opacity = '1'; });
    box.addEventListener('mouseleave', function(){ box.style.opacity = '0.32'; });
  }
  function enable(remember){ if (!driver) driver = resolveDriver(); bindNav(); if (remember) setPref('on'); renderPill(true); }
  function disable(remember){ unbindNav(); if (remember) setPref('off'); renderPill(false); }
  // 决策：一律邀请式 —— 无论高/低可信都不自动劫持键盘，只弹角落邀请条，用户主动点「开启」才绑定。
  // 仅当用户本会话已对同一 deck 点过「开启」（sessionStorage='on'）才自动开。非幻灯片：什么都不做。
  function decide(){
    if (decided) return;
    driver = resolveDriver();
    if (!driver && !looseSlides()) return; // 还不像幻灯片：暂不决策，等异步 upgrade 后重试
    decided = true;
    if (getPref() === 'on') enable(false); // 本会话已主动开过 → 直接开
    else renderPill(false);                // 默认仅邀请，绝不自动劫持键盘
  }
  if (document.readyState !== 'loading') { bootFocus(); decide(); }
  document.addEventListener('DOMContentLoaded', function(){ bootFocus(); decide(); });
  window.addEventListener('load', function(){ bootFocus(); decide(); });
  // 框架/自定义元素可能异步 upgrade：未决策则重试
  var tries = 0;
  var timer = setInterval(function(){ if (!decided) decide(); if (decided || ++tries > 30) clearInterval(timer); }, 300);
})();
</script>";

    // ─────────────────────────────────────────────
    // 评论
    // ─────────────────────────────────────────────

    public async Task<HostedSite?> SetCommentsEnabledAsync(string siteId, string userId, bool enabled, CancellationToken ct = default)
    {
        var site = await _db.HostedSites.Find(s => s.Id == siteId).FirstOrDefaultAsync(ct);
        if (site == null) return null;

        // 仅 owner / editor 可改评论开关（viewer / 非成员不行）
        var role = site.OwnerUserId == userId ? "owner" : await ResolveSiteRoleAsync(site, userId, ct);
        if (role != "owner" && role != "editor") return null;

        await _db.HostedSites.UpdateOneAsync(
            s => s.Id == siteId,
            Builders<HostedSite>.Update
                .Set(s => s.CommentsEnabled, enabled)
                .Set(s => s.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);

        site.CommentsEnabled = enabled;
        return site;
    }

    public async Task<SiteCommentsResult?> ListCommentsBySiteAsync(string siteId, string viewerUserId, CancellationToken ct = default)
    {
        // GetByIdAsync 已封装 "owner 本人 / 团队成员" 访问校验
        var site = await GetByIdAsync(siteId, viewerUserId, ct);
        if (site == null) return null;

        var comments = await LoadCommentDtosAsync(site, viewerUserId, ct);
        return new SiteCommentsResult
        {
            SiteId = site.Id,
            CommentsEnabled = site.CommentsEnabled,
            CanComment = !string.IsNullOrWhiteSpace(viewerUserId) && site.CommentsEnabled,
            Comments = comments,
        };
    }

    public async Task<SiteCommentsResult> ListCommentsByShareAsync(string token, string? password, string? viewerUserId, CancellationToken ct = default)
    {
        var (sites, err) = await ResolveShareForCommentAsync(token, password, viewerUserId, ct);
        if (err != null)
            return new SiteCommentsResult { Error = err.Value.Error, HttpStatus = err.Value.HttpStatus, ErrorCode = err.Value.ErrorCode, RetryAfterSeconds = err.Value.RetryAfter };
        if (sites.Count == 0)
            return new SiteCommentsResult { Error = "分享内无可评论站点", HttpStatus = 404, ErrorCode = "not_found" };

        var site = sites[0];
        var comments = await LoadCommentDtosAsync(site, viewerUserId, ct, maskUserId: true);
        return new SiteCommentsResult
        {
            SiteId = site.Id,
            CommentsEnabled = site.CommentsEnabled,
            // 公开分享下发表评论必须登录（viewerUserId 非空）且站点开启评论
            CanComment = !string.IsNullOrWhiteSpace(viewerUserId) && site.CommentsEnabled,
            Comments = comments,
        };
    }

    public async Task<AddCommentResult> AddCommentBySiteAsync(
        string siteId, string authorUserId, string authorName, string? avatarFileName,
        string content, CancellationToken ct = default)
    {
        var site = await GetByIdAsync(siteId, authorUserId, ct);
        if (site == null)
            return new AddCommentResult { Error = "站点不存在或无权访问", HttpStatus = 404, ErrorCode = "not_found" };

        return await InsertCommentAsync(site, authorUserId, authorName, avatarFileName, content, shareToken: null, ipAddress: null, ct);
    }

    public async Task<AddCommentResult> AddCommentByShareAsync(
        string token, string? password,
        string authorUserId, string authorName, string? avatarFileName,
        string content, string? ipAddress, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(authorUserId))
            return new AddCommentResult { Error = "请登录后发表评论", HttpStatus = 401, ErrorCode = "UNAUTHORIZED" };

        var (sites, err) = await ResolveShareForCommentAsync(token, password, authorUserId, ct);
        if (err != null)
            return new AddCommentResult { Error = err.Value.Error, HttpStatus = err.Value.HttpStatus, ErrorCode = err.Value.ErrorCode, RetryAfterSeconds = err.Value.RetryAfter };
        if (sites.Count == 0)
            return new AddCommentResult { Error = "分享内无可评论站点", HttpStatus = 404, ErrorCode = "not_found" };

        return await InsertCommentAsync(sites[0], authorUserId, authorName, avatarFileName, content, shareToken: token, ipAddress, ct);
    }

    public async Task<bool> DeleteCommentAsync(string commentId, string userId, CancellationToken ct = default)
    {
        var comment = await _db.HostedSiteComments.Find(c => c.Id == commentId && !c.IsDeleted).FirstOrDefaultAsync(ct);
        if (comment == null) return false;

        // 作者本人，或被评论站点的 owner，可删除
        bool canDelete = comment.AuthorUserId == userId;
        if (!canDelete)
        {
            var site = await _db.HostedSites.Find(s => s.Id == comment.SiteId).FirstOrDefaultAsync(ct);
            canDelete = site != null && site.OwnerUserId == userId;
        }
        if (!canDelete) return false;

        await _db.HostedSiteComments.UpdateOneAsync(
            c => c.Id == commentId,
            Builders<HostedSiteComment>.Update
                .Set(c => c.IsDeleted, true)
                .Set(c => c.UpdatedAt, DateTime.UtcNow),
            cancellationToken: ct);
        return true;
    }

    // ── 评论内部辅助 ──

    private async Task<AddCommentResult> InsertCommentAsync(
        HostedSite site, string authorUserId, string authorName, string? avatarFileName,
        string content, string? shareToken, string? ipAddress, CancellationToken ct)
    {
        if (!site.CommentsEnabled)
            return new AddCommentResult { Error = "该站点已关闭评论", HttpStatus = 403, ErrorCode = "COMMENTS_DISABLED" };

        var trimmed = (content ?? string.Empty).Trim();
        if (trimmed.Length == 0)
            return new AddCommentResult { Error = "评论内容不能为空", HttpStatus = 400, ErrorCode = "invalid" };
        if (trimmed.Length > 2000)
            return new AddCommentResult { Error = "评论内容不能超过 2000 字", HttpStatus = 400, ErrorCode = "invalid" };

        var comment = new HostedSiteComment
        {
            SiteId = site.Id,
            ShareToken = shareToken,
            AuthorUserId = authorUserId,
            AuthorName = string.IsNullOrWhiteSpace(authorName) ? "用户" : authorName,
            AuthorAvatarFileName = avatarFileName,
            Content = trimmed,
            IpAddress = ipAddress,
        };
        await _db.HostedSiteComments.InsertOneAsync(comment, cancellationToken: ct);

        // 通知站点 owner：有人评论了你的站点。自评不通知；Key 幂等保证每条评论只产生一条系统通知（用户要求「1 次」）。
        // best-effort + CancellationToken.None：通知失败不得影响评论本身，也不随客户端断开取消（server-authority）。
        if (!string.IsNullOrWhiteSpace(site.OwnerUserId) && site.OwnerUserId != authorUserId)
        {
            try
            {
                var preview = trimmed.Length > 40 ? trimmed[..40] + "…" : trimmed;
                await _db.AdminNotifications.InsertOneAsync(new AdminNotification
                {
                    Key = $"hosted-comment:{comment.Id}",
                    TargetUserId = site.OwnerUserId,
                    Title = $"{comment.AuthorName} 评论了你的站点「{site.Title}」",
                    Message = preview,
                    Level = "info",
                    Source = "web-hosting",
                    ActionLabel = "查看",
                    ActionUrl = "/web-pages",
                    ActionKind = "navigate",
                }, cancellationToken: CancellationToken.None);
            }
            catch
            {
                // 通知是 best-effort，失败静默（评论已落库成功）
            }
        }

        return new AddCommentResult
        {
            Comment = new HostedSiteCommentDto
            {
                Id = comment.Id,
                SiteId = comment.SiteId,
                Content = comment.Content,
                AuthorUserId = comment.AuthorUserId,
                AuthorName = comment.AuthorName,
                AuthorAvatarFileName = comment.AuthorAvatarFileName,
                CreatedAt = comment.CreatedAt,
                CanDelete = true,
            },
        };
    }

    private async Task<List<HostedSiteCommentDto>> LoadCommentDtosAsync(HostedSite site, string? viewerUserId, CancellationToken ct, bool maskUserId = false)
    {
        var comments = await _db.HostedSiteComments
            .Find(c => c.SiteId == site.Id && !c.IsDeleted)
            .SortByDescending(c => c.CreatedAt)
            .Limit(500)
            .ToListAsync(ct);

        bool viewerIsOwner = !string.IsNullOrWhiteSpace(viewerUserId) && site.OwnerUserId == viewerUserId;
        return comments.Select(c => new HostedSiteCommentDto
        {
            Id = c.Id,
            SiteId = c.SiteId,
            Content = c.Content,
            // 公开分享读取路径下抹掉内部 UserId，避免向匿名访客泄露账号标识（Codex P2）；CanDelete 已由服务端算好
            AuthorUserId = maskUserId ? string.Empty : c.AuthorUserId,
            AuthorName = c.AuthorName,
            AuthorAvatarFileName = c.AuthorAvatarFileName,
            CreatedAt = c.CreatedAt,
            CanDelete = viewerIsOwner || (!string.IsNullOrWhiteSpace(viewerUserId) && c.AuthorUserId == viewerUserId),
        }).ToList();
    }

    /// <summary>
    /// 评论专用分享门禁：撤销 / 过期 / 可见性 / 密码。复用 EnforceShareVisibilityAsync（与 ViewShareAsync 同款）；
    /// 密码仅校验不动滑动窗口（防爆破由 view 端点承担）。通过后内联解析分享目标站点。
    /// </summary>
    private async Task<(List<HostedSite> Sites, (string Error, int HttpStatus, string ErrorCode, int? RetryAfter)? Err)>
        ResolveShareForCommentAsync(string token, string? password, string? viewerUserId, CancellationToken ct)
    {
        var empty = new List<HostedSite>();
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token).FirstOrDefaultAsync(ct);
        if (share == null || share.IsRevoked)
            return (empty, ("分享链接不存在", 404, "not_found", null));

        if (share.ExpiresAt.HasValue && share.ExpiresAt.Value < DateTime.UtcNow)
            return (empty, ("分享链接已过期", 400, "expired", null));

        var visForbid = await EnforceShareVisibilityAsync(share, viewerUserId, ct);
        if (visForbid is { } vf)
            return (empty, (vf.Error, vf.HttpStatus, vf.ErrorCode, null));

        // 密码门控：复用 ViewShareAsync 同款 EnforceShareAccessAsync —— 它内置滑动窗口速率限制
        // （10 次/分钟）+ 持久化 RecentAttempts + 恒时比对。直接手写比对会绕过防爆破（Codex P1）。
        var gate = await EnforceShareAccessAsync(share, password, viewerUserId, ct);
        if (gate is { } g)
        {
            var code = g.HttpStatus == 429 ? "rate_limited" : "UNAUTHORIZED";
            return (empty, (g.Error, g.HttpStatus, code, g.RetryAfter));
        }

        var siteIds = new List<string>(share.SiteIds ?? new List<string>());
        if (share.SiteId != null && !siteIds.Contains(share.SiteId))
            siteIds.Insert(0, share.SiteId);
        var fetched = await _db.HostedSites.Find(x => siteIds.Contains(x.Id)).ToListAsync(ct);
        // Mongo Find 不保证返回顺序 == siteIds 顺序；调用方取 sites[0] 作为"分享首站点"挂评论，
        // 必须按 share 定义的 siteIds 顺序重排，否则多站点合集分享会把评论挂到错误站点（Cursor medium）。
        var byId = fetched.ToDictionary(s => s.Id);
        var sites = siteIds.Where(byId.ContainsKey).Select(id => byId[id]).ToList();
        return (sites, null);
    }

    private sealed class ZipExtractResult
    {
        public List<HostedSiteFile> Files { get; set; } = new();
        public string EntryFile { get; set; } = "index.html";
        public long TotalSize { get; set; }
        public string? Error { get; set; }
    }

    private sealed class ShareTokenViewAggregate
    {
        public string Token { get; set; } = string.Empty;
        public long ViewCount { get; set; }
        public DateTime LastViewedAt { get; set; }
    }
}
