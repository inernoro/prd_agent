using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 私有资料的可见范围。取值只由 <see cref="HostedSitePrivateSourceRules.ClassifyScope"/> 从知识库既有字段推出，
/// 前端只显示服务端给的 scopeLabel，不自己维护映射。
/// </summary>
public static class HostedSitePrivateSourceScopes
{
    /// <summary>个人知识库：只有所有者能读。</summary>
    public const string OwnerOnly = "owner-only";

    /// <summary>分享到了团队（DocumentStore.SharedTeamIds 非空）。</summary>
    public const string Team = "team";

    /// <summary>项目知识库（DocumentStore.PmProjectId）。</summary>
    public const string Project = "project";

    /// <summary>产品知识库（DocumentStore.ProductKnowledgeRef）。</summary>
    public const string Product = "product";

    /// <summary>识图知识库（DocumentStore.ShituCategoryRef），按后台权限可读。</summary>
    public const string Shitu = "shitu";

    /// <summary>条目或所在知识库已经不存在：无法证明它是公开的，按私有对待。</summary>
    public const string Unavailable = "unavailable";

    public static string Label(string scope) => scope switch
    {
        OwnerOnly => "个人知识库，仅所有者可见",
        Team => "团队知识库，仅团队成员可见",
        Project => "项目知识库，仅项目成员可见",
        Product => "产品知识库，仅产品成员可见",
        Shitu => "识图知识库，按后台权限可见",
        Unavailable => "资料已删除或无法读取，无法确认是否公开",
        _ => "非公开知识库",
    };
}

/// <summary>哪一个动作会把内容对外发出。写进确认记录，便于回查「当时是为什么确认的」。</summary>
public static class HostedSitePrivateSourceActions
{
    public const string RevisionPublish = "revision-publish";
    public const string ShareCreate = "share-create";
    public const string ShareWiden = "share-widen";
    public const string SitePublic = "site-public";
}

public sealed record HostedSitePrivateSourceItem(
    string SiteId,
    string EntryId,
    string Title,
    string? StoreId,
    string? StoreName,
    string Scope);

/// <summary>
/// 一次核查的结果。Items 只含私有资料；Fingerprint 是这组私有资料的指纹（没有私有资料时为 null）。
/// AnchorRevisionIds：站点 → 当前线上内容对应的版本，确认记录写在它上面。
/// </summary>
public sealed record HostedSitePrivateSourceReport(
    IReadOnlyList<HostedSitePrivateSourceItem> Items,
    string? Fingerprint,
    IReadOnlyDictionary<string, string> AnchorRevisionIds)
{
    public static readonly HostedSitePrivateSourceReport Empty = new(
        Array.Empty<HostedSitePrivateSourceItem>(),
        null,
        new Dictionary<string, string>(StringComparer.Ordinal));

    public bool HasPrivateSources => Items.Count > 0;
}

public enum HostedSitePrivateSourceVerdict
{
    /// <summary>没有私有引用，或带来的确认与当前引用集合一致。</summary>
    Allowed,

    /// <summary>有私有引用，请求没带确认。</summary>
    ConfirmationRequired,

    /// <summary>有私有引用，带来的确认与当前集合对不上（确认之后引用变了）。</summary>
    ConfirmationStale,
}

public sealed record HostedSitePrivateSourceDecision(
    HostedSitePrivateSourceVerdict Verdict,
    HostedSitePrivateSourceReport Report)
{
    public bool Allowed => Verdict == HostedSitePrivateSourceVerdict.Allowed;

    public string ErrorCode => Verdict == HostedSitePrivateSourceVerdict.ConfirmationStale
        ? ErrorCodes.HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_STALE
        : ErrorCodes.HOSTED_SITE_PRIVATE_SOURCE_CONFIRMATION_REQUIRED;

    public string Message => HostedSitePrivateSourceRules.BuildRefusalMessage(Verdict, Report);
}

/// <summary>
/// 纯判定：私有判定、指纹、内容血缘、确认比对。不碰数据库，方便直接测。
/// </summary>
public static class HostedSitePrivateSourceRules
{
    /// <summary>沿版本血缘最多回溯多少步（防环、防异常长链）。读不到头时按「更早版本的来源无法确认」列给作者，不当完整结果。</summary>
    public const int MaxLineageDepth = 64;

    /// <summary>确认记录在一条版本上最多保留多少条。</summary>
    public const int MaxConfirmationsPerRevision = 50;

    private const string FingerprintPrefix = "psc1:";

    /// <summary>
    /// 「私有」的唯一判据：复用知识库既有的 <see cref="DocumentStore.IsPublic"/>（「是否公开（其他用户可浏览）」，
    /// 与 DocumentStoreController.CanReadStoreAsync、DesignKnowledgeSnapshotResolver.CanReadAsync 的公开轴同一个字段）。
    /// 不是公开库的一律算私有；条目或知识库已经找不到时同样算私有——我们没法证明它是公开的。
    /// </summary>
    public static bool IsPrivate(DocumentEntry? entry, DocumentStore? store)
        => entry == null || store == null || !store.IsPublic;

    /// <summary>私有资料的可见范围，只从知识库既有的访问轴字段推出，不另设字段。</summary>
    public static string ClassifyScope(DocumentEntry? entry, DocumentStore? store)
    {
        if (entry == null || store == null) return HostedSitePrivateSourceScopes.Unavailable;
        if (!string.IsNullOrWhiteSpace(store.PmProjectId)) return HostedSitePrivateSourceScopes.Project;
        if (!string.IsNullOrWhiteSpace(store.ProductKnowledgeRef)) return HostedSitePrivateSourceScopes.Product;
        if (!string.IsNullOrWhiteSpace(store.ShituCategoryRef)) return HostedSitePrivateSourceScopes.Shitu;
        if (store.SharedTeamIds is { Count: > 0 }) return HostedSitePrivateSourceScopes.Team;
        return HostedSitePrivateSourceScopes.OwnerOnly;
    }

    /// <summary>指纹只由「哪些私有条目」决定：顺序、重复都不影响；集合一变指纹就变。</summary>
    public static string? ComputeFingerprint(IEnumerable<string> privateEntryIds)
    {
        var ids = privateEntryIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id.Trim())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToList();
        if (ids.Count == 0) return null;
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', ids)));
        return FingerprintPrefix + Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static HostedSitePrivateSourceVerdict Evaluate(HostedSitePrivateSourceReport report, string? confirmedFingerprint)
    {
        if (!report.HasPrivateSources || report.Fingerprint == null)
            return HostedSitePrivateSourceVerdict.Allowed;
        var confirmed = confirmedFingerprint?.Trim();
        if (string.IsNullOrEmpty(confirmed))
            return HostedSitePrivateSourceVerdict.ConfirmationRequired;
        return string.Equals(confirmed, report.Fingerprint, StringComparison.Ordinal)
            ? HostedSitePrivateSourceVerdict.Allowed
            : HostedSitePrivateSourceVerdict.ConfirmationStale;
    }

    /// <summary>
    /// 内容的上一代：回退版的内容来自被选中的历史版本，其余版本来自它所基于的上一版。
    /// 基线（首次生成 / 手动上传后的快照）没有上一代，血缘到此为止。
    /// </summary>
    public static string? PreviousContentRevisionId(HostedSiteRevision revision)
        => string.Equals(revision.Source, HostedSiteRevisionSources.Rollback, StringComparison.Ordinal)
            ? revision.RollbackTargetRevisionId ?? revision.ParentRevisionId
            : revision.ParentRevisionId;

    /// <summary>拒绝时给人读的那句话：先说后果，再说要做什么。</summary>
    public static string BuildRefusalMessage(HostedSitePrivateSourceVerdict verdict, HostedSitePrivateSourceReport report)
    {
        var titles = report.Items
            .Select(item => item.Title)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var shown = string.Join("、", titles.Take(3).Select(title => $"《{title}》"));
        var more = titles.Count > 3 ? $"等 {titles.Count} 份" : string.Empty;
        return verdict == HostedSitePrivateSourceVerdict.ConfirmationStale
            ? $"本页引用的私有资料在你确认之后发生了变化（现在是 {shown}{more}），请重新确认后再发布。"
            : $"本页引用了 {titles.Count} 份私有资料（{shown}{more}），发布后任何拿到链接的人都能看到其中内容，请先确认再发布。";
    }
}

/// <summary>核查与记录所需的数据读写，抽出来是为了让判定逻辑能脱离 Mongo 直接测。</summary>
public interface IHostedSitePrivateSourceStore
{
    /// <summary>
    /// 站点没有活动发布指针时，按内容版本找对应的已发布版本（基线快照走这条；不含 HTML 与文件字节）。
    /// 有活动指针时一律按指针取，见 <see cref="HostedSitePrivateSourceGate"/> 的 ResolveCurrentRevisionAsync。
    /// </summary>
    Task<HostedSiteRevision?> FindCurrentRevisionAsync(string siteId, DateTime contentVersion, CancellationToken ct);

    /// <summary>站点下的某条版本（不含 HTML 与文件字节）。</summary>
    Task<HostedSiteRevision?> FindRevisionAsync(string siteId, string revisionId, CancellationToken ct);

    Task<IReadOnlyList<DocumentEntry>> FindEntriesAsync(IReadOnlyCollection<string> entryIds, CancellationToken ct);

    Task<IReadOnlyList<DocumentStore>> FindStoresAsync(IReadOnlyCollection<string> storeIds, CancellationToken ct);

    /// <summary>这个站点此刻有没有「不止协作者能打开」的有效链接（登录可见 / 公开 / 访问便捷链 / 旧版无可见性字段的链接）。</summary>
    Task<bool> HasExternalShareLinkAsync(string siteId, DateTime now, CancellationToken ct);

    Task AppendConfirmationAsync(string revisionId, HostedSitePrivateSourceConfirmation confirmation, CancellationToken ct);
}

public interface IHostedSitePrivateSourceGate
{
    /// <summary>这几个站点当前线上内容引用的私有资料（分享、设为公开前用）。</summary>
    Task<HostedSitePrivateSourceReport> InspectSitesAsync(IReadOnlyList<HostedSite> sites, CancellationToken ct);

    /// <summary>某条版本（通常是待发布草稿）连同它的内容血缘引用的私有资料。</summary>
    Task<HostedSitePrivateSourceReport> InspectRevisionAsync(HostedSite site, HostedSiteRevision revision, CancellationToken ct);

    /// <summary>站点此刻是否已经对外可见（设为公开，或有不止协作者能打开的有效链接）。</summary>
    Task<bool> IsExternallyExposedAsync(HostedSite site, CancellationToken ct);

    /// <summary>新建对外分享 / 放宽分享可见性 / 设为公开：有私有引用就必须带着一致的确认，放行前先落确认记录。</summary>
    Task<HostedSitePrivateSourceDecision> EnforceForSitesAsync(
        IReadOnlyList<HostedSite> sites,
        string action,
        string userId,
        string? confirmedFingerprint,
        CancellationToken ct);

    /// <summary>
    /// 发布草稿：只有站点已经对外可见时才需要确认（发布即被拿到链接的人看到）；
    /// 没有对外链接时发布只影响作者自己，放行且不记录，等真正分享时再由分享那道闸确认。
    /// </summary>
    Task<HostedSitePrivateSourceDecision> EnforceForRevisionPublishAsync(
        HostedSite site,
        HostedSiteRevision revision,
        string userId,
        string? confirmedFingerprint,
        CancellationToken ct);
}

/// <summary>
/// 发布前私有资料确认的唯一判定源（2026-09-24，轨道 D0）。
///
/// 来源依据是版本账本上已经记下的 <see cref="HostedSiteRevision.KnowledgeEntryIds"/>，沿内容血缘
/// （<see cref="HostedSitePrivateSourceRules.PreviousContentRevisionId"/>）向上合并：一次不带新资料的
/// 「帮我修改」产出的草稿，内容里仍然是首次生成时那几份资料，只看草稿自己的引用会漏掉它们。
///
/// 「当前线上版本」按站点的活动发布指针解析（含停在 publishing 的恢复态），指针悬空按「无法确认」列出，
/// 见 ResolveCurrentRevisionAsync。血缘超过 MaxLineageDepth 或成环、没读到头时同样按「无法确认」列出，
/// 见 TruncatedLineageItem。
///
/// 已知边界（同步记在 doc/debt.platform.open-design.md）：
/// - 没有版本账本（也没有活动发布指针）的旧站点、从未在工作台打开过的上传站点，查不到来源，按现状放行；
/// - 手动重传 / 上传优化改写内容后生成的新基线不继承旧来源，按无来源放行；
/// - 站点原始对象地址、访问 / 扫码便捷链、导出 HTML 不经过这道闸。
/// </summary>
public sealed class HostedSitePrivateSourceGate : IHostedSitePrivateSourceGate
{
    private readonly IHostedSitePrivateSourceStore _store;
    private readonly Func<DateTime> _now;

    public HostedSitePrivateSourceGate(IHostedSitePrivateSourceStore store)
        : this(store, () => DateTime.UtcNow)
    {
    }

    internal HostedSitePrivateSourceGate(IHostedSitePrivateSourceStore store, Func<DateTime> now)
    {
        _store = store;
        _now = now;
    }

    public async Task<HostedSitePrivateSourceReport> InspectSitesAsync(IReadOnlyList<HostedSite> sites, CancellationToken ct)
    {
        var lineages = new List<(string SiteId, IReadOnlyList<string> EntryIds)>();
        var anchors = new Dictionary<string, string>(StringComparer.Ordinal);
        var unresolved = new List<HostedSitePrivateSourceItem>();
        foreach (var site in sites.DistinctBy(site => site.Id, StringComparer.Ordinal))
        {
            var (current, missingPointer) = await ResolveCurrentRevisionAsync(site, ct);
            if (missingPointer != null)
            {
                unresolved.Add(UnresolvedActiveRevisionItem(site, missingPointer));
                continue;
            }
            if (current == null) continue; // 没有版本账本：旧站点 / 无来源记录，按现状放行（已知边界）
            anchors[site.Id] = current.Id;
            var lineage = await CollectLineageEntryIdsAsync(site.Id, current, ct);
            lineages.Add((site.Id, lineage.EntryIds));
            if (lineage.TruncatedAfterRevisionId != null)
                unresolved.Add(TruncatedLineageItem(site, lineage.TruncatedAfterRevisionId));
        }
        return await BuildReportAsync(lineages, anchors, ct, unresolved);
    }

    /// <summary>
    /// 站点当前线上内容对应的版本。站点的活动发布指针 <see cref="HostedSite.PublishedRevisionId"/> 是地面真值：
    /// 它与入口对象、ContentVersion 在同一次 CAS 里切换，其他内容写入路径都会清空它
    /// （见 HostedSiteRevisionService.PublishAsync 与 HostedSite 字段注释）。
    ///
    /// 所以有指针就按指针取，**不看版本状态**：发布时站点已切换、只是最后一步写版本账本失败，
    /// 那条已经生效的版本会停在 publishing（PublishedContentVersion 也还没写），只认 published 的查法
    /// 会把它当成「没有账本」放行分享 / 设为公开（Codex P1）。指针指向的版本不论停在哪个状态，
    /// 站点上跑的都是它的内容，都必须纳入核查。
    ///
    /// 有指针却找不到那条版本（被删 / 数据损坏）时，返回 missingPointer，不当作「无来源」放行：
    /// 与「资料已删除按私有对待」同一语义（<see cref="HostedSitePrivateSourceScopes.Unavailable"/>）——
    /// 无法证明它没引用私有资料，就列出来让作者看到并确认。
    ///
    /// 没有指针时（基线快照、旧站点、手动重传后指针被清空）才退回「已发布且内容版本一致」的查法。
    /// </summary>
    private async Task<(HostedSiteRevision? Revision, string? MissingPointer)> ResolveCurrentRevisionAsync(
        HostedSite site,
        CancellationToken ct)
    {
        var pointer = site.PublishedRevisionId?.Trim();
        if (!string.IsNullOrEmpty(pointer))
        {
            var active = await _store.FindRevisionAsync(site.Id, pointer, ct);
            return active != null ? (active, null) : (null, pointer);
        }
        return (await _store.FindCurrentRevisionAsync(site.Id, site.ContentVersion, ct), null);
    }

    /// <summary>
    /// 活动版本找不到时列给作者看的一条「无法确认」。EntryId 带站点与指针，指针不变指纹就不变，
    /// 确认一次即可放行；指针换了（站点重新发布）就需要重新确认。
    /// 已知边界：这种站点没有可挂的版本记录，确认记录无处落（DecideAndRecordAsync 按锚点写，这里没有锚点）。
    /// </summary>
    private static HostedSitePrivateSourceItem UnresolvedActiveRevisionItem(HostedSite site, string pointer)
    {
        var siteTitle = string.IsNullOrWhiteSpace(site.Title) ? "本站点" : $"「{site.Title.Trim()}」";
        return new HostedSitePrivateSourceItem(
            site.Id,
            $"{UnresolvedRevisionEntryPrefix}{site.Id}:{pointer}",
            $"{siteTitle}当前线上版本的来源记录缺失",
            null,
            null,
            HostedSitePrivateSourceScopes.Unavailable);
    }

    /// <summary>「活动版本找不到」那一条的 EntryId 前缀；它不是知识库条目，只借条目 ID 的位置参与指纹。</summary>
    public const string UnresolvedRevisionEntryPrefix = "unresolved-revision:";

    /// <summary>
    /// 血缘没能读到头时列给作者看的一条「无法确认」：沿上一代回溯撞上步数上限
    /// （<see cref="HostedSitePrivateSourceRules.MaxLineageDepth"/>），或者撞上了环，更早的祖先版本没读到。
    /// 私有资料可能只挂在那些祖先上，把截断后的集合当成完整结果会不经确认放行（Codex P1）。
    ///
    /// EntryId 带站点与「最后读到的那一版」，与 <see cref="UnresolvedActiveRevisionItem"/> 同一写法：
    /// 血缘不变指纹就不变，确认一次即可放行；再发布一版（起点变了）就要重新确认。
    /// 这一条挂在站点上，站点有锚点版本，确认记录照常落在锚点上。
    /// </summary>
    private static HostedSitePrivateSourceItem TruncatedLineageItem(HostedSite site, string lastReadRevisionId)
    {
        var siteTitle = string.IsNullOrWhiteSpace(site.Title) ? "本站点" : $"「{site.Title.Trim()}」";
        return new HostedSitePrivateSourceItem(
            site.Id,
            $"{TruncatedLineageEntryPrefix}{site.Id}:{lastReadRevisionId}",
            $"{siteTitle}更早版本的来源无法确认",
            null,
            null,
            HostedSitePrivateSourceScopes.Unavailable);
    }

    /// <summary>「血缘没读到头」那一条的 EntryId 前缀；同样不是知识库条目，只借条目 ID 的位置参与指纹。</summary>
    public const string TruncatedLineageEntryPrefix = "lineage-truncated:";

    public async Task<HostedSitePrivateSourceReport> InspectRevisionAsync(
        HostedSite site,
        HostedSiteRevision revision,
        CancellationToken ct)
    {
        var lineage = await CollectLineageEntryIdsAsync(site.Id, revision, ct);
        var anchors = new Dictionary<string, string>(StringComparer.Ordinal) { [site.Id] = revision.Id };
        var unresolved = lineage.TruncatedAfterRevisionId == null
            ? Array.Empty<HostedSitePrivateSourceItem>()
            : new[] { TruncatedLineageItem(site, lineage.TruncatedAfterRevisionId) };
        return await BuildReportAsync([(site.Id, lineage.EntryIds)], anchors, ct, unresolved);
    }

    public async Task<bool> IsExternallyExposedAsync(HostedSite site, CancellationToken ct)
        => string.Equals(site.Visibility, "public", StringComparison.OrdinalIgnoreCase)
           || await _store.HasExternalShareLinkAsync(site.Id, _now(), ct);

    public async Task<HostedSitePrivateSourceDecision> EnforceForSitesAsync(
        IReadOnlyList<HostedSite> sites,
        string action,
        string userId,
        string? confirmedFingerprint,
        CancellationToken ct)
    {
        var report = await InspectSitesAsync(sites, ct);
        return await DecideAndRecordAsync(report, action, userId, confirmedFingerprint, ct);
    }

    public async Task<HostedSitePrivateSourceDecision> EnforceForRevisionPublishAsync(
        HostedSite site,
        HostedSiteRevision revision,
        string userId,
        string? confirmedFingerprint,
        CancellationToken ct)
    {
        // 已经是线上这一版的重放：内容没有新的对外暴露，保持原有幂等行为。
        if (revision.Status == HostedSiteRevisionStatuses.Published)
            return new HostedSitePrivateSourceDecision(HostedSitePrivateSourceVerdict.Allowed, HostedSitePrivateSourceReport.Empty);
        if (!await IsExternallyExposedAsync(site, ct))
            return new HostedSitePrivateSourceDecision(HostedSitePrivateSourceVerdict.Allowed, HostedSitePrivateSourceReport.Empty);
        var report = await InspectRevisionAsync(site, revision, ct);
        return await DecideAndRecordAsync(
            report,
            HostedSitePrivateSourceActions.RevisionPublish,
            userId,
            confirmedFingerprint,
            ct);
    }

    private async Task<HostedSitePrivateSourceDecision> DecideAndRecordAsync(
        HostedSitePrivateSourceReport report,
        string action,
        string userId,
        string? confirmedFingerprint,
        CancellationToken ct)
    {
        var verdict = HostedSitePrivateSourceRules.Evaluate(report, confirmedFingerprint);
        if (verdict != HostedSitePrivateSourceVerdict.Allowed || !report.HasPrivateSources)
            return new HostedSitePrivateSourceDecision(verdict, report);

        // 先落确认、后执行动作：确认本身就是一件已经发生的事；记录失败时整个请求失败，
        // 不会出现「内容发出去了却查不到谁确认过」。
        var confirmedAt = _now();
        foreach (var group in report.Items.GroupBy(item => item.SiteId, StringComparer.Ordinal))
        {
            if (!report.AnchorRevisionIds.TryGetValue(group.Key, out var revisionId)) continue;
            await _store.AppendConfirmationAsync(revisionId, new HostedSitePrivateSourceConfirmation
            {
                UserId = userId,
                ConfirmedAt = confirmedAt,
                Action = action,
                Fingerprint = report.Fingerprint!,
                Sources = group.Select(item => new HostedSitePrivateSourceConfirmedItem
                {
                    EntryId = item.EntryId,
                    Title = item.Title,
                    StoreId = item.StoreId,
                    StoreName = item.StoreName,
                    Scope = item.Scope,
                }).ToList(),
            }, ct);
        }
        return new HostedSitePrivateSourceDecision(HostedSitePrivateSourceVerdict.Allowed, report);
    }

    /// <summary>
    /// 沿内容血缘合并引用。TruncatedAfterRevisionId 非空 = 没读到头：循环结束时还有上一代没读
    /// （撞上步数上限、遇到环，或记着的上一代读不到），值是最后读到的那一版。调用方必须据此列出「无法确认」，
    /// 不许把截断后的集合当完整结果。读到基线（没有上一代）才算读完。
    /// </summary>
    private async Task<(IReadOnlyList<string> EntryIds, string? TruncatedAfterRevisionId)> CollectLineageEntryIdsAsync(
        string siteId,
        HostedSiteRevision start,
        CancellationToken ct)
    {
        var ids = new List<string>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        HostedSiteRevision? current = start;
        string? lastReadId = null;
        string? truncatedAfter = null;
        for (var depth = 0; current != null; depth++)
        {
            if (depth >= HostedSitePrivateSourceRules.MaxLineageDepth || !visited.Add(current.Id))
            {
                // 还有一代没读（步数用完，或者这一代已经读过、血缘成了环）：更早的来源无法确认。
                truncatedAfter = lastReadId ?? start.Id;
                break;
            }
            ids.AddRange(current.KnowledgeEntryIds ?? new List<string>());
            lastReadId = current.Id;
            var previousId = HostedSitePrivateSourceRules.PreviousContentRevisionId(current);
            if (string.IsNullOrWhiteSpace(previousId))
            {
                current = null; // 读到基线：血缘完整
                continue;
            }
            current = await _store.FindRevisionAsync(siteId, previousId, ct);
            if (current == null)
            {
                // 记着有上一代、却读不到（版本只在整站删除或撤销未发布草稿时才会被删，
                // 正常数据里不该出现）：更早的来源同样无法确认，不许当成读到了头。
                truncatedAfter = lastReadId;
            }
        }
        var distinct = ids
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToList();
        return (distinct, truncatedAfter);
    }

    private async Task<HostedSitePrivateSourceReport> BuildReportAsync(
        IReadOnlyList<(string SiteId, IReadOnlyList<string> EntryIds)> lineages,
        IReadOnlyDictionary<string, string> anchors,
        CancellationToken ct,
        IReadOnlyList<HostedSitePrivateSourceItem>? unresolved = null)
    {
        unresolved ??= Array.Empty<HostedSitePrivateSourceItem>();
        var allEntryIds = lineages.SelectMany(item => item.EntryIds).Distinct(StringComparer.Ordinal).ToList();
        if (allEntryIds.Count == 0)
            return new HostedSitePrivateSourceReport(
                unresolved,
                HostedSitePrivateSourceRules.ComputeFingerprint(unresolved.Select(item => item.EntryId)),
                anchors);

        var entries = (await _store.FindEntriesAsync(allEntryIds, ct))
            .ToDictionary(entry => entry.Id, StringComparer.Ordinal);
        var storeIds = entries.Values.Select(entry => entry.StoreId)
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var stores = storeIds.Count == 0
            ? new Dictionary<string, DocumentStore>(StringComparer.Ordinal)
            : (await _store.FindStoresAsync(storeIds, ct)).ToDictionary(store => store.Id, StringComparer.Ordinal);

        var items = new List<HostedSitePrivateSourceItem>();
        foreach (var (siteId, entryIds) in lineages)
        {
            foreach (var entryId in entryIds)
            {
                entries.TryGetValue(entryId, out var entry);
                DocumentStore? store = null;
                if (entry != null) stores.TryGetValue(entry.StoreId, out store);
                if (!HostedSitePrivateSourceRules.IsPrivate(entry, store)) continue;
                items.Add(new HostedSitePrivateSourceItem(
                    siteId,
                    entryId,
                    string.IsNullOrWhiteSpace(entry?.Title) ? "已删除的资料" : entry!.Title.Trim(),
                    entry?.StoreId,
                    store?.Name,
                    HostedSitePrivateSourceRules.ClassifyScope(entry, store)));
            }
        }
        items.AddRange(unresolved);
        var fingerprint = HostedSitePrivateSourceRules.ComputeFingerprint(items.Select(item => item.EntryId));
        return new HostedSitePrivateSourceReport(items, fingerprint, anchors);
    }
}

/// <summary>Mongo 实现：版本读取一律排除 HTML 与文件字节（单条可达数 MB）。</summary>
public sealed class MongoHostedSitePrivateSourceStore : IHostedSitePrivateSourceStore
{
    private static readonly ProjectionDefinition<HostedSiteRevision> HeaderProjection =
        Builders<HostedSiteRevision>.Projection
            .Exclude(revision => revision.Html)
            .Exclude(revision => revision.VerifiedFiles)
            // 确认历史只写不读（追加走 $push），且每条都复制一份来源元数据；沿血缘最多 64 次读取时
            // 把它也带出来，成熟站点一次核查就要搬几 MB（PR #1612 Codex 评审）。
            .Exclude(revision => revision.PrivateSourceConfirmations);

    private readonly MongoDbContext _db;

    public MongoHostedSitePrivateSourceStore(MongoDbContext db)
    {
        _db = db;
    }

    public async Task<HostedSiteRevision?> FindCurrentRevisionAsync(string siteId, DateTime contentVersion, CancellationToken ct)
        => await _db.HostedSiteRevisions
            .Find(revision => revision.SiteId == siteId
                              && revision.Status == HostedSiteRevisionStatuses.Published
                              && revision.PublishedContentVersion == contentVersion)
            .SortByDescending(revision => revision.CreatedAt)
            .Project<HostedSiteRevision>(HeaderProjection)
            .FirstOrDefaultAsync(ct);

    public async Task<HostedSiteRevision?> FindRevisionAsync(string siteId, string revisionId, CancellationToken ct)
        => await _db.HostedSiteRevisions
            .Find(revision => revision.Id == revisionId && revision.SiteId == siteId)
            .Project<HostedSiteRevision>(HeaderProjection)
            .FirstOrDefaultAsync(ct);

    public async Task<IReadOnlyList<DocumentEntry>> FindEntriesAsync(IReadOnlyCollection<string> entryIds, CancellationToken ct)
        => await _db.DocumentEntries.Find(entry => entryIds.Contains(entry.Id)).ToListAsync(ct);

    public async Task<IReadOnlyList<DocumentStore>> FindStoresAsync(IReadOnlyCollection<string> storeIds, CancellationToken ct)
        => await _db.DocumentStores.Find(store => storeIds.Contains(store.Id)).ToListAsync(ct);

    public async Task<bool> HasExternalShareLinkAsync(string siteId, DateTime now, CancellationToken ct)
    {
        var filter = Builders<WebPageShareLink>.Filter;
        var query = filter.And(
            filter.Or(
                filter.Eq(link => link.SiteId, siteId),
                filter.AnyEq(link => link.SiteIds, siteId)),
            filter.Eq(link => link.IsRevoked, false),
            filter.Or(
                filter.Eq(link => link.ExpiresAt, null),
                filter.Gt(link => link.ExpiresAt, now)),
            // owner-only 只放行创建者与站点协作者，不算对外；空串是没有可见性字段的旧链接，读路径按公开处理。
            filter.Ne(link => link.Visibility, "owner-only"));
        return await _db.WebPageShareLinks.Find(query).Limit(1).CountDocumentsAsync(ct) > 0;
    }

    public async Task AppendConfirmationAsync(
        string revisionId,
        HostedSitePrivateSourceConfirmation confirmation,
        CancellationToken ct)
    {
        var result = await _db.HostedSiteRevisions.UpdateOneAsync(
            revision => revision.Id == revisionId,
            Builders<HostedSiteRevision>.Update.PushEach(
                revision => revision.PrivateSourceConfirmations,
                new[] { confirmation },
                slice: -HostedSitePrivateSourceRules.MaxConfirmationsPerRevision),
            cancellationToken: ct);
        if (result.MatchedCount == 0)
            throw new InvalidOperationException("没能写下私有资料确认记录：对应版本已不存在，请刷新后重试");
    }
}

/// <summary>核查结果对前端的唯一投影：scopeLabel 由服务端给出，前端不维护可见范围的文案映射。</summary>
public static class HostedSitePrivateSourceResponses
{
    public static object ToDto(HostedSitePrivateSourceReport report, bool requiresConfirmation, bool? exposed = null) => new
    {
        requiresConfirmation,
        exposed,
        fingerprint = report.Fingerprint,
        items = report.Items
            .GroupBy(item => item.EntryId, StringComparer.Ordinal)
            .Select(group => group.First())
            .Select(item => new
            {
                item.EntryId,
                item.Title,
                item.StoreId,
                item.StoreName,
                item.Scope,
                scopeLabel = HostedSitePrivateSourceScopes.Label(item.Scope),
            })
            .ToList(),
    };
}
