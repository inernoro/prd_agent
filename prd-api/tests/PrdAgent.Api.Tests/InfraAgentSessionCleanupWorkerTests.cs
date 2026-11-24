using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using Xunit;

namespace PrdAgent.Api.Tests;

public sealed class InfraAgentSessionCleanupWorkerTests
{
    [Fact]
    public async Task WorkerRunsPersistedCleanupSweepImmediately()
    {
        var sessions = new Mock<IInfraAgentSessionService>();
        var firstSweep = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        sessions.Setup(service => service.RecoverPendingStopsAsync(It.IsAny<CancellationToken>()))
            .Callback(() => firstSweep.TrySetResult())
            .ReturnsAsync(1);
        sessions.Setup(service => service.RecoverExpiredPrewarmsAsync(It.IsAny<CancellationToken>()))
            .ReturnsAsync(1);
        var services = new ServiceCollection();
        services.AddScoped(_ => sessions.Object);
        await using var provider = services.BuildServiceProvider();
        var worker = new InfraAgentSessionCleanupWorker(
            provider.GetRequiredService<IServiceScopeFactory>(),
            NullLogger<InfraAgentSessionCleanupWorker>.Instance);

        await worker.StartAsync(CancellationToken.None);
        await firstSweep.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await worker.StopAsync(CancellationToken.None);

        sessions.Verify(
            service => service.RecoverPendingStopsAsync(It.IsAny<CancellationToken>()),
            Times.AtLeastOnce);
        sessions.Verify(
            service => service.RecoverExpiredPrewarmsAsync(It.IsAny<CancellationToken>()),
            Times.AtLeastOnce);
    }
}
