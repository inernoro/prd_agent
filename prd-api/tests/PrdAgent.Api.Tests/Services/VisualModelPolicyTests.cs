using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class VisualModelPolicyTests
{
    private static VisualModelPolicy Policy() => new()
    {
        DefaultModelId = "image1",
        Models = [new() { ModelId = "image2", DisplayName = "GPT Image 2" }, new() { ModelId = "image1", DisplayName = "GPT Image 1" }],
    };

    private static GatewayImageModel Model(string id, bool isDefault = true) => new()
    {
        Model = new AvailableModelPool { Id = "id-" + id, Code = id, Name = id, IsDefault = isDefault, Models = [new PoolModelInfo { ModelId = id }] },
    };

    [Fact]
    public void DefaultIsExplicit_NotListOrderOrGatewayDefault()
    {
        var result = VisualModelPolicyService.Project(Policy(), [Model("image1"), Model("image2"), Model("new-model")]);
        Assert.Equal(new[] { "image2", "image1" }, result.Select(x => x.Code));
        Assert.False(result[0].IsDefault);
        Assert.True(result[1].IsDefault);
    }

    [Fact]
    public void UnavailableDefaultRemainsVisible_WithoutSubstitution()
    {
        var result = VisualModelPolicyService.Project(Policy(), [Model("image2")]);
        var unavailable = Assert.Single(result, x => x.IsDefault);
        Assert.Equal("image1", unavailable.Code);
        Assert.Equal("GPT Image 1", unavailable.Name);
        Assert.Empty(unavailable.Models);
    }

    [Theory]
    [InlineData(null, "image1")]
    [InlineData("image2", "image2")]
    [InlineData("gpt-image-2", null)]
    [InlineData("new-model", null)]
    public void SelectionUsesOnlyBusinessAllowlist(string? requested, string? expected)
        => Assert.Equal(expected, Policy().Select(requested));

    [Fact]
    public void MissingPolicyDoesNotInventDefault() => Assert.Null(new VisualModelPolicy().Select(null));

    [Fact]
    public void MissingStoredPolicyBootstrapsOnlyGatewayDefaultTextModel()
    {
        var now = new DateTime(2026, 9, 21, 8, 0, 0, DateTimeKind.Utc);
        var nonDefault = Model("image1", false);
        var gatewayDefault = new GatewayImageModel
        {
            Model = new AvailableModelPool
            {
                Id = "id-image2",
                Code = "image2",
                Name = "GPT Image 2",
                Description = "生产生图健康目录",
                IsDefault = true,
            },
        };

        var policy = VisualModelPolicyService.BuildBootstrapPolicy([nonDefault, gatewayDefault], now);

        Assert.NotNull(policy);
        Assert.Equal(1, policy.Revision);
        Assert.Equal("image2", policy.DefaultModelId);
        var opened = Assert.Single(policy.Models);
        Assert.Equal("image2", opened.ModelId);
        Assert.Equal("GPT Image 2", opened.DisplayName);
        Assert.Equal("生产生图健康目录", opened.Description);
        Assert.Equal(now, policy.UpdatedAt);
        Assert.Equal(VisualModelPolicyService.BootstrapActor, policy.UpdatedBy);
    }

    [Fact]
    public void MissingStoredPolicyWithoutExplicitGatewayDefaultUsesStableFirstItem()
    {
        var policy = VisualModelPolicyService.BuildBootstrapPolicy(
            [Model("image2", false), Model("new-later-model", false)],
            DateTime.UtcNow);

        Assert.NotNull(policy);
        Assert.Equal("image2", policy.DefaultModelId);
        Assert.Single(policy.Models);
    }

    [Fact]
    public void MissingStoredPolicyWaitsWhenTextModelCatalogIsEmpty()
        => Assert.Null(VisualModelPolicyService.BuildBootstrapPolicy([], DateTime.UtcNow));

    [Fact]
    public async Task GatewayCatalogPreservesDefaultAndDedicatedMarkersForBootstrap()
    {
        var gateway = new Mock<ILlmGateway>();
        gateway
            .Setup(x => x.GetAvailablePoolsAsync("visual-agent.image.text2img::generation", ModelTypes.ImageGen, It.IsAny<CancellationToken>()))
            .ReturnsAsync(
            [
                new AvailableModelPool
                {
                    Id = "logical-image2",
                    Code = "image2",
                    Name = "GPT Image 2",
                    ResolutionType = "LogicalModel",
                    IsDefault = true,
                    IsDedicated = true,
                }
            ]);
        gateway
            .Setup(x => x.ResolveRequiredLogicalModelAsync(
                "visual-agent.image.text2img::generation",
                ModelTypes.ImageGen,
                "image2",
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution { Success = true, ActualModel = "gpt-image-1" });

        var catalog = await GatewayImageModelCatalog.ReadAsync(
            gateway.Object,
            "visual-agent.image.text2img::generation",
            CancellationToken.None);

        var model = Assert.Single(catalog).Model;
        Assert.True(model.IsDefault);
        Assert.True(model.IsDedicated);
    }

    [Fact]
    public void InvalidDefaultAndDuplicateEntriesAreRejected()
    {
        var policy = Policy();
        Assert.Null(policy.Validate());
        policy.DefaultModelId = "not-open";
        Assert.NotNull(policy.Validate());
        policy.DefaultModelId = "image1";
        policy.Models.Add(new() { ModelId = "image1" });
        Assert.NotNull(policy.Validate());
    }

    [Theory]
    [InlineData("1024x1024", true)]
    [InlineData("1536x1024", true)]
    [InlineData("1024x1536", true)]
    [InlineData("2048x2048", false)]
    [InlineData("1024", false)]
    public void GatewayValidatesTheSameSizesItPublishes(string size, bool valid)
    {
        var resolved = new GatewayModelResolution { Success = true, ActualModel = "gpt-image-1" };
        var error = GatewayImageModelCatalog.ValidateRequest(new GatewayCanonicalImageRequest { Prompt = "白桃", Size = size }, resolved);
        Assert.Equal(valid, error is null);
        if (valid) Assert.Contains(GatewayImageModelCatalog.Describe(resolved)!.SizesByResolution.Values.SelectMany(x => x), x => x.Size == size);
    }
}
