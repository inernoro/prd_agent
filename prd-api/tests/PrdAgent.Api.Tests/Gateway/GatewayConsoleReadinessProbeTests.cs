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
}
