using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Middleware;

public class ProductPermissionRulesTests
{
    [Fact]
    public void OnlyActiveHumanUsersGetOpenAccess()
    {
        var active = new User { Role = UserRole.PM, Status = UserStatus.Active, UserType = UserType.Human };
        var existing = new[] { ProductPermissionRules.OpenAccess, ProductPermissionRules.MapAdmin, AdminPermissionCatalog.ReviewAgentUse };
        var permissions = ProductPermissionRules.Apply(active, existing);
        Assert.Contains(ProductPermissionRules.OpenAccess, permissions);
        Assert.Contains(AdminPermissionCatalog.ReviewAgentUse, permissions);
        Assert.DoesNotContain(ProductPermissionRules.MapAdmin, permissions);
        Assert.DoesNotContain(AdminPermissionCatalog.ProductAgentManage, permissions);
        active.Status = UserStatus.Disabled;
        Assert.DoesNotContain(ProductPermissionRules.OpenAccess, ProductPermissionRules.Apply(active, existing));
        active.Status = UserStatus.Active;
        active.UserType = UserType.Bot;
        Assert.DoesNotContain(ProductPermissionRules.OpenAccess, ProductPermissionRules.Apply(active, existing));
    }

    [Theory]
    [InlineData("/api/product/products", "POST", true, null, true, 200)]
    [InlineData("/api/product/initiations/record", "PATCH", true, null, true, 200)]
    [InlineData("/api/product/review/submissions", "GET", true, null, true, 200)]
    [InlineData("/api/review-agent/submissions", "GET", true, null, false, 403)]
    [InlineData("/api/document-store/stores", "GET", true, null, false, 403)]
    [InlineData("/api/product/products", "GET", true, "agent-apikey", false, 403)]
    [InlineData("/api/product/products", "GET", true, "synthetic-test", false, 403)]
    [InlineData("/api/product/products", "GET", false, null, false, 401)]
    public async Task OpenAccessOnlyGrantsProductCollaborationToHumanSessions(
        string path, string method, bool signedIn, string? authType, bool calledExpected, int status)
    {
        var required = path.StartsWith("/api/product/") ? AdminPermissionCatalog.ProductAgentUse
            : path.StartsWith("/api/document-store/") ? AdminPermissionCatalog.DocumentStoreRead
            : AdminPermissionCatalog.ReviewAgentUse;
        var scanner = new Mock<IAdminControllerScanner>();
        scanner.Setup(x => x.GetRequiredPermission(path, method)).Returns(required);
        var service = new Mock<IAdminPermissionService>();
        service.Setup(x => x.GetEffectivePermissionsAsync("u1", false, default))
            .ReturnsAsync(new[] { ProductPermissionRules.OpenAccess });
        var called = false;
        var middleware = new AdminPermissionMiddleware(ctx =>
        {
            called = true;
            Assert.True(ctx.User.HasClaim("permissions", AdminPermissionCatalog.ProductAgentManage));
            Assert.False(ctx.User.HasClaim("permissions", AdminPermissionCatalog.ReviewAgentManage));
            Assert.False(ctx.User.HasClaim("permissions", AdminPermissionCatalog.Super));
            Assert.False(ctx.User.HasClaim("permissions", ProductPermissionRules.MapAdmin));
            return Task.CompletedTask;
        }, NullLogger<AdminPermissionMiddleware>.Instance, scanner.Object);
        var claims = new List<Claim> { new("sub", "u1") };
        if (authType != null) claims.Add(new("authType", authType));
        var context = new DefaultHttpContext
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(claims, signedIn ? "test" : null))
        };
        context.Request.Path = path;
        context.Request.Method = method;
        await middleware.Invoke(context, service.Object);
        Assert.Equal(calledExpected, called);
        Assert.Equal(status, context.Response.StatusCode);
    }
}
