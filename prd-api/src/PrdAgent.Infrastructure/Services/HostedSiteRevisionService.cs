using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 站点入口 HTML 的草稿与发布版本服务。
/// 历史版本只追加；回退的语义是“用旧内容发布一个新版本”。
/// </summary>
public sealed class HostedSiteRevisionService : IHostedSiteRevisionService
{
    private readonly MongoDbContext _db;
    private readonly IHostedSiteService _sites;

    public HostedSiteRevisionService(MongoDbContext db, IHostedSiteService sites)
    {
        _db = db;
        _sites = sites;
    }

    public async Task<HostedSiteRevision> EnsureCurrentSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry? knownEntry = null,
        CancellationToken ct = default)
    {
        var entry = knownEntry ?? await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        var existing = await _db.HostedSiteRevisions
            .Find(x => x.SiteId == siteId
                       && x.Status == HostedSiteRevisionStatuses.Published
                       && x.PublishedContentVersion == entry.ContentVersion)
            .FirstOrDefaultAsync(ct);
        if (existing != null) return existing;

        var baseline = new HostedSiteRevision
        {
            Id = $"baseline_{siteId}_{entry.ContentVersion.Ticks}",
            SiteId = siteId,
            CreatedByUserId = userId,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Baseline,
            Runtime = HostedSiteEditRuntimes.MapGateway,
            Html = entry.Html,
            BasedOnContentVersion = entry.ContentVersion,
            PublishedContentVersion = entry.ContentVersion,
            CreatedAt = entry.ContentVersion,
            PublishedAt = entry.ContentVersion,
        };

        try
        {
            await _db.HostedSiteRevisions.InsertOneAsync(baseline, cancellationToken: CancellationToken.None);
            return baseline;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return await _db.HostedSiteRevisions.Find(x => x.Id == baseline.Id).FirstAsync(ct);
        }
    }

    public async Task<HostedSiteRevision> CreateDraftAsync(
        string siteId,
        string userId,
        string html,
        string instruction,
        string runtime,
        string runId,
        string parentRevisionId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        DateTime basedOnContentVersion,
        CancellationToken ct = default)
    {
        HostedSiteRevisionRules.ValidateHtml(html);
        var current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        if (current.ContentVersion != basedOnContentVersion)
            throw new InvalidOperationException("站点在生成期间已经发生变化，请基于最新版本重新修改");

        var draft = new HostedSiteRevision
        {
            SiteId = siteId,
            CreatedByUserId = userId,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.AiEdit,
            ParentRevisionId = parentRevisionId,
            SourceRunId = runId,
            Instruction = instruction,
            Runtime = runtime,
            KnowledgeEntryIds = knowledgeEntryIds
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Distinct(StringComparer.Ordinal)
                .ToList(),
            Html = html,
            BasedOnContentVersion = basedOnContentVersion,
            CreatedAt = DateTime.UtcNow,
        };
        await _db.HostedSiteRevisions.InsertOneAsync(draft, cancellationToken: CancellationToken.None);
        return draft;
    }

    public async Task<IReadOnlyList<HostedSiteRevision>> ListAsync(
        string siteId,
        string userId,
        CancellationToken ct = default)
    {
        await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        return await _db.HostedSiteRevisions
            .Find(x => x.SiteId == siteId)
            .SortByDescending(x => x.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);
    }

    public async Task<HostedSiteRevision?> GetAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default)
    {
        await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        return await _db.HostedSiteRevisions
            .Find(x => x.Id == revisionId && x.SiteId == siteId)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<(HostedSiteRevision Revision, HostedSite Site)> PublishAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default)
    {
        var draft = await GetAsync(siteId, revisionId, userId, ct)
            ?? throw new KeyNotFoundException("版本不存在");
        if (draft.Status != HostedSiteRevisionStatuses.Draft)
            throw new InvalidOperationException("只有草稿可以发布");

        var current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        await EnsureCurrentSnapshotAsync(siteId, userId, current, ct);
        var site = await _sites.ReplaceEntryHtmlAsync(
            siteId,
            userId,
            draft.Html,
            draft.BasedOnContentVersion,
            CancellationToken.None);

        var publishedAt = DateTime.UtcNow;
        await _db.HostedSiteRevisions.UpdateOneAsync(
            x => x.Id == draft.Id && x.Status == HostedSiteRevisionStatuses.Draft,
            Builders<HostedSiteRevision>.Update
                .Set(x => x.Status, HostedSiteRevisionStatuses.Published)
                .Set(x => x.PublishedAt, publishedAt)
                .Set(x => x.PublishedContentVersion, site.ContentVersion),
            cancellationToken: CancellationToken.None);

        draft.Status = HostedSiteRevisionStatuses.Published;
        draft.PublishedAt = publishedAt;
        draft.PublishedContentVersion = site.ContentVersion;
        return (draft, site);
    }

    public async Task<(HostedSiteRevision Revision, HostedSite Site)> RollbackAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default)
    {
        var target = await GetAsync(siteId, revisionId, userId, ct)
            ?? throw new KeyNotFoundException("版本不存在");
        if (target.Status != HostedSiteRevisionStatuses.Published)
            throw new InvalidOperationException("只能回退到已经发布的版本");

        var current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        var parent = await EnsureCurrentSnapshotAsync(siteId, userId, current, ct);
        var rollback = new HostedSiteRevision
        {
            SiteId = siteId,
            CreatedByUserId = userId,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.Rollback,
            ParentRevisionId = parent.Id,
            Instruction = $"回退到 {target.Id}",
            Runtime = target.Runtime,
            KnowledgeEntryIds = target.KnowledgeEntryIds,
            Html = target.Html,
            BasedOnContentVersion = current.ContentVersion,
            CreatedAt = DateTime.UtcNow,
        };
        await _db.HostedSiteRevisions.InsertOneAsync(rollback, cancellationToken: CancellationToken.None);
        return await PublishAsync(siteId, rollback.Id, userId, CancellationToken.None);
    }

}
