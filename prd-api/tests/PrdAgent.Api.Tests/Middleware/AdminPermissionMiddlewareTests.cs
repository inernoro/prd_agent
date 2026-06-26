using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Middleware;
using PrdAgent.Core.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Middleware;

public class AdminPermissionMiddlewareTests
{
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
