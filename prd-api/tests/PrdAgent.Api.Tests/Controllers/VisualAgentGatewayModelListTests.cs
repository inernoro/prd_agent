using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using System.Text.Json;
using System.Text.Json.Nodes;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class VisualAgentGatewayModelListTests
{
    [Fact]
    public async Task AdapterInfo_UsesGatewayCapabilitiesWithoutMapResolution()
    {
        var policy = new Mock<IVisualModelPolicyService>();
        policy.Setup(x => x.ReadAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new VisualModelPolicy
        {
            DefaultModelId = "image1", Models = [new() { ModelId = "image1" }],
        });
        policy.Setup(x => x.DiscoverAsync(null, It.IsAny<CancellationToken>())).ReturnsAsync(
        [new GatewayImageModel
        {
            Model = new AvailableModelPool { Code = "image1", Name = "GPT Image 1" },
            ImageCapabilities = GatewayImageModelCatalog.Describe(new GatewayModelResolution { ActualModel = "gpt-image-1" }),
        }]);
        var action = await CreateController(policy.Object).GetAdapterInfo("image1", CancellationToken.None);
        var response = action.ShouldBeOfType<OkObjectResult>().Value.ShouldBeOfType<ApiResponse<object>>();
        var data = JsonNode.Parse(JsonSerializer.Serialize(response.Data, new JsonSerializerOptions(JsonSerializerDefaults.Web)))!;
        data["matched"]!.GetValue<bool>().ShouldBeTrue();
        data["sizeControl"]!["source"]!.GetValue<string>().ShouldBe("llmgw");
        data["sizesByResolution"]!["1k"]!.AsArray().Select(x => x!["size"]!.GetValue<string>())
            .ShouldBe(new[] { "1024x1024", "1024x1536", "1536x1024" });
        policy.Verify(x => x.DiscoverAsync(null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task AdapterInfo_RejectsUnopenedModelWithoutDiscovery()
    {
        var policy = new Mock<IVisualModelPolicyService>();
        policy.Setup(x => x.ReadAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new VisualModelPolicy());
        (await CreateController(policy.Object).GetAdapterInfo("not-open", CancellationToken.None))
            .ShouldBeOfType<BadRequestObjectResult>();
        policy.Verify(x => x.DiscoverAsync(It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task ModelMenu_UsesBusinessPolicyNotGatewayPools()
    {
        var policy = new Mock<IVisualModelPolicyService>();
        policy.Setup(x => x.ListAsync(null, It.IsAny<CancellationToken>())).ReturnsAsync(
        [new AvailableModelPool
        {
            Id = "image1", Code = "image1", Name = "GPT Image 1", ResolutionType = "LogicalModel", IsDefault = true,
            Models = [new PoolModelInfo { ModelId = "image1", PlatformId = "logical", HealthStatus = "Healthy" }],
        }]);
        var action = await CreateController(policy.Object).GetImageGenModels(CancellationToken.None);
        var data = action.ShouldBeOfType<OkObjectResult>().Value.ShouldBeOfType<ApiResponse<List<ModelPoolForAppResult>>>().Data!;
        data.Count.ShouldBe(1);
        data[0].ResolutionType.ShouldBe("LogicalModel");
        data[0].IsDefault.ShouldBeTrue();
        policy.Verify(x => x.ListAsync(null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task ModelMenu_GatewayFailureReturnsStructured503_NotEmptySuccess()
    {
        var policy = new Mock<IVisualModelPolicyService>();
        policy.Setup(x => x.ListAsync(null, It.IsAny<CancellationToken>())).ThrowsAsync(new HttpRequestException("serving down"));
        var controller = CreateController(policy.Object);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { TraceIdentifier = "trace-menu" } };
        var result = (await controller.GetImageGenModels(CancellationToken.None)).ShouldBeOfType<ObjectResult>();
        result.StatusCode.ShouldBe(503);
        var response = result.Value.ShouldBeOfType<ApiResponse<List<ModelPoolForAppResult>>>();
        response.Success.ShouldBeFalse();
        response.Error!.Code.ShouldBe("LLM_GATEWAY_UNAVAILABLE");
        response.Error.RequestId.ShouldBe("trace-menu");
        response.Error.Message.ShouldNotContain("serving down");
    }

    private static ImageGenController CreateController(IVisualModelPolicyService policy)
        => new(null!, null!, null!, null!, null!, NullLogger<ImageGenController>.Instance,
            null!, null!, null!, null!, null!, policy);
}
