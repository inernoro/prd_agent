using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Run;

public class InMemoryRunEventStoreTests
{
    [Fact]
    public async Task AppendAndGetEvents_ShouldBeOrderedAndAfterSeqWorks()
    {
        var store = new InMemoryRunEventStore();
        var runId = "r1";

        await store.SetRunAsync(RunKinds.Chat, new RunMeta { RunId = runId, Kind = RunKinds.Chat, Status = RunStatuses.Queued });

        var s1 = await store.AppendEventAsync(RunKinds.Chat, runId, "message", new { type = "start" });
        var s2 = await store.AppendEventAsync(RunKinds.Chat, runId, "message", new { type = "blockDelta", content = "hi" });
        var s3 = await store.AppendEventAsync(RunKinds.Chat, runId, "message", new { type = "done" });

        Assert.Equal(1, s1);
        Assert.Equal(2, s2);
        Assert.Equal(3, s3);

        var all = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 0, limit: 10);
        Assert.Equal(3, all.Count);
        Assert.Equal(new long[] { 1, 2, 3 }, all.Select(x => x.Seq).ToArray());

        var after2 = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 2, limit: 10);
        Assert.Single(after2);
        Assert.Equal(3, after2[0].Seq);
    }

    [Fact]
    public async Task Snapshot_SetAndGet()
    {
        var store = new InMemoryRunEventStore();
        var runId = "r2";

        await store.SetSnapshotAsync(RunKinds.Chat, runId, new RunSnapshot
        {
            Seq = 7,
            SnapshotJson = "{\"type\":\"snapshot\",\"content\":\"hello\"}",
            UpdatedAt = DateTime.UtcNow
        });

        var got = await store.GetSnapshotAsync(RunKinds.Chat, runId);
        Assert.NotNull(got);
        Assert.Equal(7, got!.Seq);
        Assert.Contains("snapshot", got.SnapshotJson);
    }
}


