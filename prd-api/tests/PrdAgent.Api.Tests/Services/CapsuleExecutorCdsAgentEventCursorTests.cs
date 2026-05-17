using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class CapsuleExecutorCdsAgentEventCursorTests
{
    [Fact]
    public async Task ListCdsAgentEventsByCursorAsync_ShouldReadMultiplePages()
    {
        var events = Enumerable.Range(1, 1200)
            .Select(seq => MakeEvent(seq))
            .ToList();
        var calls = 0;

        var result = await CapsuleExecutor.ListCdsAgentEventsByCursorAsync(
            (afterSeq, limit, _) =>
            {
                calls++;
                return Task.FromResult(events
                    .Where(x => x.Seq > afterSeq)
                    .OrderBy(x => x.Seq)
                    .Take(limit)
                    .ToList());
            },
            CancellationToken.None);

        result.IsComplete.ShouldBeTrue();
        result.Events.Count.ShouldBe(1200);
        result.LastSeq.ShouldBe(1200);
        calls.ShouldBe(3);
    }

    [Fact]
    public async Task ListCdsAgentEventsByCursorAsync_ShouldStopWhenPageDoesNotProgress()
    {
        var result = await CapsuleExecutor.ListCdsAgentEventsByCursorAsync(
            (_, _, _) => Task.FromResult(new List<InfraAgentEventView> { MakeEvent(0) }),
            CancellationToken.None);

        result.IsComplete.ShouldBeFalse();
        result.Events.ShouldBeEmpty();
        result.LastSeq.ShouldBe(0);
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
