using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class QuickCreationFilmComparisonPermissionTests
{
    [Theory]
    [InlineData(null, AdminPermissionCatalog.Super, true)]
    [InlineData(null, AdminPermissionCatalog.LlmGatewayAccess, true)]
    [InlineData(null, AdminPermissionCatalog.WebPagesWrite, false)]
    [InlineData("agent-apikey", AdminPermissionCatalog.Super, false)]
    [InlineData("synthetic-test", AdminPermissionCatalog.Super, false)]
    public async Task ComparisonUsesEffectivePermissionsFromTheExistingBrowserSession(
        string? authType, string permission, bool allowed)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DesignRuntime:QuickCreation:Enabled"] = "true",
        }).Build();
        var claims = new List<Claim>
        {
            new("sub", "comparison-user"),
            new("clientType", "admin"),
            new("sessionKey", "ordinary-browser-session"),
        };
        if (authType != null) claims.Add(new Claim("authType", authType));
        var controller = new DesignArtifactsController(
            null!, null!, null!, null!, null!, null!, null!, configuration, null!)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test")) },
            },
        };
        var permissions = new Mock<IAdminPermissionService>(MockBehavior.Strict);
        var ct = CancellationToken.None;
        if (authType == null)
            permissions.Setup(service => service.GetEffectivePermissionsAsync("comparison-user", false, ct))
                .ReturnsAsync(new[] { permission });

        // A supplementary request intentionally fails the comparison preflight before any paid work.
        var request = new QuickCreationRunRequest(
            "video", null, "补充要求", null, null, Duration: JsonSerializer.SerializeToElement(60), Trial: false);
        var result = await controller.CreateQuickCreationRun(request, ct, permissions.Object, "native-default");

        if (allowed) Assert.IsType<BadRequestObjectResult>(result);
        else Assert.IsType<ForbidResult>(result);
        permissions.Verify(service => service.GetEffectivePermissionsAsync("comparison-user", false, ct),
            authType == null ? Times.Once() : Times.Never());
    }
}
