using System.Text.RegularExpressions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>
/// 网页生成的真实耗时统计（P50 / P95），给「预计还要多久」一个有根的数。
///
/// 口径（改这里就要同步改接口注释与前端文案）：
/// - 样本：本部署作用域内、最近 <see cref="WindowDays"/> 天创建（CreatedAt）的 generate 类任务，
///   按 执行器（Runtime）× 产物类型（ArtifactType）分组。plan / edit 任务耗时形态完全不同，不混进来。
/// - 生成耗时 = CompletedAt − CreatedAt，只取 Status=Done 的任务；包含排队时间，因为那也是用户在等。
///   失败（Error）与取消（Cancelled）不进耗时，只报条数。
/// - 资料到可分享链接 = 同一用户为这次生成出来的站点（ArtifactSiteId，缺则 ProducedArtifactSiteId）
///   创建的**第一条**网页分享链接（web_page_share_links，share 与 visit 两种用途都算：两者都是
///   可发给别人打开的公开地址；已撤销的也算，看的是它被创建的时刻）的 CreatedAt − 任务 CreatedAt。
///   只统计分享链接由生成者本人创建的情形（查询走 CreatedBy+CreatedAt 索引，也更贴近
///   「这个人从交资料到拿到可分享链接」的端到端含义）；没建过链接的站点不进样本，只计入 eligibleRuns。
/// - 百分位用最近秩法（nearest-rank）：P = 升序第 ceil(p/100·n) 个样本；样本为 0 时为 null。
///   不插值，结果永远是一次真实发生过的耗时。
/// - 部署作用域：生产（DeploymentScope.Current 为 null）只看 DeploymentSlug 缺失的任务；
///   分支预览按分支级作用域（CurrentDurable，跨 revision）统计，否则每次推送样本清零，预估永远不可用。
///   这是只读聚合，不参与认领，所以放宽到分支级不破坏 revision fencing。
/// - 有界：时间窗 + 投影 + 条数上限（<see cref="RunSampleCap"/> 按「执行器 × 产物类型」每组各算一次，
///   量大的一组挤不掉量小的一组；<see cref="ShareSampleCap"/> 为分享链接总上限），截断时在响应里如实标出。任务查询以 UpdatedAt ≥ since 作为隐含下界（终态任务 UpdatedAt ≥ CreatedAt），
///   命中既有索引 idx_design_run_v2_scope_status_updated（DeploymentSlug, Status, UpdatedAt）。
/// </summary>
public static class DesignArtifactTimingStats
{
    public const int WindowDays = 30;
    public const int RunSampleCap = 2000;
    public const int ShareSampleCap = 5000;

    /// <summary>样本少于这个数时前端不许拿它当预估，只能退回经验值并说明数据在积累。</summary>
    public const int EstimateMinSamples = 5;

    public const string PercentileMethod = "nearest-rank";

    private static readonly string[] TerminalStatuses =
    {
        RunStatuses.Done,
        RunStatuses.Error,
        RunStatuses.Cancelled,
    };

    /// <summary>
    /// 最近秩法百分位。输入无需预先排序；空集返回 null。p 取 (0, 100]。
    /// n=1 时任何百分位都是那一个值；n=2 时 P50 取较小值、P95 取较大值。
    /// </summary>
    public static double? NearestRankPercentile(IReadOnlyCollection<double> values, double p)
    {
        if (p <= 0 || p > 100) throw new ArgumentOutOfRangeException(nameof(p), "百分位必须在 (0, 100] 区间");
        if (values.Count == 0) return null;
        var sorted = values.OrderBy(v => v).ToArray();
        var rank = (int)Math.Ceiling(p / 100d * sorted.Length);
        return sorted[Math.Clamp(rank, 1, sorted.Length) - 1];
    }

    public static DesignArtifactTimingMetric Metric(IReadOnlyCollection<double> seconds) => new(
        SampleCount: seconds.Count,
        P50Seconds: RoundSeconds(NearestRankPercentile(seconds, 50)),
        P95Seconds: RoundSeconds(NearestRankPercentile(seconds, 95)),
        EstimateReady: seconds.Count >= EstimateMinSamples);

    private static double? RoundSeconds(double? value) => value is null ? null : Math.Round(value.Value, 1);

    /// <summary>纯聚合：不碰数据库，单测直接喂样本。</summary>
    public static DesignArtifactTimingStatsResult Summarize(
        IReadOnlyCollection<DesignArtifactTimingRunSample> runs,
        IReadOnlyCollection<DesignArtifactTimingShareSample> shares,
        DateTime since,
        DateTime generatedAt,
        bool runSamplesTruncated,
        bool shareSamplesTruncated)
    {
        // (用户, 站点) → 最早一条链接的创建时间
        var firstShareAt = new Dictionary<(string UserId, string SiteId), DateTime>();
        foreach (var share in shares)
        {
            foreach (var siteId in share.SiteIds)
            {
                if (string.IsNullOrEmpty(siteId)) continue;
                var key = (share.CreatedBy, siteId);
                if (!firstShareAt.TryGetValue(key, out var existing) || share.CreatedAt < existing)
                    firstShareAt[key] = share.CreatedAt;
            }
        }

        var groups = runs
            .GroupBy(run => (Runtime: run.Runtime ?? string.Empty, ArtifactType: run.ArtifactType ?? string.Empty))
            .OrderBy(group => group.Key.ArtifactType, StringComparer.Ordinal)
            .ThenBy(group => group.Key.Runtime, StringComparer.Ordinal)
            .Select(group =>
            {
                var generation = new List<double>();
                var toShare = new List<double>();
                var eligible = 0;
                var failed = 0;
                var cancelled = 0;
                foreach (var run in group)
                {
                    if (run.Status == RunStatuses.Error) { failed++; continue; }
                    if (run.Status == RunStatuses.Cancelled) { cancelled++; continue; }
                    if (run.Status != RunStatuses.Done || run.CompletedAt is not { } completedAt) continue;
                    var seconds = (completedAt - run.CreatedAt).TotalSeconds;
                    // 时钟回拨或脏数据产生的负耗时不是一次真实等待，丢掉而不是截成 0。
                    if (seconds < 0) continue;
                    generation.Add(seconds);

                    if (string.IsNullOrEmpty(run.SiteId)) continue;
                    eligible++;
                    if (firstShareAt.TryGetValue((run.UserId, run.SiteId), out var sharedAt) && sharedAt >= run.CreatedAt)
                        toShare.Add((sharedAt - run.CreatedAt).TotalSeconds);
                }

                return new DesignArtifactTimingGroup(
                    Runtime: group.Key.Runtime,
                    ArtifactType: group.Key.ArtifactType,
                    SucceededCount: generation.Count,
                    FailedCount: failed,
                    CancelledCount: cancelled,
                    Generation: Metric(generation),
                    // 分享链接样本被上限截断时，被挤掉的可能正是某些任务的首条链接（用户分享默认每次新建），
                    // 数出来的百分位有偏。数字照给、但不许拿来预估：如实交给调用方 shareSamplesTruncated。
                    MaterialToShareLink: shareSamplesTruncated
                        ? Metric(toShare) with { EstimateReady = false }
                        : Metric(toShare),
                    MaterialToShareLinkEligibleRuns: eligible);
            })
            .ToList();

        return new DesignArtifactTimingStatsResult(
            WindowDays: WindowDays,
            Since: since,
            GeneratedAt: generatedAt,
            PercentileMethod: PercentileMethod,
            EstimateMinSamples: EstimateMinSamples,
            RunSampleCap: RunSampleCap,
            RunSamplesTruncated: runSamplesTruncated,
            ShareSamplesTruncated: shareSamplesTruncated,
            Groups: groups);
    }

    /// <summary>
    /// 统计作用域过滤。生产 = DeploymentSlug 缺失；分支预览 = 分支级作用域本身或其任一 revision。
    /// 锚定前缀正则可以走索引。
    /// </summary>
    public static FilterDefinition<DesignArtifactRun> ScopeFilter(string? durableScope)
    {
        var f = Builders<DesignArtifactRun>.Filter;
        if (durableScope is null) return f.Eq(x => x.DeploymentSlug, null);
        return f.Or(
            f.Eq(x => x.DeploymentSlug, durableScope),
            f.Regex(x => x.DeploymentSlug, new BsonRegularExpression($"^{Regex.Escape(durableScope + "::revision::")}")));
    }

    /// <summary>
    /// 只取「抽样到的任务产出的站点」上的链接，再套上限：先按人取、后按站点筛，
    /// 同一批人建的无关链接或更早的链接会把新任务的有效链接挤出上限，百分位就偏了。
    /// 走 idx_web_page_share_links_creator_created（CreatedBy, CreatedAt）；站点条件在索引扫描后过滤。
    /// 单站点 SiteId 与合集 SiteIds 都认，与 <see cref="WebPageShareLink.TargetSiteIds"/> 同口径。
    /// </summary>
    public static FilterDefinition<WebPageShareLink> ShareFilter(
        IReadOnlyCollection<string> userIds,
        IReadOnlyCollection<string> siteIds,
        DateTime since)
    {
        var sf = Builders<WebPageShareLink>.Filter;
        return sf.In(x => x.CreatedBy, userIds)
               & sf.Gte(x => x.CreatedAt, since)
               & (sf.In(x => x.SiteId, siteIds) | sf.AnyIn(x => x.SiteIds, siteIds));
    }

    /// <summary>单组（执行器 × 产物类型）的任务过滤：在 <see cref="RunFilter"/> 之上各自取最近样本、各自套上限。</summary>
    public static FilterDefinition<DesignArtifactRun> GroupRunFilter(string? durableScope, DateTime since, string runtime, string artifactType)
    {
        var f = Builders<DesignArtifactRun>.Filter;
        return RunFilter(durableScope, since) & f.Eq(x => x.Runtime, runtime) & f.Eq(x => x.ArtifactType, artifactType);
    }

    public static FilterDefinition<DesignArtifactRun> RunFilter(string? durableScope, DateTime since)
    {
        var f = Builders<DesignArtifactRun>.Filter;
        return ScopeFilter(durableScope)
               & f.In(x => x.Status, TerminalStatuses)
               // 隐含下界：终态任务 UpdatedAt ≥ CreatedAt，写出来是为了让既有索引的第三列参与范围扫描。
               & f.Gte(x => x.UpdatedAt, since)
               & f.Gte(x => x.CreatedAt, since)
               & f.Eq(x => x.Operation, DesignArtifactOperations.Generate);
    }

    public static async Task<DesignArtifactTimingStatsResult> QueryAsync(
        MongoDbContext db,
        DateTime now,
        CancellationToken ct)
    {
        var since = now.AddDays(-WindowDays);
        var scope = DeploymentScope.CurrentDurable;
        var baseFilter = RunFilter(scope, since);
        // 上限按组算：全局一个上限时，量大的执行器（如快速生成）会把量小的一组整组挤出窗口，
        // 后者明明样本充足却被报成「还在积累」。组合只有执行器 × 产物类型那几种，Distinct 很小。
        var runtimes = await (await db.DesignArtifactRuns.DistinctAsync(x => x.Runtime, baseFilter, cancellationToken: ct)).ToListAsync(ct);
        var artifactTypes = await (await db.DesignArtifactRuns.DistinctAsync(x => x.ArtifactType, baseFilter, cancellationToken: ct)).ToListAsync(ct);
        var runs = new List<DesignArtifactTimingRunSample>();
        var runsTruncated = false;
        foreach (var runtime in runtimes)
        foreach (var artifactType in artifactTypes)
        {
            var groupRows = await db.DesignArtifactRuns
                .Find(GroupRunFilter(scope, since, runtime, artifactType))
                .SortByDescending(x => x.UpdatedAt)
                .Limit(RunSampleCap)
                .Project(x => new
                {
                    x.Runtime,
                    x.ArtifactType,
                    x.Status,
                    x.CreatedAt,
                    x.CompletedAt,
                    x.ArtifactSiteId,
                    x.ProducedArtifactSiteId,
                    x.UserId,
                })
                .ToListAsync(ct);
            if (groupRows.Count >= RunSampleCap) runsTruncated = true;
            runs.AddRange(groupRows.Select(row => new DesignArtifactTimingRunSample(
                row.Runtime,
                row.ArtifactType,
                row.Status,
                row.CreatedAt,
                row.CompletedAt,
                row.ArtifactSiteId ?? row.ProducedArtifactSiteId,
                row.UserId)));
        }

        var sharedCandidates = runs
            .Where(run => run.Status == RunStatuses.Done && !string.IsNullOrEmpty(run.SiteId) && !string.IsNullOrEmpty(run.UserId))
            .ToList();
        var userIds = sharedCandidates.Select(run => run.UserId).Distinct(StringComparer.Ordinal).ToList();
        var siteIds = sharedCandidates.Select(run => run.SiteId!).Distinct(StringComparer.Ordinal).ToList();

        var shares = new List<DesignArtifactTimingShareSample>();
        var sharesTruncated = false;
        if (userIds.Count > 0)
        {
            var shareRows = await db.WebPageShareLinks
                .Find(ShareFilter(userIds, siteIds, since))
                .SortBy(x => x.CreatedAt)
                .Limit(ShareSampleCap)
                .Project(x => new { x.CreatedBy, x.CreatedAt, x.SiteId, x.SiteIds })
                .ToListAsync(ct);
            sharesTruncated = shareRows.Count >= ShareSampleCap;
            shares = shareRows
                .Select(row => new DesignArtifactTimingShareSample(
                    row.CreatedBy,
                    row.CreatedAt,
                    // 与 WebPageShareLink.TargetSiteIds 同口径：单站点 SiteId + 合集 SiteIds 都认。
                    new WebPageShareLink { SiteId = row.SiteId, SiteIds = row.SiteIds ?? new List<string>() }.TargetSiteIds()))
                .ToList();
        }

        return Summarize(runs, shares, since, now, runsTruncated, sharesTruncated);
    }
}

public sealed record DesignArtifactTimingRunSample(
    string Runtime,
    string ArtifactType,
    string Status,
    DateTime CreatedAt,
    DateTime? CompletedAt,
    string? SiteId,
    string UserId);

public sealed record DesignArtifactTimingShareSample(
    string CreatedBy,
    DateTime CreatedAt,
    IReadOnlyList<string> SiteIds);

public sealed record DesignArtifactTimingMetric(
    int SampleCount,
    double? P50Seconds,
    double? P95Seconds,
    bool EstimateReady);

public sealed record DesignArtifactTimingGroup(
    string Runtime,
    string ArtifactType,
    int SucceededCount,
    int FailedCount,
    int CancelledCount,
    DesignArtifactTimingMetric Generation,
    DesignArtifactTimingMetric MaterialToShareLink,
    int MaterialToShareLinkEligibleRuns);

public sealed record DesignArtifactTimingStatsResult(
    int WindowDays,
    DateTime Since,
    DateTime GeneratedAt,
    string PercentileMethod,
    int EstimateMinSamples,
    int RunSampleCap,
    bool RunSamplesTruncated,
    bool ShareSamplesTruncated,
    IReadOnlyList<DesignArtifactTimingGroup> Groups);
