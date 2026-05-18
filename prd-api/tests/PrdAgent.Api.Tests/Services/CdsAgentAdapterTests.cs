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
