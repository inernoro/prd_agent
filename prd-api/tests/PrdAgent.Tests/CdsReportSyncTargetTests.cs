using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// CDS 报告镜像库每小时同步：刷哪些库、各自从哪个 CDS 拉。
///
/// 守的是 2026-08-25 Codex review 的一条 P1。后台任务第一版按 OwnerId 去重、再用空的
/// 导入参数调导入，于是：
///
/// 一、同一个人有两个镜像库时，导入服务的 find-or-create 只会命中其中一个，
///     另一个永远不刷新，而且看不出来——它只是一直是旧的。
///
/// 二、空 options 会让导入服务挑「最近更新的那条 active CDS 连接」。装了两条系统互联时，
///     它可能从 CDS-B 拉报告、写进一个来源记着 CDS-A 的库里。两个来源的报告 id 和正文
///     就此混进同一个镜像，每小时自动混一次，全程无人报错——报告 id 在不同 CDS 上可以
///     重名，混完连「这条是谁家的」都答不上来。
///
/// 判据抽成纯函数（单独一个文件，只依赖 Core）就是为了让这两条能被钉住：删掉 StoreId 或 SourceBaseUrl 任意一个，
/// 下面都会红。
/// </summary>
public class CdsReportSyncTargetTests
{
    /// <summary>
    /// 默认造一个「记过范围、范围是全量」的库。
    ///
    /// 参数是 bool 不是可空时间：第一版写成「传进来的 ?? 默认值」，于是传 null
    /// （想表达「没有水位」）被 ?? 吃掉又变回默认值，两条断言「应该跳过」的用例
    /// 拿到的其实是有水位的库，CI 才红。**可选参数不能用来表达「显式的空」。**
    /// </summary>
    private static DocumentStore Store(
        string id,
        string owner,
        string? source,
        bool fullySyncedBefore = true,
        bool scopeRecorded = true,
        string? scopeProjectId = null,
        string? scopeReportId = null)
        => new()
        {
            Id = id,
            OwnerId = owner,
            PeerSyncNodeBaseUrl = source,
            PeerSyncLastAt = fullySyncedBefore ? new DateTime(2026, 8, 25, 0, 0, 0, DateTimeKind.Utc) : null,
            CdsReportScopeRecordedAt = scopeRecorded ? new DateTime(2026, 8, 26, 0, 0, 0, DateTimeKind.Utc) : null,
            CdsReportScopeProjectId = scopeProjectId,
            CdsReportScopeReportId = scopeReportId,
        };

    [Fact]
    public void 每个库都带着自己的来源_不会混源()
    {
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("store-a", "user-1", "https://cds-a.example.com"),
            Store("store-b", "user-1", "https://cds-b.example.com"),
        });

        Assert.Equal(2, targets.Count);
        // 同一个人的两个库都要刷到——按 OwnerId 去重会让这里只剩一个。
        Assert.Equal(new[] { "store-a", "store-b" }, targets.Select(t => t.StoreId));
        // 而且各自的源不能串。这一条是本次 P1 的核心。
        Assert.Equal("https://cds-a.example.com", targets[0].SourceBaseUrl);
        Assert.Equal("https://cds-b.example.com", targets[1].SourceBaseUrl);
        Assert.All(targets, t => Assert.Equal("user-1", t.OwnerId));
    }

    [Fact]
    public void 库还没记过来源时才退回默认连接()
    {
        // 历史数据：手动导入过但那会儿还没回写来源。这时退回默认解析，与手动导入首次的
        // 行为一致；导入成功后服务会把来源写回库上，下一轮就钉住了。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("store-legacy", "user-1", null),
            Store("store-blank", "user-2", "   "),
        });

        Assert.All(targets, t => Assert.Null(t.SourceBaseUrl));
    }

    [Fact]
    public void 来源两侧的空白会被去掉_否则匹配连接时对不上()
    {
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("store-a", "user-1", "  https://cds-a.example.com  "),
        });

        Assert.Equal("https://cds-a.example.com", targets[0].SourceBaseUrl);
    }

    [Fact]
    public void 缺id或属主的库一律跳过()
    {
        // 缺属主就没法做写入鉴权，缺 id 就只能 find-or-create——两种都不该硬着头皮同步。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("", "user-1", "https://cds-a.example.com"),
            Store("store-b", "", "https://cds-a.example.com"),
            Store("store-c", "user-1", "https://cds-a.example.com"),
        });

        Assert.Single(targets);
        Assert.Equal("store-c", targets[0].StoreId);
    }

    [Fact]
    public void 一个库都没有时返回空_让调用方去说清原因()
    {
        Assert.Empty(CdsReportSyncTargets.Build(Array.Empty<DocumentStore>()));
    }

    [Fact]
    public void 只存了一条报告的库_每小时刷的还是那一条_不会被撑成整座库()
    {
        // 2026-08-26 真人验收现场撞到的那件事：手工导入 1 份报告成功，等一小时
        // 没有任何自动更新。上一版为了防「被撑成整座库」，干脆把这类库排除在自动
        // 刷新之外——方向对，代价是它**永远不会新鲜**，而且看不出为什么。
        //
        // 正解是把范围记下来重放：刷的还是那一条，既新鲜又不撑大。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("store-one-report", "user-1", "https://cds-a.example.com",
                fullySyncedBefore: false, scopeReportId: "rep-42"),
        });

        Assert.Single(targets);
        Assert.Equal("rep-42", targets[0].ReportId);
        Assert.Null(targets[0].ProjectId);
        Assert.Equal("单份报告 rep-42", CdsReportSyncTargets.DescribeScope(targets[0]));
    }

    [Fact]
    public void 只存了一个项目的库_每小时刷的还是那个项目()
    {
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("store-one-project", "user-1", "https://cds-a.example.com",
                fullySyncedBefore: false, scopeProjectId: "proj-x"),
        });

        Assert.Single(targets);
        Assert.Equal("proj-x", targets[0].ProjectId);
        Assert.Null(targets[0].ReportId);
        Assert.Equal("项目 proj-x", CdsReportSyncTargets.DescribeScope(targets[0]));
    }

    [Fact]
    public void 记的范围就是全量时_两个过滤都为空()
    {
        var targets = CdsReportSyncTargets.Build(new[] { Store("store-full", "user-1", null) });

        Assert.Single(targets);
        Assert.Null(targets[0].ProjectId);
        Assert.Null(targets[0].ReportId);
        Assert.Equal("全部报告", CdsReportSyncTargets.DescribeScope(targets[0]));
    }

    [Fact]
    public void 没记过范围的老库_有全量水位才刷_按全量()
    {
        // 本改动之前建的库没有范围记录。只能靠间接证据：PeerSyncLastAt 只有
        // 「默认全量且零失败」的导入才回写，带过滤的从不写它。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("legacy-full", "user-1", null, scopeRecorded: false, fullySyncedBefore: true),
        });

        Assert.Single(targets);
        Assert.Null(targets[0].ReportId);
    }

    [Fact]
    public void 既没记范围也没水位的库不碰_证明不了它是什么()
    {
        // 反面对照：没有这一条，把判据写成「永远返回全部库」也能让上面几条绿，
        // 而那正好是「把只存一条报告的老库撑成整座库」的那个事故。
        Assert.Empty(CdsReportSyncTargets.Build(new[]
        {
            Store("unknown", "user-1", null, scopeRecorded: false, fullySyncedBefore: false),
        }));
    }

    [Fact]
    public void 范围里的空白当没有_不会拼出一个空过滤条件()
    {
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("store-blank-scope", "user-1", null, scopeProjectId: "   ", scopeReportId: ""),
        });

        Assert.Single(targets);
        Assert.Null(targets[0].ProjectId);
        Assert.Null(targets[0].ReportId);
    }
}
