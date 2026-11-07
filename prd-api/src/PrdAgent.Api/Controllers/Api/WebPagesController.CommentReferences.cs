using Microsoft.Extensions.Configuration;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    private sealed record RelatedMention(string CommentId, string AuthorName, string SourceSiteId, string SourceTitle, string Label);

    private async Task<Dictionary<HostedDocumentLink, List<string>>> ResolveRelatedLinksAsync(IEnumerable<HostedDocumentLink> inputs)
    {
        var links = inputs.Distinct().ToList();
        var sequences = links.Where(x => x.Kind == "sequence").Select(x => long.Parse(x.Value)).ToList();
        var shorts = sequences.Count == 0 ? new List<ShortLink>() : await _db.ShortLinks
            .Find(x => x.TargetType == ShortLinkTargetTypes.WebPage && sequences.Contains(x.Seq)).ToListAsync();
        var tokens = links.Where(x => x.Kind == "token").Select(x => x.Value).Concat(shorts.Select(x => x.TargetId)).Distinct().ToList();
        var now = DateTime.UtcNow;
        var shares = tokens.Count == 0 ? new List<WebPageShareLink>() : await _db.WebPageShareLinks
            .Find(x => tokens.Contains(x.Token) && !x.IsRevoked && (x.ExpiresAt == null || x.ExpiresAt > now || x.Purpose == "visit")).ToListAsync();
        var result = new Dictionary<HostedDocumentLink, List<string>>();
        foreach (var link in links)
        {
            if (link.Kind == "site") { result[link] = new() { link.Value }; continue; }
            var token = link.Kind == "sequence" ? shorts.FirstOrDefault(x => x.Seq == long.Parse(link.Value))?.TargetId : link.Value;
            var share = shares.FirstOrDefault(x => x.Token == token);
            var ids = share?.SiteIds.ToList() ?? new List<string>();
            if (share?.SiteId != null && !ids.Contains(share.SiteId)) ids.Insert(0, share.SiteId);
            result[link] = string.IsNullOrWhiteSpace(link.SelectedSiteId) ? ids.Take(90).ToList()
                : ids.Contains(link.SelectedSiteId) ? new() { link.SelectedSiteId } : new();
        }
        return result;
    }

    private async Task<List<string>> RelatedOriginsAsync()
    {
        var config = HttpContext.RequestServices.GetRequiredService<IConfiguration>();
        var origins = config.GetSection("Cors:AllowedOrigins").Get<string[]>()?.ToList() ?? new List<string>();
        // TLS 在前置代理终止时内部请求为 HTTP；同一站点域名的 HTTPS 链接仍属于本站。
        origins.Add($"http://{Request.Host}");
        origins.Add($"https://{Request.Host}");
        // CDS 会改写内部 Host，原外部域名由代理透传；这只用于识别链接，不授予文件访问权。
        var publicHost = Request.Headers["X-Forwarded-Host"].FirstOrDefault()?.Split(',')[0].Trim();
        if (!string.IsNullOrWhiteSpace(publicHost) && publicHost.Length <= 256
            && Uri.TryCreate($"https://{publicHost}", UriKind.Absolute, out var publicOrigin)
            && publicOrigin.UserInfo.Length == 0 && publicOrigin.AbsolutePath == "/"
            && publicOrigin.Query.Length == 0 && publicOrigin.Fragment.Length == 0)
        {
            origins.Add(publicOrigin.GetLeftPart(UriPartial.Authority));
            origins.Add($"http://{publicOrigin.Authority}");
        }
        origins.AddRange(config.GetSection("WebHosting:RelatedDocumentOrigins").Get<string[]>() ?? Array.Empty<string>());
        var ssoOrigin = await _db.AppSettings.Find(x => x.Id == "global").Project(x => x.MiduoSsoRedirectUri).FirstOrDefaultAsync();
        if (!string.IsNullOrWhiteSpace(ssoOrigin)) origins.Add(ssoOrigin);
        return origins;
    }

    private async Task<Dictionary<string, List<RelatedMention>>> RelatedCommentMentionsAsync(
        HostedSite current, List<HostedSite> visible, string? userId, HashSet<string> sharedIds)
    {
        var origins = await RelatedOriginsAsync();
        var sites = visible.ToDictionary(x => x.Id);
        var checkedIds = new HashSet<string>(sites.Keys);
        async Task<HostedSite?> Accessible(string id)
        {
            if (sites.TryGetValue(id, out var existing)) return existing;
            if (!checkedIds.Add(id)) return null;
            var site = sharedIds.Contains(id) ? await _db.HostedSites.Find(x => x.Id == id).FirstOrDefaultAsync()
                : userId == null ? null : await _siteService.GetByIdAsync(id, userId, CancellationToken.None);
            if (site != null) sites[id] = site;
            return site;
        }
        var history = new Dictionary<string, bool>();
        async Task<bool> VisibleComment(HostedSiteComment comment, HostedSite site)
        {
            if (!site.CommentsEnabled) return false;
            if (!history.TryGetValue(site.Id, out var canViewHistory))
                history[site.Id] = canViewHistory = userId != null && await _siteService.CanEditSiteAsync(site, userId, CancellationToken.None);
            return HostedSiteCommentRules.CanViewReviewVersion(HostedSiteCommentRules.StoredVersion(comment), HostedSiteService.EffectiveContentVersion(site), canViewHistory);
        }
        var seedIds = visible.Select(x => x.Id).ToList();
        var comments = await _db.HostedSiteComments.Find(x => seedIds.Contains(x.SiteId) && !x.IsDeleted)
            .SortByDescending(x => x.CreatedAt).Limit(500).ToListAsync();
        var incoming = await _db.HostedSiteComments.Find(x => x.ReferencedSiteIds.Contains(current.Id) && !x.IsDeleted && !seedIds.Contains(x.SiteId))
            .SortByDescending(x => x.CreatedAt).Limit(100).ToListAsync();
        var allowed = new List<HostedSiteComment>();
        foreach (var comment in comments.Concat(incoming))
        {
            var source = await Accessible(comment.SiteId);
            if (source != null && await VisibleComment(comment, source)) allowed.Add(comment);
        }
        var parsed = allowed.ToDictionary(x => x.Id, x => HostedDocumentLinkParser.Extract(x.Content, origins));
        var resolved = await ResolveRelatedLinksAsync(parsed.Values.SelectMany(x => x));
        var mentions = new Dictionary<string, List<RelatedMention>>();
        var updates = new List<WriteModel<HostedSiteComment>>();
        void Add(string target, HostedSiteComment comment, HostedSite source)
        {
            if (!mentions.TryGetValue(target, out var list)) mentions[target] = list = new();
            if (list.All(x => x.CommentId != comment.Id)) list.Add(new(comment.Id, comment.AuthorName, source.Id, source.Title, $"评论区{comment.AuthorName}提到"));
        }
        foreach (var comment in allowed)
        {
            var ids = parsed[comment.Id].SelectMany(x => resolved.GetValueOrDefault(x) ?? new()).Where(x => x != comment.SiteId).Distinct().ToList();
            // 只修复派生索引，CAS 避免覆盖并发删除或正文变动；原文、授权均不变。
            if (!comment.ReferencedSiteIds.ToHashSet().SetEquals(ids)) updates.Add(new UpdateOneModel<HostedSiteComment>(
                Builders<HostedSiteComment>.Filter.Where(x => x.Id == comment.Id && !x.IsDeleted && x.Content == comment.Content),
                Builders<HostedSiteComment>.Update.Set(x => x.ReferencedSiteIds, ids)));
            var source = sites[comment.SiteId];
            foreach (var id in ids.Take(50))
            {
                if (seedIds.Contains(comment.SiteId) && mentions.Count < 100)
                {
                    var target = await Accessible(id);
                    if (target != null) Add(id, comment, source);
                }
                if (id == current.Id && source.Id != current.Id) Add(source.Id, comment, source);
            }
        }
        if (updates.Count > 0) await _db.HostedSiteComments.BulkWriteAsync(updates, new BulkWriteOptions { IsOrdered = false });
        foreach (var id in mentions.Keys)
            if (sites.TryGetValue(id, out var site) && visible.All(x => x.Id != id)) visible.Add(site);
        return mentions;
    }
}
