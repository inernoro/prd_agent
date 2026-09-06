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
