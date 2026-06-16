using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class ChangelogLinkedDefectsTests
{
    [Fact]
    public void ResolvePublishStatus_UsesDeployedCommitPosition()
    {
        var shaIndex = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
        {
            ["newer"] = 0,
            ["deployed"] = 1,
            ["older"] = 2,
        };

        Assert.Equal(
            DefectResolutionPublishStatus.Pending,
            ChangelogController.ResolvePublishStatus(
                new DefectResolutionTrace { CommitSha = "newer" },
                "deployed",
                1,
                shaIndex));

        Assert.Equal(
            DefectResolutionPublishStatus.Published,
            ChangelogController.ResolvePublishStatus(
                new DefectResolutionTrace { CommitSha = "older" },
                "deployed",
                1,
                shaIndex));
    }

    [Fact]
    public void ResolvePublishStatus_KeepsPersistedPublishedStatus()
    {
        var status = ChangelogController.ResolvePublishStatus(
            new DefectResolutionTrace
            {
                CommitSha = "missing",
                PublishStatus = DefectResolutionPublishStatus.Published,
            },
            null,
            -1,
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase));

        Assert.Equal(DefectResolutionPublishStatus.Published, status);
    }
}
