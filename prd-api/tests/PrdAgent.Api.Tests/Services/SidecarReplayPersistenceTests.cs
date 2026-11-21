using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;
using Xunit;
namespace PrdAgent.Api.Tests.Services;

// Opt-in real Mongo tests. Never reads production connection configuration.
[Trait("Category", "Integration")]
public sealed class SidecarReplayPersistenceTests
{
    private readonly Xunit.Abstractions.ITestOutputHelper _output;
    public SidecarReplayPersistenceTests(Xunit.Abstractions.ITestOutputHelper output) => _output = output;
    internal static MongoSidecarReplayStore Store(bool unavailable = false)
    {
        var name = Environment.GetEnvironmentVariable("KD05_REPLAY_DATABASE");
        Assert.StartsWith("kd05_replay_", name);
        return new(new LlmGatewayDataContext($"mongodb://127.0.0.1:{(unavailable ? 27392 : 27391)}/?serverSelectionTimeoutMS=600&connectTimeoutMS=600&retryWrites=false", name!), NullLogger<MongoSidecarReplayStore>.Instance);
    }
    static SidecarReplayBinding Binding(string? run = null) => new(run ?? Guid.NewGuid().ToString("N"), "alice", "credential-hash", "approval", "echo", SidecarReplayBinding.Hash("{\"text\":\"approved\"}"), DateTimeOffset.UtcNow.AddMinutes(30).ToUnixTimeSeconds());
    static async Task Approve(ISidecarReplayStore store, SidecarReplayBinding b)
    {
        Assert.Equal(ReplayResult.Accepted, await store.RegisterApprovalAsync(b, default));
        Assert.Equal(ReplayResult.Accepted, await store.ClaimWaitAsync(b, default));
        Assert.Equal(ReplayResult.Accepted, await store.FinishWaitAsync(b, true, true, default));
    }
    [Fact]
    public async Task TwoReplicasConsumeApprovalAndReserveRunExactlyOnce()
    {
        var a = Store(); var b = Store(); var binding = Binding(); await Approve(a, binding);
        var outcomes = await Task.WhenAll(Enumerable.Range(0, 40).Select(i => (i % 2 == 0 ? a : b).ConsumeAsync(binding, default)));
        Assert.Single(outcomes, x => x == ReplayResult.Accepted);
        Assert.Equal(39, outcomes.Count(x => x == ReplayResult.Rejected));
        var runs = await Task.WhenAll(Enumerable.Range(0, 40).Select(i => (i % 2 == 0 ? a : b).ReserveRunAsync(binding, default)));
        Assert.Single(runs, x => x == ReplayResult.Accepted);
        Assert.Equal(39, runs.Count(x => x == ReplayResult.Rejected));
        Assert.Equal(ReplayResult.Rejected, await b.RegisterApprovalAsync(binding with { CredentialHash = "new-issuance" }, default));
    }
    [Fact]
    public async Task BindingTamperingCannotBurnValidApproval()
    {
        var store = Store(); var b = Binding(); await Approve(store, b);
        foreach (var altered in new[] { b with { Subject = "bob" }, b with { RunId = "other" }, b with { Tool = "Bash" }, b with { InputHash = "changed" }, b with { CredentialHash = "other" }, b with { ExpiresAt = b.ExpiresAt + 1 }, b with { ApprovalId = "other" } })
            Assert.Equal(ReplayResult.Rejected, await store.ConsumeAsync(altered, default));
        Assert.Equal(ReplayResult.Accepted, await store.ConsumeAsync(b, default));
    }
    [Fact]
    public async Task ExpiryDenialNativeReleaseAndUnfinishedWaitCannotExecuteAgain()
    {
        var store = Store(); var expired = Binding() with { ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-10).ToUnixTimeSeconds() };
        Assert.Equal(ReplayResult.Rejected, await store.RegisterApprovalAsync(expired, default));
        Assert.Equal(ReplayResult.Rejected, await store.ReserveRunAsync(expired, default));
        Assert.Equal(ReplayResult.Rejected, await store.ClaimWaitAsync(expired, default));
        Assert.Equal(ReplayResult.Rejected, await store.ConsumeAsync(expired, default));
        var expiresAfterApproval = Binding() with { ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(3).ToUnixTimeSeconds() };
        await Approve(store, expiresAfterApproval);
        await Task.Delay(TimeSpan.FromSeconds(3.1));
        Assert.Equal(ReplayResult.Rejected, await Store().ConsumeAsync(expiresAfterApproval, default));
        foreach (var native in new[] { false, true })
        {
            var b = Binding(); Assert.Equal(ReplayResult.Accepted, await store.RegisterApprovalAsync(b, default));
            var claims = await Task.WhenAll(store.ClaimWaitAsync(b, default), Store().ClaimWaitAsync(b, default));
            Assert.Single(claims, x => x == ReplayResult.Accepted);
            Assert.Equal(ReplayResult.Rejected, await Store().ConsumeAsync(b, default));
            Assert.Equal(ReplayResult.Accepted, await store.FinishWaitAsync(b, native, !native, default));
            Assert.Equal(ReplayResult.Rejected, await Store().ClaimWaitAsync(b, default));
            Assert.Equal(ReplayResult.Rejected, await Store().FinishWaitAsync(b, true, true, default));
            Assert.Equal(ReplayResult.Rejected, await Store().ConsumeAsync(b, default));
        }
    }
    [Fact]
    public async Task UnavailableStorageNeverGrants()
    {
        var store = Store(true); var b = Binding();
        Assert.Equal(ReplayResult.Unavailable, await store.ReserveRunAsync(b, default));
        Assert.Equal(ReplayResult.Unavailable, await store.RegisterApprovalAsync(b, default));
        Assert.Equal(ReplayResult.Unavailable, await store.ClaimWaitAsync(b, default));
        Assert.Equal(ReplayResult.Unavailable, await store.FinishWaitAsync(b, true, true, default));
        Assert.Equal(ReplayResult.Unavailable, await store.ConsumeAsync(b, default));
    }
    [Fact]
    public async Task IndependentProcessRace()
    {
        var b = Binding("restart-run") with { ApprovalId = "process-race",
            ExpiresAt = long.Parse(Environment.GetEnvironmentVariable("KD05_REPLAY_EXPIRY")!) };
        var results = await Task.WhenAll(Enumerable.Range(0, 30).Select(_ => Store().ConsumeAsync(b, default)));
        Assert.DoesNotContain(ReplayResult.Unavailable, results);
        Assert.InRange(results.Count(x => x == ReplayResult.Accepted), 0, 1);
        _output.WriteLine("CAS_WINNERS=" + results.Count(x => x == ReplayResult.Accepted));
    }
    [Fact]
    public async Task ReplaySurvivesTestHostAndDatabaseRestart()
    {
        var phase = Environment.GetEnvironmentVariable("KD05_REPLAY_PHASE"); Assert.Contains(phase, new[] { "seed", "verify" });
        var b = Binding("restart-run") with { ExpiresAt = long.Parse(Environment.GetEnvironmentVariable("KD05_REPLAY_EXPIRY")!) };
        var pending = b with { ApprovalId = "pending" }; var store = Store();
        if (phase == "seed")
        {
            Assert.Equal(ReplayResult.Accepted, await store.ReserveRunAsync(b, default));
            await Approve(store, b); await Approve(store, pending);
            await Approve(store, b with { ApprovalId = "process-race" });
            Assert.Equal(ReplayResult.Accepted, await store.ConsumeAsync(b, default));
        }
        else
        {
            Assert.Equal(ReplayResult.Rejected, await store.ReserveRunAsync(b, default));
            Assert.Equal(ReplayResult.Rejected, await store.RegisterApprovalAsync(b, default));
            Assert.Equal(ReplayResult.Rejected, await store.ConsumeAsync(b, default));
            Assert.Equal(ReplayResult.Accepted, await store.ConsumeAsync(pending, default));
            Assert.Equal(ReplayResult.Rejected, await store.ConsumeAsync(pending, default));
        }
    }
}
