using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    public record RelatedDocumentsRequest(List<string> SiteIds, string MainSiteId, long Version);
    public record RelatedPermissionRequest(string Fingerprint, bool RevokeTargetShares = false);

    [HttpGet("{siteId}/related-documents")]
    public async Task<IActionResult> GetRelatedDocuments(string siteId)
    {
        var site = await _siteService.GetByIdAsync(siteId, GetUserId(), CancellationToken.None);
        if (site == null) return RelatedNotFound();
        return await RelatedViewAsync(site, GetUserId(), new HashSet<string>());
    }

    [AllowAnonymous]
    [HttpGet("shares/view/{token}/related-documents")]
    public async Task<IActionResult> GetShareRelatedDocuments(string token, [FromQuery] string? siteId, [FromQuery] string? password)
    {
        Response.Headers.CacheControl = "no-store";
        var userId = User.Identity?.IsAuthenticated == true ? GetUserId() : null;
        var resolved = await _siteService.ResolveShareSiteAsync(token, siteId, password, userId);
        if (resolved.Error != null) return MapCommentError(resolved.Error, resolved.HttpStatus, resolved.ErrorCode, resolved.RetryAfterSeconds);
        if (resolved.Site == null || resolved.Share == null) return RelatedNotFound();
        var allowed = resolved.Share.SiteIds.ToHashSet(StringComparer.Ordinal);
        if (resolved.Share.SiteId != null) allowed.Add(resolved.Share.SiteId);
        return await RelatedViewAsync(resolved.Site, userId, allowed, token);
    }

    private async Task<IActionResult> RelatedViewAsync(HostedSite current, string? userId, HashSet<string> sharedIds, string? shareToken = null)
    {
        Response.Headers.CacheControl = "no-store";
        var group = await _db.HostedDocumentGroups.Find(x => x.SiteIds.Contains(current.Id)).FirstOrDefaultAsync();
        var ids = group?.SiteIds ?? new List<string> { current.Id };
        var visible = new List<HostedSite>();
        foreach (var id in ids)
        {
            // 原分享明确授权的成员可见；其他成员必须通过独立账号权限。
            var item = id == current.Id ? current
                : sharedIds.Contains(id) ? await _db.HostedSites.Find(x => x.Id == id).FirstOrDefaultAsync()
                : userId == null ? null : await _siteService.GetByIdAsync(id, userId, CancellationToken.None);
            if (item != null) visible.Add(item);
        }
        var canManage = userId != null && current.OwnerUserId == userId && (group == null || group.OwnerUserId == userId);
        if (canManage && group != null)
        {
            var existing = await _db.HostedSites.Find(x => group.SiteIds.Contains(x.Id)).ToListAsync();
            canManage = existing.All(x => x.OwnerUserId == userId);
        }
        var manualSites = visible.ToList();
        var mentions = await RelatedCommentMentionsAsync(current, visible, userId, sharedIds);
        // 手动成员沿用作者保存的顺序；评论自动发现的文档由上一步附加在末尾。
        var ordered = visible;
        return Ok(ApiResponse<object>.Ok(new
        {
            version = canManage ? group?.Version ?? 0 : 0,
            mainSiteId = visible.Any(x => x.Id == group?.MainSiteId) ? group!.MainSiteId : null,
            canManage,
            hasPermissionDifferences = canManage && manualSites.Any(x => !HostedDocumentPermissionPolicy.SamePageAccess(current, x)),
            items = ordered.Select(x => new
            {
                x.Id, x.Title, x.Description, x.UpdatedAt, x.Tags,
                isManual = ids.Contains(x.Id),
                canEditTags = userId != null && x.OwnerUserId == userId,
                mentions = mentions.GetValueOrDefault(x.Id) ?? new(),
                preview = new { x.Id, x.SiteUrl, x.EntryFile, x.WrappedAssetType,
                    contentShape = HostedSiteContentShapeRules.Resolve(x), x.RequiresPreviewBridge,
                    useShareAccess = shareToken != null && sharedIds.Contains(x.Id) },
                isMain = x.Id == group?.MainSiteId,
                // 不创建公开便捷链，不向其它页面传播当前分享凭证。
                href = shareToken != null && sharedIds.Contains(x.Id)
                    ? $"/s/wp/{Uri.EscapeDataString(shareToken)}?siteId={Uri.EscapeDataString(x.Id)}"
                    : $"/web-pages?openSite={Uri.EscapeDataString(x.Id)}",
            }),
        }));
    }

    [HttpGet("{siteId}/related-documents/candidates")]
    public async Task<IActionResult> RelatedCandidates(string siteId, [FromQuery] string? keyword)
    {
        if (await OwnedRelatedSiteAsync(siteId) == null) return RelatedNotFound();
        var owned = await _db.HostedSites.Find(x => x.OwnerUserId == GetUserId())
            .SortByDescending(x => x.UpdatedAt).Limit(1000).ToListAsync();
        var groups = await _db.HostedDocumentGroups.Find(x => x.OwnerUserId == GetUserId()).ToListAsync();
        var current = groups.FirstOrDefault(x => x.SiteIds.Contains(siteId));
        var elsewhere = groups.Where(x => x.Id != current?.Id).SelectMany(x => x.SiteIds).ToHashSet();
        var items = owned.Where(x => !elsewhere.Contains(x.Id)
            && (string.IsNullOrWhiteSpace(keyword) || x.Title.Contains(keyword.Trim(), StringComparison.OrdinalIgnoreCase)))
            .Select(x => new { x.Id, x.Title, x.Description });
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpPut("{siteId}/related-documents")]
    public async Task<IActionResult> SaveRelatedDocuments(string siteId, [FromBody] RelatedDocumentsRequest req)
    {
        var userId = GetUserId();
        if (await OwnedRelatedSiteAsync(siteId) == null) return RelatedNotFound();
        var ids = (req.SiteIds ?? new()).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        if (ids.Count is < 1 or > 90 || !ids.Contains(siteId) || !ids.Contains(req.MainSiteId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择 1–90 份文档，包含当前文档和主文档"));
        var sites = await _db.HostedSites.Find(x => ids.Contains(x.Id) && x.OwnerUserId == userId).ToListAsync();
        if (sites.Count != ids.Count) return RelatedNotFound();
        var group = await _db.HostedDocumentGroups.Find(x => x.SiteIds.Contains(siteId)).FirstOrDefaultAsync();
        if (group != null && group.OwnerUserId != userId) return RelatedNotFound();
        if ((group?.Version ?? 0) != req.Version) return RelatedConflict();
        if (ids.Count == 1)
        {
            if (group != null)
            {
                var removed = await _db.HostedDocumentGroups.DeleteOneAsync(x => x.Id == group.Id && x.Version == req.Version);
                if (removed.DeletedCount == 0) return RelatedConflict();
            }
            return await GetRelatedDocuments(siteId);
        }
        try
        {
            // 生产不自动执行 MongoDbContext.CreateIndexes；首次写入也建立唯一性约束。
            await _db.HostedDocumentGroups.Indexes.CreateOneAsync(new CreateIndexModel<HostedDocumentGroup>(
                Builders<HostedDocumentGroup>.IndexKeys.Ascending(x => x.SiteIds),
                new CreateIndexOptions { Unique = true, Name = "ux_hosted_document_groups_member" }));
            if (group == null)
            {
                await _db.HostedDocumentGroups.InsertOneAsync(new HostedDocumentGroup
                { OwnerUserId = userId, SiteIds = ids, MainSiteId = req.MainSiteId });
            }
            else
            {
                var changed = await _db.HostedDocumentGroups.UpdateOneAsync(x => x.Id == group.Id && x.Version == req.Version,
                    Builders<HostedDocumentGroup>.Update.Set(x => x.SiteIds, ids).Set(x => x.MainSiteId, req.MainSiteId)
                        .Inc(x => x.Version, 1).Set(x => x.UpdatedAt, DateTime.UtcNow));
                if (changed.MatchedCount == 0) return RelatedConflict();
            }
        }
        catch (MongoWriteException ex) when (ex.WriteError.Category == ServerErrorCategory.DuplicateKey)
        { return Conflict(ApiResponse<object>.Fail("RELATED_GROUP_CONFLICT", "部分文档已属于其他关联组，请刷新后重试")); }
        return await GetRelatedDocuments(siteId);
    }

    private async Task<HostedSite?> OwnedRelatedSiteAsync(string siteId) =>
        await _db.HostedSites.Find(x => x.Id == siteId && x.OwnerUserId == GetUserId()).FirstOrDefaultAsync();

    private IActionResult RelatedNotFound() => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文档不存在或无权访问"));
    private IActionResult RelatedConflict() => Conflict(ApiResponse<object>.Fail("RELATED_GROUP_CHANGED", "关联或权限已变化，请刷新后重新确认"));

    private async Task<(HostedDocumentGroup? Group, List<HostedSite> Sites, List<WebPageShareLink> Shares)> RelatedPermissionContextAsync(string siteId)
    {
        var group = await _db.HostedDocumentGroups.Find(x => x.SiteIds.Contains(siteId) && x.OwnerUserId == GetUserId()).FirstOrDefaultAsync();
        if (group == null) return (null, new(), new());
        var sites = await _db.HostedSites.Find(x => group.SiteIds.Contains(x.Id)).ToListAsync();
        // 已删除的成员不妨碍其余成员管理；被转移所有权的成员禁止批量修改。
        if (sites.All(x => x.Id != siteId) || sites.Any(x => x.OwnerUserId != GetUserId()) || sites.All(x => x.Id != group.MainSiteId))
            return (null, new(), new());
        var now = DateTime.UtcNow;
        var sf = Builders<WebPageShareLink>.Filter;
        var shares = await _db.WebPageShareLinks.Find(sf.And(
            sf.Eq(x => x.IsRevoked, false),
            sf.Or(sf.Eq(x => x.ExpiresAt, null), sf.Gt(x => x.ExpiresAt, now), sf.Eq(x => x.Purpose, "visit")),
            sf.Or(sf.In(x => x.SiteId, group.SiteIds), sf.AnyIn(x => x.SiteIds, group.SiteIds))))
            .ToListAsync();
        return (group, sites, shares);
    }

    private static bool RelatedShareContains(WebPageShareLink share, string siteId) => share.SiteId == siteId || share.SiteIds.Contains(siteId);

    private async Task<string> RelatedFingerprintAsync(HostedDocumentGroup group, List<HostedSite> sites, List<WebPageShareLink> shares)
    {
        var groupIds = sites.Select(x => x.GroupId).Where(x => x != null).Distinct().ToList();
        var restrictions = await _db.WebPageGroups.Find(x => groupIds.Contains(x.Id)).ToListAsync();
        var json = JsonSerializer.Serialize(new
        {
            group.Version, group.MainSiteId,
            sites = sites.OrderBy(x => x.Id).Select(x => new { x.Id, x.OwnerUserId, x.Visibility, x.GroupId, teams = x.SharedTeamIds.OrderBy(t => t) }),
            shares = shares.OrderBy(x => x.Id).Select(x => new { x.Id, x.CreatedBy, x.SiteId, x.SiteIds, x.Visibility, x.AccessLevel, x.ExpiresAt }),
            restrictions = restrictions.OrderBy(x => x.Id).Select(x => new { x.Id, x.UpdatedAt, x.Visibility, x.AccessRules }),
        });
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
    }

    [HttpGet("{siteId}/related-documents/permissions")]
    public async Task<IActionResult> PreviewRelatedPermissions(string siteId)
    {
        var (group, sites, shares) = await RelatedPermissionContextAsync(siteId);
        if (group == null) return RelatedNotFound();
        Response.Headers.CacheControl = "no-store";
        var source = sites.First(x => x.Id == group.MainSiteId);
        var teams = await _teams.GetMyWebHostingTeamRolesAsync(GetUserId(), CancellationToken.None);
        var missing = sites.Any(x => source.SharedTeamIds.Except(x.SharedTeamIds).Any(id => !teams.TryGetValue(id, out var role)
            || (role != WebHostingRoles.Owner && role != WebHostingRoles.Editor)));
        var foreignShares = shares.Any(x => x.CreatedBy != GetUserId() && sites.Any(s => s.Id != source.Id && RelatedShareContains(x, s.Id)));
        return Ok(ApiResponse<object>.Ok(new
        {
            sourceId = source.Id, sourceTitle = source.Title,
            fingerprint = await RelatedFingerprintAsync(group, sites, shares),
            canSync = !missing,
            blockingReason = missing ? "你在主文档的部分团队中没有投放权限，不能统一" : null,
            canRevokeShares = !foreignShares,
            shareNotice = "分享链接独立授权，不复制主文档的链接、密码或有效期。可选择撤销其他文档现有链接；合集链接撤销会同时影响合集内其他文件。",
            items = sites.OrderBy(x => x.Id == source.Id ? 0 : 1).Select(x => new
            {
                x.Id, x.Title, isMain = x.Id == source.Id,
                differences = HostedDocumentPermissionPolicy.DescribeChanges(source, x),
                matches = HostedDocumentPermissionPolicy.SamePageAccess(source, x),
                activeShareCount = shares.Count(s => RelatedShareContains(s, x.Id)),
            }),
        }));
    }

    [HttpPost("{siteId}/related-documents/permissions/sync")]
    public async Task<IActionResult> SyncRelatedPermissions(string siteId, [FromBody] RelatedPermissionRequest req)
    {
        var (group, sites, shares) = await RelatedPermissionContextAsync(siteId);
        if (group == null) return RelatedNotFound();
        if (req.Fingerprint != await RelatedFingerprintAsync(group, sites, shares)) return RelatedConflict();
        var source = sites.First(x => x.Id == group.MainSiteId);
        var targets = sites.Where(x => x.Id != source.Id).ToList();
        var roles = await _teams.GetMyWebHostingTeamRolesAsync(GetUserId(), CancellationToken.None);
        if (targets.Any(x => source.SharedTeamIds.Except(x.SharedTeamIds).Any(id => !roles.TryGetValue(id, out var role)
            || (role != WebHostingRoles.Owner && role != WebHostingRoles.Editor))))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "你没有向主文档全部团队投放文档的权限"));
        var targetShares = shares.Where(x => targets.Any(t => RelatedShareContains(x, t.Id))).ToList();
        if (req.RevokeTargetShares && targetShares.Any(x => x.CreatedBy != GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "部分分享链接属于其他成员，不能替他们撤销"));
        if (req.RevokeTargetShares && targetShares.Any(x => RelatedShareContains(x, source.Id)))
            return Conflict(ApiResponse<object>.Fail("RELATED_SHARED_COLLECTION", "部分合集链接同时包含主文档，请先在分享管理中拆分该合集"));
        var widening = targets.Where(x => source.Visibility == "public" && x.Visibility != "public").ToList();
        if (widening.Count > 0 && _privateSources != null)
        {
            var decision = await _privateSources.EnforceForSitesAsync(widening,
                PrdAgent.Api.Services.HostedSitePrivateSourceActions.SitePublic, GetUserId(), null, CancellationToken.None);
            if (!decision.Allowed) return Conflict(ApiResponse<object>.Fail(decision.ErrorCode, decision.Message));
        }
        if (source.GroupId != null)
        {
            var restriction = await _db.WebPageGroups.Find(x => x.Id == source.GroupId).FirstOrDefaultAsync();
            if (restriction == null || !source.SharedTeamIds.Contains(restriction.TeamId)) return RelatedConflict();
            if (WebPageGroupAccess.IsRestricted(restriction)
                && (!roles.TryGetValue(restriction.TeamId, out var groupRole) || groupRole != WebHostingRoles.Owner))
                return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "受限分组的权限同步需要团队所有者操作"));
        }
        var results = new List<object>();
        foreach (var target in targets)
        {
            try
            {
                // 沿用历史资源与私有资料检查，不绕过现有公开发布保护。
                var visibility = await _siteService.SetVisibilityAsync(target.Id, GetUserId(), source.Visibility);
                if (visibility == null) { results.Add(new { id = target.Id, title = target.Title, success = false, message = "文档已变化" }); continue; }
                var updated = await _siteService.SetSharedTeamsAsync(target.Id, GetUserId(), source.SharedTeamIds);
                if (updated == null) { results.Add(new { id = target.Id, title = target.Title, success = false, message = "文档已变化" }); continue; }
                await _db.HostedSites.UpdateOneAsync(x => x.Id == target.Id && x.OwnerUserId == GetUserId(),
                    Builders<HostedSite>.Update.Set(x => x.GroupId, source.GroupId).Set(x => x.UpdatedAt, DateTime.UtcNow));
                results.Add(new { id = target.Id, title = target.Title, success = true, message = "页面权限已同步" });
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or InvalidOperationException or ArgumentException)
            { results.Add(new { id = target.Id, title = target.Title, success = false, message = ex.Message }); }
        }
        if (req.RevokeTargetShares)
            foreach (var share in targetShares)
                await _siteService.RevokeShareAsync(share.Id, GetUserId(), "关联文档权限统一");
        return Ok(ApiResponse<object>.Ok(new { results, sharesRevoked = req.RevokeTargetShares ? targetShares.Count : 0 }));
    }
}
