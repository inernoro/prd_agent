using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Tests;

public class TeamActivityQueryCacheTests
{
    [Fact]
    public async Task ConcurrentReadersShareComputationAndCompletedResult()
    {
        var cache = new TeamActivityQueryCache<int>(TimeSpan.FromSeconds(30));
        var completion = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        Task<int> Compute() { Interlocked.Increment(ref calls); return completion.Task; }
        var readers = Enumerable.Range(0, 20).Select(_ => cache.GetAsync("today", Compute)).ToArray();
        Assert.Equal(1, calls);
        completion.SetResult(42);
        Assert.All(await Task.WhenAll(readers), value => Assert.Equal(42, value));
        Assert.Equal(42, await cache.GetAsync("today", Compute));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task FailureDoesNotPoisonRetry()
    {
        var cache = new TeamActivityQueryCache<int>(TimeSpan.FromSeconds(30));
        await Assert.ThrowsAsync<InvalidOperationException>(() => cache.GetAsync("today", () => Task.FromException<int>(new InvalidOperationException())));
        Assert.Equal(7, await cache.GetAsync("today", () => Task.FromResult(7)));
    }

    [Fact]
    public async Task ExpiryStartsAfterCompletionAndDifferentWindowsRemainSeparate()
    {
        var clock = new TestClock();
        var cache = new TeamActivityQueryCache<int>(TimeSpan.FromSeconds(30), clock);
        var completion = new TaskCompletionSource<int>();
        var first = cache.GetAsync("today", () => completion.Task);
        clock.Now = clock.Now.AddMinutes(1);
        completion.SetResult(1);
        await first;
        Assert.Equal(1, await cache.GetAsync("today", () => Task.FromResult(2)));
        Assert.Equal(3, await cache.GetAsync("week", () => Task.FromResult(3)));
        clock.Now = clock.Now.AddSeconds(31);
        Assert.Equal(2, await cache.GetAsync("today", () => Task.FromResult(2)));
    }

    private sealed class TestClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.Parse("2026-11-04T00:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
