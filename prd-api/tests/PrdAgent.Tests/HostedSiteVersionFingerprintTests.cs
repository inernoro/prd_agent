using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 网页托管「替换网页不生效」回归守护。
///
/// 根因：reupload 把 index.html 原地覆盖到同一个 COS key，SiteUrl 字符串不变，
/// 浏览器/CDN 继续吐旧缓存 → 用户以为"替换没生效"，缓存过期后又忽然好了（无法稳定复现）。
///
/// 修复：SiteUrl 追加 ?v={UpdatedAt.Ticks} 版本指纹。
/// - 内容没更新 → UpdatedAt 不变 → URL 恒定 → 命中缓存（满足"没更新还要缓存"）
/// - 重新上传 → UpdatedAt 变化 → URL 变化 → 击穿缓存
///
/// 本测试直接验证 <see cref="HostedSiteService.AppendVersion"/> 的这两条性质。
/// </summary>
public class HostedSiteVersionFingerprintTests
{
    private const string BaseUrl = "https://cdn.example.com/web-hosting/sites/abc/index.html";

    [Fact]
    public void SameVersion_ProducesStableUrl_SoUnchangedSiteStaysCached()
    {
        var v = new DateTime(2026, 5, 26, 1, 2, 3, DateTimeKind.Utc);
        var a = HostedSiteService.AppendVersion(BaseUrl, v);
        var b = HostedSiteService.AppendVersion(BaseUrl, v);

        // 没更新 → 版本相同 → URL 完全一致 → 浏览器/CDN 命中缓存
        Assert.Equal(a, b);
        Assert.Contains($"v={v.Ticks}", a);
    }

    [Fact]
    public void NewVersion_BustsCache_SoReuploadTakesEffect()
    {
        var older = HostedSiteService.AppendVersion(BaseUrl, new DateTime(2026, 5, 26, 0, 0, 0, DateTimeKind.Utc));
        var newer = HostedSiteService.AppendVersion(BaseUrl, new DateTime(2026, 5, 26, 0, 0, 1, DateTimeKind.Utc));

        // 重新上传 → UpdatedAt 前进 → URL 必须不同，否则缓存击不穿
        Assert.NotEqual(older, newer);
    }

    [Fact]
    public void AppendsWithAmpersand_WhenUrlAlreadyHasQuery()
    {
        var url = "https://cdn.example.com/x/index.html?foo=bar";
        var result = HostedSiteService.AppendVersion(url, new DateTime(2026, 5, 26, 0, 0, 0, DateTimeKind.Utc));

        Assert.Contains("?foo=bar", result);
        Assert.Contains("&v=", result);
        Assert.DoesNotContain("?v=", result);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public void EmptyUrl_ReturnedUntouched(string? url)
    {
        var result = HostedSiteService.AppendVersion(url!, DateTime.UtcNow);
        Assert.Equal(url, result);
    }

    // ── EffectiveContentVersion：老文档（无 ContentVersion）必须有确定且稳定的回退 ──
    // 守护 Codex PR #686 P2：ContentVersion 不能带 = DateTime.UtcNow 初始化器，
    // 否则反序列化老文档时每次读取都得到当前时间，?v 每次变 → 缓存被击穿。

    [Fact]
    public void EffectiveContentVersion_NewSite_UsesContentVersion()
    {
        var content = new DateTime(2026, 5, 26, 3, 0, 0, DateTimeKind.Utc);
        var site = new HostedSite { CreatedAt = new DateTime(2026, 1, 1), ContentVersion = content };
        Assert.Equal(content, HostedSiteService.EffectiveContentVersion(site));
    }

    [Fact]
    public void EffectiveContentVersion_LegacySite_FallsBackToCreatedAt_AndIsStable()
    {
        var created = new DateTime(2026, 2, 2, 8, 0, 0, DateTimeKind.Utc);
        // 模拟老文档：Mongo 反序列化后 ContentVersion 为 default(DateTime)
        var site = new HostedSite { CreatedAt = created };
        Assert.Equal(default, site.ContentVersion);

        var v1 = HostedSiteService.EffectiveContentVersion(site);
        var v2 = HostedSiteService.EffectiveContentVersion(site);
        // 两次读取必须一致（稳定），且等于 CreatedAt（不是 UpdatedAt、不是当前时间）
        Assert.Equal(created, v1);
        Assert.Equal(v1, v2);
    }

    [Fact]
    public void ContentVersion_HasNoUtcNowInitializer_SoDefaultIsDeterministic()
    {
        // 直接 new 出来不显式赋值 → 必须是 default(DateTime)，而非 DateTime.UtcNow。
        // 这正是 Codex 评审要求：禁止给 ContentVersion 加 = DateTime.UtcNow 初始化器。
        Assert.Equal(default, new HostedSite().ContentVersion);
    }

    [Fact]
    public void VisitShare_WithHistoricalExpiresAt_IsStillAccepted()
    {
        var now = new DateTime(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc);
        var share = new WebPageShareLink
        {
            Purpose = "visit",
            ExpiresAt = now.AddDays(-1),
        };

        Assert.False(HostedSiteService.ShouldRejectExpiredShare(share, now));
    }

    [Fact]
    public void NormalShare_WithExpiredExpiresAt_IsRejected()
    {
        var now = new DateTime(2026, 6, 25, 0, 0, 0, DateTimeKind.Utc);
        var share = new WebPageShareLink
        {
            Purpose = "share",
            ExpiresAt = now.AddDays(-1),
        };

        Assert.True(HostedSiteService.ShouldRejectExpiredShare(share, now));
    }
}
