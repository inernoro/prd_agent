using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using Moq;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class LiteraryWebImageSizeTests
{
    [Fact]
    public void RetiredPublicIdUsesDeclaredSuccessorBeforeQueueingWithoutArbitraryFallback()
    {
        var successor = new GatewayImageModel { Model = new() { Code = "image-sunlight", IsDefault = true,
            Aliases = ["gpt-image-2.5-sunburst"] } };
        Assert.Same(successor, GatewayImageModelCatalog.Select([successor], "gpt-image-2.5-sunburst"));
        Assert.Null(GatewayImageModelCatalog.Select([successor], "unknown-old-model"));
        Assert.Same(successor, GatewayImageModelCatalog.Select([successor], null));
        var conflict = new GatewayImageModel { Model = new() { Code = "other", Aliases = ["gpt-image-2.5-sunburst"] } };
        Assert.Null(GatewayImageModelCatalog.Select([successor, conflict], "gpt-image-2.5-sunburst"));
    }

    [Fact]
    public async Task CatalogKeepsDefaultWithoutAcquiringRouteLease()
    {
        var gateway = new Mock<ILlmGateway>(MockBehavior.Strict);
        const string caller = "literary-agent.illustration.text2img::generation";
        gateway.Setup(x => x.GetAvailablePoolsAsync(caller, ModelTypes.ImageGen, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<AvailableModelPool>
            {
                new() { Code = "seedream", IsDefault = true, ResolutionType = "LogicalModel", Models = new()
                {
                    new() { ImageCapabilities = new GatewayImageCapabilitiesSnapshot
                    {
                        SizeConstraintType = "whitelist", SizesByResolution = new() { ["2k"] = new() { "2400x1600" } },
                    } },
                } },
            });
        var catalog = await GatewayImageModelCatalog.ReadAsync(gateway.Object, caller, CancellationToken.None);
        Assert.True(Assert.Single(catalog).Model.IsDefault);
        gateway.Verify(x => x.GetAvailablePoolsAsync(caller, ModelTypes.ImageGen, It.IsAny<CancellationToken>()), Times.Once);
        gateway.VerifyNoOtherCalls();
    }

    [Fact]
    public void OldProSizeCannotEnterFlashQueue()
    {
        var flash = new ImageGenAdapterInfo
        {
            SizeConstraintType = "whitelist",
            SizesByResolution = new() { ["1k"] = [new SizeOption { Size = "1264x848", AspectRatio = "3:2" }] },
        };
        Assert.NotNull(LiteraryIllustrationChoices.ValidateWebSize("1248x832", flash));
        Assert.Null(LiteraryIllustrationChoices.ValidateWebSize("1264x848", flash));
    }

    [Fact]
    public void RangeModelAlsoRequiresSizeDeclaredByWebCatalog()
    {
        var seedream = new ImageGenAdapterInfo
        {
            SizeConstraintType = "range", MaxWidth = 4096, MaxHeight = 4096, MaxPixels = 16777216,
            SizesByResolution = new() { ["2k"] = [new SizeOption { Size = "2400x1600", AspectRatio = "3:2" }] },
        };
        Assert.NotNull(LiteraryIllustrationChoices.ValidateWebSize("1264x848", seedream));
        Assert.Null(LiteraryIllustrationChoices.ValidateWebSize("2400x1600", seedream));
    }
}
