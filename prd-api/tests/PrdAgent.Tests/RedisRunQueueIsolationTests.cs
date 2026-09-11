using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using StackExchange.Redis;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 仅使用显式指定的独立本地 Redis，不读取应用连接串或凭据。
/// 每条用例使用独立数据库，退出时不清库；运行方负责启动和终止临时实例。
/// </summary>
public sealed class RedisRunQueueIsolationTests : IAsyncLifetime
{
    private static int _nextDatabase = -1;
    private string _connection = Environment.GetEnvironmentVariable("DESIGN_QUEUE_REDIS_TEST_CONNECTION") ?? "";
    private const string LegacyDesignKey = "run:designArtifact:queue";
    private readonly ITestOutputHelper _output;
    private ConnectionMultiplexer? _redis;

    public RedisRunQueueIsolationTests(ITestOutputHelper output) => _output = output;

    public async Task InitializeAsync()
    {
        var options = ConfigurationOptions.Parse(_connection);
        Assert.Single(options.EndPoints);
        Assert.Equal("127.0.0.1:16388", options.EndPoints.Single().ToString());
        options.DefaultDatabase = Interlocked.Increment(ref _nextDatabase);
        _connection = options.ToString();
        _redis = await ConnectionMultiplexer.ConnectAsync(_connection);
        Assert.Equal(0, await _redis.GetServer(options.EndPoints.Single()).DatabaseSizeAsync(options.DefaultDatabase.Value));
        _output.WriteLine($"隔离 Redis 127.0.0.1:16388，DB={options.DefaultDatabase}");
    }

    [DesignQueueRedisTheory]
    [InlineData("project-a", "branch-a", "revision-a", "project-b", "branch-a", "revision-a")]
    [InlineData("project-a", "branch-a", "revision-a", "project-a", "branch-b", "revision-a")]
    [InlineData("project-a", "branch-a", "revision-a", "project-a", "branch-a", "revision-b")]
    [InlineData(null, null, null, "project-a", "branch-a", "revision-a")]
    public async Task DifferentScopes_CannotConsumeEachOthersDesignRuns(
        string? projectA, string? branchA, string? revisionA,
        string? projectB, string? branchB, string? revisionB)
    {
        using var a = Queue(DeploymentScope.Compose(projectA, branchA, revisionA));
        using var b = Queue(DeploymentScope.Compose(projectB, branchB, revisionB));
        await a.EnqueueAsync(RunKinds.DesignArtifact, "run-a");
        Assert.Null(await b.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        await b.EnqueueAsync(RunKinds.DesignArtifact, "run-b");
        Assert.Equal("run-a", await a.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Null(await a.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal("run-b", await b.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
    }

    [DesignQueueRedisTheory]
    [InlineData("project-a::branch-a::revision::revision-a")]
    [InlineData(null)]
    public async Task SameScope_PreservesFifoAcrossInstances(string? scope)
    {
        using var producer = Queue(scope);
        using var consumer = Queue(scope);
        await producer.EnqueueAsync(RunKinds.DesignArtifact, "first");
        await producer.EnqueueAsync(RunKinds.DesignArtifact, "second");
        Assert.Equal("first", await consumer.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal("second", await consumer.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Null(await consumer.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
    }

    [DesignQueueRedisTheory]
    [InlineData("project-a::branch-a::revision::revision-a")]
    [InlineData(null)]
    public async Task LegacyPublicQueue_CannotPopNewDesignIds(string? scope)
    {
        Assert.Equal("designArtifact", RunKinds.DesignArtifact);
        using var queue = Queue(scope);
        await queue.EnqueueAsync(RunKinds.DesignArtifact, "new-run");
        Assert.True((await _redis!.GetDatabase().ListLeftPopAsync(LegacyDesignKey)).IsNull);
        await _redis.GetDatabase().ListRightPushAsync(LegacyDesignKey, "legacy-run");
        Assert.Equal("new-run", await queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Null(await queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal("legacy-run", (string?)await _redis.GetDatabase().ListLeftPopAsync(LegacyDesignKey));
    }

    [DesignQueueRedisFact]
    public async Task OtherKinds_KeepExistingKeysAndCrossScopeBehavior()
    {
        using var a = Queue("project-a::branch-a::revision::revision-a");
        using var b = Queue("project-b::branch-b::revision::revision-b");
        foreach (var kind in typeof(RunKinds).GetFields().Where(field => field.IsLiteral)
                     .Select(field => (string)field.GetRawConstantValue()!).Where(kind => kind != RunKinds.DesignArtifact))
        {
            await a.EnqueueAsync($" {kind} ", "new-run");
            Assert.Equal("new-run", (string?)await _redis!.GetDatabase().ListLeftPopAsync($"run:{kind}:queue"));
            await _redis.GetDatabase().ListRightPushAsync($"run:{kind}:queue", "legacy-run");
            Assert.Equal("legacy-run", await b.DequeueAsync(kind, TimeSpan.Zero));
        }
    }

    [DesignQueueRedisFact]
    public async Task Scope_IsCapturedAtConstructionAndDoesNotDrift()
    {
        string? current = "project-a::branch-a::revision::revision-a";
        var reads = 0;
        using var queue = new RedisRunQueue(_connection, () => { reads++; return current; });
        current = "project-a::branch-a::revision::revision-b";
        using var originalScope = Queue("project-a::branch-a::revision::revision-a");
        using var changedScope = Queue(current);
        await queue.EnqueueAsync($" {RunKinds.DesignArtifact} ", "frozen-run");
        Assert.Null(await changedScope.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal("frozen-run", await originalScope.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        await originalScope.EnqueueAsync(RunKinds.DesignArtifact, "return-run");
        Assert.Equal("return-run", await queue.DequeueAsync(RunKinds.DesignArtifact, TimeSpan.Zero));
        Assert.Equal(1, reads);
    }

    private RedisRunQueue Queue(string? scope) => new(_connection, () => scope);

    public async Task DisposeAsync()
    {
        if (_redis is not null) await _redis.DisposeAsync();
    }
}

public sealed class RedisRunQueueKeyTests
{
    [Theory]
    [InlineData("project-a::branch::revision::one", "project-b::branch::revision::one")]
    [InlineData("project-a::branch-a::revision::one", "project-a::branch-b::revision::one")]
    [InlineData("project-a::branch::revision::one", "project-a::branch::revision::two")]
    [InlineData(null, "project-a::branch::revision::one")]
    [InlineData(null, "unscoped")]
    public void DesignKeys_IsolateScopesAndNeverUseLegacyQueue(string? first, string? second)
    {
        var firstKey = RedisRunQueue.BuildKey(RunKinds.DesignArtifact, first);
        Assert.NotEqual(firstKey, RedisRunQueue.BuildKey(RunKinds.DesignArtifact, second));
        Assert.NotEqual("run:designArtifact:queue", firstKey);
        Assert.StartsWith("run:v2:designArtifact:", firstKey);
        Assert.Equal(firstKey, RedisRunQueue.BuildKey($" {RunKinds.DesignArtifact} ", first));
    }

    [Fact]
    public void OtherKinds_PreserveLegacyKeys()
    {
        foreach (var kind in typeof(RunKinds).GetFields().Where(field => field.IsLiteral)
                     .Select(field => (string)field.GetRawConstantValue()!).Where(kind => kind != RunKinds.DesignArtifact))
            Assert.Equal($"run:{kind}:queue", RedisRunQueue.BuildKey($" {kind} ", "project::branch::revision::one"));
    }
}

public sealed class DesignQueueRedisFactAttribute : FactAttribute
{
    public DesignQueueRedisFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DESIGN_QUEUE_REDIS_TEST_CONNECTION")))
            Skip = "需要显式 DESIGN_QUEUE_REDIS_TEST_CONNECTION=127.0.0.1:16388 和全新独立 Redis 实例；不连接应用 Redis。";
    }
}

public sealed class DesignQueueRedisTheoryAttribute : TheoryAttribute
{
    public DesignQueueRedisTheoryAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DESIGN_QUEUE_REDIS_TEST_CONNECTION")))
            Skip = "需要显式 DESIGN_QUEUE_REDIS_TEST_CONNECTION=127.0.0.1:16388 和全新独立 Redis 实例；不连接应用 Redis。";
    }
}
