using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class AuthFailureHealthPolicyTests
{
    [Theory]
    [InlineData("admin", "admin")]
    [InlineData("developer", "developer")]
    [InlineData("viewer", "viewer")]
    [InlineData("owner", "viewer")]
    [InlineData("billing", "viewer")]
    [InlineData(null, "viewer")]
    public void StableSmokeRole_ShouldNeverImplicitlyGrantOwnerOrBilling(string? configured, string expected)
    {
        Assert.Equal(expected, StableSmokeFederation.NormalizeRole(configured));
    }

    [Theory]
    [InlineData(0, 30)]
    [InlineData(1, 5)]
    [InlineData(15, 15)]
    [InlineData(90, 30)]
    public void StableSmokeSession_ShouldStayBetweenFiveAndThirtyMinutes(int configured, int expected)
    {
        Assert.Equal(expected, StableSmokeFederation.NormalizeSessionMinutes(configured));
    }

    [Fact]
    public void SameIdentityThreeTimes_ShouldOpenIdentityIncidentWithoutUsername()
    {
        var now = DateTime.UtcNow;
        var samples = Enumerable.Range(0, 3)
            .Select(index => Failure("machine-one", "INVALID_SIGNATURE", now.AddSeconds(index)))
            .ToList();

        var incident = Assert.Single(AuthFailureHealthPolicy.Evaluate(samples));

        Assert.Equal("identity", incident.Scope);
        Assert.Equal(3, incident.Attempts);
        Assert.Equal(1, incident.AffectedIdentities);
        Assert.NotEqual("machine-one", incident.IdentityFingerprint);
        Assert.Equal(12, incident.IdentityFingerprint?.Length);
    }

    [Fact]
    public void LaterSuccess_ShouldClosePriorIdentityFailures()
    {
        var now = DateTime.UtcNow;
        var samples = new List<LlmGwLoginAudit>
        {
            Failure("machine-one", "INVALID_SIGNATURE", now),
            Failure("machine-one", "INVALID_SIGNATURE", now.AddSeconds(1)),
            Failure("machine-one", "INVALID_SIGNATURE", now.AddSeconds(2)),
            Success("machine-one", now.AddSeconds(3)),
        };

        Assert.Empty(AuthFailureHealthPolicy.Evaluate(samples));
        var recovery = Assert.Single(AuthFailureHealthPolicy.FindRecoveries(samples));
        Assert.Equal("INVALID_SIGNATURE", recovery.Reason);
        Assert.Equal(3, recovery.Attempts);
        Assert.Equal(now.AddSeconds(3), recovery.RecoveredAt);
    }

    [Fact]
    public void SameReasonAcrossThreeIdentities_ShouldOpenPlatformIncident()
    {
        var now = DateTime.UtcNow;
        var samples = new List<LlmGwLoginAudit>
        {
            Failure("machine-one", "KEY_NOT_CONFIGURED", now),
            Failure("machine-two", "KEY_NOT_CONFIGURED", now.AddSeconds(1)),
            Failure("machine-three", "KEY_NOT_CONFIGURED", now.AddSeconds(2)),
        };

        var incident = Assert.Single(AuthFailureHealthPolicy.Evaluate(samples));

        Assert.Equal("platform", incident.Scope);
        Assert.Equal(3, incident.AffectedIdentities);
        Assert.Null(incident.IdentityFingerprint);
    }

    private static LlmGwLoginAudit Failure(string username, string reason, DateTime at) => new()
    {
        Username = username,
        Reason = reason,
        Success = false,
        CreatedAt = at,
    };

    private static LlmGwLoginAudit Success(string username, DateTime at) => new()
    {
        Username = username,
        Success = true,
        CreatedAt = at,
    };
}
