using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", "Integration")]
public sealed class SidecarRunControlTests
{
    static SidecarReplayBinding Binding(string? run = null) => new(run ?? Guid.NewGuid().ToString("N"),
        "alice", "credential-a", "", "", null, DateTimeOffset.UtcNow.AddMinutes(20).ToUnixTimeSeconds());
    [Fact]
    public async Task FreshRouterUsesTrustedPrincipalAndRejectsOtherOrMissingSubject()
    {
        var store = SidecarReplayPersistenceTests.Store(); var b = Binding();
        Assert.Equal(ReplayResult.Accepted, await store.ReserveRunAsync(b, default));
        var context = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        var accessor = new Microsoft.AspNetCore.Http.HttpContextAccessor { HttpContext = context };
        var router = new PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarRouter(
            Moq.Mock.Of<System.Net.Http.IHttpClientFactory>(),
            Moq.Mock.Of<Microsoft.Extensions.Options.IOptionsMonitor<PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarOptions>>(),
            new PrdAgent.Infrastructure.Services.ClaudeSidecar.InstanceStateRegistry(),
            Moq.Mock.Of<PrdAgent.Core.Interfaces.IDynamicSidecarRegistry>(),
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), accessor,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<PrdAgent.Infrastructure.Services.ClaudeSidecar.ClaudeSidecarRouter>.Instance,
            runControl: store);
        Assert.False((await router.CancelRunAsync(b.RunId, default)).Cancelled);
        context.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
            new[] { new System.Security.Claims.Claim("sub", "bob") }, "test"));
        Assert.False((await router.CancelRunAsync(b.RunId, default)).Cancelled);
        context.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity(
            new[] { new System.Security.Claims.Claim("sub", "alice") }, "test"));
        var pending = await router.CancelRunAsync(b.RunId, default);
        Assert.False(pending.Cancelled);
        Assert.Equal("cancel_requested", pending.Reason);
        Assert.Equal("cancel_requested", (await store.ControlRunAsync(b, "status", default)).State);
        Assert.Equal("cancelled", (await store.ControlRunAsync(b, "fail", default)).State);
        Assert.True((await router.CancelRunAsync(b.RunId, default)).Cancelled);
    }
    [Fact]
    public async Task OwnershipCancellationAndTerminalStateAreSharedAndImmutable()
    {
        var first = SidecarReplayPersistenceTests.Store(); var second = SidecarReplayPersistenceTests.Store(); var b = Binding();
        Assert.Equal(ReplayResult.Accepted, await first.ReserveRunAsync(b, default));
        Assert.Equal(ReplayResult.Rejected, (await second.CancelOwnedRunAsync(b.RunId, "bob", default)).Result);
        Assert.Equal(ReplayResult.Rejected, (await second.ControlRunAsync(b with { CredentialHash = "other" }, "cancel", default)).Result);
        Assert.Equal(ReplayResult.Rejected, (await second.ControlRunAsync(b with { RunId = "other" }, "cancel", default)).Result);
        Assert.Equal("running", (await first.ControlRunAsync(b, "status", default)).State);
        Assert.Equal("cancel_requested", (await second.CancelOwnedRunAsync(b.RunId, "alice", default)).State);
        Assert.Equal("cancelled", (await first.ControlRunAsync(b, "complete", default)).State);
        foreach (var op in new[] { "status", "cancel", "complete", "fail" })
            Assert.Equal("cancelled", (await second.ControlRunAsync(b, op, default)).State);
        Assert.Equal(ReplayResult.Rejected, await second.ReserveRunAsync(b, default));
    }
    [Fact]
    public async Task CompletionRacesCancellationWithoutContradictoryTerminalState()
    {
        for (var i = 0; i < 30; i++)
        {
            var store = SidecarReplayPersistenceTests.Store(); var b = Binding();
            Assert.Equal(ReplayResult.Accepted, await store.ReserveRunAsync(b, default));
            var results = await Task.WhenAll(store.ControlRunAsync(b, "complete", default),
                SidecarReplayPersistenceTests.Store().CancelOwnedRunAsync(b.RunId, "alice", default));
            var final = await store.ControlRunAsync(b, "status", default);
            Assert.Contains(final.State, new[] { "completed", "cancelled" });
            Assert.Equal(final.State, results[0].State);
            Assert.Equal(final.State, (await store.ControlRunAsync(b, "fail", default)).State);
        }
    }
    [Fact]
    public async Task ExpiredAndUnavailableRunsCannotClaimCancellationSuccess()
    {
        var b = Binding() with { ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1).ToUnixTimeSeconds() };
        var store = SidecarReplayPersistenceTests.Store();
        Assert.Equal(ReplayResult.Rejected, await store.ReserveRunAsync(b, default));
        Assert.Equal("expired", (await store.ControlRunAsync(b, "cancel", default)).State);
        Assert.Equal("expired", (await store.ControlRunAsync(b, "complete", default)).State);
        Assert.Equal(ReplayResult.Unavailable, (await SidecarReplayPersistenceTests.Store(true).ControlRunAsync(b, "cancel", default)).Result);
        Assert.Equal(ReplayResult.Unavailable, (await SidecarReplayPersistenceTests.Store(true).CancelOwnedRunAsync(b.RunId, "alice", default)).Result);
    }
    [Fact]
    public async Task IndependentProcessLifecycle()
    {
        var phase = Environment.GetEnvironmentVariable("KD05_CANCEL_PHASE");
        var b = Binding("cross-process-cancel") with { ExpiresAt = long.Parse(Environment.GetEnvironmentVariable("KD05_REPLAY_EXPIRY")!) };
        var store = SidecarReplayPersistenceTests.Store();
        switch (phase)
        {
            case "seed": Assert.Equal(ReplayResult.Accepted, await store.ReserveRunAsync(b, default)); break;
            case "cancel": Assert.Equal("cancel_requested", (await store.CancelOwnedRunAsync(b.RunId, "alice", default)).State); break;
            case "finish": Assert.Equal("cancelled", (await store.ControlRunAsync(b, "complete", default)).State); break;
            case "verify":
                Assert.Equal("cancelled", (await store.ControlRunAsync(b, "status", default)).State);
                Assert.Equal("cancelled", (await store.ControlRunAsync(b, "complete", default)).State);
                Assert.Equal(ReplayResult.Rejected, await store.ReserveRunAsync(b, default)); break;
            default: Assert.Fail("Set KD05_CANCEL_PHASE to seed/cancel/finish/verify in separate testhost processes"); break;
        }
    }
}
