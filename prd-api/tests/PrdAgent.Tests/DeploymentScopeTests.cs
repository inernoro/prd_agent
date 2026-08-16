using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public sealed class DeploymentScopeTests
{
    [Theory]
    [InlineData(null, "codex/feature", "abc123", null)]
    [InlineData(" ", "codex/feature", "abc123", null)]
    [InlineData("prd-agent", null, null, "prd-agent")]
    [InlineData("prd-agent", "codex/feature", null, "prd-agent::codex/feature")]
    [InlineData(" prd-agent ", " codex/feature ", " abc123 ", "prd-agent::codex/feature::revision::abc123")]
    [InlineData("prd-agent", null, "abc123", "prd-agent::revision::abc123")]
    public void Compose_FencesPreviewScopeByProjectBranchAndRevision(
        string? projectId,
        string? branch,
        string? revision,
        string? expected)
    {
        Assert.Equal(expected, DeploymentScope.Compose(projectId, branch, revision));
    }

    [Fact]
    public void Compose_DurableBranchScopeOmitsRevision()
    {
        Assert.Equal(
            "prd-agent::codex/feature",
            DeploymentScope.Compose("prd-agent", "codex/feature", revision: null));
    }

    [Fact]
    public void DurableIdempotencyScope_RemainsStableAcrossRevisionChanges()
    {
        const string key = "profile-avatar::client-request";
        var durableScope = DeploymentScope.Compose("prd-agent", "codex/feature", revision: null);
        var revisionA = DeploymentScope.Compose("prd-agent", "codex/feature", "commit-a");
        var revisionB = DeploymentScope.Compose("prd-agent", "codex/feature", "commit-b");

        Assert.NotEqual(revisionA, revisionB);
        Assert.Equal(
            "prd-agent::codex/feature::profile-avatar::client-request",
            DeploymentScope.BuildScopedIdempotencyKey(key, durableScope));
        Assert.NotEqual(
            DeploymentScope.BuildScopedIdempotencyKey(key, revisionA),
            DeploymentScope.BuildScopedIdempotencyKey(key, revisionB));
    }
}
