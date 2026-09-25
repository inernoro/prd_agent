using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 守的是「预计还要多久」的根：百分位算法、失败/取消不混进耗时、资料到分享链接的配对口径、
/// 查询有界且走部署作用域。红绿闭环：把 NearestRankPercentile 改成取平均，边界用例会红；
/// 把 Error 计进耗时，失败隔离用例会红；把 RunFilter 的时间下界删掉，渲染断言会红。
/// </summary>
public sealed class DesignArtifactTimingStatsTests
{
    private static readonly DateTime T0 = new(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Percentile_EmptyIsNull()
    {
        Assert.Null(DesignArtifactTimingStats.NearestRankPercentile(Array.Empty<double>(), 50));
        Assert.Null(DesignArtifactTimingStats.NearestRankPercentile(Array.Empty<double>(), 95));
    }

    [Fact]
    public void Percentile_SingleSampleIsThatSample()
    {
        Assert.Equal(42d, DesignArtifactTimingStats.NearestRankPercentile(new[] { 42d }, 50));
        Assert.Equal(42d, DesignArtifactTimingStats.NearestRankPercentile(new[] { 42d }, 95));
    }

    [Fact]
    public void Percentile_TwoSamples_P50LowerP95Upper()
    {
        var values = new[] { 300d, 60d };
        Assert.Equal(60d, DesignArtifactTimingStats.NearestRankPercentile(values, 50));
        Assert.Equal(300d, DesignArtifactTimingStats.NearestRankPercentile(values, 95));
    }

    [Fact]
    public void Percentile_NearestRankNeverInterpolates()
    {
        var values = Enumerable.Range(1, 20).Select(i => (double)i * 10).Reverse().ToArray();
        // ceil(0.5*20)=10 → 100；ceil(0.95*20)=19 → 190
        Assert.Equal(100d, DesignArtifactTimingStats.NearestRankPercentile(values, 50));
        Assert.Equal(190d, DesignArtifactTimingStats.NearestRankPercentile(values, 95));
        Assert.Equal(200d, DesignArtifactTimingStats.NearestRankPercentile(values, 100));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(101)]
    public void Percentile_RejectsOutOfRange(double p)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => DesignArtifactTimingStats.NearestRankPercentile(new[] { 1d }, p));
    }

    private static DesignArtifactTimingRunSample Done(string runtime, int seconds, string? siteId = null, string user = "u1", int startOffsetMinutes = 0)
    {
        var created = T0.AddMinutes(startOffsetMinutes);
        return new DesignArtifactTimingRunSample(runtime, DesignArtifactTypes.WebPage, RunStatuses.Done, created, created.AddSeconds(seconds), siteId, user);
    }

    private static DesignArtifactTimingRunSample Terminal(string runtime, string status) =>
        new(runtime, DesignArtifactTypes.WebPage, status, T0, T0.AddSeconds(9999), null, "u1");

    private static DesignArtifactTimingStatsResult Summarize(
        IReadOnlyCollection<DesignArtifactTimingRunSample> runs,
        IReadOnlyCollection<DesignArtifactTimingShareSample>? shares = null)
        => DesignArtifactTimingStats.Summarize(runs, shares ?? Array.Empty<DesignArtifactTimingShareSample>(),
            T0.AddDays(-30), T0.AddDays(1), false, false);

    [Fact]
    public void Summarize_FailedAndCancelledAreCountedButNotTimed()
    {
        var result = Summarize(new[]
        {
            Done(DesignArtifactRuntimes.OpenDesign, 600),
            Terminal(DesignArtifactRuntimes.OpenDesign, RunStatuses.Error),
            Terminal(DesignArtifactRuntimes.OpenDesign, RunStatuses.Error),
            Terminal(DesignArtifactRuntimes.OpenDesign, RunStatuses.Cancelled),
        });

        var group = Assert.Single(result.Groups);
        Assert.Equal(1, group.SucceededCount);
        Assert.Equal(2, group.FailedCount);
        Assert.Equal(1, group.CancelledCount);
        Assert.Equal(1, group.Generation.SampleCount);
        Assert.Equal(600d, group.Generation.P50Seconds);
        Assert.Equal(600d, group.Generation.P95Seconds);
        Assert.False(group.Generation.EstimateReady);
    }

    [Fact]
    public void Summarize_GroupsByRuntimeAndMarksReadyAtThreshold()
    {
        var runs = new List<DesignArtifactTimingRunSample>();
        for (var i = 1; i <= DesignArtifactTimingStats.EstimateMinSamples; i++)
            runs.Add(Done(DesignArtifactRuntimes.MapGateway, i * 30));
        runs.Add(Done(DesignArtifactRuntimes.OpenDesign, 700));

        var result = Summarize(runs);
        var gateway = result.Groups.Single(g => g.Runtime == DesignArtifactRuntimes.MapGateway);
        var openDesign = result.Groups.Single(g => g.Runtime == DesignArtifactRuntimes.OpenDesign);

        Assert.True(gateway.Generation.EstimateReady);
        Assert.Equal(DesignArtifactTimingStats.EstimateMinSamples, gateway.Generation.SampleCount);
        Assert.Equal(90d, gateway.Generation.P50Seconds);   // 30,60,90,120,150 → ceil(2.5)=3 → 90
        Assert.Equal(150d, gateway.Generation.P95Seconds);
        Assert.False(openDesign.Generation.EstimateReady);
        Assert.Equal("nearest-rank", result.PercentileMethod);
    }

    [Fact]
    public void Summarize_DropsNegativeDurationsInsteadOfClampingToZero()
    {
        var broken = new DesignArtifactTimingRunSample(DesignArtifactRuntimes.MapGateway, DesignArtifactTypes.WebPage,
            RunStatuses.Done, T0, T0.AddSeconds(-5), null, "u1");
        var group = Assert.Single(Summarize(new[] { broken, Done(DesignArtifactRuntimes.MapGateway, 60) }).Groups);
        Assert.Equal(1, group.Generation.SampleCount);
        Assert.Equal(60d, group.Generation.P50Seconds);
    }

    [Fact]
    public void Summarize_MaterialToShare_UsesFirstLinkBySameUserForProducedSite()
    {
        var runs = new[]
        {
            Done(DesignArtifactRuntimes.OpenDesign, 600, siteId: "site-a", user: "u1"),
            Done(DesignArtifactRuntimes.OpenDesign, 600, siteId: "site-b", user: "u1"),   // 没建过链接
            Done(DesignArtifactRuntimes.OpenDesign, 600, siteId: "site-c", user: "u2"),   // 链接是别人建的
        };
        var shares = new[]
        {
            new DesignArtifactTimingShareSample("u1", T0.AddMinutes(20), new[] { "site-a" }),
            new DesignArtifactTimingShareSample("u1", T0.AddMinutes(12), new[] { "site-x", "site-a" }), // 合集里也认
            new DesignArtifactTimingShareSample("u9", T0.AddMinutes(11), new[] { "site-c" }),
        };

        var group = Assert.Single(Summarize(runs, shares).Groups);
        Assert.Equal(3, group.MaterialToShareLinkEligibleRuns);
        Assert.Equal(1, group.MaterialToShareLink.SampleCount);
        Assert.Equal(12 * 60d, group.MaterialToShareLink.P50Seconds);
    }

    [Fact]
    public void Summarize_TruncatedShareSamples_NeverClaimAnEstimate()
    {
        // 分享链接样本被上限截断时，被挤掉的可能正是某些任务的首条链接：数字照给，但不许拿来预估。
        var runs = Enumerable.Range(0, 6)
            .Select(i => Done(DesignArtifactRuntimes.OpenDesign, 600, siteId: $"site-{i}", user: "u1"))
            .ToArray();
        var shares = Enumerable.Range(0, 6)
            .Select(i => new DesignArtifactTimingShareSample("u1", T0.AddMinutes(20), new[] { $"site-{i}" }))
            .ToArray();

        var complete = Assert.Single(DesignArtifactTimingStats.Summarize(runs, shares, T0.AddDays(-30), T0.AddDays(1), false, false).Groups);
        var truncated = Assert.Single(DesignArtifactTimingStats.Summarize(runs, shares, T0.AddDays(-30), T0.AddDays(1), false, true).Groups);

        Assert.True(complete.MaterialToShareLink.EstimateReady);
        Assert.False(truncated.MaterialToShareLink.EstimateReady);
        Assert.Equal(6, truncated.MaterialToShareLink.SampleCount);
        // 生成耗时不受分享样本截断影响
        Assert.True(truncated.Generation.EstimateReady);
    }

    private static string Render(FilterDefinition<DesignArtifactRun> filter)
        => filter.Render(new RenderArgs<DesignArtifactRun>(
                BsonSerializer.SerializerRegistry.GetSerializer<DesignArtifactRun>(),
                BsonSerializer.SerializerRegistry))
            .ToString();

    [Fact]
    public void ShareFilter_KeepsOnlyLinksOnSampledSitesBeforeTheCap()
    {
        var rendered = DesignArtifactTimingStats.ShareFilter(["u1"], ["site-a"], T0)
            .Render(new RenderArgs<WebPageShareLink>(
                BsonSerializer.SerializerRegistry.GetSerializer<WebPageShareLink>(),
                BsonSerializer.SerializerRegistry))
            .ToString();
        Assert.Contains("\"CreatedBy\" : { \"$in\" : [\"u1\"] }", rendered, StringComparison.Ordinal);
        Assert.Contains("\"CreatedAt\" : { \"$gte\"", rendered, StringComparison.Ordinal);
        // 单站点与合集两种指向都要在库里就筛掉无关链接，否则上限会被它们占满
        Assert.Contains("\"SiteId\" : { \"$in\" : [\"site-a\"] }", rendered, StringComparison.Ordinal);
        Assert.Contains("\"SiteIds\" : { \"$in\" : [\"site-a\"] }", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void RunFilter_ProductionIsBoundedAndOnlyGenerate()
    {
        var rendered = Render(DesignArtifactTimingStats.RunFilter(null, T0));
        Assert.Contains("\"DeploymentSlug\" : null", rendered, StringComparison.Ordinal);
        Assert.Contains("\"UpdatedAt\" : { \"$gte\"", rendered, StringComparison.Ordinal);
        Assert.Contains("\"CreatedAt\" : { \"$gte\"", rendered, StringComparison.Ordinal);
        Assert.Contains("\"Operation\" : \"generate\"", rendered, StringComparison.Ordinal);
        Assert.Contains("\"Status\" : { \"$in\" : [\"Done\", \"Error\", \"Cancelled\"] }", rendered, StringComparison.Ordinal);
    }

    [Fact]
    public void ScopeFilter_PreviewMatchesBranchAcrossRevisionsOnly()
    {
        var rendered = Render(DesignArtifactTimingStats.ScopeFilter("proj::feat.x"));
        Assert.Contains("\"DeploymentSlug\" : \"proj::feat.x\"", rendered, StringComparison.Ordinal);
        // 锚定前缀 + 转义：不许把 proj::feat-x 或 proj::feat.xyz 的任务算进来
        Assert.Contains("/^proj::feat\\.x::revision::/", rendered, StringComparison.Ordinal);
    }
}
