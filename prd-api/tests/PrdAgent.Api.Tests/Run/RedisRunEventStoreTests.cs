using System.Text.Json;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using StackExchange.Redis;
using Xunit;

namespace PrdAgent.Api.Tests.Run;

// Run against an isolated local Redis with RUN_EVENT_REDIS_TEST_CONNECTION=127.0.0.1:<port>.
// Never flush a database: each test owns only its random run's three keys.
public sealed class RedisRunEventStoreTests : IDisposable
{
    private readonly string _connection = Environment.GetEnvironmentVariable("RUN_EVENT_REDIS_TEST_CONNECTION") ?? "";
    private readonly string _runId = "redis-event-test-" + Guid.NewGuid().ToString("N");
    private readonly List<RedisKey> _keys = new();
    private ConnectionMultiplexer? _redis;

    private IDatabase Database => (_redis ??= ConnectionMultiplexer.Connect(_connection)).GetDatabase();
    private RedisKey Key(string suffix)
    {
        RedisKey key = $"run:{RunKinds.DesignArtifact}:{_runId}:{suffix}";
        if (!_keys.Contains(key)) _keys.Add(key);
        return key;
    }

    [LocalRedisFact]
    public async Task ConcurrentAppend_ShouldUseOneEvalPerEventAndKeepOrderedSequenceAndCursor()
    {
        using var first = new RedisRunEventStore(_connection);
        using var second = new RedisRunEventStore(_connection);
        Key("seq"); Key("events"); Key("meta");
        await first.TryMarkCancelRequestedAsync(RunKinds.DesignArtifact, _runId);
        var before = await EvalCountAsync();
        var results = await Task.WhenAll(Enumerable.Range(0, 128).Select(async index =>
        {
            var seq = await (index % 2 == 0 ? first : second).AppendEventAsync(
                RunKinds.DesignArtifact, _runId, "delta", new { text = $"片段-{index}" });
            return (seq, index);
        }));

        (await EvalCountAsync() - before).ShouldBe(128);
        results.Select(x => x.seq).Order().ShouldBe(Enumerable.Range(1, 128).Select(x => (long)x));
        var events = await first.GetEventsAsync(RunKinds.DesignArtifact, _runId, 0, 500);
        events.Select(x => x.Seq).ShouldBe(Enumerable.Range(1, 128).Select(x => (long)x));
        foreach (var item in events)
        {
            item.RunId.ShouldBe(_runId);
            item.EventName.ShouldBe("delta");
            using var payload = JsonDocument.Parse(item.PayloadJson);
            payload.RootElement.GetProperty("text").GetString().ShouldBe($"片段-{results.Single(x => x.seq == item.Seq).index}");
        }
        (await first.GetRunAsync(RunKinds.DesignArtifact, _runId))!.LastSeq.ShouldBe(128);
        (await first.IsCancelRequestedAsync(RunKinds.DesignArtifact, _runId)).ShouldBeTrue();
    }

    [LocalRedisFact]
    public async Task Append_ShouldKeepFullPayloadReplayAndTerminalEventEvenWithCancelledCallerToken()
    {
        using var store = new RedisRunEventStore(_connection);
        Key("seq"); Key("events"); Key("meta");
        var pieces = new[] { "<html>中文", "\"quoted\"\\line\n\0", "9007199254740993</html>" };
        foreach (var text in pieces)
            await store.AppendEventAsync(RunKinds.DesignArtifact, _runId, " delta ", new { text }, ct: new CancellationToken(true));
        await store.AppendEventAsync(RunKinds.DesignArtifact, _runId, "done", new { revisionId = "synthetic-revision" });

        var all = await store.GetEventsAsync(RunKinds.DesignArtifact, _runId, 0, 100);
        var rendered = string.Concat(all.Where(x => x.EventName == "delta").Select(x =>
        {
            using var payload = JsonDocument.Parse(x.PayloadJson);
            return payload.RootElement.GetProperty("text").GetString();
        }));
        rendered.ShouldBe(string.Concat(pieces));
        all.Last().EventName.ShouldBe("done");
        all.All(x => x.CreatedAt.Kind == DateTimeKind.Utc).ShouldBeTrue();
        (await store.GetEventsAsync(RunKinds.DesignArtifact, _runId, 2, 1)).Single().Seq.ShouldBe(3);
        (await store.GetEventsAsync(RunKinds.DesignArtifact, _runId, 4, 100)).ShouldBeEmpty();
    }

    [LocalRedisFact]
    public async Task Append_ShouldPreserveLargeIntegerSequenceWithoutLuaScientificNotation()
    {
        using var store = new RedisRunEventStore(_connection);
        Key("events"); Key("meta");
        const long previous = 100_000_000_000_000;
        await Database.StringSetAsync(Key("seq"), previous, TimeSpan.FromMinutes(1));
        (await store.AppendEventAsync(RunKinds.DesignArtifact, _runId, "delta", new { text = "precise" })).ShouldBe(previous + 1);
        (await store.GetEventsAsync(RunKinds.DesignArtifact, _runId, previous, 10)).Single().Seq.ShouldBe(previous + 1);
    }

    [LocalRedisFact]
    public async Task Append_ShouldRefreshAndExpireAllThreeKeysAndPreserveCancelFlag()
    {
        using var store = new RedisRunEventStore(_connection, TimeSpan.FromSeconds(8));
        var keys = new[] { Key("seq"), Key("events"), Key("meta") };
        await store.TryMarkCancelRequestedAsync(RunKinds.DesignArtifact, _runId);
        await store.AppendEventAsync(RunKinds.DesignArtifact, _runId, "delta", new { text = "first" });
        foreach (var key in keys) await Database.KeyExpireAsync(key, TimeSpan.FromSeconds(1));
        await store.AppendEventAsync(RunKinds.DesignArtifact, _runId, "delta", new { text = "next" });
        foreach (var key in keys)
            (await Database.KeyTimeToLiveAsync(key))!.Value.TotalSeconds.ShouldBeGreaterThan(5);
        (await store.IsCancelRequestedAsync(RunKinds.DesignArtifact, _runId)).ShouldBeTrue();

        await store.AppendEventAsync(RunKinds.DesignArtifact, _runId, "done", new { }, TimeSpan.FromMilliseconds(200));
        await Task.Delay(400);
        foreach (var key in keys) (await Database.KeyExistsAsync(key)).ShouldBeFalse();
    }

    [LocalRedisFact]
    public async Task Append_ShouldPropagateRedisFailureSoCallerCanDegradeProjection()
    {
        using var store = new RedisRunEventStore(_connection);
        Key("seq"); Key("meta");
        await Database.StringSetAsync(Key("events"), "wrong-type", TimeSpan.FromMinutes(1));
        await Should.ThrowAsync<RedisServerException>(() => store.AppendEventAsync(
            RunKinds.DesignArtifact, _runId, "delta", new { text = "not-silently-discarded" }));
        (await Database.HashGetAsync(Key("meta"), "lastSeq")).IsNull.ShouldBeTrue();
    }

    private async Task<long> EvalCountAsync()
    {
        var info = (string?)await Database.ExecuteAsync("INFO", "commandstats") ?? "";
        var line = info.Split('\n').SingleOrDefault(x => x.StartsWith("cmdstat_eval:", StringComparison.Ordinal));
        return line == null ? 0 : long.Parse(line.Split("calls=", StringSplitOptions.None)[1].Split(',')[0]);
    }

    public void Dispose()
    {
        if (_keys.Count == 0) return;
        var database = Database;
        foreach (var key in _keys) database.KeyDelete(key);
        _redis?.Dispose();
    }

    private sealed class LocalRedisFactAttribute : FactAttribute
    {
        public LocalRedisFactAttribute()
        {
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("RUN_EVENT_REDIS_TEST_CONNECTION")))
                Skip = "Requires an isolated local Redis via RUN_EVENT_REDIS_TEST_CONNECTION.";
        }
    }
}
