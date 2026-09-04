using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Middleware;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Middleware;

public class AdminPermissionMiddlewareTests
{
    [Theory]
    [InlineData("GET", "/api/design-artifacts/runtime/run-1/workspace/input")]
    [InlineData("POST", "/api/design-artifacts/runtime/run-1/workspace/result")]
    [InlineData("GET", "/api/design-artifacts/runtime/run-1/llm/v1/models")]
    [InlineData("POST", "/api/design-artifacts/runtime/run-1/llm/v1/chat/completions")]
    public async Task DesignRuntimeDataPlaneEndpointSkipsOnlyAdminPermissionGate(string method, string path)
    {
        var scanner = new Mock<IAdminControllerScanner>(MockBehavior.Strict);
        var permissionService = new Mock<IAdminPermissionService>(MockBehavior.Strict);
        var nextCalled = false;
        var middleware = new AdminPermissionMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AdminPermissionMiddleware>.Instance,
            scanner.Object);
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(new AllowAnonymousAttribute()),
            "OpenDesign runtime workspace input"));

        await middleware.Invoke(context, permissionService.Object);

        Assert.True(nextCalled);
        scanner.VerifyNoOtherCalls();
        permissionService.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("GET", "/api/design-artifacts/runtime/run-1/workspace/input")]
    [InlineData("GET", "/api/design-artifacts/runtime/run-1/workspace/input-extra", true)]
    [InlineData("GET", "/api/design-artifacts/runtime/run-1/workspace/input/debug", true)]
    [InlineData("POST", "/api/design-artifacts/runtime/run-1/workspace/input", true)]
    [InlineData("GET", "/api/web-pages/public", true)]
    public async Task RequestsOutsideExactDesignRuntimeDataPlaneStillRequireAdminAuthentication(
        string method,
        string path,
        bool allowAnonymous = false)
    {
        var scanner = new Mock<IAdminControllerScanner>(MockBehavior.Strict);
        scanner.Setup(item => item.GetRequiredPermission(path, method))
            .Returns(AdminPermissionCatalog.WebPagesRead);
        var permissionService = new Mock<IAdminPermissionService>(MockBehavior.Strict);
        var nextCalled = false;
        var middleware = new AdminPermissionMiddleware(
            _ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            },
            NullLogger<AdminPermissionMiddleware>.Instance,
            scanner.Object);
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = path;
        if (allowAnonymous)
        {
            context.SetEndpoint(new Endpoint(
                _ => Task.CompletedTask,
                new EndpointMetadataCollection(new AllowAnonymousAttribute()),
                "non data-plane endpoint"));
        }

        await middleware.Invoke(context, permissionService.Object);

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        scanner.VerifyAll();
        permissionService.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task RuntimeControllerStillRejectsInvalidTransferTicket()
    {
        var keyRoot = Path.Combine(Path.GetTempPath(), $"design-runtime-ticket-{Guid.NewGuid():N}");
        try
        {
            Directory.CreateDirectory(keyRoot);
            var broker = new DesignArtifactWorkspaceBroker(
                new MongoDbContext(
                    "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=50",
                    $"design-runtime-ticket-{Guid.NewGuid():N}"),
                Mock.Of<IAssetStorage>(),
                DataProtectionProvider.Create(new DirectoryInfo(keyRoot)),
                new ConfigurationBuilder().Build());
            var controller = new DesignArtifactRuntimeController(
                broker,
                Mock.Of<IHttpClientFactory>(),
                new ConfigurationBuilder().Build(),
                NullLogger<DesignArtifactRuntimeController>.Instance)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            controller.Request.Headers.Authorization = "Bearer invalid-transfer-ticket";

            var result = await controller.GetWorkspaceInput("run-1", CancellationToken.None);

            var rejected = Assert.IsType<ObjectResult>(result);
            Assert.Equal(StatusCodes.Status401Unauthorized, rejected.StatusCode);
            var body = JsonSerializer.SerializeToElement(rejected.Value);
            Assert.Equal(
                "DESIGN_RUNTIME_TICKET_INVALID",
                body.GetProperty("error").GetProperty("code").GetString());
        }
        finally
        {
            if (Directory.Exists(keyRoot))
                Directory.Delete(keyRoot, recursive: true);
        }
    }

    [Theory]
    [InlineData("GET", "/api/defect-agent/share/view/share-token")]
    [InlineData("POST", "/api/defect-agent/share/view/share-token/comments")]
    [InlineData("POST", "/api/defect-agent/share/view/share-token/report")]
    [InlineData("POST", "/api/defect-agent/share/view/share-token/fix-status")]
    public void HasDefectShareScopeGrant_AllowsOnlyShareTokenEndpoints(string method, string path)
    {
        var allowed = AdminPermissionMiddleware.HasDefectShareScopeGrant(
            [DefectAgentController.AgentShareScope],
            AdminPermissionCatalog.DefectAgentUse,
            path,
            method);

        Assert.True(allowed);
    }

    [Theory]
    [InlineData("GET", "/api/defect-agent/defects")]
    [InlineData("GET", "/api/defect-agent/shares")]
    [InlineData("POST", "/api/defect-agent/agent/next")]
    [InlineData("POST", "/api/defect-agent/share/view/share-token")]
    [InlineData("GET", "/api/defect-agent/share/view/share-token/comments")]
    [InlineData("POST", "/api/defect-agent/share/view/share-token/comments/extra")]
    public void HasDefectShareScopeGrant_DeniesBroadDefectAgentAccess(string method, string path)
    {
        var allowed = AdminPermissionMiddleware.HasDefectShareScopeGrant(
            [DefectAgentController.AgentShareScope],
            AdminPermissionCatalog.DefectAgentUse,
            path,
            method);

        Assert.False(allowed);
    }

    [Fact]
    public void HasDefectShareScopeGrant_DoesNotApplyToOtherPermissions()
    {
        var allowed = AdminPermissionMiddleware.HasDefectShareScopeGrant(
            [DefectAgentController.AgentShareScope],
            AdminPermissionCatalog.DocumentStoreRead,
            "/api/defect-agent/share/view/share-token",
            "GET");

        Assert.False(allowed);
    }
}
