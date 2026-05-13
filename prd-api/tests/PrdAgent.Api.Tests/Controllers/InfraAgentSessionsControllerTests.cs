using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class InfraAgentSessionsControllerTests
{
    [Fact]
    public async Task Create_ShouldReturnCreated_AndUseCurrentUser()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var request = new CreateInfraAgentSessionRequest("conn-1", null, null, "测试会话", null, null);
        var expected = BuildSessionView("session-1", "user-1");

        service
            .Setup(x => x.CreateAsync("user-1", request, It.IsAny<CancellationToken>()))
            .ReturnsAsync(expected);

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Create(request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status201Created);
        service.Verify(x => x.CreateAsync("user-1", request, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task Create_ShouldMapDomainErrorToHttpStatus()
    {
        var service = new Mock<IInfraAgentSessionService>();
        var request = new CreateInfraAgentSessionRequest("conn-1", null, null, null, null, null);

        service
            .Setup(x => x.CreateAsync("user-1", request, It.IsAny<CancellationToken>()))
            .ThrowsAsync(new InfraAgentSessionException(
                InfraAgentSessionErrorCodes.ConnectionNotActive,
                "CDS 连接不可用，请先探活或重新授权",
                StatusCodes.Status409Conflict));

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Create(request, CancellationToken.None);

        var objectResult = result.ShouldBeOfType<ObjectResult>();
        objectResult.StatusCode.ShouldBe(StatusCodes.Status409Conflict);
    }

    [Fact]
    public async Task Get_ShouldReturnNotFound_WhenSessionDoesNotBelongToUser()
    {
        var service = new Mock<IInfraAgentSessionService>();
        service
            .Setup(x => x.GetAsync("user-1", "session-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync((InfraAgentSessionView?)null);

        var controller = BuildController(service.Object, "user-1");

        var result = await controller.Get("session-1", CancellationToken.None);

        result.ShouldBeOfType<NotFoundObjectResult>();
    }

    private static InfraAgentSessionsController BuildController(
        IInfraAgentSessionService service,
        string userId)
    {
        var claims = new List<Claim>
        {
            new("sub", userId)
        };
        var identity = new ClaimsIdentity(claims, "test");
        var principal = new ClaimsPrincipal(identity);

        return new InfraAgentSessionsController(service)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = principal
                }
            }
        };
    }

    private static InfraAgentSessionView BuildSessionView(string id, string userId)
    {
        var now = DateTime.UtcNow;
        return new InfraAgentSessionView(
            id,
            userId,
            "conn-1",
            "cds",
            "shared-service",
            null,
            null,
            null,
            InfraAgentRuntimes.ClaudeSdk,
            null,
            "confirm-dangerous",
            null,
            "测试会话",
            InfraAgentSessionStatuses.Idle,
            null,
            now,
            now,
            null,
            null);
    }
}
