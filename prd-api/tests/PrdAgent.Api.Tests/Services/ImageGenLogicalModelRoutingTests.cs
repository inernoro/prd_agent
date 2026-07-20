using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ImageGenLogicalModelRoutingTests
{
    [Fact]
    public void ResolveExplicitLogicalModelPublicId_PrefersPersistedStableIdentity()
    {
        var run = new ImageGenRun
        {
            PlatformId = "provider-after-old-scheduling",
            ModelId = "upstream/model-after-old-scheduling",
            LogicalModelPublicId = "nanobanana-2",
        };

        var result = ImageGenRunWorker.ResolveExplicitLogicalModelPublicId(run);

        Assert.Equal("nanobanana-2", result);
    }

    [Fact]
    public void ResolveExplicitLogicalModelPublicId_RecoversIdentityFromLogicalPlatformMarker()
    {
        var run = new ImageGenRun
        {
            PlatformId = "LOGICAL-MODEL",
            ModelId = " image2 ",
        };

        var result = ImageGenRunWorker.ResolveExplicitLogicalModelPublicId(run);

        Assert.Equal("image2", result);
    }

    [Fact]
    public void ResolveExplicitLogicalModelPublicId_DoesNotTreatLegacyPoolModelAsLogical()
    {
        var run = new ImageGenRun
        {
            PlatformId = "openrouter.ai",
            ModelId = "google/gemini-3.1-flash-image",
        };

        var result = ImageGenRunWorker.ResolveExplicitLogicalModelPublicId(run);

        Assert.Null(result);
    }
}
