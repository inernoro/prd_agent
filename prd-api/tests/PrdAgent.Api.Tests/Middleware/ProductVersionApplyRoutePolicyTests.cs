using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Middleware;

public class ProductVersionApplyRoutePolicyTests
{
    [Theory]
    [InlineData("GET", "/api/product/version-workflow/products", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/version-workflow/products/p1", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/version-workflow/review-sources", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/version-workflow/initiation-defaults", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/products/p1/releases/history-check", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/version-workflow/parse-message", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/products/p1/initiations", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/products/p1/releases", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/products/p1/features", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/overview/releases", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/overview/version-workflow/legacy", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/overview/version-workflow/snapshots/s1", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("PATCH", "/api/product/initiations/i1/meeting", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("DELETE", "/api/product/initiations/i1", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("DELETE", "/api/product/releases/r1", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/initiations/i1/review", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/initiations/i1/decision", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/initiations/i1/approve", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("PUT", "/api/product/releases/r1/feature-manifest", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/releases/r1/complete", AdminPermissionCatalog.ProductAgentUse)]
    public void AllowsOnlyVersionWorkflowPaths(string method, string path, string required)
        => Assert.True(ProductVersionApplyRoutePolicy.Allows(path, method, required));

    [Theory]
    [InlineData("GET", "/api/product/overview/requirements", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("DELETE", "/api/product/initiations/i1/meeting", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("DELETE", "/api/product/releases/r1/complete", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/products/p1/releases/history-check", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/overview/version-workflow/import", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/overview/version-workflow/snapshots", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/products/p1/version-workflow/import", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/products/p1", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/products", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/products/p1/members", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/version-workflow/initiation-defaults", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("POST", "/api/product/products/p1/features", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/settings/admins", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/initiations/i1/approve", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("PUT", "/api/review-agent/dimensions", AdminPermissionCatalog.ReviewAgentUse)]
    [InlineData("GET", "/api/review-agent/submissions/all", AdminPermissionCatalog.ReviewAgentUse)]
    [InlineData("GET", "/api/review-agent/submissions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/results", AdminPermissionCatalog.ReviewAgentUse)]
    [InlineData("GET", "/api/product/overview/releases-extra", AdminPermissionCatalog.ProductAgentUse)]
    [InlineData("GET", "/api/product/overview/releases", AdminPermissionCatalog.ReviewAgentUse)]
    [InlineData("GET", "/api/review-agent/dimensions", AdminPermissionCatalog.ReviewAgentUse)]
    [InlineData("POST", "/api/review-agent/submissions", AdminPermissionCatalog.ReviewAgentUse)]
    [InlineData("GET", "/api/review-agent/submissions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", AdminPermissionCatalog.ReviewAgentUse)]
    [InlineData("GET", "/api/review-agent/submissions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/result/stream", AdminPermissionCatalog.ReviewAgentUse)]
    public void DeniesOtherPagesAndMethodVariants(string method, string path, string required)
        => Assert.False(ProductVersionApplyRoutePolicy.Allows(path, method, required));

    [Theory]
    [InlineData("GET", "/api/product/version-workflow/products", AdminPermissionCatalog.ProductAgentUse, true)]
    [InlineData("GET", "/api/product/overview/requirements", AdminPermissionCatalog.ProductAgentUse, false)]
    [InlineData("POST", "/api/review-agent/submissions", AdminPermissionCatalog.ReviewAgentUse, false)]
    [InlineData("PUT", "/api/review-agent/dimensions", AdminPermissionCatalog.ReviewAgentUse, false)]
    public async Task MiddlewareHonorsVersionPermissionWithoutProductOrReviewPermission(
        string method, string path, string required, bool expectedAllowed)
    {
        var scanner = new Mock<IAdminControllerScanner>();
        scanner.Setup(x => x.GetRequiredPermission(path, method)).Returns(required);
        var permissionService = new Mock<IAdminPermissionService>();
        permissionService.Setup(x => x.GetEffectivePermissionsAsync("user-1", false, default))
            .ReturnsAsync((IReadOnlyList<string>)new[] { AdminPermissionCatalog.Access, AdminPermissionCatalog.ProductAgentVersionApply });
        var nextCalled = false;
        var middleware = new AdminPermissionMiddleware(_ => { nextCalled = true; return Task.CompletedTask; },
            NullLogger<AdminPermissionMiddleware>.Instance, scanner.Object);
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("sub", "user-1") }, "test"));

        await middleware.Invoke(context, permissionService.Object);

        Assert.Equal(expectedAllowed, nextCalled);
        Assert.Equal(expectedAllowed ? StatusCodes.Status200OK : StatusCodes.Status403Forbidden,
            context.Response.StatusCode);
    }
}
