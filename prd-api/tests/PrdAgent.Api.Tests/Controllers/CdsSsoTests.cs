using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.IdentityModel.Tokens;
using Moq;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class CdsSsoTests
{
    private const string Issuer = "https://cds.shared.test/api/oidc";
    private const string ClientId = "cds-site:map-preview";
    private const string ReturnUri = "https://map.shared.test/api/v1/auth/cds/callback";

    [Fact]
    public void LoginIsOptInAndLimitedToTheConfiguredHost()
    {
        var request = new DefaultHttpContext().Request;
        request.Host = new HostString("map.shared.test");
        var disabled = CdsSsoSettings.Read(new ConfigurationBuilder().Build());
        Assert.False(disabled.IsForRequest(request));

        var enabled = CdsSsoSettings.Read(Configuration(ReturnUri));
        Assert.True(enabled.IsForRequest(request));
        request.Host = new HostString("another.preview.test");
        Assert.False(enabled.IsForRequest(request));
        request.Host = new HostString("map.shared.test:8443");
        Assert.False(enabled.IsForRequest(request));
        Assert.Throws<InvalidOperationException>(() => CdsSsoSettings.Read(Configuration("http://map.shared.test/api/v1/auth/cds/callback")));
        Assert.Throws<InvalidOperationException>(() => CdsSsoSettings.Read(Configuration("https://cds.shared.test/api/v1/auth/cds/callback")));
        Assert.Throws<InvalidOperationException>(() => CdsSsoSettings.Read(Configuration(ReturnUri + "?extra=1")));
        Assert.Equal("existing-map-id", enabled.LocalAccount("cds-user-1"));
        Assert.Null(enabled.LocalAccount("another-cds-id"));
    }

    [Fact]
    public void ForwardedPublicHostRequiresTheConfiguredProxyAndAnExactAuthority()
    {
        var config = Configuration(ReturnUri);
        var context = new DefaultHttpContext();
        var request = context.Request;
        request.Host = new HostString("127.0.0.1:5500");
        request.Headers[CdsSsoSettings.ForwardedHostHeader] = "map.shared.test";
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        Assert.False(CdsSsoSettings.Read(config).IsForRequest(request));

        config["CdsSso:TrustedProxyIps:0"] = "127.0.0.1";
        var settings = CdsSsoSettings.Read(config);
        context.Connection.RemoteIpAddress = IPAddress.Loopback.MapToIPv6();
        Assert.True(settings.IsForRequest(request));
        context.Connection.RemoteIpAddress = IPAddress.Parse("192.0.2.1");
        Assert.False(settings.IsForRequest(request));

        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        request.Headers[CdsSsoSettings.ForwardedHostHeader] = "other.shared.test";
        request.Headers["X-Forwarded-Host"] = "map.shared.test";
        Assert.False(settings.IsForRequest(request));
        request.Headers[CdsSsoSettings.ForwardedHostHeader] = new[] { "map.shared.test", "other.shared.test" };
        Assert.False(settings.IsForRequest(request));
    }

    [Theory]
    [InlineData("https://elsewhere.test/", "/")]
    [InlineData("//elsewhere.test/", "/")]
    [InlineData("/\\elsewhere.test/", "/")]
    [InlineData("/%5celsewhere.test/", "/")]
    [InlineData("/auth/sso#code=private", "/")]
    [InlineData("/login?cdsSso=complete", "/")]
    [InlineData("/document-store?entry=1&fragRef=ref", "/document-store?entry=1&fragRef=ref")]
    public void ReturnUrlStaysInMap(string value, string expected) => Assert.Equal(expected, CdsSsoController.SafeReturnUrl(value));

    [Fact]
    public void IdTokenRequiresTrustedSigningKeyIssuerAudienceLifetimeAndNonce()
    {
        using var trustedRsa = RSA.Create(2048);
        using var otherRsa = RSA.Create(2048);
        var trustedKey = new RsaSecurityKey(trustedRsa) { KeyId = "fixture-key" };
        var otherKey = new RsaSecurityKey(otherRsa) { KeyId = "fixture-key" };
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient());
        var client = new CdsSsoClient(CdsSsoSettings.Read(Configuration(ReturnUri)), factory.Object);
        var now = DateTime.UtcNow;

        string Token(string issuer, string audience, string nonce, SecurityKey key, DateTime expires, string? secondAudience = null)
        {
            var claims = new List<Claim> { new("sub", "cds-user-1"), new("nonce", nonce) };
            if (secondAudience is not null) claims.Add(new Claim("aud", secondAudience));
            return new JwtSecurityTokenHandler().WriteToken(new JwtSecurityToken(issuer, audience, claims,
                now.AddMinutes(-2), expires, new SigningCredentials(key, SecurityAlgorithms.RsaSha256)));
        }

        Assert.Equal("cds-user-1", client.ValidateIdToken(Token(Issuer, ClientId, "expected", trustedKey, now.AddMinutes(1)), [trustedKey], "expected"));
        Assert.Null(client.ValidateIdToken(Token(Issuer, ClientId, "wrong", trustedKey, now.AddMinutes(1)), [trustedKey], "expected"));
        Assert.Null(client.ValidateIdToken(Token(Issuer, ClientId, "expected", trustedKey, now.AddMinutes(1), "another-app"), [trustedKey], "expected"));
        Assert.ThrowsAny<SecurityTokenException>(() => client.ValidateIdToken(Token(Issuer, ClientId, "expected", otherKey, now.AddMinutes(1)), [trustedKey], "expected"));
        Assert.Throws<SecurityTokenInvalidAudienceException>(() => client.ValidateIdToken(Token(Issuer, "other-site", "expected", trustedKey, now.AddMinutes(1)), [trustedKey], "expected"));
        Assert.Throws<SecurityTokenInvalidIssuerException>(() => client.ValidateIdToken(Token("https://other.test", ClientId, "expected", trustedKey, now.AddMinutes(1)), [trustedKey], "expected"));
        Assert.Throws<SecurityTokenExpiredException>(() => client.ValidateIdToken(Token(Issuer, ClientId, "expected", trustedKey, now.AddMinutes(-1)), [trustedKey], "expected"));
    }

    [Fact]
    public async Task DiscoversCdsEndpointsWithoutFollowingAnotherHost()
    {
        var settings = CdsSsoSettings.Read(Configuration(ReturnUri));
        var flow = new CdsSsoFlow("state", "nonce", "verifier", "proof", "/");
        var calls = new List<string>();

        CdsSsoClient ClientFor(string keysUri)
        {
            var factory = new Mock<IHttpClientFactory>();
            factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(() => new HttpClient(new FixtureHandler(request =>
            {
                calls.Add(request.RequestUri!.AbsoluteUri);
                var payload = request.RequestUri.AbsolutePath.EndsWith("/jwks", StringComparison.Ordinal)
                    ? "{\"keys\":[]}"
                    : JsonSerializer.Serialize(new
                    {
                        issuer = Issuer, authorization_endpoint = Issuer + "/auth",
                        token_endpoint = Issuer + "/token", userinfo_endpoint = Issuer + "/me", jwks_uri = keysUri,
                    });
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(payload) };
            })));
            return new CdsSsoClient(settings, factory.Object);
        }

        var authorize = await ClientFor(Issuer + "/jwks").AuthorizationUrlAsync(flow, true, default);
        Assert.StartsWith(Issuer + "/auth?", authorize);
        Assert.Contains("prompt=select_account", authorize);
        Assert.EndsWith("/jwks", calls[1]);

        calls.Clear();
        await Assert.ThrowsAsync<InvalidOperationException>(() => ClientFor("https://elsewhere.test/jwks").AuthorizationUrlAsync(flow, false, default));
        Assert.Single(calls);
    }

    [Fact]
    public async Task CdsResponsesDoNotRedirectThroughTheSharedEgressHandler()
    {
        var config = Configuration(ReturnUri);
        var writer = new Mock<IMiduoPlanetSsoAuditWriter>();
        writer.Setup(w => w.BeginAsync(It.IsAny<ApiRequestLog>())).ReturnsAsync(true);
        var calls = new List<Uri>();
        var auditHandler = new CdsSsoAuditHandler(writer.Object, new HttpContextAccessor(), CdsSsoSettings.Read(config), config)
        {
            InnerHandler = new FixtureHandler(request =>
            {
                calls.Add(request.RequestUri!);
                return new HttpResponseMessage(HttpStatusCode.Found)
                {
                    Content = new StringContent("{}"),
                    Headers = { Location = new Uri("https://other.shared.test/userinfo") }
                };
            })
        };
        using var client = new HttpClient(new MapModelEgressHandler(nameof(CdsSsoClient), new Uri("https://gateway.shared.test/"))
        {
            InnerHandler = auditHandler
        });
        var endpoint = new Uri(Issuer + "/userinfo");
        using var response = await client.GetAsync(endpoint);

        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        Assert.Equal(endpoint, Assert.Single(calls));
    }

    [Fact]
    public async Task ExchangeAuditPreservesProtocolFailureWithoutSensitiveValues()
    {
        const string sensitive = "fixture-sensitive-token";
        const string json = "{\"error\":\"invalid_grant\",\"error_description\":\"fixture-sensitive-token\",\"sub\":null,\"access_token\":\"fixture-sensitive-token\"}";
        var config = Configuration(ReturnUri);
        var writer = new Mock<IMiduoPlanetSsoAuditWriter>();
        writer.Setup(w => w.BeginAsync(It.IsAny<ApiRequestLog>())).ReturnsAsync(true);
        ApiRequestLog? evidence = null;
        writer.Setup(w => w.CompleteAsync(It.IsAny<ApiRequestLog>())).Callback<ApiRequestLog>(log => evidence = log).ReturnsAsync(true);
        var handler = new CdsSsoAuditHandler(writer.Object, new HttpContextAccessor(), CdsSsoSettings.Read(config), config)
        {
            InnerHandler = new FixtureHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent(json) })
        };
        using var client = new HttpClient(handler);
        using var response = await client.PostAsync(Issuer + "/token", new StringContent(sensitive));

        Assert.Equal(json, await response.Content.ReadAsStringAsync());
        writer.Verify(w => w.BeginAsync(It.IsAny<ApiRequestLog>()), Times.Once);
        Assert.NotNull(evidence);
        Assert.Equal("invalid_grant", evidence.ErrorCode);
        Assert.Equal(400, evidence.StatusCode);
        Assert.DoesNotContain(sensitive, evidence.ResponseBody!);
        Assert.DoesNotContain(sensitive, evidence.RequestBody!);
        using var audit = JsonDocument.Parse(evidence.ResponseBody!);
        var fields = audit.RootElement.GetProperty("upstreamResponse").GetProperty("fields");
        Assert.Equal("null", fields.GetProperty("sub").GetProperty("state").GetString());
        Assert.Equal("missing", fields.GetProperty("id_token").GetProperty("state").GetString());
    }

    [Theory]
    [InlineData("<html>sample private content</html>", "markup")]
    [InlineData("{\"status\":\"sample private content\"", "json_object")]
    public async Task UnparseableResponseRetainsRedactedAuditEvidence(string content, string format)
    {
        var config = Configuration(ReturnUri);
        var writer = new Mock<IMiduoPlanetSsoAuditWriter>();
        ApiRequestLog? evidence = null;
        writer.Setup(w => w.BeginAsync(It.IsAny<ApiRequestLog>()))
            .Callback<ApiRequestLog>(log => evidence = log).ReturnsAsync(true);
        var handler = new CdsSsoAuditHandler(writer.Object, new HttpContextAccessor(), CdsSsoSettings.Read(config), config)
        {
            InnerHandler = new FixtureHandler(_ => new HttpResponseMessage(HttpStatusCode.BadGateway)
            {
                Content = new StringContent(content)
            })
        };
        using var client = new HttpClient(handler);
        await Assert.ThrowsAnyAsync<JsonException>(() => client.GetAsync(Issuer + "/userinfo"));

        Assert.NotNull(evidence);
        Assert.Equal("invalid_json", evidence.ErrorCode);
        Assert.Equal(502, evidence.StatusCode);
        Assert.DoesNotContain("sample private content", evidence.ResponseBody!);
        using var audit = JsonDocument.Parse(evidence.ResponseBody!);
        var summary = audit.RootElement.GetProperty("upstreamResponse");
        Assert.Equal(format, summary.GetProperty("format").GetString());
        Assert.False(summary.GetProperty("parseSucceeded").GetBoolean());
        Assert.Matches("^[0-9a-f]{64}$", summary.GetProperty("bodyFingerprint").GetString()!);
        Assert.Equal("complete_body", summary.GetProperty("fingerprintScope").GetString());
    }

    [Fact]
    public void DelegatedSessionsCannotIssueExternalConsoleTickets()
    {
        var session = new ClaimsPrincipal(new ClaimsIdentity([new Claim("clientType", "admin"), new Claim("sessionKey", "cds-fixture-session")]));
        Assert.False(FederatedConsoleSessionPolicy.IsEligibleBrowserSession(session));
    }

    private static IConfiguration Configuration(string redirectUri) => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["CdsSso:Enabled"] = "true",
        ["CdsSso:Issuer"] = Issuer,
        ["CdsSso:ClientId"] = ClientId,
        ["CdsSso:RedirectUri"] = redirectUri,
        ["CdsSso:Accounts:cds-user-1"] = "existing-map-id",
        ["Jwt:Secret"] = "fixture-sso-audit-key-with-sufficient-length",
    }).Build();

    private sealed class FixtureHandler(Func<HttpRequestMessage, HttpResponseMessage> reply) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(reply(request));
    }
}
