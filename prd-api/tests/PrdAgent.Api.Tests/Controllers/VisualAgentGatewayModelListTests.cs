using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class VisualAgentGatewayModelListTests
{
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

        var controller = new ImageGenController(
            null!,
            null!,
            null!,
            gateway.Object,
            null!,
            NullLogger<ImageGenController>.Instance,
            null!,
            null!,
            null!,
            null!,
            null!);

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
}
