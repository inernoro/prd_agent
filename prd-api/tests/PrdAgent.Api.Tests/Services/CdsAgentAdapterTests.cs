using PrdAgent.Api.Services.Toolbox.Adapters;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class CdsAgentAdapterTests
{
    [Theory]
    [InlineData(InfraAgentRuntimes.ClaudeSdk, true)]
    [InlineData(InfraAgentRuntimes.Custom, true)]
    [InlineData(InfraAgentRuntimes.Codex, false)]
    [InlineData("other-agent", false)]
    public void RequiresManagedRuntime_ShouldOnlyGateCdsManagedAgentRuntimes(string runtime, bool expected)
    {
        CdsAgentAdapter.RequiresManagedRuntime(runtime).ShouldBe(expected);
    }

    [Fact]
    public void BuildRuntimeUnavailableMessage_ShouldBlockManagedRuntimeWhenAdapterMissing()
    {
        var message = CdsAgentAdapter.BuildRuntimeUnavailableMessage(InfraAgentRuntimes.ClaudeSdk, null);

        message.ShouldBe("runtime adapter 未注册");
    }

    [Fact]
    public void BuildRuntimeUnavailableMessage_ShouldExposeAdapterPoolCounts()
    {
        var adapter = new FakeRuntimeAdapter(isConfigured: false, instanceCount: 2, healthyCount: 0);

        var message = CdsAgentAdapter.BuildRuntimeUnavailableMessage(InfraAgentRuntimes.ClaudeSdk, adapter);

        message.ShouldBe("adapter=fake-official-adapter, instances=2, healthy=0");
    }

    [Fact]
    public void BuildRuntimeUnavailableMessage_ShouldAllowConfiguredManagedRuntime()
    {
        var adapter = new FakeRuntimeAdapter(isConfigured: true, instanceCount: 2, healthyCount: 1);

        var message = CdsAgentAdapter.BuildRuntimeUnavailableMessage(InfraAgentRuntimes.ClaudeSdk, adapter);

        message.ShouldBeNull();
    }

    [Fact]
    public void BuildRuntimeUnavailableMessage_ShouldNotBlockNonManagedRuntime()
    {
        var adapter = new FakeRuntimeAdapter(isConfigured: false, instanceCount: 0, healthyCount: 0);

        var message = CdsAgentAdapter.BuildRuntimeUnavailableMessage(InfraAgentRuntimes.Codex, adapter);

        message.ShouldBeNull();
    }

    [Fact]
    public async Task ListEventsByCursorAsync_ShouldReadMultiplePagesAndReportComplete()
    {
        var events = Enumerable.Range(1, 1200)
            .Select(seq => MakeEvent(seq))
            .ToList();

        var result = await CdsAgentAdapter.ListEventsByCursorAsync(
            (afterSeq, limit, _) => Task.FromResult(events
                .Where(x => x.Seq > afterSeq)
                .OrderBy(x => x.Seq)
                .Take(limit)
                .ToList()),
            CancellationToken.None);

        result.IsComplete.ShouldBeTrue();
        result.Events.Count.ShouldBe(1200);
        result.LastSeq.ShouldBe(1200);
        CdsAgentAdapter.FormatEventCursorSummary(result).ShouldBe("1200 events, lastSeq=1200, cursor=complete");
    }

    [Fact]
    public async Task ListEventsByCursorAsync_ShouldStopWhenPageDoesNotProgress()
    {
        var result = await CdsAgentAdapter.ListEventsByCursorAsync(
            (_, _, _) => Task.FromResult(new List<InfraAgentEventView> { MakeEvent(0) }),
            CancellationToken.None);

        result.IsComplete.ShouldBeFalse();
        result.Events.ShouldBeEmpty();
        result.LastSeq.ShouldBe(0);
        CdsAgentAdapter.FormatEventCursorSummary(result).ShouldBe("0 events, lastSeq=0, cursor=truncated_or_stalled");
    }

    private sealed class FakeRuntimeAdapter : IInfraAgentRuntimeAdapter
    {
        public FakeRuntimeAdapter(bool isConfigured, int instanceCount, int healthyCount)
        {
            IsConfigured = isConfigured;
            InstanceCount = instanceCount;
            HealthyCount = healthyCount;
        }

        public string RuntimeKey => InfraAgentRuntimes.ClaudeSdk;
        public string AdapterKind => "fake-official-adapter";
        public bool IsConfigured { get; }
        public int InstanceCount { get; }
        public int HealthyCount { get; }

        public async IAsyncEnumerable<InfraAgentRuntimeEvent> RunStreamAsync(
            InfraAgentRuntimeRunRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            yield return new InfraAgentRuntimeEvent
            {
                Type = InfraAgentRuntimeEventType.Done,
                FinalText = "ok"
            };
        }

        public Task<InfraAgentRuntimeCancelResult> CancelAsync(string runId, CancellationToken ct) =>
            Task.FromResult(new InfraAgentRuntimeCancelResult(true, AdapterKind: AdapterKind));
    }

    private static InfraAgentEventView MakeEvent(long seq) =>
        new(
            $"evt-{seq}",
            "session-1",
            seq,
            "trace-1",
            InfraAgentEventTypes.Log,
            "{}",
            DateTime.UtcNow);
}
