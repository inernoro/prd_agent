using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    private sealed record CollectionContextLink(string Id, string Title, string ShareUrl, DateTime CreatedAt,
        DateTime? ExpiresAt, string AccessLevel, int MemberCount, bool IsActive, string StatusLabel);
    private sealed record CollectionContext(string Id, string Title, int MemberCount, DateTime UpdatedAt,
        string? CollectionId, string? LegacyShareId, int ShareCount, CollectionContextLink? PrimaryLink);

    private static CollectionContextLink ContextLink(WebPageShareLink share, HostedCollection? collection)
    {
        var stopped = share.CollectionId != null && !HostedCollectionRules.AllowsShare(collection, share);
        var expired = share.ExpiresAt.HasValue && share.ExpiresAt.Value <= DateTime.UtcNow;
        return new(share.Id, string.IsNullOrWhiteSpace(share.Title) ? collection?.Title ?? "未命名合集" : share.Title,
            $"/s/wp/{Uri.EscapeDataString(share.Token)}", share.CreatedAt, share.ExpiresAt, share.AccessLevel,
            share.TargetSiteIds().Count, !share.IsRevoked && !stopped && !expired,
            share.IsRevoked ? "已撤销" : stopped ? "已停止" : expired ? "已过期" : "有效");
    }

    private FilterDefinition<WebPageShareLink> ContextShares(string siteId) =>
        Builders<WebPageShareLink>.Filter.Where(x => x.CreatedBy == GetUserId() && x.ShareType == "collection"
            && x.Purpose != "visit" && (x.SiteId == siteId || x.SiteIds.Contains(siteId)));

    // 当前归属读取合集实体；历史未命名实体的合集沿用原分享身份，绝不按成员相同猜测合并。
    [HttpGet("{siteId}/collection-contexts")]
    public async Task<IActionResult> CollectionContexts(string siteId, [FromQuery] int page = 1, [FromQuery] string? keyword = null)
    {
        Response.Headers.CacheControl = "no-store";
        if (await _siteService.GetByIdAsync(siteId, GetUserId(), CancellationToken.None) == null) return RelatedNotFound();
        if (keyword?.Trim().Length > 100) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "搜索内容请控制在 100 字以内"));
        var collections = await _db.HostedCollections.Find(x => x.OwnerUserId == GetUserId() && !x.IsDissolved && x.SiteIds.Contains(siteId)).ToListAsync();
        var byId = collections.ToDictionary(x => x.Id);
        var contexts = collections.ToDictionary(x => "collection:" + x.Id, x => new CollectionContext("collection:" + x.Id,
            x.Title, x.SiteIds.Count, x.UpdatedAt, x.Id, null, 0, null));
        var matched = new HashSet<string>();
        var query = keyword?.Trim();
        // 按当前文档、当前创建者流式读取；只保留每个合集的摘要，不把全部分享历史发送给浏览器。
        using var cursor = await _db.WebPageShareLinks.Find(ContextShares(siteId)).ToCursorAsync();
        while (await cursor.MoveNextAsync())
        foreach (var share in cursor.Current)
        {
            var id = share.CollectionId == null ? "legacy:" + share.Id : "collection:" + share.CollectionId;
            if (share.CollectionId != null && !byId.ContainsKey(share.CollectionId)) continue;
            var link = ContextLink(share, share.CollectionId == null ? null : byId[share.CollectionId]);
            if (!contexts.TryGetValue(id, out var context))
                context = new(id, link.Title, link.MemberCount, share.CreatedAt, null, share.Id, 0, null);
            var best = context.PrimaryLink;
            if (best == null || (link.IsActive && !best.IsActive) || (link.IsActive == best.IsActive
                && (link.CreatedAt > best.CreatedAt || (link.CreatedAt == best.CreatedAt && string.CompareOrdinal(link.Id, best.Id) > 0)))) best = link;
            contexts[id] = context with { ShareCount = context.ShareCount + 1, PrimaryLink = best };
            if (!string.IsNullOrEmpty(query) && (share.Token.Contains(query, StringComparison.OrdinalIgnoreCase)
                || share.Title?.Contains(query, StringComparison.OrdinalIgnoreCase) == true)) matched.Add(id);
        }
        var ordered = contexts.Values.Where(x => string.IsNullOrEmpty(query) || x.Title.Contains(query, StringComparison.OrdinalIgnoreCase) || matched.Contains(x.Id))
            .OrderBy(x => x.CollectionId == null).ThenByDescending(x => x.UpdatedAt).ThenBy(x => x.Id, StringComparer.Ordinal).ToList();
        page = Math.Max(1, page);
        var skip = (long)(page - 1) * 20;
        var items = skip > int.MaxValue ? new List<CollectionContext>() : ordered.Skip((int)skip).Take(20).ToList();
        return Ok(ApiResponse<object>.Ok(new { items, total = ordered.Count, totalContexts = contexts.Count, page, pageSize = 20 }));
    }

    private async Task<(HostedSite? Site, HostedCollection? Collection, WebPageShareLink? Legacy)> ResolveCollectionContextAsync(string siteId, string contextId)
    {
        var site = await _siteService.GetByIdAsync(siteId, GetUserId(), CancellationToken.None);
        if (site == null) return (null, null, null);
        if (contextId.StartsWith("collection:", StringComparison.Ordinal))
        {
            var collection = await OwnedCollectionAsync(contextId["collection:".Length..]);
            return collection?.SiteIds.Contains(siteId) == true ? (site, collection, null) : (null, null, null);
        }
        if (!contextId.StartsWith("legacy:", StringComparison.Ordinal)) return (null, null, null);
        var id = contextId["legacy:".Length..];
        var share = await _db.WebPageShareLinks.Find(ContextShares(siteId) & Builders<WebPageShareLink>.Filter.Eq(x => x.Id, id)
            & Builders<WebPageShareLink>.Filter.Eq(x => x.CollectionId, null)).FirstOrDefaultAsync();
        return share == null ? (null, null, null) : (site, null, share);
    }

    [HttpGet("{siteId}/collection-contexts/{contextId}/documents")]
    public async Task<IActionResult> CollectionContextDocuments(string siteId, string contextId)
    {
        Response.Headers.CacheControl = "no-store";
        var (site, collection, legacy) = await ResolveCollectionContextAsync(siteId, contextId);
        if (site == null) return RelatedNotFound();
        var group = new HostedDocumentGroup { OwnerUserId = GetUserId(),
            SiteIds = HostedCollectionRules.OrderedIds(collection?.SiteIds ?? legacy!.TargetSiteIds(), collection?.MainSiteId ?? legacy?.MainSiteId),
            MainSiteId = collection?.MainSiteId ?? legacy?.MainSiteId ?? string.Empty };
        // 管理后台仍逐文档鉴权；合集归属或失效分享均不能授予额外文档访问权。
        return await RelatedViewAsync(site, GetUserId(), new HashSet<string>(), contextGroup: group);
    }

    [HttpGet("{siteId}/collection-contexts/{contextId}/links")]
    public async Task<IActionResult> CollectionContextLinks(string siteId, string contextId, [FromQuery] int page = 1)
    {
        Response.Headers.CacheControl = "no-store";
        var (site, collection, legacy) = await ResolveCollectionContextAsync(siteId, contextId);
        if (site == null) return RelatedNotFound();
        var filter = ContextShares(siteId) & (collection != null
            ? Builders<WebPageShareLink>.Filter.Eq(x => x.CollectionId, collection.Id)
            : Builders<WebPageShareLink>.Filter.Eq(x => x.Id, legacy!.Id));
        var total = await _db.WebPageShareLinks.CountDocumentsAsync(filter);
        page = Math.Max(1, page);
        var skip = (long)(page - 1) * 20;
        var shares = skip > int.MaxValue ? new List<WebPageShareLink>() : await _db.WebPageShareLinks.Find(filter)
            .SortByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id).Skip((int)skip).Limit(20).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items = shares.Select(x => ContextLink(x, collection)), total, page, pageSize = 20 }));
    }
}
