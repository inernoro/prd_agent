using System.IdentityModel.Tokens.Jwt;
using System.Reflection;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class AdminVideoRunsControllerTests
{
    [Fact]
    public void Route_ShouldRequireSuperPermissionAndAuthentication()
    {
        var controllerType = typeof(AdminVideoRunsController);
        Assert.NotNull(controllerType.GetCustomAttribute<AuthorizeAttribute>());
        var admin = controllerType.GetCustomAttribute<AdminControllerAttribute>();
        Assert.NotNull(admin);
        Assert.Equal("video-agent", admin.AppKey);
        Assert.Equal(AdminPermissionCatalog.Super, admin.ReadPermission);
        Assert.Equal(AdminPermissionCatalog.Super, admin.WritePermission);

        var scanner = new AdminControllerScanner(
            NullLogger<AdminControllerScanner>.Instance,
            controllerType.Assembly);
        Assert.Equal(
            AdminPermissionCatalog.Super,
            scanner.GetRequiredPermission("/api/admin/video-runs/example/terminate-stalled", "POST"));
    }

    [Fact]
    public async Task TerminateStalled_ShouldUseAuthenticatedAdministratorAndReturnSanitizedResult()
    {
        var service = new Mock<IVideoGenService>(MockBehavior.Strict);
        var endedAt = DateTime.UtcNow;
        service.Setup(item => item.TerminateStalledRunAsAdminAsync(
                "run-1", "root-admin", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new AdminTerminateStalledVideoRunResult(
                "run-1", VideoGenRunStatus.Editing, "video-agent", true, endedAt));
        var controller = new AdminVideoRunsController(service.Object)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new Microsoft.AspNetCore.Http.DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        [new Claim(JwtRegisteredClaimNames.Sub, "root-admin")],
                        "test")),
                },
            },
        };

        var action = await controller.TerminateStalled("run-1", CancellationToken.None);

        var ok = Assert.IsType<OkObjectResult>(action);
        var response = Assert.IsType<ApiResponse<AdminTerminateStalledVideoRunResult>>(ok.Value);
        Assert.True(response.Success);
        Assert.NotNull(response.Data);
        Assert.Equal("run-1", response.Data.RunId);
        Assert.Equal("video-agent", response.Data.AppKey);
        service.VerifyAll();
    }
}
