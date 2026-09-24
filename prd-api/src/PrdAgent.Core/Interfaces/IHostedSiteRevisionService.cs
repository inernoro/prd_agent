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

    /// <summary>
    /// 列出版本记录，<b>只带元数据</b>：<see cref="HostedSiteRevision.Html"/> 与
    /// <see cref="HostedSiteRevision.VerifiedFiles"/> 恒为空值，要正文或文件请逐条走
    /// <see cref="GetAsync"/>。
    ///
    /// 这不是省事，是必须：一条版本记录可以带上多兆的整页 HTML 与整包文件字节，
    /// 而列表一次取 100 条——不排除这两个字段的话，光是打开版本面板就会读出并分配
    /// 几百兆，卡顿甚至打爆 API 进程。返回类型仍是实体，所以「哪些字段是空的」
    /// 必须写在契约里，不能只在实现里偷偷 Project 掉（那正是「看着完整、其实被掏空」）。
    /// </summary>
    Task<IReadOnlyList<HostedSiteRevision>> ListAsync(
        string siteId,
        string userId,
        CancellationToken ct = default);

    Task<HostedSiteRevision?> GetAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default);

    /// <summary>复核当前站点访问权，并只投影一个已验证版本文件，供短时预览读取。</summary>
    Task<HostedSiteRevisionFile?> GetVerifiedFileAsync(
        string siteId,
        string revisionId,
        string path,
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
