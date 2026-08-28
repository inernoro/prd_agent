using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 分享列表按站点过滤必须下推到库里。
///
/// `ListSharesAsync` 的结果是全局按时间取最近 100 条。调用方要问的却往往是「这个站点
/// 有没有活着的链接」——不把 siteId 推进查询条件，该站点的链接落在窗口外就会被判成
/// 「没有」，调用方据此再建一条（forceNew）。表现是每次都多出一条重复链接，而卡片上
/// 还显示未分享：坏的是数据，用户看到的却是「还没分享过」。
///
/// 用源码守卫是因为这条判据要真跑得起一个 Mongo + 一百多条种子数据才测得出行为，
/// 而它退化的形态很单一：siteId 参数还在、查询条件里没接上。
/// </summary>
public class ShareListSiteScopeTests
{
    private static string ReadSrc(string relative)
    {
        var dir = AppContext.BaseDirectory;
        while (dir != null && !Directory.Exists(Path.Combine(dir, "src", "PrdAgent.Api")))
            dir = Directory.GetParent(dir)?.FullName;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!, relative));
    }

    [Fact]
    public void 带_siteId_时过滤必须进查询条件_不能只挂在签名上()
    {
        var svc = ReadSrc(Path.Combine(
            "src", "PrdAgent.Infrastructure", "Services", "HostedSiteService.cs"));
        var body = SourceSlice.Member(svc, "public async Task<List<WebPageShareLink>> ListSharesAsync(");

        // 参数在
        Assert.Contains("string? siteId", body);
        // 且真的接进了 filter：两个字段都要认（存量单站点分享只写 SiteId）
        Assert.Matches(new Regex(@"filter\s*&=.*SiteId", RegexOptions.Singleline), body);
        Assert.Contains("AnyEq(x => x.SiteIds, siteId)", body);
        // 过滤要排在取数之前，否则先截断再过滤等于没过滤。
        // 找的是 `.Limit(100)`（带点 = 真的方法调用），不是裸的 `Limit(100)`——
        // 后者会命中上面那段解释里提到的同一串字，判据于是读到了「讲代码的话」而不是代码本身。
        // 这条守卫第一次写出来就栽在这上面：注释排在代码前面，顺序判定当场反过来。
        var filterAt = body.IndexOf("filter &=", StringComparison.Ordinal);
        var limitAt = body.IndexOf(".Limit(100)", StringComparison.Ordinal);
        Assert.True(filterAt > -1 && limitAt > filterAt,
            "站点过滤必须排在 .Limit(100) 之前，否则先截断再过滤，等于没过滤");
    }

    [Fact]
    public void 端点要把_siteId_透出去()
    {
        var ctrl = ReadSrc(Path.Combine(
            "src", "PrdAgent.Api", "Controllers", "Api", "WebPagesController.cs"));
        var body = SourceSlice.Member(ctrl, "public async Task<IActionResult> ListShares(");

        Assert.Contains("[FromQuery] string? siteId", body);
        Assert.Contains("includeRevoked, siteId", body);
    }
}
