using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public sealed record HostedSiteRevisionMutationResult(
    HostedSiteRevision Revision,
    HostedSite Site,
    bool Changed);

public interface IHostedSiteRevisionService
{
    Task<HostedSiteRevision> EnsureCurrentSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry? knownEntry = null,
        CancellationToken ct = default);

    Task<HostedSiteRevision> EnsureGeneratedSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry knownEntry,
        string runtime,
        string sourceRunId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        CancellationToken ct = default);

    Task<HostedSiteRevision> EnsureGeneratedVerifiedSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry knownEntry,
        IReadOnlyList<HostedSiteVerifiedFile> files,
        string runtime,
        string sourceRunId,
        IReadOnlyCollection<string> knowledgeEntryIds,
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

    Task<HostedSiteRevision> CreateVerifiedDraftAsync(
        string siteId,
        string userId,
        string html,
        IReadOnlyList<HostedSiteVerifiedFile> files,
        string instruction,
        string runtime,
        string runId,
        string parentRevisionId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        DateTime basedOnContentVersion,
        CancellationToken ct = default);

    /// <summary>
    /// 补偿尚未完成的设计任务所写入的草稿。仅当版本仍为 draft、创建者与 SourceRunId 均精确匹配时删除。
    /// 已进入发布流程或由其他任务创建的版本永远不会被此方法删除。
    /// </summary>
    Task<bool> CompensateUnpublishedDraftAsync(
        string siteId,
        string runId,
        string userId,
        string? revisionId = null,
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

    Task<HostedSiteRevisionMutationResult> PublishAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default);

    Task<HostedSiteRevisionMutationResult> RollbackAsync(
        string siteId,
        string revisionId,
        string userId,
        string idempotencyKey,
        CancellationToken ct = default);

    /// <summary>
    /// 将草稿终结为 rejected。重复拒绝同一版本幂等返回，Changed=false；
    /// publishing 与 published 均不允许转为 rejected。
    /// </summary>
    Task<(HostedSiteRevision Revision, bool Changed)> RejectAsync(
        string siteId,
        string revisionId,
        string userId,
        string? reason,
        CancellationToken ct = default);
}
