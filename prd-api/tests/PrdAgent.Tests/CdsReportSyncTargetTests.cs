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
/// 三、**每一份报告刷回它自己那台 CDS**，条目上记着；没记的一律留空，不拿库级来源顶替。
///     库级来源记的是「最后一次导入从哪来」，拿它替一条来历不明的老条目作答就是猜；
///     而且那个猜会绕开「认不出就不猜」那道闸——重新保存其中一份就会把库级来源钉上，
///     下一轮剩下的老条目全都「有来源」了（Codex review P1）。报告 id 在不同 CDS 上可以重名，
///     混完连「这条是谁家的」都答不上来。
/// </summary>
public class CdsReportSyncTargetTests
{
    private static DocumentStore Store(string id, string owner, string? source)
        => new() { Id = id, OwnerId = owner, CdsReportSourceBaseUrl = source };

    /// <summary>条目没记自己的来源（老数据）——判据应把目标源留空，交给凭据解析去判。</summary>
    private static CdsReportMirror Mirror(string id, string owner, string? source, params string[] reportIds)
        => new(Store(id, owner, source), reportIds.Select(r => new CdsMirroredReport(r, null)).ToArray());

    /// <summary>条目各自记着自己从哪台 CDS 来的。</summary>
    private static CdsReportMirror MirrorWithSources(
        string id, string owner, string? storeSource, params (string ReportId, string? Source)[] entries)
        => new(Store(id, owner, storeSource),
            entries.Select(e => new CdsMirroredReport(e.ReportId, e.Source)).ToArray());

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
            MirrorWithSources("store-a", "user-1", null, ("rep-1", "https://cds-a.example.com")),
            MirrorWithSources("store-b", "user-1", null, ("rep-2", "https://cds-b.example.com")),
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
        // 历史数据：手动导入过但那会儿还没有这个字段。目标源留空，交给凭据解析判——
        // 只有一条已授权连接时照常用，两条以上就让这一份失败。导入成功后条目上会盖上来源，
        // 下一轮就钉住了。
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
            MirrorWithSources("store-a", "user-1", null, ("rep-1", "  https://cds-a.example.com  ")),
        });

        Assert.Equal("https://cds-a.example.com", targets[0].SourceBaseUrl);
    }

    [Fact]
    public void 缺id或属主的库一律跳过()
    {
        // 缺属主就没法做写入鉴权，缺 id 就只能 find-or-create——两种都不该硬着头皮同步。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Mirror("", "user-1", null, "rep-1"),
            Mirror("store-b", "", null, "rep-2"),
            Mirror("store-c", "user-1", null, "rep-3"),
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

    [Fact]
    public void 每一份报告刷回它自己那台cds_不按库级来源一刀切()
    {
        // 一个人从两台 CDS 各存过报告，两次都落进同一个默认库；库级来源被后存的那次覆盖
        // （这里特意把它设成 B，用来证明判据完全不看它）。
        // 照库级来源刷，先存的那台的报告要么找不到，要么在 id 撞车时被另一台的同名报告
        // 覆盖掉——正是这个文件通篇在防的「混源」，只是换了个入口（Codex review P1）。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            MirrorWithSources("store-a", "user-1", "https://cds-b.example.com",
                ("rep-1", "https://cds-a.example.com"),
                ("rep-2", "https://cds-b.example.com")),
        });

        Assert.Equal(2, targets.Count);
        Assert.Equal("https://cds-a.example.com", targets[0].SourceBaseUrl);
        Assert.Equal("https://cds-b.example.com", targets[1].SourceBaseUrl);
    }

    [Fact]
    public void 两台cds上的同名报告是两份东西_不许按id去重吞掉一份()
    {
        // 报告 id 在不同 CDS 上可以重名。只按 id 去重会把其中一份悄悄吞掉，
        // 而那一份从此再也不刷新，且看不出来。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            MirrorWithSources("store-a", "user-1", null,
                ("rep-same", "https://cds-a.example.com"),
                ("rep-same", "https://cds-b.example.com")),
        });

        Assert.Equal(2, targets.Count);
        Assert.Equal(
            new[] { "https://cds-a.example.com", "https://cds-b.example.com" },
            targets.Select(t => t.SourceBaseUrl));
    }

    [Fact]
    public void 同一台cds上的同一份报告仍然只刷一遍()
    {
        // 反面对照：上一条把去重键加宽了，这条保证它没宽过头——
        // 真正重复的条目（同 id 同源）还是只该刷一次。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            MirrorWithSources("store-a", "user-1", null,
                ("rep-1", "https://cds-a.example.com"),
                ("rep-1", "  https://cds-a.example.com  "),
                ("  rep-1  ", "https://cds-a.example.com")),
        });

        Assert.Single(targets);
    }

    [Fact]
    public void 条目没记来源时目标源留空_不拿库级来源顶替()
    {
        // 本改动之前存进来的条目没有 cdsSourceBaseUrl。它们不该被跳过（还是要刷），
        // 但**也不能拿库级来源替它作答**——那记的是「最后一次导入从哪来」，不是「这一份从哪来」。
        //
        // 这条防的是一条绕闸通路：老库里一堆没记来源的条目，用户按提示重新保存**其中一份**，
        // 库级来源就被钉上；下一轮剩下那些老条目全都「有来源」了，于是被一股脑按这个源去刷，
        // 「认不出就不猜」那道闸从此形同虚设（Codex review P1）。
        //
        // 留空之后由凭据解析判：只有一条已授权连接时照常用，两条以上就让这一份失败。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            MirrorWithSources("store-a", "user-1", "https://cds-legacy.example.com",
                ("rep-old", null),
                ("rep-old-blank", "   ")),
        });

        Assert.Equal(2, targets.Count);
        Assert.All(targets, t => Assert.Null(t.SourceBaseUrl));
    }

    [Fact]
    public void 同一个库里_记了来源的照自己的刷_没记的留空()
    {
        // 反面对照：上一条把库级兜底删掉了，这条保证没删过头——条目自己记着来源时
        // 仍然按它刷，不会连带被清成空。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            MirrorWithSources("store-a", "user-1", "https://cds-legacy.example.com",
                ("rep-known", "https://cds-a.example.com"),
                ("rep-old", null)),
        });

        Assert.Equal(2, targets.Count);
        Assert.Equal("https://cds-a.example.com", targets[0].SourceBaseUrl);
        Assert.Null(targets[1].SourceBaseUrl);
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

    [Theory]
    // 一条都没有：两种调用方都只能失败，没什么可挑的。
    [InlineData(0, true, CdsSourcePick.None)]
    [InlineData(0, false, CdsSourcePick.None)]
    // 只有一条：那就不叫猜。自动刷新照样用，否则装了一条连接的人反而刷不动。
    [InlineData(1, true, CdsSourcePick.Single)]
    [InlineData(1, false, CdsSourcePick.Single)]
    // 两条以上：手动导入维持原样（人当场发起、挑错看得见）；
    // 自动刷新必须停手——挑错是把 CDS-B 的正文写进一条来自 CDS-A 的条目，不响。
    [InlineData(2, true, CdsSourcePick.Single)]
    [InlineData(2, false, CdsSourcePick.Ambiguous)]
    [InlineData(5, false, CdsSourcePick.Ambiguous)]
    public void 没记来源时_只有一条连接才不算猜(int count, bool allowGuess, CdsSourcePick expected)
        => Assert.Equal(expected, CdsReportSyncTargets.PickDefaultSource(count, allowGuess));
}
