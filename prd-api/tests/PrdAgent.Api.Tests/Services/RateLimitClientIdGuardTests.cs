using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 限流分桶必须按真实访客而不是反代地址。
///
/// 背景：海鲜市场的读接口 2026-07-28 改匿名后，匿名请求全靠 IP 分桶。生产是
/// Nginx + Docker，裸的 RemoteIpAddress 是反代的共享地址——所有匿名访客会被算成
/// 同一个 clientId 共用一个 600 RPM / 100 并发的桶，一个忙碌客户端就能让所有人
/// 的列表/详情/标签/下载 429。仓库既有的 GetRealClientIp 专门处理这个拓扑
/// （只信反代覆盖的 X-Real-IP，取不到时仍回落 RemoteIpAddress）。
///
/// 这里读源码断言而不是起中间件管道：要复现「共享桶」需要真实反代拓扑，
/// 单测造不出来；而这条约定的实质就是「别再写回裸的 RemoteIpAddress」。
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
    public void 匿名分桶走真实客户端_IP()
    {
        var src = File.ReadAllText(Path.Combine(
            RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Middleware", "RateLimitMiddleware.cs"));

        src.ShouldContain("GetRealClientIp");
        // 裸取上一跳地址的写法不许回潮
        src.ShouldNotContain("context.Connection.RemoteIpAddress?.ToString() ?? \"unknown\"");
    }
}
