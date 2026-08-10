using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 分享过期判定的守卫（PR #1351 第八轮 review）。
///
/// 历史遗留的 Purpose="visit" 链接带着一个早已过去的 ExpiresAt，ViewShareAsync 刻意豁免并
/// 顺手治愈；而评论/正文代理/提问那条路径原本是裸比 ExpiresAt，于是同一条链接
/// 「页面打得开、正文代理和提问却说已过期」。判据抄成两份之后各自漂移的典型。
/// </summary>
public class ShareExpiryPredicateTests
{
    private static WebPageShareLink Link(string purpose, DateTime? expiresAt) =>
        new() { Purpose = purpose, ExpiresAt = expiresAt };

    private static readonly DateTime Now = new(2026, 8, 10, 12, 0, 0, DateTimeKind.Utc);

    /// <summary>核心用例：visit 链接即使 ExpiresAt 早已过去也不判过期。</summary>
    [Fact]
    public void visit链接过期时间已过_仍不拒绝()
    {
        Assert.False(HostedSiteService.ShouldRejectExpiredShare(
            Link("visit", Now.AddDays(-30)), Now));
    }

    [Fact]
    public void 普通分享过期即拒绝()
    {
        Assert.True(HostedSiteService.ShouldRejectExpiredShare(
            Link("share", Now.AddMinutes(-1)), Now));
    }

    [Fact]
    public void 普通分享未过期不拒绝()
    {
        Assert.False(HostedSiteService.ShouldRejectExpiredShare(
            Link("share", Now.AddMinutes(1)), Now));
    }

    [Fact]
    public void 没有过期时间的一律不拒绝()
    {
        Assert.False(HostedSiteService.ShouldRejectExpiredShare(Link("share", null), Now));
        Assert.False(HostedSiteService.ShouldRejectExpiredShare(Link("visit", null), Now));
    }

    [Fact]
    public void visit判定不区分大小写()
    {
        Assert.False(HostedSiteService.ShouldRejectExpiredShare(
            Link("VISIT", Now.AddDays(-1)), Now));
    }
}
