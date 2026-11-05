using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class VideoModelRecoveryContractTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ModelCatalog_PreservesRecoveryEligibilityWithoutClaimingHealthy(bool recoveryEligible)
    {
        var query = new Mock<IModelPoolQueryService>();
        query.Setup(service => service.GetModelPoolsAsync(It.IsAny<string?>(), "video-gen", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new List<ModelPoolForAppResult>
            {
                new()
                {
                    Code = "recovery-video", Name = "恢复中的视频模型",
                    Models = new List<ModelPoolModelItem>
                    {
                        new() { HealthStatus = "Unavailable", IsRecoveryProbeAvailable = recoveryEligible }
                    }
                }
            });
        var protection = new Mock<IDataProtectionProvider>();
        protection.Setup(provider => provider.CreateProtector(It.IsAny<string>())).Returns(Mock.Of<IDataProtector>());
        var controller = new VideoAgentController(null!, null!, null!, query.Object, null!, null!, null!,
            protection.Object, NullLogger<VideoAgentController>.Instance);

        var response = (await controller.ListVideoModels(CancellationToken.None)).ShouldBeOfType<OkObjectResult>();
        var envelope = response.Value.ShouldBeOfType<ApiResponse<List<VideoModelOption>>>();
        envelope.Data!.Count.ShouldBe(1);
        var option = envelope.Data[0];
        option.Id.ShouldBe("recovery-video");
        option.HealthStatus.ShouldBe("Unavailable");
        option.IsRecoveryProbeAvailable.ShouldBe(recoveryEligible);
    }
}
