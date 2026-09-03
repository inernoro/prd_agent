using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IHostedSiteRevisionService
{
    Task<HostedSiteRevision> EnsureCurrentSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry? knownEntry = null,
        CancellationToken ct = default);

    Task<HostedSiteRevision> CreateDraftAsync(
        string siteId,
        string userId,
        string html,
        string instruction,
        string runtime,
        string runId,
        string parentRevisionId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        DateTime basedOnContentVersion,
        CancellationToken ct = default);

    Task<IReadOnlyList<HostedSiteRevision>> ListAsync(
        string siteId,
        string userId,
        CancellationToken ct = default);

    Task<HostedSiteRevision?> GetAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default);

    Task<(HostedSiteRevision Revision, HostedSite Site)> PublishAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default);

    Task<(HostedSiteRevision Revision, HostedSite Site)> RollbackAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default);
}
