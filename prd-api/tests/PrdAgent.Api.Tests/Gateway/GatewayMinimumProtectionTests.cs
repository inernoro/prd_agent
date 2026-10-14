using Microsoft.AspNetCore.Http;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayMinimumProtectionTests
{
    [Theory]
    [InlineData(false, "map", "gw-native", "automatic", "general")]
    [InlineData(true, "external", "gw-native", "automatic", "general")]
    [InlineData(true, "map", "openai-compatible", "automatic", "general")]
    [InlineData(true, "map", "gw-native", "", "general")]
    [InlineData(true, "map", "gw-native", "automatic", "automatic")]
    public void OriginRequiresVerifiedInternalCredentialAndMapNativeIngress(
        bool internalCredential, string source, string protocol, string origin, string expected)
    {
        var http = new DefaultHttpContext();
        http.Request.Headers["X-Gateway-Execution-Origin"] = origin;
        http.Request.Headers["X-Gateway-Source-Deployment"] = "cds:branch-one/rev-a";
        http.Request.Headers["X-Gateway-User-Id"] = "business-owner";
        var authorization = new GatewayKeyAuthorization(true, true, 200, "", "",
            TenantId: "tenant", LegacySharedKey: internalCredential,
            ClientCode: internalCredential ? "map-internal" : "external-client");

        var identity = GatewayMinimumRequestIdentity.Resolve(http, authorization, source, protocol);

        identity.Origin.ShouldBe(expected);
        identity.SourceDeployment.ShouldBe(expected == "automatic" ? "cds:branch-one/rev-a" : null);
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
