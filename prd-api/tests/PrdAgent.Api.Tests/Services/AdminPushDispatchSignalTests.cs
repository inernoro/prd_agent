using System.Diagnostics;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class AdminPushDispatchSignalTests
{
    [Fact]
    public async Task WaitAsync_ReturnsPromptlyWhenNotified()
    {
        var signal = new AdminPushDispatchSignal();
        var sw = Stopwatch.StartNew();

        var waitTask = signal.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        await Task.Delay(50);
        signal.NotifyPending();
        await waitTask;

        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task WaitAsync_UsesFallbackDelayWithoutSignal()
    {
        var signal = new AdminPushDispatchSignal();
        var sw = Stopwatch.StartNew();

        await signal.WaitAsync(TimeSpan.FromMilliseconds(80), CancellationToken.None);

        Assert.True(sw.Elapsed >= TimeSpan.FromMilliseconds(60));
    }
}
