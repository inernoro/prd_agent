using System.Runtime.CompilerServices;
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

/// <summary>
/// ChatRun 关键分支“闭环套件”（纯内存 + FakeChatService）：
/// - done / error / cancel-before / cancel-mid
/// - snapshot 兜底（短回答也必须能恢复）
/// </summary>
public class ChatRunSuiteTests
{
    private static IServiceProvider BuildSp(IChatService chat)
    {
        var services = new ServiceCollection();
        services.AddSingleton<IRunEventStore, InMemoryRunEventStore>();
        services.AddSingleton<IRunQueue, InMemoryRunQueue>();
        services.AddSingleton(chat);
        return services.BuildServiceProvider();
    }

    private static async Task WaitRunAsync(IRunEventStore store, string runId, Func<RunMeta?, bool> pred, CancellationToken ct)
    {
        var until = DateTime.UtcNow.AddSeconds(2);
        while (DateTime.UtcNow < until)
        {
            var cur = await store.GetRunAsync(RunKinds.Chat, runId, ct);
            if (pred(cur)) return;
            await Task.Delay(20, ct);
        }
    }

    private static RunMeta NewMeta(string runId, string content = "hi")
    {
        return new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.Chat,
            Status = RunStatuses.Queued,
            AssistantMessageId = "assist-1",
            UserMessageId = "user-1",
            InputJson = JsonSerializer.Serialize(new
            {
                sessionId = "s1",
                content,
                promptKey = (string?)null,
                userId = "u1",
                attachmentIds = Array.Empty<string>()
            })
        };
    }

    private static ChatRunWorker NewWorker(IServiceProvider sp)
        => new(sp.GetRequiredService<IServiceScopeFactory>(),
            sp.GetRequiredService<IRunQueue>(),
            sp.GetRequiredService<IRunEventStore>(),
            NullLogger<ChatRunWorker>.Instance);

    private sealed class DoneChatService : IChatService
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
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var mid = fixedAssistantMessageId ?? "a1";
            yield return new ChatStreamEvent { Type = "start", MessageId = mid };
            yield return new ChatStreamEvent { Type = "blockStart", MessageId = mid, BlockId = "b1", BlockKind = "paragraph" };
            yield return new ChatStreamEvent { Type = "blockDelta", MessageId = mid, BlockId = "b1", BlockKind = "paragraph", Content = "hello\n" };
            yield return new ChatStreamEvent { Type = "blockEnd", MessageId = mid, BlockId = "b1", BlockKind = "paragraph" };
            await Task.Delay(5, cancellationToken);
            yield return new ChatStreamEvent { Type = "done", MessageId = mid };
        }

        public Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50) => Task.FromResult(new List<Message>());
        public Task<List<Message>> GetGroupHistoryAsync(string groupId, int limit = 100) => Task.FromResult(new List<Message>());
    }

    private sealed class ErrorChatService : IChatService
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
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var mid = fixedAssistantMessageId ?? "a1";
            yield return new ChatStreamEvent { Type = "start", MessageId = mid };
            await Task.Delay(5, cancellationToken);
            yield return new ChatStreamEvent { Type = "error", MessageId = mid, ErrorCode = ErrorCodes.LLM_ERROR, ErrorMessage = "boom" };
        }

        public Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50) => Task.FromResult(new List<Message>());
        public Task<List<Message>> GetGroupHistoryAsync(string groupId, int limit = 100) => Task.FromResult(new List<Message>());
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
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            var mid = fixedAssistantMessageId ?? "a1";
            yield return new ChatStreamEvent { Type = "start", MessageId = mid };
            for (var i = 0; i < 20; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return new ChatStreamEvent { Type = "blockDelta", MessageId = mid, BlockId = "b1", BlockKind = "paragraph", Content = $"t{i}\n" };
                await Task.Delay(60, cancellationToken);
            }
            yield return new ChatStreamEvent { Type = "done", MessageId = mid };
        }

        public Task<List<Message>> GetHistoryAsync(string sessionId, int limit = 50) => Task.FromResult(new List<Message>());
        public Task<List<Message>> GetGroupHistoryAsync(string groupId, int limit = 100) => Task.FromResult(new List<Message>());
    }

    [Fact]
    public async Task Done_ShouldMarkDone_AndWriteSnapshot()
    {
        var sp = BuildSp(new DoneChatService());
        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        var runId = "suite-done-1";
        await store.SetRunAsync(RunKinds.Chat, NewMeta(runId));
        await queue.EnqueueAsync(RunKinds.Chat, runId);

        var worker = NewWorker(sp);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await worker.StartAsync(cts.Token);

        await WaitRunAsync(store, runId, m => m?.Status == RunStatuses.Done, cts.Token);

        var meta = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
        meta.ShouldNotBeNull();
        meta!.Status.ShouldBe(RunStatuses.Done);

        var events = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 0, limit: 50, cts.Token);
        events.ShouldContain(e => e.PayloadJson.Contains("\"type\":\"done\"", StringComparison.OrdinalIgnoreCase));

        var snap = await store.GetSnapshotAsync(RunKinds.Chat, runId, cts.Token);
        snap.ShouldNotBeNull();
        snap!.SnapshotJson.ShouldContain("\"type\":\"snapshot\"");

        await worker.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Error_ShouldMarkError_AndEmitErrorEvent()
    {
        var sp = BuildSp(new ErrorChatService());
        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        var runId = "suite-err-1";
        await store.SetRunAsync(RunKinds.Chat, NewMeta(runId));
        await queue.EnqueueAsync(RunKinds.Chat, runId);

        var worker = NewWorker(sp);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await worker.StartAsync(cts.Token);

        await WaitRunAsync(store, runId, m => m?.Status == RunStatuses.Error, cts.Token);

        var meta = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
        meta.ShouldNotBeNull();
        meta!.Status.ShouldBe(RunStatuses.Error);

        var events = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 0, limit: 50, cts.Token);
        events.ShouldContain(e => e.PayloadJson.Contains("\"type\":\"error\"", StringComparison.OrdinalIgnoreCase));

        await worker.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task CancelRequested_BeforeStart_ShouldMarkCancelled()
    {
        var sp = BuildSp(new SlowChatService());
        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        var runId = "suite-cancel-early-1";
        await store.SetRunAsync(RunKinds.Chat, NewMeta(runId));
        await store.TryMarkCancelRequestedAsync(RunKinds.Chat, runId);
        await queue.EnqueueAsync(RunKinds.Chat, runId);

        var worker = NewWorker(sp);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await worker.StartAsync(cts.Token);

        await WaitRunAsync(store, runId, m => m?.Status == RunStatuses.Cancelled, cts.Token);

        var meta = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
        meta.ShouldNotBeNull();
        meta!.Status.ShouldBe(RunStatuses.Cancelled);

        await worker.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task CancelRequested_MidStream_ShouldStopAndMarkCancelled()
    {
        var sp = BuildSp(new SlowChatService());
        var store = sp.GetRequiredService<IRunEventStore>();
        var queue = sp.GetRequiredService<IRunQueue>();

        var runId = "suite-cancel-mid-1";
        await store.SetRunAsync(RunKinds.Chat, NewMeta(runId, content: "stream"));
        await queue.EnqueueAsync(RunKinds.Chat, runId);

        var worker = NewWorker(sp);
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await worker.StartAsync(cts.Token);

        // 等待至少写入一些事件后再 cancel
        await Task.Delay(250, cts.Token);
        await store.TryMarkCancelRequestedAsync(RunKinds.Chat, runId, cts.Token);

        await WaitRunAsync(store, runId, m => m?.Status == RunStatuses.Cancelled, cts.Token);
        var meta = await store.GetRunAsync(RunKinds.Chat, runId, cts.Token);
        meta.ShouldNotBeNull();
        meta!.Status.ShouldBe(RunStatuses.Cancelled);

        // 取消后不要求有 done；但应该至少有部分事件
        var events = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 0, limit: 200, cts.Token);
        events.Count.ShouldBeGreaterThan(0);

        await worker.StopAsync(CancellationToken.None);
    }
}


