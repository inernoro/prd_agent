using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Extensions;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class SyntheticLoginControllerTests
{
    [Theory]
    [InlineData(null, true, "/")]
    [InlineData("/", true, "/")]
    [InlineData("/visual-agent?tab=recent", true, "/visual-agent?tab=recent")]
    [InlineData("https://evil.example", false, "/")]
    [InlineData("//evil.example", false, "/")]
    [InlineData("/safe\\evil", false, "/")]
    public void ReturnUrlPolicy_ShouldAllowOnlySameOriginPaths(
        string? raw,
        bool expected,
        string normalized)
    {
        var args = new object?[] { raw, null };

        var valid = Invoke<bool>("TryNormalizeReturnUrl", args);

        Assert.Equal(expected, valid);
        Assert.Equal(normalized, args[1]);
    }

    [Theory]
    [InlineData(null, 180)]
    [InlineData(1, 60)]
    [InlineData(240, 240)]
    [InlineData(900, 300)]
    public void TicketLifetime_ShouldStayWithinOneToFiveMinutes(int? requested, int expected)
    {
        Assert.Equal(expected, Invoke<int>("NormalizeTicketSeconds", requested));
    }

    [Fact]
    public void LoginUrl_ShouldCarryOneTimeCodeOnlyInFragment()
    {
        var loginUrl = Invoke<string>(
            "BuildLoginUrl",
            "one-time-code",
            "/visual-agent?tab=recent");

        Assert.StartsWith("/synthetic-login#", loginUrl);
        Assert.DoesNotContain("/synthetic-login?", loginUrl);
        Assert.Contains("code=one-time-code", loginUrl);
        Assert.Contains("returnUrl=%2Fvisual-agent%3Ftab%3Drecent", loginUrl);
    }

    [Fact]
    public void TicketIssuance_ShouldRequireAiOrStableSmokeScheme()
    {
        var method = typeof(SyntheticLoginController).GetMethod(nameof(SyntheticLoginController.IssueTicket));

        Assert.NotNull(method);
        var authorize = method.GetCustomAttribute<AuthorizeAttribute>();
        Assert.NotNull(authorize);
        Assert.Equal(
            AiAccessKeyAuthenticationHandler.SchemeName + "," + StableSmokeAuthenticationHandler.SchemeName,
            authorize.AuthenticationSchemes);
    }

    [Fact]
    public void Exchange_ShouldBeAnonymousAndTicketBased()
    {
        var method = typeof(SyntheticLoginController).GetMethod(nameof(SyntheticLoginController.Exchange));

        Assert.NotNull(method);
        Assert.NotNull(method.GetCustomAttribute<AllowAnonymousAttribute>());
        Assert.NotNull(method.GetCustomAttribute<HttpPostAttribute>());
    }

    [Fact]
    public void AccountPolicy_ShouldFailClosedWhenAllowlistIsEmpty()
    {
        Assert.False(Invoke<bool>(
            "IsAllowedUser",
            "stable-smoke-user",
            new HashSet<string>(StringComparer.OrdinalIgnoreCase)));
        Assert.True(Invoke<bool>(
            "IsAllowedUser",
            "stable-smoke-user",
            new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "stable-smoke-user" }));
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("false", false)]
    [InlineData("true", true)]
    public void SyntheticLogin_ShouldRequireExplicitEnableFlag(string? enabled, bool expected)
    {
        using var rsa = RSA.Create(2048);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SYNTHETIC_LOGIN_ENABLED"] = enabled,
                ["StableSmoke:PublicKeys:0:Id"] = "test-key",
                ["StableSmoke:PublicKeys:0:Username"] = "stable-smoke-user",
                ["StableSmoke:PublicKeys:0:PublicKey"] = Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo()),
            })
            .Build();

        Assert.Equal(expected, Invoke<bool>("IsEnabled", configuration));
    }

    [Fact]
    public void StableSmokeSignature_ShouldVerifyCanonicalBodyAndRejectMutation()
    {
        using var rsa = RSA.Create(2048);
        var publicKey = Convert.ToBase64String(rsa.ExportSubjectPublicKeyInfo());
        var canonical = StableSmokeAuthenticationHandler.BuildCanonicalRequest(
            "POST",
            "/api/v1/auth/synthetic/ticket",
            1_786_547_200,
            "nonce_for_test_1234567890",
            "stsmk_prod",
            "{\"returnUrl\":\"/\",\"expiresInSeconds\":60}");
        var signature = rsa.SignData(
            Encoding.UTF8.GetBytes(canonical),
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pss);

        Assert.True(StableSmokeAuthenticationHandler.VerifySignature(publicKey, canonical, signature));
        var mutatedCanonical = StableSmokeAuthenticationHandler.BuildCanonicalRequest(
            "POST",
            "/api/v1/auth/synthetic/ticket",
            1_786_547_200,
            "nonce_for_test_1234567890",
            "stsmk_prod",
            "{\"returnUrl\":\"/users\",\"expiresInSeconds\":60}");
        Assert.False(StableSmokeAuthenticationHandler.VerifySignature(
            publicKey,
            mutatedCanonical,
            signature));
    }

    [Theory]
    [InlineData("POST", "/api/v1/auth/synthetic/ticket", true)]
    [InlineData("POST", "/api/v1/auth/synthetic/gateway-ticket", true)]
    [InlineData("POST", "/api/dashboard/notifications/events", true)]
    [InlineData("POST", "/api/v1/auth/synthetic/testing/web-pages/0123456789abcdef0123456789abcdef/legacy-entry", true)]
    [InlineData("DELETE", "/api/v1/auth/synthetic/testing/web-pages/0123456789abcdef0123456789abcdef/legacy-entry", true)]
    [InlineData("GET", "/api/v1/auth/synthetic/testing/web-pages/0123456789abcdef0123456789abcdef/legacy-entry", false)]
    [InlineData("POST", "/api/v1/auth/synthetic/testing/web-pages/not-a-site/legacy-entry", false)]
    [InlineData("GET", "/api/v1/auth/synthetic/ticket", false)]
    [InlineData("POST", "/api/users", false)]
    public void StableSmokeSignature_ShouldBeEndpointScoped(string method, string path, bool expected)
    {
        Assert.Equal(expected, StableSmokeAuthenticationHandler.IsAllowedRequest(method, path));
    }

    [Fact]
    public void LegacyStorageFixture_ShouldAlwaysAdvanceContentVersion()
    {
        var futureVersion = DateTime.UtcNow.AddMinutes(1);

        var next = Invoke<DateTime>("NextContentVersion", futureVersion);

        Assert.True(next > futureVersion);
    }

    [Fact]
    public void FixtureAuthorization_ShouldUseSharedIdentityResolverWithNameIdentifier()
    {
        var source = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/SyntheticLoginController.cs"));
        var controller = new IdentityProbeController
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim(ClaimTypes.NameIdentifier, "stable-smoke-user-id") },
                        "test")),
                },
            },
        };

        Assert.Contains("userId = this.GetRequiredUserId().Trim();", source);
        Assert.Equal("stable-smoke-user-id", controller.GetRequiredUserId());
    }

    [Fact]
    public void StableSmokeSignature_ShouldResolveDeploymentHostWithoutWildcardTrust()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["CDS_PREVIEW_URL"] = "https://branch.example.test/visual-agent",
            })
            .Build();

        Assert.True(StableSmokeAuthenticationHandler.IsAllowedHost(
            "@deployment", "branch.example.test", configuration));
        Assert.False(StableSmokeAuthenticationHandler.IsAllowedHost(
            "@deployment", "other.example.test", configuration));
        Assert.True(StableSmokeAuthenticationHandler.IsAllowedHost(
            "fixed.example.test", "FIXED.EXAMPLE.TEST", configuration));
    }

    [Fact]
    public void StableSmokeSignature_ShouldTrustForwardedHostOnlyFromPrivateProxy()
    {
        var proxied = new DefaultHttpContext();
        proxied.Connection.RemoteIpAddress = IPAddress.Parse("10.240.24.1");
        proxied.Request.Host = new HostString("127.0.0.1", 8080);
        proxied.Request.Headers["X-Forwarded-Host"] = "branch.example.test, proxy.internal";
        Assert.Equal(
            "branch.example.test",
            StableSmokeAuthenticationHandler.ResolveRequestHost(proxied.Request));

        var direct = new DefaultHttpContext();
        direct.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.20");
        direct.Request.Host = new HostString("api.example.test");
        direct.Request.Headers["X-Forwarded-Host"] = "spoofed.example.test";
        Assert.Equal(
            "api.example.test",
            StableSmokeAuthenticationHandler.ResolveRequestHost(direct.Request));
    }

    [Fact]
    public void GatewayFederation_ShouldAutoProvisionOnlyMissingStateAndCircuitBreakManualChanges()
    {
        var controller = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Controllers/SyntheticLoginController.cs"));
        var federation = File.ReadAllText(LocateRepoFile(
            "llmgw/console-api/Auth/StableSmokeFederation.cs"));
        var gateway = File.ReadAllText(LocateRepoFile(
            "llmgw/console-api/Program.cs"));

        Assert.Contains("StableSmokeAuthenticationHandler.SchemeName", controller);
        var gatewayTicketMethod = typeof(SyntheticLoginController).GetMethod(
            nameof(SyntheticLoginController.IssueGatewayTicket));
        Assert.NotNull(gatewayTicketMethod);
        Assert.Equal(
            StableSmokeAuthenticationHandler.SchemeName,
            gatewayTicketMethod.GetCustomAttribute<AuthorizeAttribute>()?.AuthenticationSchemes);
        Assert.Contains("if (!user.IsActive)", federation);
        Assert.Contains("STABLE_SMOKE_ACCOUNT_DISABLED", federation);
        Assert.Contains("STABLE_SMOKE_MEMBERSHIP_DISABLED", federation);
        Assert.Contains("STABLE_SMOKE_ROLE_DRIFT", federation);
        Assert.DoesNotContain(".Set(x => x.IsActive, true)", federation);
        Assert.Contains("/gw/auth/failure-health", gateway);
        Assert.Contains("single-refresh-single-retry", gateway);
        Assert.Contains("one-time-ticket-auto-provision", gateway);
    }

    [Fact]
    public void StableSmokeSignature_ShouldApplyAStreamingBufferLimitBeforeReadingTheBody()
    {
        var handler = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/Authentication/StableSmokeAuthenticationHandler.cs"));

        Assert.Contains("bufferLimit: MaximumBodyBytes", handler);
        Assert.Contains("catch (IOException)", handler);
        Assert.True(
            handler.IndexOf("bufferLimit: MaximumBodyBytes", StringComparison.Ordinal)
            < handler.IndexOf("ReadToEndAsync", StringComparison.Ordinal));
    }

    [Fact]
    public void StableSmokePublicRegistry_ShouldNotBeCommittedToAppSettings()
    {
        var settings = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Api/appsettings.json"));

        Assert.DoesNotContain("StableSmokeAuthentication", settings, StringComparison.Ordinal);
        Assert.DoesNotContain("PublicKey", settings, StringComparison.Ordinal);
        Assert.DoesNotContain("PRIVATE KEY", settings, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("SigningPrivateKey", settings, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TicketIndexes_ShouldProvideUniqueHashLookupAndExpiryCleanup()
    {
        var catalog = File.ReadAllText(LocateRepoFile("scripts/mongodb-indexes.js"));
        var startup = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/DatabaseInitializer.cs"));

        Assert.Contains("uniq_console_sso_tickets_code_hash", catalog);
        Assert.Contains("ttl_console_sso_tickets_expires_at", catalog);
        Assert.DoesNotContain("EnsureConsoleSsoTicketIndexesAsync", startup);
    }

    [Fact]
    public void DirectVideoIndexes_ShouldProvideUniqueOwnershipAndExpiryCleanup()
    {
        var catalog = File.ReadAllText(LocateRepoFile("scripts/mongodb-indexes.js"));
        var startup = File.ReadAllText(LocateRepoFile(
            "prd-api/src/PrdAgent.Infrastructure/Database/DatabaseInitializer.cs"));

        Assert.Contains("db.direct_video_job_ownerships.updateMany", catalog);
        Assert.Contains("uniq_direct_video_job_app_job", catalog);
        Assert.Contains("ttl_direct_video_job_expires_at", catalog);
        Assert.DoesNotContain("EnsureDirectVideoJobOwnershipIndexesAsync", startup);
    }

    private static string LocateRepoFile(string relativePath)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }

        throw new FileNotFoundException($"Cannot locate repository file: {relativePath}");
    }

    private static T Invoke<T>(string name, params object?[] args)
    {
        var method = typeof(SyntheticLoginController).GetMethod(
            name,
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return Assert.IsAssignableFrom<T>(method.Invoke(null, args));
    }

    private sealed class IdentityProbeController : ControllerBase
    {
    }
}
