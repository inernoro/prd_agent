using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// CDS 报告镜像库每小时同步：刷哪些库的哪些报告、各自从哪个 CDS 拉。
///
/// 三条判据，各自都有过教训：
///
/// 一、**要刷的清单来自库里已有的条目**，不来自另记的一套「范围」账。早先那版把首次导入
///     的筛选范围记在库上、自动任务照着重放，前提是「首次导入的范围代表用户想要什么」——
///     产品里根本不成立：唯一的导入入口是 CDS 报告页的「保存到 MAP 知识库」，一次存一份、
///     都进同一个默认库。于是每存一份新的就把范围改写成那一份，之前存的全部不再更新，
///     **存得越多坏得越彻底**（Codex review P1）。
///
/// 二、**同一个人的两个镜像库都要刷到**。第一版按 OwnerId 去重，导入服务的 find-or-create
///     只会命中其中一个，另一个永远是旧的，而且看不出来。
///
/// 三、**每个库只从它自己那个 CDS 拉**。空 options 会让导入服务挑「最近更新的那条 active
///     连接」，可能从 CDS-B 拉报告写进记着 CDS-A 的库；报告 id 在不同 CDS 上可以重名，
///     混完连「这条是谁家的」都答不上来。
/// </summary>
public class CdsReportSyncTargetTests
{
    private static DocumentStore Store(string id, string owner, string? source)
        => new() { Id = id, OwnerId = owner, CdsReportSourceBaseUrl = source };

    private static CdsReportMirror Mirror(string id, string owner, string? source, params string[] reportIds)
        => new(Store(id, owner, source), reportIds);

    [Fact]
    public void 库里存过哪几份就刷哪几份()
    {
        // 这条是本轮 P1 的核心：用户在 CDS 报告页存了三份，三份都要保持新鲜，
        // 而不是只刷最后存的那一份。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("store-a", "user-1", "https://cds-a.example.com", "rep-1", "rep-2", "rep-3"),
        });

        Assert.Equal(new[] { "rep-1", "rep-2", "rep-3" }, targets.Select(t => t.ReportId));
        Assert.All(targets, t => Assert.Equal("store-a", t.StoreId));
    }

    [Fact]
    public void 每个库都带着自己的来源_不会混源()
    {
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("store-a", "user-1", "https://cds-a.example.com", "rep-1"),
            Mirror("store-b", "user-1", "https://cds-b.example.com", "rep-2"),
        });

        Assert.Equal(2, targets.Count);
        // 同一个人的两个库都要刷到——按 OwnerId 去重会让这里只剩一个。
        Assert.Equal(new[] { "store-a", "store-b" }, targets.Select(t => t.StoreId));
        // 而且各自的源不能串。
        Assert.Equal("https://cds-a.example.com", targets[0].SourceBaseUrl);
        Assert.Equal("https://cds-b.example.com", targets[1].SourceBaseUrl);
        Assert.All(targets, t => Assert.Equal("user-1", t.OwnerId));
    }

    [Fact]
    public void 库还没记过来源时才退回默认连接()
    {
        // 历史数据：手动导入过但那会儿还没有这个字段。退回默认解析，与手动导入首次的
        // 行为一致；导入成功后服务会把来源写回库上，下一轮就钉住了。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("store-legacy", "user-1", null, "rep-1"),
            Mirror("store-blank", "user-2", "   ", "rep-2"),
        });

        Assert.Equal(2, targets.Count);
        Assert.All(targets, t => Assert.Null(t.SourceBaseUrl));
    }

    [Fact]
    public void 来源两侧的空白会被去掉_否则匹配连接时对不上()
    {
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("store-a", "user-1", "  https://cds-a.example.com  ", "rep-1"),
        });

        Assert.Equal("https://cds-a.example.com", targets[0].SourceBaseUrl);
    }

    [Fact]
    public void 缺id或属主的库一律跳过()
    {
        // 缺属主就没法做写入鉴权，缺 id 就只能 find-or-create——两种都不该硬着头皮同步。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("", "user-1", "https://cds-a.example.com", "rep-1"),
            Mirror("store-b", "", "https://cds-a.example.com", "rep-2"),
            Mirror("store-c", "user-1", "https://cds-a.example.com", "rep-3"),
        });

        Assert.Single(targets);
        Assert.Equal("store-c", targets[0].StoreId);
    }

    [Fact]
    public void 空库不产出任何目标_并且空输入也不炸()
    {
        // 反面对照：没有这一条，把判据写成「永远返回一条全量目标」也能让上面几条绿。
        Assert.Empty(CdsReportSyncTargets.Build(new[] { Mirror("store-empty", "user-1", null) }));
        Assert.Empty(CdsReportSyncTargets.Build(Array.Empty<CdsReportMirror>()));
    }

    [Fact]
    public void 报告id去重_重复插入的历史数据不会被刷两遍()
    {
        // 「自动与手动导入没有互斥」这条已知边界会留下重复条目（见 debt 台账）。
        // 那种库不该因此每小时多打一次 CDS。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("store-a", "user-1", null, "rep-1", "rep-1", "  rep-1  ", "rep-2"),
        });

        Assert.Equal(new[] { "rep-1", "rep-2" }, targets.Select(t => t.ReportId));
    }

    [Fact]
    public void 空白报告id一律跳过_不会拼出一个空过滤条件()
    {
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("store-a", "user-1", null, "", "   ", "rep-1"),
        });

        Assert.Single(targets);
        Assert.Equal("rep-1", targets[0].ReportId);
    }

    [Fact]
    public void 超过上限就截断_而且截了多少要报得出来()
    {
        // 上限不是为了省事，是别让一个异常大的库把整轮拖死、顺带打爆 CDS。
        // 但截断必须能被说出来（no-silent-caps）——悄悄少刷会让「每小时都在更新」变成假话。
        var many = Enumerable.Range(1, CdsReportSyncTargets.MaxReportsPerStorePerRound + 7)
            .Select(i => $"rep-{i}")
            .ToArray();
        var mirror = Mirror("store-big", "user-1", null, many);

        var targets = CdsReportSyncTargets.Build(new[] { mirror });

        Assert.Equal(CdsReportSyncTargets.MaxReportsPerStorePerRound, targets.Count);
        Assert.Equal(7, CdsReportSyncTargets.TruncatedCount(mirror));
    }

    [Fact]
    public void 没超上限时截断数是零_不许恒报一个数()
    {
        Assert.Equal(0, CdsReportSyncTargets.TruncatedCount(Mirror("s", "u", null, "rep-1", "rep-2")));
    }

    [Theory]
    // 还没记过来源 = 没有旧状态可作废，不算换源。
    [InlineData(null, "https://cds-a.example.com", false)]
    [InlineData("   ", "https://cds-a.example.com", false)]
    // 同一个源的各种等价写法都不算换：尾斜杠、大小写、两侧空白。
    // 判成「换了」会白清一次水位，把本可增量的一轮变成全量扫描。
    [InlineData("https://cds-a.example.com", "https://cds-a.example.com", false)]
    [InlineData("https://cds-a.example.com/", "https://cds-a.example.com", false)]
    [InlineData("HTTPS://CDS-A.EXAMPLE.COM", "https://cds-a.example.com", false)]
    [InlineData("  https://cds-a.example.com  ", "https://cds-a.example.com", false)]
    // 真换了。这一条判错就是那条静默通路：拿 A 的游标去列 B 的报告。
    [InlineData("https://cds-a.example.com", "https://cds-b.example.com", true)]
    public void 换没换源_同一个源的各种写法不算换(string? recorded, string? resolved, bool expected)
        => Assert.Equal(expected, CdsReportSyncTargets.SourceChanged(recorded, resolved));
}
