using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AngleSharp.Html.Parser;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Api.Services;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    private IMongoCollection<HostedDocumentCollection> Collections => _db.Database.GetCollection<HostedDocumentCollection>("hosted_document_collections");

    [HttpGet("collections")]
    public async Task<IActionResult> ListDocumentCollections([FromQuery] bool dissolved = false)
    {
        var rows = await Collections.Find(c => c.OwnerUserId == GetUserId() && (dissolved ? c.DissolvedAt != null : c.DissolvedAt == null))
            .SortByDescending(c => c.UpdatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items = rows }));
    }

    [HttpGet("collections/candidates")]
    public async Task<IActionResult> CollectionCandidates()
    {
        var user = GetUserId();
        var teams = (await _teams.GetMyWebHostingTeamRolesAsync(user)).Keys.ToList();
        var pool = await _db.HostedSites.Find(s => s.OwnerUserId == user || s.SharedTeamIds.Any(id => teams.Contains(id)))
            .SortByDescending(s => s.UpdatedAt).Limit(1000).ToListAsync();
        var visible = new List<object>(); var visibleIds = new HashSet<string>();
        foreach (var site in pool)
            if (await _siteService.GetByIdAsync(site.Id, user) != null) { visible.Add(await CollectionItem(site, true)); visibleIds.Add(site.Id); }
        var legacy = await _db.HostedDocumentGroups.Find(g => g.OwnerUserId == user).ToListAsync();
        var ids = visibleIds;
        return Ok(ApiResponse<object>.Ok(new { items = visible, legacy = legacy.Select(g => new {
            g.Id, name = pool.FirstOrDefault(s => s.Id == g.MainSiteId)?.Title ?? "历史关联组",
            siteIds = g.SiteIds.Where(ids.Contains), g.MainSiteId
        }), templates = WritingTemplateRegistry.All }));
    }

    [HttpGet("collections/members")]
    public async Task<IActionResult> CollectionMemberDirectory([FromQuery] string keyword)
    {
        var query = (keyword ?? "").Trim();
        if (query.Length < 2) return Ok(ApiResponse<object>.Ok(new { items = Array.Empty<object>() }));
        var users = await _db.Users.Find(u => u.Status == UserStatus.Active && (u.DisplayName.Contains(query) || u.Username.Contains(query)))
            .Limit(30).Project(u => new { id = u.UserId, name = u.DisplayName }).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items = users }));
    }

    [HttpPost("collections")]
    public async Task<IActionResult> CreateDocumentCollection([FromBody] CollectionSaveRequest request)
    {
        var collection = new HostedDocumentCollection { OwnerUserId = GetUserId(), OwnerName = await ResolveDisplayNameAsync(GetUserId()),
            Name = request.Name.Trim(), Description = request.Description ?? "", SiteIds = request.SiteIds,
            MainSiteId = request.MainSiteId, Sections = request.Sections ?? new() };
        var error = await ValidateCollection(collection);
        if (error != null) return error;
        await Collections.InsertOneAsync(collection);
        return await GetDocumentCollection(collection.Id);
    }

    [HttpPut("collections/{id}")]
    public async Task<IActionResult> UpdateDocumentCollection(string id, [FromBody] CollectionSaveRequest request)
    {
        var collection = await Collections.Find(c => c.Id == id && c.OwnerUserId == GetUserId() && c.DissolvedAt == null).FirstOrDefaultAsync();
        if (collection == null) return RelatedNotFound();
        if (collection.Version != request.Version) return RelatedConflict();
        var previousIds = collection.SiteIds.ToHashSet();
        collection.Name = request.Name.Trim(); collection.Description = request.Description ?? "";
        collection.SiteIds = request.SiteIds; collection.MainSiteId = request.MainSiteId; collection.Sections = request.Sections ?? new();
        var error = await ValidateCollection(collection, previousIds);
        if (error != null) return error;
        collection.Version++; collection.UpdatedAt = DateTime.UtcNow;
        var saved = await Collections.UpdateOneAsync(c => c.Id == id && c.OwnerUserId == GetUserId() && c.Version == request.Version && c.DissolvedAt == null,
            Builders<HostedDocumentCollection>.Update.Set(c => c.Name, collection.Name).Set(c => c.Description, collection.Description)
                .Set(c => c.SiteIds, collection.SiteIds).Set(c => c.MainSiteId, collection.MainSiteId).Set(c => c.Sections, collection.Sections).Set(c => c.MemberMetadata, collection.MemberMetadata)
                .Set(c => c.UpdatedAt, collection.UpdatedAt).Inc(c => c.Version, 1));
        return saved.ModifiedCount == 1 ? await GetDocumentCollection(id) : RelatedConflict();
    }

    [HttpGet("collections/{id}")]
    public async Task<IActionResult> GetDocumentCollection(string id)
    {
        Response.Headers.CacheControl = "no-store";
        var collection = await Collections.Find(c => c.Id == id && c.DissolvedAt == null).FirstOrDefaultAsync();
        if (collection == null) return RelatedNotFound();
        var owner = collection.OwnerUserId == GetUserId();
        if (!owner && await _siteService.GetByIdAsync(collection.MainSiteId, GetUserId()) == null) return RelatedNotFound();
        var items = new List<object>(); var visibleIds = new List<string>();
        foreach (var siteId in collection.SiteIds)
        {
            var site = await _siteService.GetByIdAsync(siteId, GetUserId());
            if (site != null) { items.Add(await CollectionItem(site, owner, true)); visibleIds.Add(siteId); }
            else if (owner) { items.Add(UnavailableCollectionItem(siteId, collection.MemberMetadata)); visibleIds.Add(siteId); }
        }
        // 可读一个成员不等于获准得知其他受限成员的标题、数量或章节名称。
        if (!owner) HostedCollectionPolicy.RestrictVisibleMembers(collection, visibleIds.ToHashSet());

        var main = await _siteService.GetByIdAsync(collection.MainSiteId, GetUserId());
        var related = main == null ? null : await RelatedViewAsync(main, GetUserId(), new HashSet<string>()) as OkObjectResult;
        return Ok(ApiResponse<object>.Ok(new { collection, items, canManage = owner,
            related = (related?.Value as ApiResponse<object>)?.Data,
            templates = WritingTemplateRegistry.All }));
    }

    private async Task<object> CollectionItem(HostedSite site, bool manage, bool metadata = false, bool publicRead = false)
    {
        if (metadata) await RefreshCollectionMetadata(site);
        var memberships = publicRead ? new List<object>() : (await Collections.Find(c => c.OwnerUserId == GetUserId() && c.DissolvedAt == null && c.SiteIds.Contains(site.Id))
            .Project(c => new { c.Id, c.Name }).ToListAsync()).Cast<object>().ToList();
        var threads = metadata ? await _db.HostedSiteComments.Find(c => c.SiteId == site.Id && !c.IsDeleted && c.ParentId == null).ToListAsync() : new();
        threads = threads.Where(c => HostedSiteCommentRules.CanViewReviewVersion(HostedSiteCommentRules.StoredVersion(c), site.ContentVersion, false)).ToList();
        return new { site.Id, site.Title, site.SiteUrl, site.EntryFile, site.WrappedAssetType, site.ContentShape, summary = site.Description, excerpt = site.DocumentTextExcerpt,
            headings = site.DocumentHeadings, templateId = site.WritingTemplateId,
            type = WritingTemplateRegistry.Find(site.WritingTemplateId ?? "")?.Type ?? "文档",
            ownerUserId = publicRead ? null : site.OwnerUserId, author = await ResolveDisplayNameAsync(site.OwnerUserId), site.UpdatedAt,
            characterCount = site.DocumentCharacterCount, commentCount = threads.Count,
            annotationCount = threads.Count(c => c.Anchor != null), discussionCount = threads.Count(c => c.Anchor == null),
            versionNumber = metadata ? Math.Max(1, await _db.HostedSiteRevisions.CountDocumentsAsync(r => r.SiteId == site.Id && r.Status == HostedSiteRevisionStatuses.Published)) : 1,
            version = site.ContentVersion, visibility = publicRead ? null : site.Visibility, sharedTeamIds = publicRead ? null : site.SharedTeamIds, groupId = publicRead ? null : site.GroupId,
            canShare = manage && await _siteService.CanCreateShareAsync(new[] { site.Id }, GetUserId()),
            canEdit = !publicRead && site.OwnerUserId == GetUserId(), memberships, unavailable = false };
    }

    private async Task<IActionResult?> ValidateCollection(HostedDocumentCollection collection, HashSet<string>? previousIds = null)
    {
        try { HostedCollectionPolicy.Validate(collection); }
        catch (InvalidOperationException ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
        foreach (var id in collection.SiteIds) {
            var site = await _siteService.GetByIdAsync(id, GetUserId());
            if (site == null) { if (previousIds?.Contains(id) != true) return RelatedNotFound(); continue; }
            collection.MemberMetadata[id] = new HostedCollectionMemberMetadata { Title = site.Title,
                Author = await ResolveDisplayNameAsync(site.OwnerUserId), Type = WritingTemplateRegistry.Find(site.WritingTemplateId ?? "")?.Type ?? "文档", UpdatedAt = site.UpdatedAt };
        }
        collection.MemberMetadata = collection.MemberMetadata.Where(pair => collection.SiteIds.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => pair.Value);
        return null;
    }

    [HttpPost("collections/{id}/dissolve")]
    public async Task<IActionResult> DissolveDocumentCollection(string id, [FromBody] CollectionVersionRequest request)
    {
        var collection = await Collections.FindOneAndUpdateAsync<HostedDocumentCollection>(Builders<HostedDocumentCollection>.Filter.Where(c => c.Id == id && c.OwnerUserId == GetUserId() && c.DissolvedAt == null && c.Version == request.Version),
            Builders<HostedDocumentCollection>.Update.Set(c => c.DissolvedAt, DateTime.UtcNow).Set(c => c.UpdatedAt, DateTime.UtcNow).Inc(c => c.Version, 1).Inc(c => c.ShareGeneration, 1),
            new FindOneAndUpdateOptions<HostedDocumentCollection, HostedDocumentCollection> { ReturnDocument = ReturnDocument.After });
        if (collection == null) return RelatedConflict();
        await RevokeEarlierCollectionShares(id, collection.ShareGeneration);
        return Ok(ApiResponse<object>.Ok(new { dissolved = true }));
    }

    [HttpPost("collections/{id}/restore")]
    public async Task<IActionResult> RestoreDocumentCollection(string id, [FromBody] CollectionVersionRequest request)
    {
        var earliest = DateTime.UtcNow.AddDays(-30);
        var result = await Collections.UpdateOneAsync(c => c.Id == id && c.OwnerUserId == GetUserId() && c.DissolvedAt >= earliest && c.Version == request.Version,
            Builders<HostedDocumentCollection>.Update.Set(c => c.DissolvedAt, null).Set(c => c.UpdatedAt, DateTime.UtcNow).Inc(c => c.Version, 1));
        return result.ModifiedCount == 1 ? await GetDocumentCollection(id) : RelatedConflict();
    }

    [HttpGet("collections/{id}/shares")]
    public async Task<IActionResult> ListCollectionShares(string id)
    {
        var collection = await Collections.Find(c => c.Id == id && c.OwnerUserId == GetUserId()).FirstOrDefaultAsync();
        if (collection == null) return RelatedNotFound();
        var shares = await _db.WebPageShareLinks.Find(s => s.CollectionSnapshot != null && s.CollectionSnapshot.CollectionId == id && s.CreatedBy == GetUserId())
            .SortByDescending(s => s.CreatedAt).ToListAsync();
        // 只为当前所有者已创建的名单补全显示名，不向匿名目录或其他合集暴露用户目录。
        var memberIds = shares.SelectMany(s => s.CollectionSnapshot!.AccessUserIds).Distinct().ToList();
        var members = await _db.Users.Find(u => memberIds.Contains(u.UserId))
            .Project(u => new { u.UserId, u.DisplayName, u.Username }).ToListAsync();
        var memberNames = members.ToDictionary(u => u.UserId, u => string.IsNullOrWhiteSpace(u.DisplayName) ? u.Username : u.DisplayName);
        return Ok(ApiResponse<object>.Ok(new { items = shares.Select(s => new { s.Id, s.Token, s.Title, s.Visibility,
            s.AccessLevel, s.ExpiresAt, s.CreatedAt, s.ViewCount, isRevoked = s.IsRevoked || s.CollectionSnapshot!.ShareGeneration != collection.ShareGeneration, snapshot = s.CollectionSnapshot,
            accessMembers = s.CollectionSnapshot!.AccessUserIds.Select(memberId => new { id = memberId, name = memberNames.GetValueOrDefault(memberId) ?? memberId }),
            shareUrl = $"/s/collection/{Uri.EscapeDataString(s.Token)}" }) }));
    }

    private async Task<string> CollectionFingerprint(HostedDocumentCollection collection)
    {
        var sites = await _db.HostedSites.Find(s => collection.SiteIds.Contains(s.Id)).ToListAsync();
        var groups = sites.Select(s => s.GroupId).Where(g => g != null).ToList();
        var restrictions = await _db.WebPageGroups.Find(g => groups.Contains(g.Id)).ToListAsync();
        var json = JsonSerializer.Serialize(new { collection.Version, collection.ShareGeneration, collection.SiteIds, sites = sites.OrderBy(s => s.Id).Select(s => new {
            s.Id, s.OwnerUserId, s.Visibility, s.SharedTeamIds, s.GroupId, s.ContentVersion
        }), restrictions = restrictions.Select(g => new { g.Id, g.UpdatedAt }) });
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
    }

    [HttpGet("collections/{id}/permissions")]
    public async Task<IActionResult> CollectionPermissions(string id)
    {
        var collection = await Collections.Find(c => c.Id == id && c.OwnerUserId == GetUserId() && c.DissolvedAt == null).FirstOrDefaultAsync();
        if (collection == null) return RelatedNotFound();
        var main = await _siteService.GetByIdAsync(collection.MainSiteId, GetUserId());
        var items = new List<object>();
        foreach (var memberId in collection.SiteIds) {
            var site = await _siteService.GetByIdAsync(memberId, GetUserId());
            if (site == null) { items.Add(new { id = memberId, title = "不可用文档", canShare = false, canSync = false, matches = false }); continue; }
            items.Add(new { id = site.Id, site.Title, site.Visibility, site.SharedTeamIds,
                canShare = await _siteService.CanCreateShareAsync(new[] { site.Id }, GetUserId()),
                canSync = site.OwnerUserId == GetUserId() && main != null && main.OwnerUserId == GetUserId(),
                matches = main != null && HostedDocumentPermissionPolicy.SamePageAccess(main, site),
                differences = main == null ? new List<string>() : HostedDocumentPermissionPolicy.DescribeChanges(main, site) });
        }
        return Ok(ApiResponse<object>.Ok(new { fingerprint = await CollectionFingerprint(collection), items }));
    }

    [HttpPost("collections/{id}/shares")]
    public async Task<IActionResult> CreateCollectionShare(string id, [FromBody] CollectionShareRequest request)
    {
        var collection = await Collections.Find(c => c.Id == id && c.OwnerUserId == GetUserId() && c.DissolvedAt == null).FirstOrDefaultAsync();
        if (collection == null) return RelatedNotFound();
        if (collection.Version != request.Version || request.Fingerprint != await CollectionFingerprint(collection)) return RelatedConflict();
        HostedCollectionSnapshot snapshot;
        try { snapshot = HostedCollectionPolicy.Snapshot(collection, request.SiteIds); }
        catch (InvalidOperationException ex) { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
        if (request.AccessUserIds.Count > 100) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "指定成员最多100人"));
        var userIds = request.AccessUserIds.Distinct().ToList();
        if (userIds.Count > 0 && await _db.Users.CountDocumentsAsync(u => userIds.Contains(u.UserId) && u.Status == UserStatus.Active) != userIds.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "部分指定成员不可用，请重新选择"));
        snapshot.AccessUserIds = userIds;
        // 复用完整的既有分享权限、私有资料确认、密码及有效期规则，不创建绕过门禁的分享。
        var result = await CreateShareCore(new CreateWebPageShareRequest { SiteIds = snapshot.SiteIds, ShareType = "collection",
            Title = request.Title ?? collection.Name, Description = collection.Description, Password = request.Password,
            ExpiresInDays = request.ExpiresInDays, Visibility = userIds.Count > 0 && request.Visibility != "owner-only" ? "logged-in" : request.Visibility, ForceNew = true,
            ConfirmedPrivateSourceFingerprint = request.ConfirmedPrivateSourceFingerprint }, snapshot);
        if (result is not OkObjectResult ok || ok.Value is not ApiResponse<object> response || response.Data == null) return result;
        var json = JsonSerializer.SerializeToElement(response.Data, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var shareId = json.GetProperty("id").GetString()!;
        var active = await Collections.Find(c => c.Id == id && c.DissolvedAt == null && c.ShareGeneration == snapshot.ShareGeneration).FirstOrDefaultAsync();
        if (active == null) {
            await _siteService.RevokeShareAsync(shareId, GetUserId(), "创建期间合集已解散");
            return RelatedConflict();
        }
        var token = json.GetProperty("token").GetString()!;
        return Ok(ApiResponse<object>.Ok(new { id = shareId, token, shareUrl = $"/s/collection/{Uri.EscapeDataString(token)}", snapshot }));
    }

    [HttpPost("collections/{id}/permissions/sync")]
    public async Task<IActionResult> SyncCollectionPermissions(string id, [FromBody] CollectionSyncRequest request)
    {
        var collection = await Collections.Find(c => c.Id == id && c.OwnerUserId == GetUserId() && c.DissolvedAt == null).FirstOrDefaultAsync();
        if (collection == null) return RelatedNotFound();
        if (request.Fingerprint != await CollectionFingerprint(collection)) return RelatedConflict();
        var source = await _db.HostedSites.Find(s => s.Id == collection.MainSiteId && s.OwnerUserId == GetUserId()).FirstOrDefaultAsync();
        if (source == null || request.SiteIds.Any(s => !collection.SiteIds.Contains(s))) return RelatedNotFound();
        var targets = await _db.HostedSites.Find(s => request.SiteIds.Contains(s.Id) && s.OwnerUserId == GetUserId()).ToListAsync();
        if (targets.Count != request.SiteIds.Distinct().Count()) return RelatedNotFound();
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(GetUserId());
        if (targets.Any(t => source.SharedTeamIds.Except(t.SharedTeamIds).Any(team => !roles.TryGetValue(team, out var role)
            || role != WebHostingRoles.Owner && role != WebHostingRoles.Editor)))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "你没有向主文档全部团队投放文档的权限"));
        if (source.GroupId != null) {
            var group = await _db.WebPageGroups.Find(g => g.Id == source.GroupId).FirstOrDefaultAsync();
            if (group == null || !source.SharedTeamIds.Contains(group.TeamId)) return RelatedConflict();
            if (WebPageGroupAccess.IsRestricted(group) && (!roles.TryGetValue(group.TeamId, out var role) || role != WebHostingRoles.Owner))
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "受限分组需要团队所有者操作"));
        }
        var widening = targets.Where(t => source.Visibility == "public" && t.Visibility != "public").ToList();
        if (widening.Count > 0 && _privateSources != null) {
            var decision = await _privateSources.EnforceForSitesAsync(widening, HostedSitePrivateSourceActions.SitePublic, GetUserId(), null, CancellationToken.None);
            if (!decision.Allowed) return Conflict(ApiResponse<object>.Fail(decision.ErrorCode, decision.Message));
        }
        var results = new List<object>();
        foreach (var target in targets) {
            var visibilityChanged = false;
            try {
                var changed = await _siteService.SetVisibilityAsync(target.Id, GetUserId(), source.Visibility);
                if (changed == null) { results.Add(new { id = target.Id, success = false, message = "文档已变化，未同步" }); continue; }
                visibilityChanged = true;
                var assigned = await _siteService.SetSharedTeamsAndGroupAsync(target.Id, GetUserId(), source.SharedTeamIds, source.GroupId);
                results.Add(new { id = target.Id, success = assigned != null, message = assigned != null ? "页面权限已同步" : "可见性已同步，团队权限未同步，请重新核对" });
            } catch (Exception ex) when (ex is not OperationCanceledException) {
                results.Add(new { id = target.Id, success = false, message = visibilityChanged ? "可见性已同步，团队权限同步失败，请重新核对" : "同步失败，原权限保留，请重试" });
            }
        }
        return Ok(ApiResponse<object>.Ok(new { results, fingerprint = await CollectionFingerprint(collection) }));
    }

    [HttpPost("collections/{id}/shares/stop")]
    public async Task<IActionResult> StopCollectionShares(string id)
    {
        var collection = await Collections.FindOneAndUpdateAsync<HostedDocumentCollection>(Builders<HostedDocumentCollection>.Filter.Where(c => c.Id == id && c.OwnerUserId == GetUserId()),
            Builders<HostedDocumentCollection>.Update.Inc(c => c.ShareGeneration, 1),
            new FindOneAndUpdateOptions<HostedDocumentCollection, HostedDocumentCollection> { ReturnDocument = ReturnDocument.After });
        if (collection == null) return RelatedNotFound();
        var stopped = await RevokeEarlierCollectionShares(id, collection.ShareGeneration);
        return Ok(ApiResponse<object>.Ok(new { stopped }));
    }

    private async Task<int> RevokeEarlierCollectionShares(string id, int cutoffGeneration)
    {
        var shares = await _db.WebPageShareLinks.Find(s => s.CollectionSnapshot != null && s.CollectionSnapshot.CollectionId == id
            && s.CollectionSnapshot.ShareGeneration < cutoffGeneration && s.CreatedBy == GetUserId() && !s.IsRevoked).ToListAsync();
        foreach (var share in shares) await _siteService.RevokeShareAsync(share.Id, GetUserId(), "停止合集全部分享");
        return shares.Count;
    }

    [AllowAnonymous]
    [HttpGet("shares/view/{token}/collection")]
    public async Task<IActionResult> ReadCollectionShare(string token, [FromQuery] string? password)
    {
        Response.Headers.CacheControl = "no-store";
        var viewer = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var resolved = await _siteService.ResolveCollectionShareAsync(token, password, viewer);
        if (resolved.Error != null) return MapCommentError(resolved.Error, resolved.HttpStatus, resolved.ErrorCode, resolved.RetryAfterSeconds);
        var snapshot = resolved.Share?.CollectionSnapshot;
        if (snapshot == null) return RelatedNotFound();
        if (await Collections.Find(c => c.Id == snapshot.CollectionId && c.DissolvedAt == null).FirstOrDefaultAsync() == null)
            return RelatedNotFound();
        // 仅返回创建链接时已授权的成员快照，当前合集新增或修改不会扩展旧链接。
        var allowed = resolved.Share!.TargetSiteIds().ToHashSet();
        var sites = await _db.HostedSites.Find(s => snapshot.SiteIds.Contains(s.Id) && allowed.Contains(s.Id)).ToListAsync();
        var byId = sites.ToDictionary(s => s.Id);
        var items = new List<object>();
        foreach (var siteId in snapshot.SiteIds.Where(allowed.Contains))
            items.Add(byId.TryGetValue(siteId, out var site) ? await CollectionItem(site, false, true, true)
                : UnavailableCollectionItem(siteId, snapshot.MemberMetadata));
        return Ok(ApiResponse<object>.Ok(new { collection = snapshot, items, canManage = false, shareToken = token }));
    }

    private static object UnavailableCollectionItem(string id, Dictionary<string, HostedCollectionMemberMetadata> remembered)
    {
        var metadata = remembered.GetValueOrDefault(id);
        return new { id, title = metadata?.Title ?? "不可用文档", author = metadata?.Author, type = metadata?.Type,
            updatedAt = metadata?.UpdatedAt, unavailable = true, canShare = false, canEdit = false };
    }

    private static readonly MemoryCache CollectionMetadataCache = new(new MemoryCacheOptions { SizeLimit = 1024 });
    private record CollectionMetadata(List<string> Headings, string Excerpt, int Characters);
    private async Task RefreshCollectionMetadata(HostedSite site)
    {
        if (_reviewStorage == null) return;
        var key = $"{site.Id}:{site.ContentVersion.Ticks}";
        if (!CollectionMetadataCache.TryGetValue(key, out CollectionMetadata? metadata)) {
            var entry = site.Files.FirstOrDefault(f => string.Equals(f.Path, site.EntryFile, StringComparison.OrdinalIgnoreCase));
            if (entry == null || entry.Size > 2 * 1024 * 1024 || !string.IsNullOrEmpty(site.WrappedAssetType) && site.WrappedAssetType != "markdown") return;
            var bytes = await _reviewStorage.TryDownloadBytesAsync(entry.CosKey, HttpContext.RequestAborted);
            if (bytes == null || bytes.Length > 2 * 1024 * 1024) return;
            var html = Encoding.UTF8.GetString(bytes);
            var extracted = CollectionDocumentText(html);
            var parsed = new HtmlParser().ParseDocument(html);
            foreach (var node in parsed.QuerySelectorAll("script,style,nav,header,footer")) node.Remove();
            metadata = new CollectionMetadata(extracted.Headings, extracted.Excerpt,
                System.Text.RegularExpressions.Regex.Replace(parsed.Body?.TextContent ?? "", @"\s+", "").Length);
            CollectionMetadataCache.Set(key, metadata, new MemoryCacheEntryOptions { Size = 1, AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) });
        }
        if (metadata == null) return;
        site.DocumentHeadings = metadata.Headings; site.DocumentTextExcerpt = metadata.Excerpt; site.DocumentCharacterCount = metadata.Characters;
    }

    internal static (List<string> Headings, string Excerpt) CollectionDocumentText(string html)
    {
        var document = new HtmlParser().ParseDocument(html);
        foreach (var node in document.QuerySelectorAll("script,style,nav,header,footer")) node.Remove();
        var headings = document.QuerySelectorAll("h2").Select(h => h.TextContent.Trim()).Where(h => h.Length > 0).Take(30).ToList();
        foreach (var node in document.QuerySelectorAll("h1,h2,h3,h4,h5,h6")) node.Remove();
        var text = (document.QuerySelector("article,main") ?? document.Body)?.TextContent.Trim() ?? "";
        text = string.Join(" ", text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return (headings, text[..Math.Min(60, text.Length)]);
    }

    public class CollectionVersionRequest { public long Version { get; set; } }
    public class CollectionSaveRequest : CollectionVersionRequest {
        public string Name { get; set; } = ""; public string? Description { get; set; }
        public List<string> SiteIds { get; set; } = new(); public string MainSiteId { get; set; } = "";
        public List<HostedCollectionSection>? Sections { get; set; }
    }
    public class CollectionShareRequest : CollectionVersionRequest {
        public List<string> AccessUserIds { get; set; } = new();
        public string Fingerprint { get; set; } = ""; public List<string> SiteIds { get; set; } = new();
        public string? Title { get; set; } public string? Password { get; set; } public int ExpiresInDays { get; set; }
        public string Visibility { get; set; } = "owner-only"; public string? ConfirmedPrivateSourceFingerprint { get; set; }
    }
    public class CollectionSyncRequest { public string Fingerprint { get; set; } = ""; public List<string> SiteIds { get; set; } = new(); }
}
