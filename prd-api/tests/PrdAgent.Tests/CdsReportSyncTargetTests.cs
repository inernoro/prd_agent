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
    /// <summary>默认造一个「全量镜像」：有水位 = 被当作默认全量导入过（见 Build 的判据）。</summary>
    private static DocumentStore Store(string id, string owner, string? source, DateTime? lastAt = null)
        => new()
        {
            Id = id,
            OwnerId = owner,
            PeerSyncNodeBaseUrl = source,
            PeerSyncLastAt = lastAt ?? new DateTime(2026, 8, 25, 0, 0, 0, DateTimeKind.Utc),
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
    public void 带过滤的镜像库不自动刷新_不许把单条报告撑成整座库()
    {
        // 手动导入可以只导一条报告或只导一个项目，那种库里装的是用户特意挑的那几条。
        // 后台任务不带过滤地再导一遍，会把那个 CDS 上所有读得到的报告统统灌进去，
        // 每小时一次且无人告知——用户点了「存这一条」却收获整座库（Codex review P1）。
        //
        // 判据用已经在存的 PeerSyncLastAt：只有「默认全量且零失败」的导入才回写它，
        // 带过滤的导入从来不写。所以没有水位 = 不能证明它是全量镜像 = 不碰。
        var targets = CdsReportSyncTargets.Build(new[]
        {
            Store("store-filtered", "user-1", "https://cds-a.example.com", lastAt: null),
            Store("store-full", "user-1", "https://cds-a.example.com"),
        });

        Assert.Single(targets);
        Assert.Equal("store-full", targets[0].StoreId);
    }

    [Fact]
    public void 从没成功全量导入过的库也不刷_宁可不同步也不撑大范围()
    {
        // 全量导入但有失败时同样不回写水位（那是为了让失败条目下轮重试）。
        // 这种库这轮也不自动刷新——保守方向一致：证明不了是全量镜像就不碰。
        Assert.Empty(CdsReportSyncTargets.Build(new[]
        {
            Store("store-partial-fail", "user-1", "https://cds-a.example.com", lastAt: null),
        }));
    }
}
