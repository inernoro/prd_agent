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
        // 端点自描述里 serving.unhandled-exceptions 是 21600 秒（6 小时）常设探测。
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
    public void 真实请求进入窗口内计数()
    {
        var tracker = new ServingFaultTracker();
        tracker.RecordRequest();
        tracker.RecordRequest();

        tracker.RequestsWithinWindow().ShouldBe(2);
    }

    [Fact]
    public void 窗口外的请求被丢弃()
    {
        var now = new DateTime(2026, 9, 10, 12, 0, 0, DateTimeKind.Utc);
        var clock = now;
        var tracker = new ServingFaultTracker(windowMinutes: 60, now: () => clock);

        tracker.RecordRequest();
        tracker.RequestsWithinWindow().ShouldBe(1);

        clock = now.AddMinutes(61);
        tracker.RequestsWithinWindow().ShouldBe(
            0,
            customMessage: "窗口外的请求必须被丢弃，否则样本量只增不减，「没人用」永远看不出来");
    }

    [Fact]
    public async Task 中间件把成功请求也记进样本量()
    {
        // 这是「零异常」这条判据的分母。没有它，零流量与全部成功长得一模一样，
        // 被动监控退化成一条恒绿的假判据（degradation-must-alarm）。
        var tracker = new ServingFaultTracker();
        var middleware = new ServingFaultTrackingMiddleware(_ => Task.CompletedTask, tracker);

        await middleware.InvokeAsync(new DefaultHttpContext());

        tracker.RequestsWithinWindow().ShouldBe(1);
        tracker.CountWithinWindow().ShouldBe(0, customMessage: "成功请求不是异常");
    }

    [Fact]
    public async Task 探针自己的请求不算真实调用()
    {
        // 少了这条排除，6 小时窗口里永远有那么一两次探针请求，
        // 「零真实调用」这个最要紧的信号就永远出不来。
        var tracker = new ServingFaultTracker();
        var middleware = new ServingFaultTrackingMiddleware(_ => Task.CompletedTask, tracker);

        foreach (var path in new[] { "/gw/v1/healthz/deep", "/gw/v1/healthz", "/gw/v1/readyz", "/metrics" })
        {
            var ctx = new DefaultHttpContext();
            ctx.Request.Path = path;
            await middleware.InvokeAsync(ctx);
        }

        tracker.RequestsWithinWindow().ShouldBe(
            0,
            customMessage: "探针路径不能算真实调用，否则样本量永远大于 0");
    }

    [Fact]
    public async Task 抛异常的请求既记异常也记样本()
    {
        var tracker = new ServingFaultTracker();
        var middleware = new ServingFaultTrackingMiddleware(_ => throw new InvalidOperationException("boom"), tracker);

        await Should.ThrowAsync<InvalidOperationException>(async () => await middleware.InvokeAsync(new DefaultHttpContext()));

        tracker.CountWithinWindow().ShouldBe(1);
        tracker.RequestsWithinWindow().ShouldBe(
            1,
            customMessage: "崩掉的那次也是一次真实调用，分母不能漏");
    }

    // 端点源码上两条 check 的起始标记，按它们在文件里的先后顺序排列。
    // 判据必须**逐条 check** 地看，不能在整份源码上找子串：整份源码里
    // 「某处出现过 cds:monitor」不等于「这一条 check 上有 cds:monitor」
    // （predicate-and-wiring-discipline 形状 1：判据比它该管的范围宽）。
    private const string UnhandledCheckMarker = "[\"serving:unhandled-exceptions\"] = new object[]";
    private const string RequestsCheckMarker = "[\"serving:requests\"] = new object[]";
    private const string ImageOutcomeCheckMarker = "[\"visual-image:recent-outcomes\"] = new object[]";
    private const string ImageRequestsCheckMarker = "[\"visual-image:requests\"] = new object[]";
    private const string DatabaseCheckMarker = "[\"db:roundtrip\"] = new object[]";

    /// <summary>取端点源码里某一条 check 的声明块（到下一条 check 开始为止）。</summary>
    private static string CheckBlock(string source, string startMarker, string? nextMarker)
    {
        var start = source.IndexOf(startMarker, StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(
            0,
            customMessage: $"端点上整条 check 不见了：找不到 {startMarker}");

        var end = nextMarker == null
            ? -1
            : source.IndexOf(nextMarker, start, StringComparison.Ordinal);
        return end < 0 ? source[start..] : source[start..end];
    }

    private static string EndpointSource() => File.ReadAllText(
        Path.Combine(RepoRoot(), "llmgw", "serving", "GatewayHttpEndpoints.cs"));

    [Fact]
    public void 样本量声明必须与端点一起存在()
    {
        // 接线守卫：零异常那条必须指名一条**真实存在**的 check 当分母。
        //
        // 判据落在端点源码上，不再读仓库根的那份声明文件 —— 监控自发现落地后
        // 声明就长在端点自己的响应里，那份文件已随之删除。判据跟着搬家，
        // 而不是放宽：删掉 sampleComponentId、或把整条 serving:requests 删掉，
        // 这里都会红。后者尤其要单独断言——`"serving.requests"` 这个子串
        // 在 `sampleComponentId = "serving.requests"` 里也出现，光找它等于
        // 让「被指名的分母根本不存在」这种情况静默通过。
        var endpoints = EndpointSource();
        var unhandled = CheckBlock(endpoints, UnhandledCheckMarker, RequestsCheckMarker);
        var requests = CheckBlock(endpoints, RequestsCheckMarker, null);

        unhandled.ShouldContain(
            "sampleComponentId = \"serving.requests\"",
            customMessage: "零异常那条必须指名分母，否则窗口内一次调用都没有时它会判成健康");
        requests.ShouldContain(
            "[\"componentId\"] = \"serving.requests\"",
            customMessage: "被指名的分母必须是端点上一条真实的 check，不能只是别处的一句引用");
    }

    [Fact]
    public void 每条check都必须自带监控声明()
    {
        // 接线守卫：componentId 与「该怎么判它」必须在**同一条 check 上**同时存在。
        // 少了自描述段，对账就不会为这一条建监控 —— 那条铃在最需要的时候是哑的，
        // 而整份源码里另一条 check 的 cds:monitor 会让粗糙的判据照样判绿。
        var endpoints = EndpointSource();
        var unhandled = CheckBlock(endpoints, UnhandledCheckMarker, RequestsCheckMarker);
        var requests = CheckBlock(endpoints, RequestsCheckMarker, null);

        endpoints.ShouldContain(
            "\"/gw/v1/healthz/deep\"",
            customMessage: "深度自检端点被移除或改名了，登记在 CDS 上的探针会打空");

        unhandled.ShouldContain(
            "[\"componentId\"] = \"serving.unhandled-exceptions\"",
            customMessage: "未处理异常这条 check 不能消失，它是「后台在炸、前台看着正常」的唯一判据");
        unhandled.ShouldContain(
            "[\"cds:monitor\"]",
            customMessage: "未处理异常这条 check 必须自报怎么监控自己，否则那条 P0 监控建不出来");
        requests.ShouldContain(
            "[\"cds:monitor\"]",
            customMessage: "真实调用数这条 check 必须自报怎么监控自己，否则分母那条监控建不出来");
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

    [Fact]
    public void MAP深度自检必须监控生图真实结果并携带样本量()
    {
        var program = File.ReadAllText(
            Path.Combine(RepoRoot(), "prd-api", "src", "PrdAgent.Api", "Program.cs"));
        var outcomes = CheckBlock(program, ImageOutcomeCheckMarker, ImageRequestsCheckMarker);
        var requests = CheckBlock(program, ImageRequestsCheckMarker, DatabaseCheckMarker);

        program.ShouldContain(
            "gatewayDb.LlmRequestLogs",
            customMessage: "生图结果不能再用进程异常代替，必须读取网关已落库的真实调用结果");
        program.ShouldContain(
            "VisualModelPolicyService.AppCallers",
            customMessage: "真实结果必须只统计与 MAP 生图路由相同的三个调用场景");
        outcomes.ShouldContain("[\"componentId\"] = \"visual-image.recent-outcomes\"");
        outcomes.ShouldContain("[\"cds:monitor\"]");
        outcomes.ShouldContain(
            "sampleComponentId = \"visual-image.requests\"",
            customMessage: "零连续失败必须带真实样本量，否则零调用也会被误判为健康");
        requests.ShouldContain("[\"componentId\"] = \"visual-image.requests\"");
        requests.ShouldContain("[\"cds:monitor\"]");
    }
}
