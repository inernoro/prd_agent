using Microsoft.AspNetCore.Http;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 未处理异常计数与深度自检端点（2026-09-09，规则 degradation-must-alarm）。
///
/// 这条判据是整套监控里最值钱的一条：它不为某个功能单独写探针，
/// 而是把「页面看着好、后台在炸」的**全部**同类故障一次网住。
/// 所以它自己更不能出错——尤其是「窗口比探测间隔短」这种会让它恒读 0 的错。
/// </summary>
public sealed class ServingFaultTrackerTests
{
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
    public void 没有异常时窗口内计数为零()
    {
        var tracker = new ServingFaultTracker();
        tracker.CountWithinWindow().ShouldBe(0);
        tracker.TotalSinceStart.ShouldBe(0);
    }

    [Fact]
    public void 记录到的异常进入窗口内计数()
    {
        var tracker = new ServingFaultTracker();
        tracker.Record();
        tracker.Record();

        tracker.CountWithinWindow().ShouldBe(2);
        tracker.TotalSinceStart.ShouldBe(2);
    }

    [Fact]
    public void 窗口外的记录被丢弃但累计数保留()
    {
        var now = new DateTime(2026, 9, 9, 12, 0, 0, DateTimeKind.Utc);
        var clock = now;
        var tracker = new ServingFaultTracker(windowMinutes: 60, now: () => clock);

        tracker.Record();
        tracker.CountWithinWindow().ShouldBe(1);

        // 走过一个窗口零一分钟
        clock = now.AddMinutes(61);
        tracker.CountWithinWindow().ShouldBe(
            0,
            customMessage: "窗口外的记录必须被丢弃，否则计数只增不减，探针永远红");
        tracker.TotalSinceStart.ShouldBe(
            1,
            customMessage: "累计数要保留——窗口内回落到 0 时它仍能说明这个实例崩过");
    }

    [Fact]
    public void 默认窗口必须不小于六小时的常设探测间隔()
    {
        // cds-monitors.yml 里 serving.unhandled-exceptions 是 21600 秒（6 小时）常设探测。
        // 窗口比它短，异常就会落在窗口之外，探针每次读到 0 —— 一个恒绿的假判据，
        // 比没有判据更糟（predicate-and-wiring-discipline 形状 4）。
        ServingFaultTracker.DefaultWindowMinutes.ShouldBeGreaterThanOrEqualTo(
            360,
            customMessage: "默认窗口必须覆盖 6 小时探测间隔，否则探针恒读 0");
    }

    [Fact]
    public async Task 中间件只记不吞异常()
    {
        var tracker = new ServingFaultTracker();
        var boom = new InvalidOperationException("模拟穿透管道的异常");
        var middleware = new ServingFaultTrackingMiddleware(_ => throw boom, tracker);

        var thrown = await Should.ThrowAsync<InvalidOperationException>(
            async () => await middleware.InvokeAsync(new DefaultHttpContext()));

        thrown.ShouldBeSameAs(boom, customMessage: "异常必须原样抛回，吞掉会改变既有错误响应行为");
        tracker.CountWithinWindow().ShouldBe(1);
    }

    [Fact]
    public async Task 正常请求不计数()
    {
        var tracker = new ServingFaultTracker();
        var middleware = new ServingFaultTrackingMiddleware(_ => Task.CompletedTask, tracker);

        await middleware.InvokeAsync(new DefaultHttpContext());

        tracker.CountWithinWindow().ShouldBe(0);
    }

    [Fact]
    public void 端点的componentId必须与监控声明一致()
    {
        // 跨文件接线守卫：端点改了 componentId 而声明没跟上（或反过来），
        // 探针会去找一条不存在的 check —— CDS 侧会判失败，但那时已经在线上了。
        var endpoints = File.ReadAllText(
            Path.Combine(RepoRoot(), "llmgw", "serving", "GatewayHttpEndpoints.cs"));
        var declaration = File.ReadAllText(Path.Combine(RepoRoot(), "cds-monitors.yml"));

        endpoints.ShouldContain(
            "\"/gw/v1/healthz/deep\"",
            customMessage: "深度自检端点被移除或改名了，cds-monitors.yml 里的探针会打空");
        endpoints.ShouldContain("serving.unhandled-exceptions");
        declaration.ShouldContain(
            "serving.unhandled-exceptions",
            customMessage: "端点与监控声明的 componentId 必须一致，否则探针找不到那条 check");
    }

    [Fact]
    public void 深度自检必须免鉴权否则探针永远打不进来()
    {
        // CDS 的自定义探针刻意不携带任何密钥（探测令牌绝不发给外部地址）。
        // 这个豁免被撤掉的话，探针会稳定收到 401 —— 铃在最需要的时候是哑的。
        var endpoints = File.ReadAllText(
            Path.Combine(RepoRoot(), "llmgw", "serving", "GatewayHttpEndpoints.cs"));

        endpoints.ShouldContain(
            "!path.Equals(\"/gw/v1/healthz/deep\", StringComparison.OrdinalIgnoreCase)",
            customMessage: "深度自检必须留在免鉴权名单里，否则 CDS 探针打不进来");
    }
}
