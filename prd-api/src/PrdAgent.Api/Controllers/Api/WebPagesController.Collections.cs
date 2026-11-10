using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    public record CollectionEditRequest(string Title, List<string> SiteIds, string MainSiteId, long Version = 0);
    public record CollectionVersionRequest(long Version);
    public class CollectionShareRequest : CreateWebPageShareRequest
    {
        public long CollectionVersion { get; set; }
        public string PermissionFingerprint { get; set; } = string.Empty;
    }
    public record CollectionAdoptRequest(string Title, string MainSiteId);

    private async Task<HostedCollection?> OwnedCollectionAsync(string id) => await _db.HostedCollections
        .Find(x => x.Id == id && x.OwnerUserId == GetUserId() && !x.IsDissolved).FirstOrDefaultAsync();
    private IActionResult CollectionMissing() => NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "合集不存在或无权管理"));
    private IActionResult CollectionChanged() => Conflict(ApiResponse<object>.Fail("COLLECTION_CHANGED", "合集已变化，请刷新后重新确认"));

    [HttpGet("collections")]
    public async Task<IActionResult> ListCollections([FromQuery] string? keyword, [FromQuery] int page = 1)
    {
        page = Math.Max(1, page);
        var filter = Builders<HostedCollection>.Filter.Where(x => x.OwnerUserId == GetUserId() && !x.IsDissolved);
        if (!string.IsNullOrWhiteSpace(keyword)) filter &= Builders<HostedCollection>.Filter.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(Regex.Escape(keyword.Trim()), "i"));
        var total = await _db.HostedCollections.CountDocumentsAsync(filter);
        var items = await _db.HostedCollections.Find(filter).SortByDescending(x => x.UpdatedAt).Skip((page - 1) * 20).Limit(20).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize = 20 }));
    }

    [HttpGet("collections/candidates")]
    public async Task<IActionResult> CollectionCandidates([FromQuery] string? keyword, [FromQuery] int page = 1)
    {
        page = Math.Max(1, page);
        var filter = Builders<HostedSite>.Filter.Eq(x => x.OwnerUserId, GetUserId());
        if (!string.IsNullOrWhiteSpace(keyword)) filter &= Builders<HostedSite>.Filter.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(Regex.Escape(keyword.Trim()), "i"));
        var total = await _db.HostedSites.CountDocumentsAsync(filter);
        var sites = await _db.HostedSites.Find(filter).SortByDescending(x => x.UpdatedAt).Skip((page - 1) * 30).Limit(30).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items = sites.Select(x => new { x.Id, x.Title }), total, page, pageSize = 30 }));
    }

    [HttpGet("collections/{id}")]
    public async Task<IActionResult> GetCollection(string id)
    {
        var collection = await OwnedCollectionAsync(id);
        return collection == null ? CollectionMissing() : await CollectionDetailsAsync(collection);
    }

    [HttpGet("collections/by-share/{token}")]
    public async Task<IActionResult> CollectionByShare(string token)
    {
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token && x.CreatedBy == GetUserId()).FirstOrDefaultAsync();
        if (share == null || share.ShareType != "collection") return CollectionMissing();
        if (share.CollectionId != null) return await GetCollection(share.CollectionId);
        var sites = await CollectionSitesAsync(share.TargetSiteIds());
        return Ok(ApiResponse<object>.Ok(new { collection = (HostedCollection?)null, sites,
            legacyShare = new { share.Id, share.Title, siteIds = share.TargetSiteIds() }, shares = Array.Empty<object>() }));
    }

    private async Task<List<object>> CollectionSitesAsync(IEnumerable<string> ids)
    {
        var sites = new List<object>();
        foreach (var id in ids)
        {
            var site = await _siteService.GetByIdAsync(id, GetUserId(), CancellationToken.None);
            sites.Add(new { id, title = site?.Title ?? "文档已删除或当前无权访问", available = site != null });
        }
        return sites;
    }

    private async Task<IActionResult> CollectionDetailsAsync(HostedCollection collection)
    {
        Response.Headers.CacheControl = "no-store";
        var shares = await _db.WebPageShareLinks.Find(x => x.CollectionId == collection.Id && x.CreatedBy == GetUserId())
            .SortByDescending(x => x.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { collection,
            sites = await CollectionSitesAsync(HostedCollectionRules.OrderedIds(collection.SiteIds, collection.MainSiteId)),
            shares = shares.Select(x => new { x.Id, x.Token, x.Visibility, x.ExpiresAt, x.IsRevoked,
                active = !x.IsRevoked && HostedCollectionRules.AllowsShare(collection, x) && (x.ExpiresAt == null || x.ExpiresAt > DateTime.UtcNow),
                needsUpdate = x.CollectionVersion != collection.Version,
                memberCount = x.TargetSiteIds().Count, x.CollectionVersion }),
        }));
    }

    private async Task<string?> ValidateCollectionAsync(CollectionEditRequest req)
    {
        var ids = HostedCollectionRules.OrderedIds(req.SiteIds ?? new());
        var error = HostedCollectionRules.Validate(req.Title, ids, req.MainSiteId);
        if (error != null) return error;
        return await _siteService.CanCreateShareAsync(ids, GetUserId(), CancellationToken.None)
            ? null : "部分文档已删除，或你没有将其加入分享的权限，请移出后重试";
    }

    [HttpPost("collections")]
    public async Task<IActionResult> CreateCollection([FromBody] CollectionEditRequest req)
    {
        var error = await ValidateCollectionAsync(req);
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var collection = new HostedCollection { OwnerUserId = GetUserId(), Title = req.Title.Trim(),
            SiteIds = HostedCollectionRules.OrderedIds(req.SiteIds, req.MainSiteId), MainSiteId = req.MainSiteId };
        await _db.HostedCollections.InsertOneAsync(collection, cancellationToken: CancellationToken.None);
        return await CollectionDetailsAsync(collection);
    }

    [HttpPut("collections/{id}")]
    public async Task<IActionResult> UpdateCollection(string id, [FromBody] CollectionEditRequest req)
    {
        var collection = await OwnedCollectionAsync(id);
        if (collection == null) return CollectionMissing();
        var error = await ValidateCollectionAsync(req);
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var changed = await _db.HostedCollections.UpdateOneAsync(x => x.Id == id && x.OwnerUserId == GetUserId() && !x.IsDissolved && x.Version == req.Version,
            Builders<HostedCollection>.Update.Set(x => x.Title, req.Title.Trim())
                .Set(x => x.SiteIds, HostedCollectionRules.OrderedIds(req.SiteIds, req.MainSiteId)).Set(x => x.MainSiteId, req.MainSiteId)
                .Inc(x => x.Version, 1).Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
        return changed.MatchedCount == 0 ? CollectionChanged() : await GetCollection(id);
    }

    [HttpPost("collections/from-share/{token}")]
    public async Task<IActionResult> AdoptCollection(string token, [FromBody] CollectionAdoptRequest req)
    {
        var share = await _db.WebPageShareLinks.Find(x => x.Token == token && x.CreatedBy == GetUserId() && !x.IsRevoked).FirstOrDefaultAsync();
        if (share == null || share.ShareType != "collection") return CollectionMissing();
        if (share.CollectionId != null) return await GetCollection(share.CollectionId);
        var ids = share.TargetSiteIds();
        var error = await ValidateCollectionAsync(new(req.Title, ids, req.MainSiteId));
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var collection = new HostedCollection { OwnerUserId = GetUserId(), Title = req.Title.Trim(), SiteIds = HostedCollectionRules.OrderedIds(ids, req.MainSiteId), MainSiteId = req.MainSiteId };
        await _db.HostedCollections.InsertOneAsync(collection, cancellationToken: CancellationToken.None);
        var attached = await _db.WebPageShareLinks.UpdateOneAsync(x => x.Id == share.Id && x.CreatedBy == GetUserId() && !x.IsRevoked && x.CollectionId == null,
            Builders<WebPageShareLink>.Update.Set(x => x.CollectionId, collection.Id).Set(x => x.MainSiteId, collection.MainSiteId)
                .Set(x => x.CollectionVersion, collection.Version).Set(x => x.CollectionShareGeneration, collection.ShareGeneration)
                .Set(x => x.Title, collection.Title).Set(x => x.SiteIds, collection.SiteIds), cancellationToken: CancellationToken.None);
        if (attached.MatchedCount == 0)
        {
            await _db.HostedCollections.DeleteOneAsync(x => x.Id == collection.Id, CancellationToken.None);
            return CollectionChanged();
        }
        return await CollectionDetailsAsync(collection);
    }

    [HttpPost("collections/{id}/stop-sharing")]
    public Task<IActionResult> StopCollectionShares(string id, [FromBody] CollectionVersionRequest req) => CloseCollectionSharesAsync(id, req.Version, false);

    [HttpPost("collections/{id}/dissolve")]
    public Task<IActionResult> DissolveCollection(string id, [FromBody] CollectionVersionRequest req) => CloseCollectionSharesAsync(id, req.Version, true);

    private async Task<IActionResult> CloseCollectionSharesAsync(string id, long version, bool dissolve)
    {
        var collection = await OwnedCollectionAsync(id);
        if (collection == null) return CollectionMissing();
        var changed = await _db.HostedCollections.UpdateOneAsync(x => x.Id == id && x.OwnerUserId == GetUserId() && !x.IsDissolved && x.Version == version,
            Builders<HostedCollection>.Update.Inc(x => x.ShareGeneration, 1).Inc(x => x.Version, 1)
                .Set(x => x.IsDissolved, dissolve).Set(x => x.UpdatedAt, DateTime.UtcNow), cancellationToken: CancellationToken.None);
        if (changed.MatchedCount == 0) return CollectionChanged();
        // 先递增授权代次，再撤销记录：并发创建或失败重试都不能使旧代链接重新有效。
        await _db.WebPageShareLinks.UpdateManyAsync(x => x.CollectionId == id && x.CollectionShareGeneration <= collection.ShareGeneration && !x.IsRevoked,
            Builders<WebPageShareLink>.Update.Set(x => x.IsRevoked, true).Set(x => x.RevokedAt, DateTime.UtcNow)
                .Set(x => x.RevokedReason, dissolve ? "合集已解散" : "合集已停止全部分享"), cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { dissolved = dissolve, sharingStopped = true, documentsDeleted = false }));
    }

    private async Task<(string Fingerprint, List<HostedSite> Sites)?> CollectionSharingContextAsync(HostedCollection collection)
    {
        var sites = new List<HostedSite>();
        foreach (var id in collection.SiteIds)
        {
            var site = await _siteService.GetByIdAsync(id, GetUserId(), CancellationToken.None);
            if (site == null) return null;
            sites.Add(site);
        }
        var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new {
            collection.Id, collection.Version, collection.ShareGeneration,
            sites = sites.Select(x => new { x.Id, x.OwnerUserId, x.Visibility, x.GroupId, x.ContentVersion,
                teams = x.SharedTeamIds.OrderBy(t => t).ToArray() }) });
        return (Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)), sites);
    }

    [HttpGet("collections/{id}/sharing-preview")]
    public async Task<IActionResult> PreviewCollectionSharing(string id)
    {
        var collection = await OwnedCollectionAsync(id);
        if (collection == null) return CollectionMissing();
        var context = await CollectionSharingContextAsync(collection);
        if (context == null) return BadRequest(ApiResponse<object>.Fail("COLLECTION_UNAVAILABLE", "部分文档已删除或失去访问权限，请先调整合集"));
        return Ok(ApiResponse<object>.Ok(new { fingerprint = context.Value.Fingerprint, version = collection.Version,
            canShare = await _siteService.CanCreateShareAsync(collection.SiteIds, GetUserId(), CancellationToken.None),
            items = context.Value.Sites.Select(x => new { x.Id, x.Title, x.Visibility, teamCount = x.SharedTeamIds.Count, isMain = x.Id == collection.MainSiteId }),
            notice = "本次分享仅授权下列成员快照，不修改原文档权限。以后新增成员不会自动加入旧链接；其他独立分享继续有效。" }));
    }

    [HttpPost("collections/{id}/shares")]
    public async Task<IActionResult> CreateCollectionShare(string id, [FromBody] CollectionShareRequest req)
    {
        var collection = await OwnedCollectionAsync(id);
        if (collection == null) return CollectionMissing();
        var error = await ValidateCollectionAsync(new(collection.Title, collection.SiteIds, collection.MainSiteId));
        if (error != null) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, error));
        var visibility = req.Visibility ?? "owner-only";
        if (visibility is not ("owner-only" or "logged-in" or "public")) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请选择有效的分享访问范围"));
        var preview = await CollectionSharingContextAsync(collection);
        if (preview == null || req.CollectionVersion != collection.Version || req.PermissionFingerprint != preview.Value.Fingerprint) return CollectionChanged();
        if (visibility != "owner-only")
        {
            var refusal = await EnforcePrivateSourcesForShareAsync(collection.SiteIds,
                PrdAgent.Api.Services.HostedSitePrivateSourceActions.ShareCreate, req.ConfirmedPrivateSourceFingerprint);
            if (refusal != null) return refusal;
        }
        WebPageShareLink? share = null;
        var completed = false;
        try
        {
            // 新链接先仅作者可见；绑定合集代次并完成历史资源发布检查后才对外激活。
            share = await _siteService.CreateShareAsync(GetUserId(), await ResolveDisplayNameAsync(GetUserId()), null,
                HostedCollectionRules.OrderedIds(collection.SiteIds, collection.MainSiteId), "collection", collection.Title, req.Description,
                req.Password, req.ExpiresInDays, CancellationToken.None, forceNew: true, visibility: "owner-only",
                allocateShortLink: req.AllocateShortLink ?? false, askSuggestedQuestions: req.AskSuggestedQuestions);
            await _db.WebPageShareLinks.UpdateOneAsync(x => x.Id == share.Id && !x.IsRevoked,
                Builders<WebPageShareLink>.Update.Set(x => x.CollectionId, collection.Id).Set(x => x.MainSiteId, collection.MainSiteId)
                    .Set(x => x.CollectionVersion, collection.Version).Set(x => x.CollectionShareGeneration, collection.ShareGeneration), cancellationToken: CancellationToken.None);
            var current = await OwnedCollectionAsync(id);
            if (current == null || current.Version != collection.Version || current.ShareGeneration != collection.ShareGeneration) return CollectionChanged();
            var activated = await _siteService.UpdateShareSettingsAsync(share.Id, GetUserId(), visibility, null, CancellationToken.None);
            if (!activated.Ok) return Conflict(ApiResponse<object>.Fail("COLLECTION_SHARE_FAILED", activated.Error ?? "分享未完成，请重新生成"));
            completed = true;
            return Ok(ApiResponse<object>.Ok(new { share.Id, share.Token, share.Password, share.ExpiresAt,
                visibility, collectionId = collection.Id, shareUrl = $"/s/wp/{share.Token}", share.ShortSeq }));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or UnauthorizedAccessException)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
        finally
        {
            if (!completed && share != null) await _siteService.RevokeShareAsync(share.Id, GetUserId(), "合集分享创建未完成", CancellationToken.None);
        }
    }

    private async Task<(HostedDocumentGroup? Group, List<HostedSite> Sites, List<WebPageShareLink> Shares)> CollectionPermissionContextAsync(string id)
    {
        var collection = await OwnedCollectionAsync(id);
        if (collection == null) return (null, new(), new());
        var sites = new List<HostedSite>();
        foreach (var siteId in collection.SiteIds)
        {
            var site = await _siteService.GetByIdAsync(siteId, GetUserId(), CancellationToken.None);
            // 同步沿用既有关联权限规则，只处理当前作者实际拥有的全部成员。
            if (site == null || site.OwnerUserId != GetUserId()) return (null, new(), new());
            sites.Add(site);
        }
        var shares = await _db.WebPageShareLinks.Find(x => !x.IsRevoked && (x.ExpiresAt == null || x.ExpiresAt > DateTime.UtcNow || x.Purpose == "visit") && (collection.SiteIds.Contains(x.SiteId!) || x.SiteIds.Any(s => collection.SiteIds.Contains(s))))
            .ToListAsync();
        return (new HostedDocumentGroup { Id = collection.Id, OwnerUserId = collection.OwnerUserId,
            MainSiteId = collection.MainSiteId, SiteIds = collection.SiteIds, Version = collection.Version }, sites, shares);
    }

    [HttpGet("collections/{id}/permissions")]
    public async Task<IActionResult> CollectionPermissions(string id)
    {
        var (group, sites, shares) = await CollectionPermissionContextAsync(id);
        return group == null ? BadRequest(ApiResponse<object>.Fail("COLLECTION_PERMISSIONS_UNAVAILABLE", "合集含不可访问或其他作者的文档，请先移出或由文档所有者处理权限"))
            : await RelatedPermissionsPreviewAsync(group, sites, shares);
    }

    [HttpPost("collections/{id}/permissions/sync")]
    public async Task<IActionResult> SyncCollectionPermissions(string id, [FromBody] RelatedPermissionRequest req)
    {
        var (group, sites, shares) = await CollectionPermissionContextAsync(id);
        return group == null ? BadRequest(ApiResponse<object>.Fail("COLLECTION_PERMISSIONS_UNAVAILABLE", "无法统一其他作者或不可访问文档的权限"))
            : await ApplyRelatedPermissionsAsync(group, sites, shares, req);
    }
}
