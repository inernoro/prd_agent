using System.Text.Json;
using PrdAgent.LlmGw;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayConsoleReadinessProbeTests
{
    [Fact]
    public async Task CheckAsync_ShouldReportReadyOnlyAfterMongoPingSucceeds()
    {
        var called = false;
        var probe = new GatewayConsoleReadinessProbe(_ =>
        {
            called = true;
            return Task.CompletedTask;
        });

        var result = await probe.CheckAsync();

        called.ShouldBeTrue();
        result.Status.ShouldBe("ready");
        result.ErrorCode.ShouldBeNull();
        result.Components.ShouldHaveSingleItem().Ready.ShouldBeTrue();
    }

    [Fact]
    public async Task CheckAsync_ShouldHideMongoFailureDetails()
    {
        const string sensitiveDetail = "mongodb://root:never-return-this@db:27017";
        var probe = new GatewayConsoleReadinessProbe(_ =>
            Task.FromException(new InvalidOperationException(sensitiveDetail)));

        var result = await probe.CheckAsync();
        var json = JsonSerializer.Serialize(result);

        result.Status.ShouldBe("not-ready");
        result.ErrorCode.ShouldBe(GatewayConsoleReadinessProbe.MongoUnavailable);
        result.Components.ShouldHaveSingleItem().Ready.ShouldBeFalse();
        json.ShouldNotContain(sensitiveDetail);
        json.ShouldNotContain("exception", Case.Insensitive);
    }

    [Fact]
    public async Task CheckAsync_ShouldCancelMongoProbeWhenTimeoutElapses()
    {
        // 超时只让调用方走人是不够的：探测本身留在后台跑，Mongo 掉线期间每次探测都堆一条在途操作。
        using var probeEntered = new SemaphoreSlim(0, 1);
        CancellationToken observedToken = default;
        var probe = new GatewayConsoleReadinessProbe(
            async token =>
            {
                observedToken = token;
                probeEntered.Release();
                await Task.Delay(TimeSpan.FromSeconds(30), token);
            },
            TimeSpan.FromMilliseconds(50));

        var result = await probe.CheckAsync();

        (await probeEntered.WaitAsync(TimeSpan.FromSeconds(5))).ShouldBeTrue();
        result.Status.ShouldBe("not-ready");
        result.ErrorCode.ShouldBe(GatewayConsoleReadinessProbe.MongoUnavailable);
        observedToken.IsCancellationRequested.ShouldBeTrue(
            customMessage: "超时后传给 Mongo 探测的令牌必须已取消，否则这条探测会在后台继续跑");
    }

    [Fact]
    public async Task CheckAsync_ShouldPropagateCallerCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var probe = new GatewayConsoleReadinessProbe(token =>
            Task.Delay(TimeSpan.FromSeconds(30), token));

        await Should.ThrowAsync<OperationCanceledException>(
            () => probe.CheckAsync(cancellation.Token));
    }

    /// <summary>
    /// 控制台读两个库：网关库（自己的权威存储）与 MAP 库（model_groups / llmplatforms /
    /// llmmodels / model_exchanges）。两者配置上可以指向不同部署，只探一个的话，
    /// MAP 库一挂就出现「readyz 回 200、那几条路由全坏」——就绪声明退化成只探进程活着
    /// （Codex P2，2026-09-16；同一个 PR 刚给 serving 修过同型问题）。
    /// </summary>
    [Fact]
    public async Task CheckAsync_ShouldNotReportReadyWhenTheMapDatabaseIsDown()
    {
        var probe = new GatewayConsoleReadinessProbe(
            [
                ("mongodb", _ => Task.CompletedTask),
                ("map-mongodb", _ => throw new InvalidOperationException("MAP Mongo 掉线")),
            ],
            TimeSpan.FromMilliseconds(200));

        var snapshot = await probe.CheckAsync();

        snapshot.Status.ShouldBe("not-ready");
        snapshot.ErrorCode.ShouldBe(GatewayConsoleReadinessProbe.MongoUnavailable);
        snapshot.Components.Single(x => x.Name == "mongodb").Ready.ShouldBeTrue();
        snapshot.Components.Single(x => x.Name == "map-mongodb").Ready.ShouldBeFalse();
    }

    /// <summary>
    /// 组件名 `mongodb` 是对外契约：CDS 凭据轮换的深检按这个名字要求它存在且为 true，
    /// 改名会让轮换在控制台这一档直接判失败。
    /// </summary>
    [Fact]
    public async Task CheckAsync_ShouldKeepTheGatewayComponentNamedMongodbForRotationDeepCheck()
    {
        var probe = new GatewayConsoleReadinessProbe(
            [("mongodb", _ => Task.CompletedTask), ("map-mongodb", _ => Task.CompletedTask)],
            TimeSpan.FromMilliseconds(200));

        var snapshot = await probe.CheckAsync();

        snapshot.Status.ShouldBe("ready");
        snapshot.Components.ShouldContain(x => x.Name == "mongodb" && x.Ready);
        snapshot.Components.Count.ShouldBe(2);
    }

    /// <summary>
    /// 每条探测必须有自己的超时作用域。共用一个的话，第一条把上限耗光就把令牌取消了，
    /// 后面几条在**根本没被探过**的情况下直接判成不可用——网关库单挂会顺带把
    /// map-mongodb 报成挂了，运维被指向错误的依赖（形状 10：降级产出的失败与
    /// 另一种问题分不开。Codex P2，2026-09-16，指的是本 PR 上一轮刚加的多库循环）。
    /// </summary>
    [Fact]
    public async Task CheckAsync_ShouldStillProbeTheSecondDatabaseAfterTheFirstOneTimesOut()
    {
        var healthyProbeEntered = false;
        CancellationToken healthyToken = default;
        var probe = new GatewayConsoleReadinessProbe(
            [
                // 网关库掉线：吃满整条超时，且认令牌（真 Mongo ping 就是这个形状）。
                ("mongodb", token => Task.Delay(TimeSpan.FromSeconds(30), token)),
                // MAP 库好着：同样认令牌，所以拿到一条已取消的令牌就会直接失败。
                ("map-mongodb", async token =>
                {
                    healthyProbeEntered = true;
                    healthyToken = token;
                    await Task.Delay(TimeSpan.FromMilliseconds(20), token);
                }),
            ],
            TimeSpan.FromMilliseconds(150));

        var snapshot = await probe.CheckAsync();

        healthyProbeEntered.ShouldBeTrue();
        healthyToken.IsCancellationRequested.ShouldBeFalse(
            customMessage: "好着的那条库拿到的令牌被另一条的超时取消了，说明两条探测共用同一个作用域");
        snapshot.Components.Single(x => x.Name == "mongodb").Ready.ShouldBeFalse();
        snapshot.Components.Single(x => x.Name == "map-mongodb").Ready.ShouldBeTrue(
            customMessage: "网关库超时不得连带把 MAP 库判成不可用——那会把运维指向错误的依赖");
        snapshot.Status.ShouldBe("not-ready");
    }

    /// <summary>
    /// 接线守卫：探针类支持两个库不等于应用真的两个都传了。
    /// 只测类不测接线的话，把 Program.cs 改回单库照样全绿（形状 2）。
    /// </summary>
    [Fact]
    public void ConsoleMustWireBothConfiguredMongoDatabasesIntoTheReadinessProbe()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "llmgw", "console-api")))
            directory = directory.Parent;
        directory.ShouldNotBeNull();
        var program = File.ReadAllText(
            Path.Combine(directory!.FullName, "llmgw", "console-api", "Program.cs"));

        program.ShouldContain(
            "new GatewayConsoleReadinessProbe(gatewayDatabase, mapDatabase)",
            customMessage: "控制台就绪探针必须同时探网关库与 MAP 库；只探一个的话 MAP 库掉线时 readyz 仍回 200");
        // companion：这两个库确实都是控制台在用的，判据才有意义
        program.ShouldContain("mapDatabase.GetCollection", customMessage: "控制台若不再读 MAP 库，这条判据要跟着改");
    }
}
