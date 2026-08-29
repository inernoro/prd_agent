using System.Collections.Generic;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 一条分享到底指向哪几个站点。
///
/// 这件事在读路径上原先被各写了一遍（鉴权、阅读、另存、分享列表…），每处都是
/// 「SiteIds 打底 + SiteId 补一个」。少认 SiteId 的表现是**存量单站点分享整条被漏掉**，
/// 而且不报错——访客数一栏就因此对这类分享一直显示 0，「修了一半」比没修更难发现。
/// 判据收敛成 TargetSiteIds() 一处之后，这条守住它的语义。
/// </summary>
public class ShareTargetSiteIdsTests
{
    [Fact]
    public void 存量单站点分享_只有_SiteId_也要认出来()
    {
        var share = new WebPageShareLink { SiteId = "site-legacy" };
        Assert.Equal(new[] { "site-legacy" }, share.TargetSiteIds());
    }

    [Fact]
    public void 合集分享_按_SiteIds_返回()
    {
        var share = new WebPageShareLink { SiteIds = new List<string> { "a", "b" } };
        Assert.Equal(new[] { "a", "b" }, share.TargetSiteIds());
    }

    [Fact]
    public void 两个字段都有时_合并且不重复_单站点那个排在前()
    {
        var share = new WebPageShareLink
        {
            SiteId = "a",
            SiteIds = new List<string> { "b", "a" },
        };
        Assert.Equal(new[] { "a", "b" }, share.TargetSiteIds());
    }

    [Fact]
    public void 空值一律不进结果()
    {
        var share = new WebPageShareLink
        {
            SiteId = "",
            SiteIds = new List<string> { "", "a" },
        };
        Assert.Equal(new[] { "a" }, share.TargetSiteIds());
        Assert.Empty(new WebPageShareLink().TargetSiteIds());
    }
}
