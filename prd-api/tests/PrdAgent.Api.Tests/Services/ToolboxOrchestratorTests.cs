using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Services.Toolbox;
using PrdAgent.Core.Models.Toolbox;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ToolboxOrchestratorTests
{
    [Fact]
    public async Task ExecuteRunAsync_ShouldEmitStepProgressBeforeAdapterCompletes()
    {
        var adapter = new GatedStreamingAdapter();
        var orchestrator = new SimpleOrchestrator(new IAgentAdapter[] { adapter }, NullLogger<SimpleOrchestrator>.Instance);
        var run = new ToolboxRun
        {
            Id = "run-streaming-test",
            UserId = "user-1",
            UserMessage = "run remotely",
            PlannedAgents = ["stream-agent"],
            Steps =
            {
                new ToolboxRunStep
                {
                    AgentKey = "stream-agent",
                    AgentDisplayName = "Stream Agent",
                    Action = "execute",
                    Index = 0,
                }
            }
        };

        await using var events = orchestrator.ExecuteRunAsync(run, CancellationToken.None).GetAsyncEnumerator();

        (await events.MoveNextAsync()).ShouldBeTrue();
        events.Current.Type.ShouldBe(ToolboxRunEventType.RunStarted);

        (await events.MoveNextAsync()).ShouldBeTrue();
        events.Current.Type.ShouldBe(ToolboxRunEventType.StepStarted);

        (await events.MoveNextAsync()).ShouldBeTrue();
        events.Current.Type.ShouldBe(ToolboxRunEventType.StepProgress);
        events.Current.Content.ShouldBe("first chunk\n");
        adapter.HasReachedGate.ShouldBeTrue();

        adapter.Release();

        (await events.MoveNextAsync()).ShouldBeTrue();
        events.Current.Type.ShouldBe(ToolboxRunEventType.StepProgress);
        events.Current.Content.ShouldBe("second chunk\n");
    }

    private sealed class GatedStreamingAdapter : IAgentAdapter
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public string AgentKey => "stream-agent";

        public string DisplayName => "Stream Agent";

        public bool HasReachedGate { get; private set; }

        public bool CanHandle(string action) => true;

        public Task<AgentExecutionResult> ExecuteAsync(AgentExecutionContext context, CancellationToken ct = default)
            => Task.FromResult(AgentExecutionResult.Ok("done"));

        public async IAsyncEnumerable<AgentStreamChunk> StreamExecuteAsync(
            AgentExecutionContext context,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
        {
            yield return AgentStreamChunk.Text("first chunk\n");
            HasReachedGate = true;
            await _release.Task.WaitAsync(ct);
            yield return AgentStreamChunk.Text("second chunk\n");
            yield return AgentStreamChunk.Done();
        }

        public void Release() => _release.TrySetResult();
    }
}
