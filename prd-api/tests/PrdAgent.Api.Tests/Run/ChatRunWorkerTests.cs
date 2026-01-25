using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Run;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class ChatRunWorkerTests
{
    private sealed class FakeChatService : IChatService
    {
        public async IAsyncEnumerable<ChatStreamEvent> SendMessageAsync(
            string sessionId,
            string content,
            string? resendOfMessageId = null,
            string? promptKey = null,
            string? userId = null,
            List<string>? attachmentIds = null,
            string? runId = null,
            string? fixedUserMessageId = null,
            string? fixedAssistantMessageId = null,
            bool disableGroupContext = false,
            string? systemPromptOverride = null,
            UserRole? answerAsRole = null,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            yield return new ChatStreamEvent { Type = "start", MessageId = fixedAssistantMessageId ?? "a1" };
            yield return new ChatStreamEvent { Type = "blockStart", MessageId = fixedAssistantMessageId ?? "a1", BlockId = "b1", BlockKind = "paragraph" };
            yield return new ChatStreamEvent { Type = "blockDelta", MessageId = fixedAssistantMessageId ?? "a1", BlockId = "b1", BlockKind = "paragraph", Content = "hello\n" };
            yield return new ChatStreamEvent { Type = "blockEnd", MessageId = fixedAssistantMessageId ?? "a1", BlockId = "b1", BlockKind = "paragraph" };
            await Task.Delay(10, cancellationToken);
            yield return new ChatStreamEvent { Type = "done", MessageId = fixedAssistantMessageId ?? "a1" };
        }

        public Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50) => Task.FromResult(new List<Message>());
        public Task<List<Message>> GetGroupHistoryAsync(string groupId, int limit = 100) => Task.FromResult(new List<Message>());
    }

    [Fact]
    public async Task Worker_ShouldAppendEventsAndSnapshot_WithoutDbOrLlm()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IRunEventStore, InMemoryRunEventStore>();
        services.AddSingleton<IRunQueue, InMemoryRunQueue>();
        services.AddSingleton<IChatService, FakeChatService>();
        var sp = services.BuildServiceProvider();

        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        var runId = "run-test-1";
        var meta = new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.Chat,
            Status = RunStatuses.Queued,
            AssistantMessageId = "assist-1",
            UserMessageId = "user-1",
            InputJson = JsonSerializer.Serialize(new { sessionId = "s1", content = "hi", promptKey = (string?)null, userId = "u1", attachmentIds = new string[0] })
        };
        await store.SetRunAsync(RunKinds.Chat, meta);
        await queue.EnqueueAsync(RunKinds.Chat, runId);

        var worker = new ChatRunWorker(
            scopeFactory: sp.GetRequiredService<IServiceScopeFactory>(),
            queue: queue,
            runStore: store,
            logger: NullLogger<ChatRunWorker>.Instance);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await worker.StartAsync(cts.Token);

        // 等待 run 处理完成
        var doneAt = DateTime.UtcNow.AddSeconds(1);
        while (DateTime.UtcNow < doneAt)
        {
            var cur = await store.GetRunAsync(RunKinds.Chat, runId);
            if (cur?.Status == RunStatuses.Done) break;
            await Task.Delay(20, cts.Token);
        }

        var final = await store.GetRunAsync(RunKinds.Chat, runId);
        final.ShouldNotBeNull();
        final!.Status.ShouldBe(RunStatuses.Done);

        var events = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 0, limit: 50);
        events.Count.ShouldBeGreaterThanOrEqualTo(2); // start + blockDelta + done

        var snapshot = await store.GetSnapshotAsync(RunKinds.Chat, runId);
        snapshot.ShouldNotBeNull();
        snapshot!.SnapshotJson.ShouldContain("snapshot");

        await worker.StopAsync(CancellationToken.None);
    }
}


