using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 限流分桶必须按真实访客，且桶键不能由调用方自选。
///
/// 背景：海鲜市场的读接口 2026-07-28 改匿名后，匿名请求全靠 IP 分桶，这条路径上
/// 有两个相反方向的坑，两边都得躲开：
///
///   往左：裸用 RemoteIpAddress。生产是 Nginx + Docker，取到的是反代共享地址，
///   所有匿名访客算成同一个 clientId 共用一个 600 RPM / 100 并发的桶，一个忙碌
///   客户端就能让所有人 429。
///
///   往右：无条件采信 X-Real-IP（即 GetRealClientIp 的语义，那条是给展示/统计用的）。
///   Kestrel 直接暴露或反代不覆盖该头时，调用方每个请求换一个头值就换一个桶，
///   限流等于不存在。
///
///   正解：GetAbuseControlClientIp —— 只在 socket 对端是回环/私网（我方反代）时
///   才采信该头，否则回落 RemoteIpAddress。
///
/// 这里读源码断言而不是起中间件管道：要复现「共享桶」需要真实反代拓扑，单测造
/// 不出来；而这条约定的实质就是「别再写回那两种错法」。
/// </summary>
public class RateLimitClientIdGuardTests
{
    /// <summary>从测试程序集所在目录向上找仓库根（以 CLAUDE.md 与 prd-api 同时存在为准）。</summary>
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "CLAUDE.md"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
            {
                return dir.FullName;
            }
            dir = dir.Parent;
        }
        throw new InvalidOperationException("找不到仓库根：向上没有同时含 CLAUDE.md 与 prd-api 的目录");
    }

    [Fact]
    public void 匿名分桶走可信来源的客户端_IP()
    {
        var src = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Middleware", "RateLimitMiddleware.cs"));

        src.ShouldContain("GetAbuseControlClientIp");
        // 裸取上一跳地址的写法不许回潮（所有人共用一个桶）
        src.ShouldNotContain("context.Connection.RemoteIpAddress?.ToString() ?? \"unknown\"");
        // 无条件采信 X-Real-IP 的写法也不许回潮（调用方自选桶键）
        src.ShouldNotContain("context.GetRealClientIp()");
    }

    [Fact]
    public void 下载去重也用同一套可信来源口径()
    {
        // 同源的第二处：下载计数去重也是防滥用控制，不能一处收紧一处敞着
        var src = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Controllers", "Api",
            "MarketplaceSkills", "SkillDownloadCounter.cs"));

        src.ShouldContain("GetAbuseControlClientIp");
        src.ShouldNotContain("http.GetRealClientIp()");
    }
}
