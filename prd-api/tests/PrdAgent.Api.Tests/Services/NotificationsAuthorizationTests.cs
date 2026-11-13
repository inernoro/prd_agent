using System.Reflection;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class NotificationsAuthorizationTests
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, false, true)]
    [InlineData(true, true, true)]
    public async Task NotificationVisibility_UsesCurrentPermissionsAndAdminRole(
        bool adminRole, bool allowedNow, bool stalePermissionClaim)
    {
        var permissions = new Mock<IAdminPermissionService>(MockBehavior.Strict);
        permissions.Setup(x => x.GetEffectivePermissionsAsync("recipient", false, It.IsAny<CancellationToken>()))
            .ReturnsAsync(allowedNow ? new[] { AdminPermissionCatalog.SettingsWrite } : Array.Empty<string>());
        var claims = new List<Claim> { new("sub", "recipient") };
        if (adminRole) claims.Add(new Claim(ClaimTypes.Role, UserRole.ADMIN.ToString()));
        if (stalePermissionClaim) claims.Add(new Claim("permissions", AdminPermissionCatalog.Super));
        var controller = new NotificationsController(null!, null!, null!,
            new ConfigurationBuilder().Build(), permissions.Object)
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(claims, "test")),
                },
            },
        };
        var method = typeof(NotificationsController).GetMethod("HasAdminNotificationPermissionAsync",
            BindingFlags.NonPublic | BindingFlags.Instance)!;
        var actual = await (Task<bool>)method.Invoke(controller, new object[] { CancellationToken.None })!;
        Assert.Equal(adminRole && allowedNow, actual);
        permissions.Verify(x => x.GetEffectivePermissionsAsync("recipient", false, It.IsAny<CancellationToken>()),
            adminRole ? Times.Once() : Times.Never());
    }
}
