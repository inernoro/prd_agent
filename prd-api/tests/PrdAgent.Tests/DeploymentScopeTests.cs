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
}
