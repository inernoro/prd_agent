using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Run;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
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

        s1.ShouldBe(1);
        s2.ShouldBe(2);
        s3.ShouldBe(3);

        var all = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 0, limit: 10);
        all.Count.ShouldBe(3);
        all.Select(x => x.Seq).ToArray().ShouldBe(new long[] { 1, 2, 3 });

        var after2 = await store.GetEventsAsync(RunKinds.Chat, runId, afterSeq: 2, limit: 10);
        after2.Count.ShouldBe(1);
        after2[0].Seq.ShouldBe(3);
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
        got.ShouldNotBeNull();
        got!.Seq.ShouldBe(7);
        got.SnapshotJson.ShouldContain("snapshot");
    }
}


