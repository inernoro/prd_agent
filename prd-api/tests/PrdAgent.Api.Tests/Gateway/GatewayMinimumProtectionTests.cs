using Microsoft.AspNetCore.Http;
using PrdAgent.Core.LlmGateway;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayMinimumProtectionTests
{
    [Theory]
    [InlineData(null, "automatic")]
    [InlineData("interactive", "general")]
    [InlineData("agent", "automatic")]
    [InlineData("scheduled", "automatic")]
    public void OriginUsesServerVerifiedPermitAndNeverSelfReportedHeaders(string? origin, string expected)
    {
        var http = new DefaultHttpContext();
        http.Request.Headers["X-Gateway-Execution-Origin"] = "interactive";
        http.Request.Headers["X-Gateway-Source-Deployment"] = "forged-deployment";
        http.Request.Headers["X-Gateway-User-Id"] = "business-owner";
        var authorization = new GatewayKeyAuthorization(true, true, 200, "", "",
            TenantId: "tenant", LegacySharedKey: true, ClientCode: "map-internal");
        if (origin is not null)
            http.Items[GatewayTaskAdmission.HttpContextPermitKey] = new GatewayTaskPermitRecord
                { Origin = origin, SourceDeployment = "cds:branch-one/rev-a" };

        var identity = GatewayMinimumRequestIdentity.Resolve(http, authorization, "map", "gw-native");

        identity.Origin.ShouldBe(expected);
        identity.SourceDeployment.ShouldBe(expected == "automatic" && origin is not null ? "cds:branch-one/rev-a" : null);
    }

    [Fact]
    public void UnauthenticatedOriginAndArbitraryDeploymentTextAreNotTrusted()
    {
        var http = new DefaultHttpContext();
        http.Request.Headers["X-Gateway-Execution-Origin"] = "automatic";
        http.Request.Headers["X-Gateway-Source-Deployment"] = "arbitrary request payload";
        var authorization = new GatewayKeyAuthorization(true, false, 200, "", "", LegacySharedKey: true, ClientCode: "map-internal");
        GatewayMinimumRequestIdentity.Resolve(http, authorization, "map", "gw-native").Automatic.ShouldBeFalse();
        var verified = authorization with { Authenticated = true };
        GatewayMinimumRequestIdentity.Resolve(http, verified, "map", "gw-native").SourceDeployment.ShouldBeNull();
    }
}
