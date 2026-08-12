using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;
using PrdAgent.Core.LlmGateway;

namespace PrdAgent.Api.Tests.Controllers;

public class VisualAgentGatewayModelListTests
{
    [Theory]
    [InlineData("image_size.none", true, "none")]
    [InlineData("image_size.field.size", false, "WxH")]
    public async Task GetAdapterInfo_WhenUnknownAdapterHasExplicitCapability_ShouldExposeUpstreamControl(
        string capability,
        bool sizesNotApplicable,
        string sizeParamFormat)
    {
        var gateway = new Mock<ILlmGateway>();
        gateway
            .Setup(x => x.ResolveRequiredLogicalModelAsync(
                "visual-agent.image.text2img::generation",
                "generation",
                "new-logical-image",
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution
            {
                Success = true,
                ResolutionType = "LogicalModel",
                LogicalModelPublicId = "new-logical-image",
                ActualModel = "vendor/new-image-model-without-adapter",
                ActualPlatformName = "Vendor",
                ParameterCapabilities = new Dictionary<string, bool>
                {
                    [capability] = true,
                },
            });
        var controller = CreateController(gateway.Object);

        var action = await controller.GetAdapterInfo("new-logical-image", CancellationToken.None);

        var response = action.ShouldBeOfType<OkObjectResult>()
            .Value.ShouldBeOfType<ApiResponse<object>>();
        response.Success.ShouldBeTrue();
        var data = JsonNode.Parse(JsonSerializer.Serialize(response.Data))!.AsObject();
        data["matched"]!.GetValue<bool>().ShouldBeTrue();
        data["sizesNotApplicable"]!.GetValue<bool>().ShouldBe(sizesNotApplicable);
        data["sizeParamFormat"]!.GetValue<string>().ShouldBe(sizeParamFormat);
        data["sizeControl"]!["source"]!.GetValue<string>().ShouldBe("upstream-model");
        data["sizesByResolution"]!["1k"]!.AsArray().Count.ShouldBe(5);
    }

    [Fact]
    public async Task GetAdapterInfo_WhenLogicalModelIsOnlyAuthorizedForImg2Img_ShouldExposeUpstreamControl()
    {
        var gateway = new Mock<ILlmGateway>();
        gateway
            .Setup(x => x.ResolveRequiredLogicalModelAsync(
                It.IsAny<string>(),
                "generation",
                "img2img-only-model",
                It.IsAny<CancellationToken>()))
            .ReturnsAsync((string appCallerCode, string _, string _, CancellationToken _) =>
                appCallerCode == "visual-agent.image.img2img::generation"
                    ? new GatewayModelResolution
                    {
                        Success = true,
                        ResolutionType = "LogicalModel",
                        LogicalModelPublicId = "img2img-only-model",
                        ActualModel = "vendor/img2img-only-model",
                        ActualPlatformName = "Vendor",
                        ParameterCapabilities = new Dictionary<string, bool>
                        {
                            ["image_size.prompt"] = true,
                        },
                    }
                    : new GatewayModelResolution
                    {
                        Success = false,
                        ResolutionType = "NotFound",
                    });
        var controller = CreateController(gateway.Object);

        var action = await controller.GetAdapterInfo("img2img-only-model", CancellationToken.None);

        var response = action.ShouldBeOfType<OkObjectResult>()
            .Value.ShouldBeOfType<ApiResponse<object>>();
        response.Success.ShouldBeTrue();
        var data = JsonNode.Parse(JsonSerializer.Serialize(response.Data))!.AsObject();
        data["matched"]!.GetValue<bool>().ShouldBeTrue();
        data["isAdaptive"]!.GetValue<bool>().ShouldBeTrue();
        data["sizeControl"]!["source"]!.GetValue<string>().ShouldBe("upstream-model");
        data["sizeControl"]!["mode"]!.GetValue<string>().ShouldBe("prompt");
        gateway.Verify(x => x.ResolveRequiredLogicalModelAsync(
            "visual-agent.image.text2img::generation",
            "generation",
            "img2img-only-model",
            It.IsAny<CancellationToken>()), Times.Once);
        gateway.Verify(x => x.ResolveRequiredLogicalModelAsync(
            "visual-agent.image.img2img::generation",
            "generation",
            "img2img-only-model",
            It.IsAny<CancellationToken>()), Times.Once);
        gateway.Verify(x => x.ResolveRequiredLogicalModelAsync(
            "visual-agent.image.vision::generation",
            "generation",
            "img2img-only-model",
            It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task GetImageGenModels_ShouldReturnGatewayRegistryPoolMembers()
    {
        var gateway = new Mock<ILlmGateway>();
        gateway
            .Setup(x => x.GetAvailablePoolsAsync(
                It.IsAny<string>(),
                "generation",
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<AvailableModelPool>
            {
                new()
                {
                    Id = "gateway-image-pool",
                    Name = "视觉创作测试池",
                    Code = "visual-creation-image-test",
                    Priority = 10,
                    ResolutionType = "GatewayRegistryPool",
                    IsDedicated = true,
                    Models = new List<PoolModelInfo>
                    {
                        new() { ModelId = "openai/gpt-image-2", PlatformId = "openrouter", Priority = 10, HealthStatus = "Healthy" },
                        new() { ModelId = "google/gemini-3.1-flash-image", PlatformId = "openrouter", Priority = 20, HealthStatus = "Healthy" },
                        new() { ModelId = "google/gemini-3.1-flash-lite-image", PlatformId = "openrouter", Priority = 30, HealthStatus = "Healthy" },
                    }
                }
            });

        var controller = CreateController(gateway.Object);

        var action = await controller.GetImageGenModels(CancellationToken.None);

        var response = action.ShouldBeOfType<OkObjectResult>()
            .Value.ShouldBeOfType<ApiResponse<List<ModelPoolForAppResult>>>();
        response.Success.ShouldBeTrue();
        response.Data.ShouldNotBeNull();
        response.Data.Count.ShouldBe(1);
        response.Data[0].ResolutionType.ShouldBe("GatewayRegistryPool");
        response.Data[0].IsDedicated.ShouldBeTrue();
        response.Data[0].Models.Select(model => model.ModelId).ShouldBe(new[]
        {
            "openai/gpt-image-2",
            "google/gemini-3.1-flash-image",
            "google/gemini-3.1-flash-lite-image",
        });
        gateway.Verify(x => x.GetAvailablePoolsAsync(
            It.IsAny<string>(),
            "generation",
            It.IsAny<CancellationToken>()), Times.Exactly(3));
    }

    private static ImageGenController CreateController(ILlmGateway gateway)
        => new(
            null!,
            null!,
            null!,
            gateway,
            null!,
            NullLogger<ImageGenController>.Instance,
            null!,
            null!,
            null!,
            null!,
            null!);
}
