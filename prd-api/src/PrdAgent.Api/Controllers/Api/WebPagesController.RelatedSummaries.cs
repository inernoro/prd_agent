using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    // 列表只取轻量摘要，展开时才加载该文档的预览和完整关系；不为每张卡发请求。
    [HttpGet("related-documents/summaries")]
    public async Task<IActionResult> RelatedSummaries([FromQuery] string? siteIds)
    {
        Response.Headers.CacheControl = "no-store";
        var ids = (siteIds?.Split(',', StringSplitOptions.RemoveEmptyEntries) ?? Array.Empty<string>()).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        if (ids.Count > 200) return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "一次最多读取 200 份文档"));
        var userId = GetUserId();
        var readable = new Dictionary<string, HostedSite>();
        var checkedIds = new HashSet<string>();
        async Task Load(IEnumerable<string> candidates)
        {
            var pending = candidates.Distinct().Where(checkedIds.Add).ToList();
            if (pending.Count == 0) return;
            foreach (var batch in pending.Chunk(1000))
            {
                var records = await _db.HostedSites.Find(x => batch.Contains(x.Id))
                    .Project(x => new HostedSite { Id = x.Id, Title = x.Title, OwnerUserId = x.OwnerUserId,
                        CommentsEnabled = x.CommentsEnabled, ContentVersion = x.ContentVersion, CreatedAt = x.CreatedAt }).ToListAsync();
                foreach (var site in records)
                {
                    // 作者路径批量判定；团队与受限分组继续走原单文件权限门。
                    var accessible = site.OwnerUserId == userId ? site : await _siteService.GetByIdAsync(site.Id, userId, CancellationToken.None);
                    if (accessible != null) readable[site.Id] = accessible;
                }
            }
        }
        await Load(ids);
        var seeds = ids.Where(readable.ContainsKey).ToList();
        if (seeds.Count == 0) return Ok(ApiResponse<object>.Ok(new { items = new Dictionary<string, object>() }));
        var groups = await _db.HostedDocumentGroups.Find(Builders<HostedDocumentGroup>.Filter.AnyIn(x => x.SiteIds, seeds)).ToListAsync();
        var members = seeds.Concat(groups.SelectMany(x => x.SiteIds)).Distinct().ToList();
        await Load(members);
        var visibleMembers = members.Where(readable.ContainsKey).ToList();
        var outgoing = await _db.HostedSiteComments.Find(x => visibleMembers.Contains(x.SiteId) && !x.IsDeleted)
            .SortByDescending(x => x.CreatedAt).Limit(10000).ToListAsync();
        var incoming = await _db.HostedSiteComments.Find(Builders<HostedSiteComment>.Filter.And(
                Builders<HostedSiteComment>.Filter.AnyIn(x => x.ReferencedSiteIds, seeds),
                Builders<HostedSiteComment>.Filter.Eq(x => x.IsDeleted, false),
                Builders<HostedSiteComment>.Filter.Nin(x => x.SiteId, visibleMembers)))
            .SortByDescending(x => x.CreatedAt).Limit(2000).ToListAsync();
        await Load(incoming.Select(x => x.SiteId));
        var canReview = new Dictionary<string, bool>();
        var allowed = new List<HostedSiteComment>();
        foreach (var comment in outgoing.Concat(incoming))
        {
            if (!readable.TryGetValue(comment.SiteId, out var source) || !source.CommentsEnabled) continue;
            if (!canReview.TryGetValue(source.Id, out var history))
                canReview[source.Id] = history = source.OwnerUserId == userId || await _siteService.CanEditSiteAsync(source, userId, CancellationToken.None);
            if (HostedSiteCommentRules.CanViewReviewVersion(HostedSiteCommentRules.StoredVersion(comment), HostedSiteService.EffectiveContentVersion(source), history)) allowed.Add(comment);
        }
        var origins = await RelatedOriginsAsync();
        var parsed = allowed.ToDictionary(x => x.Id, x => HostedDocumentLinkParser.Extract(x.Content, origins));
        var links = await ResolveRelatedLinksAsync(parsed.Values.SelectMany(x => x));
        var sourceIds = allowed.ToDictionary(x => x.Id, x => x.SiteId);
        var targets = parsed.ToDictionary(x => x.Key, x => x.Value.SelectMany(link => links.GetValueOrDefault(link) ?? new())
            .Where(id => id != sourceIds[x.Key]).Distinct().ToList());
        // 列表发现新引用时同步修复派生索引，保证直接打开目标页也能发现反向来源。
        var updates = new List<WriteModel<HostedSiteComment>>();
        foreach (var comment in allowed)
        {
            var refs = targets[comment.Id];
            if (comment.ReferencedSiteIds.ToHashSet().SetEquals(refs)) continue;
            updates.Add(new UpdateOneModel<HostedSiteComment>(
                Builders<HostedSiteComment>.Filter.Where(x => x.Id == comment.Id && !x.IsDeleted && x.Content == comment.Content),
                Builders<HostedSiteComment>.Update.Set(x => x.ReferencedSiteIds, refs)));
            comment.ReferencedSiteIds = refs;
        }
        if (updates.Count > 0) await _db.HostedSiteComments.BulkWriteAsync(updates, new BulkWriteOptions { IsOrdered = false });
        await Load(targets.Values.SelectMany(x => x.Take(50)));
        var summaries = new Dictionary<string, object>();
        foreach (var id in seeds)
        {
            var group = groups.FirstOrDefault(x => x.SiteIds.Contains(id));
            var family = (group?.SiteIds ?? new List<string> { id }).Where(readable.ContainsKey).ToHashSet();
            var related = family.ToHashSet();
            var mentioned = new HashSet<string>();
            foreach (var comment in outgoing.Where(x => family.Contains(x.SiteId)).OrderByDescending(x => x.CreatedAt).Take(500))
            {
                if (!targets.TryGetValue(comment.Id, out var refs)) continue;
                foreach (var target in refs.Take(50))
                    if (mentioned.Count < 100 && readable.ContainsKey(target)) { mentioned.Add(target); related.Add(target); }
            }
            foreach (var comment in outgoing.Concat(incoming).Where(x => !family.Contains(x.SiteId) && x.ReferencedSiteIds.Contains(id))
                .OrderByDescending(x => x.CreatedAt).Take(100))
                if (targets.TryGetValue(comment.Id, out var refs) && refs.Contains(id)) related.Add(comment.SiteId);
            related.Remove(id);
            var primary = group != null && readable.TryGetValue(group.MainSiteId, out var main) ? main : null;
            summaries[id] = new { count = related.Count, mainTitle = primary?.Title, isMain = primary?.Id == id,
                titles = related.Select(x => readable[x].Title).Take(8).ToList() };
        }
        Response.Headers.CacheControl = "no-store";
        return Ok(ApiResponse<object>.Ok(new { items = summaries }));
    }
}
