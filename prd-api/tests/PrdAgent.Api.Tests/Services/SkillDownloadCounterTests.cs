using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using PrdAgent.Api.Controllers.Api.MarketplaceSkills;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 海鲜市场下载计数去重闸。
///
/// 背景：下载端点（fork）2026-07-28 改匿名后，任何人都能不取回产物地重复 POST，
/// 每次把 DownloadCount +1 —— 刷高「按热度排序」的默认榜单，同时白造 Mongo 写入。
/// 本测试钉住：同一调用方窗口内只计一次，不同调用方 / 不同技能互不影响。
/// </summary>
public class SkillDownloadCounterTests
{
    private static IMemoryCache NewCache() => new MemoryCache(new MemoryCacheOptions());

    private static HttpContext HttpFrom(string ip)
    {
        var ctx = new DefaultHttpContext();
        ctx.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(ip);
        return ctx;
    }

    [Fact]
    public void 同一匿名调用方对同一技能只计一次()
    {
        var cache = NewCache();
        var http = HttpFrom("203.0.113.7");

        SkillDownloadCounter.ShouldCount(cache, http, "skill-a", null).ShouldBeTrue();
        // 重放：窗口内再怎么打都不再计数
        for (var i = 0; i < 50; i++)
            SkillDownloadCounter.ShouldCount(cache, http, "skill-a", null).ShouldBeFalse();
    }

    [Fact]
    public void 不同技能各自独立计数()
    {
        var cache = NewCache();
        var http = HttpFrom("203.0.113.7");

        SkillDownloadCounter.ShouldCount(cache, http, "skill-a", null).ShouldBeTrue();
        SkillDownloadCounter.ShouldCount(cache, http, "skill-b", null).ShouldBeTrue();
    }

    [Fact]
    public void 不同匿名来源各自独立计数()
    {
        var cache = NewCache();

        SkillDownloadCounter.ShouldCount(cache, HttpFrom("203.0.113.7"), "skill-a", null).ShouldBeTrue();
        SkillDownloadCounter.ShouldCount(cache, HttpFrom("203.0.113.8"), "skill-a", null).ShouldBeTrue();
    }

    [Fact]
    public void 登录用户按用户身份去重而不是按_IP()
    {
        var cache = NewCache();

        // 同一个人换了网络（IP 变了），仍然算同一个调用方
        SkillDownloadCounter.ShouldCount(cache, HttpFrom("203.0.113.7"), "skill-a", "user-1").ShouldBeTrue();
        SkillDownloadCounter.ShouldCount(cache, HttpFrom("198.51.100.9"), "skill-a", "user-1").ShouldBeFalse();
        // 另一个人从同一个 IP 来，是另一个调用方
        SkillDownloadCounter.ShouldCount(cache, HttpFrom("203.0.113.7"), "skill-a", "user-2").ShouldBeTrue();
    }

    [Fact]
    public void 匿名指纹不泄露原始_IP()
    {
        // 指纹只在内存里当去重键，但仍然哈希 —— 万一将来被打进日志也不该带出原始 IP
        var fp = SkillDownloadCounter.Fingerprint(HttpFrom("203.0.113.7"), null);
        fp.ShouldStartWith("a:");
        fp.ShouldNotContain("203.0.113.7");
    }

    [Fact]
    public void 去重窗口是有限的不会永久压制真实下载()
    {
        // 窗口太长会让真实的重复下载永远不计数，太短等于没防护
        SkillDownloadCounter.Window.ShouldBeGreaterThan(TimeSpan.FromMinutes(1));
        SkillDownloadCounter.Window.ShouldBeLessThanOrEqualTo(TimeSpan.FromHours(1));
    }
}
