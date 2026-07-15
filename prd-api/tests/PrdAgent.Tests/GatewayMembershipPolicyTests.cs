using PrdAgent.LlmGw.Organization;
using Xunit;

namespace PrdAgent.Tests;

public sealed class GatewayMembershipPolicyTests
{
    [Theory]
    [InlineData("tenant-a", "viewer", "tenant-a.viewer")]
    [InlineData("tenant-a", "tenant-a.viewer", "tenant-a.viewer")]
    [InlineData("tenant-b", "viewer", "tenant-b.viewer")]
    public void CanonicalUsername_IsTenantNamespacedAndIdempotent(string tenantSlug, string requested, string expected)
    {
        Assert.True(MembershipPolicy.TryCanonicalizeUsername(tenantSlug, requested, out var actual));
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData("ab")]
    [InlineData("_leading")]
    [InlineData("bad name")]
    public void CanonicalUsername_RejectsInvalidAccountName(string requested)
        => Assert.False(MembershipPolicy.TryCanonicalizeUsername("tenant-a", requested, out _));

    [Fact]
    public void CanonicalUsername_AllowsMaximumTenantSlugAndAccountName()
    {
        var tenantSlug = new string('t', 64);
        var accountName = new string('a', 48);

        Assert.True(MembershipPolicy.TryCanonicalizeUsername(tenantSlug, accountName, out var username));
        Assert.Equal(113, username.Length);
    }

    [Theory]
    [InlineData("completed", true, true)]
    [InlineData("pending", false, false)]
    [InlineData("failed", false, false)]
    [InlineData(null, false, false)]
    public void IdempotentReplay_RequiresCompletedSuccessfulAudit(string? state, bool success, bool expected)
        => Assert.Equal(expected, MembershipPolicy.AllowsIdempotentReplay(state, success));

    [Fact]
    public void DeveloperScope_RequiresEverySelectedTeamToRemainActive()
    {
        var selected = new[] { "active-team", "disabled-team" };
        var active = new HashSet<string>(new[] { "active-team" }, StringComparer.Ordinal);

        Assert.False(MembershipPolicy.HasUsableDeveloperScope("developer", selected, active));
        Assert.True(MembershipPolicy.HasUsableDeveloperScope("viewer", selected, active));
    }

    [Fact]
    public void OwnerRemoval_OnlyProtectsAnActiveOwner()
    {
        Assert.True(MembershipPolicy.RemovesActiveOwner("owner", "active", "viewer", "active"));
        Assert.True(MembershipPolicy.RemovesActiveOwner("owner", "active", "owner", "disabled"));
        Assert.False(MembershipPolicy.RemovesActiveOwner("owner", "disabled", "viewer", "disabled"));
    }
}
