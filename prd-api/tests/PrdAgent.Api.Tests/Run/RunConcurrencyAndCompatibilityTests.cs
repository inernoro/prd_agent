using System.Collections.Concurrent;
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

public class RunConcurrencyAndCompatibilityTests
{
    [Fact]
    public async Task InMemoryRunEventStore_ConcurrentAppend_ShouldHaveUniqueMonotonicSeq()
    {
        var store = new InMemoryRunEventStore();
        var runId = "conc-evt-1";
        await store.SetRunAsync(RunKinds.Chat, new RunMeta { RunId = runId, Kind = RunKinds.Chat, Status = RunStatuses.Queued });

        var bag = new ConcurrentBag<long>();
        var tasks = Enumerable.Range(0, 200).Select(async i =>
        {
            var seq = await store.AppendEventAsync(RunKinds.Chat, runId, "message", new { type = "blockDelta", content = $"c{i}" });
            bag.Add(seq);
        });
        await Task.WhenAll(tasks);

        bag.Count.ShouldBe(200);
        bag.Distinct().Count().ShouldBe(200);
        bag.Min().ShouldBe(1);
        bag.Max().ShouldBe(200);

        var evts = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 0, limit: 500);
        evts.Count.ShouldBe(200);
        evts.Select(x => x.Seq).ShouldBe(evts.Select(x => x.Seq).OrderBy(x => x)); // 已排序
    }

    [Fact]
    public async Task InMemoryRunQueue_ConcurrentEnqueueDequeue_ShouldNotLoseItems()
    {
        var q = new InMemoryRunQueue();
        var kind = RunKinds.Chat;

        var ids = Enumerable.Range(0, 200).Select(i => $"r{i}").ToArray();
        await Task.WhenAll(ids.Select(id => q.EnqueueAsync(kind, id)));

        var got = new ConcurrentBag<string>();
        var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var consumers = Enumerable.Range(0, 8).Select(async _ =>
        {
            while (!cts.IsCancellationRequested)
            {
                var id = await q.DequeueAsync(kind, TimeSpan.FromMilliseconds(50), cts.Token);
                if (id == null) break;
                got.Add(id);
            }
        });
        await Task.WhenAll(consumers);

        got.Count.ShouldBe(200);
        got.Distinct().Count().ShouldBe(200);
    }

    private sealed class SlowChatService : IChatService
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
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var mid = fixedAssistantMessageId ?? "a1";
            yield return new ChatStreamEvent { Type = "start", MessageId = mid };
            for (var i = 0; i < 8; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return new ChatStreamEvent { Type = "blockDelta", MessageId = mid, BlockId = "b1", BlockKind = "paragraph", Content = $"t{i}\n" };
                await Task.Delay(30, cancellationToken);
            }
            yield return new ChatStreamEvent { Type = "done", MessageId = mid };
        }

        public Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50) => Task.FromResult(new List<Message>());
        public Task<List<Message>> GetGroupHistoryAsync(string groupId, int limit = 100) => Task.FromResult(new List<Message>());
    }

    [Fact]
    public async Task ChatRunWorker_MultipleRuns_ParallelCompletion()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IRunEventStore, InMemoryRunEventStore>();
        services.AddSingleton<IRunQueue, InMemoryRunQueue>();
        services.AddSingleton<IChatService, SlowChatService>();
        var sp = services.BuildServiceProvider();

        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        var runIds = Enumerable.Range(0, 6).Select(i => $"multi-{i}").ToArray();
        foreach (var id in runIds)
        {
            await store.SetRunAsync(RunKinds.Chat, new RunMeta
            {
                RunId = id,
                Kind = RunKinds.Chat,
                Status = RunStatuses.Queued,
                AssistantMessageId = $"assist-{id}",
                UserMessageId = $"user-{id}",
                InputJson = JsonSerializer.Serialize(new { sessionId = "s1", content = "hi", userId = "u1", promptKey = (string?)null, attachmentIds = Array.Empty<string>() })
            });
            await queue.EnqueueAsync(RunKinds.Chat, id);
        }

        var worker = new ChatRunWorker(sp.GetRequiredService<IServiceScopeFactory>(), queue, store, NullLogger<ChatRunWorker>.Instance);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(4));
        await worker.StartAsync(cts.Token);

        var until = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < until)
        {
            var allDone = true;
            foreach (var id in runIds)
            {
                var meta = await store.GetRunAsync(RunKinds.Chat, id, cts.Token);
                if (meta?.Status != RunStatuses.Done) { allDone = false; break; }
            }
            if (allDone) break;
            await Task.Delay(50, cts.Token);
        }

        foreach (var id in runIds)
        {
            var meta = await store.GetRunAsync(RunKinds.Chat, id, cts.Token);
            meta.ShouldNotBeNull();
            meta!.Status.ShouldBe(RunStatuses.Done);
            var snap = await store.GetSnapshotAsync(RunKinds.Chat, id, cts.Token);
            snap.ShouldNotBeNull();
        }

        await worker.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ChatRunWorker_InputJson_WithFutureFields_ShouldStillRun()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IRunEventStore, InMemoryRunEventStore>();
        services.AddSingleton<IRunQueue, InMemoryRunQueue>();
        services.AddSingleton<IChatService, SlowChatService>();
        var sp = services.BuildServiceProvider();

        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        // 未来字段：extra、platformId/modelId、unknownNested，兼容忽略
        var inputJson = JsonSerializer.Serialize(new
        {
            sessionId = "s1",
            content = "hi",
            userId = "u1",
            promptKey = (string?)null,
            attachmentIds = new object?[] { "a1", 123, null, " " }, // 非法项应被忽略
            platformId = "p1",
            modelId = "m1",
            extra = new { foo = "bar" },
            unknownNested = new[] { new { k = "v" } }
        });

        var runId = "compat-1";
        await store.SetRunAsync(RunKinds.Chat, new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.Chat,
            Status = RunStatuses.Queued,
            AssistantMessageId = "assist-1",
            UserMessageId = "user-1",
            InputJson = inputJson
        });
        await queue.EnqueueAsync(RunKinds.Chat, runId);

        var worker = new ChatRunWorker(sp.GetRequiredService<IServiceScopeFactory>(), queue, store, NullLogger<ChatRunWorker>.Instance);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await worker.StartAsync(cts.Token);

        var until = DateTime.UtcNow.AddSeconds(2);
        while (DateTime.UtcNow < until)
        {
            var meta = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
            if (meta?.Status == RunStatuses.Done) break;
            await Task.Delay(30, cts.Token);
        }

        var final = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
        final.ShouldNotBeNull();
        final!.Status.ShouldBe(RunStatuses.Done);

        await worker.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task ChatRunWorker_InputJson_Invalid_ShouldMarkError()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IRunEventStore, InMemoryRunEventStore>();
        services.AddSingleton<IRunQueue, InMemoryRunQueue>();
        services.AddSingleton<IChatService, SlowChatService>();
        var sp = services.BuildServiceProvider();

        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        var runId = "invalid-1";
        await store.SetRunAsync(RunKinds.Chat, new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.Chat,
            Status = RunStatuses.Queued,
            AssistantMessageId = "assist-1",
            UserMessageId = "user-1",
            InputJson = "{\"sessionId\":\"\",\"content\":\"\"}" // 无效
        });
        await queue.EnqueueAsync(RunKinds.Chat, runId);

        var worker = new ChatRunWorker(sp.GetRequiredService<IServiceScopeFactory>(), queue, store, NullLogger<ChatRunWorker>.Instance);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await worker.StartAsync(cts.Token);

        var until = DateTime.UtcNow.AddSeconds(1);
        while (DateTime.UtcNow < until)
        {
            var meta = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
            if (meta?.Status == RunStatuses.Error) break;
            await Task.Delay(30, cts.Token);
        }

        var final = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
        final.ShouldNotBeNull();
        final!.Status.ShouldBe(RunStatuses.Error);

        await worker.StopAsync(CancellationToken.None);
    }
}


