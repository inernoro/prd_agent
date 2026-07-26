using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class ConsoleSsoControllerTests
{
    [Theory]
    [InlineData("https://cds.miduo.org/auth/sso", true)]
    [InlineData("https://branch-cds.miduo.org/auth/sso", true)]
    [InlineData("https://miduo.org.evil.example/auth/sso", false)]
    [InlineData("https://cds.miduo.org/other", false)]
    [InlineData("http://cds.miduo.org/auth/sso", false)]
    public void RedirectValidation_ShouldAllowConfiguredHttpsCallback(string redirectUri, bool expected)
    {
        var origins = Invoke<IReadOnlyList<string>>(
            "ParseOrigins",
            "https://cds.miduo.org,*.miduo.org");
        var args = new object?[] { redirectUri, origins, null };
        var valid = Invoke<bool>("TryValidateRedirect", args);

        Assert.Equal(expected, valid);
        Assert.Equal(expected ? redirectUri : "", args[2]);
    }

    [Theory]
    [InlineData("http://localhost:9900/auth/sso", "http://localhost:9900")]
    [InlineData("http://127.0.0.1:9900/auth/sso", "http://127.0.0.1:9900")]
    [InlineData("http://[::1]:9900/auth/sso", "http://[::1]:9900")]
    public void RedirectValidation_ShouldAllowConfiguredLoopbackHttpCallback(
        string redirectUri,
        string allowedOrigin)
    {
        var origins = Invoke<IReadOnlyList<string>>("ParseOrigins", allowedOrigin);
        var args = new object?[] { redirectUri, origins, null };

        var valid = Invoke<bool>("TryValidateRedirect", args);

        Assert.True(valid);
        Assert.Equal(redirectUri, args[2]);
    }

    [Fact]
    public void ClientCredentialComparison_ShouldRejectDifferentValues()
    {
        Assert.True(Invoke<bool>("FixedEquals", "client-secret", "client-secret"));
        Assert.False(Invoke<bool>("FixedEquals", "client-secret", "client-secret-2"));
        Assert.False(Invoke<bool>("FixedEquals", "client-secret", null));
    }

    [Fact]
    public void Authorization_ShouldUseAnonymousPageAndBearerProtectedPost()
    {
        var pageMethod = typeof(ConsoleSsoController).GetMethod(nameof(ConsoleSsoController.AuthorizePage));
        var authorizeMethod = typeof(ConsoleSsoController).GetMethod(nameof(ConsoleSsoController.Authorize));

        Assert.NotNull(pageMethod);
        Assert.NotNull(authorizeMethod);
        Assert.NotNull(pageMethod.GetCustomAttribute<HttpGetAttribute>());
        Assert.NotNull(pageMethod.GetCustomAttribute<AllowAnonymousAttribute>());
        Assert.NotNull(authorizeMethod.GetCustomAttribute<HttpPostAttribute>());
        Assert.NotNull(authorizeMethod.GetCustomAttribute<AuthorizeAttribute>());
    }

    [Fact]
    public void Provider_ShouldRemainDisabledWithoutAnyAllowedRedirectOrigin()
    {
        Assert.False(Invoke<bool>(
            "IsProviderEnabled",
            true,
            "cds-console",
            "client-secret",
            Array.Empty<string>()));
        Assert.True(Invoke<bool>(
            "IsProviderEnabled",
            true,
            "cds-console",
            "client-secret",
            new[] { "https://cds.miduo.org" }));
    }

    [Fact]
    public void OriginParsing_ShouldDropUnsupportedSchemesAndPublicHttp()
    {
        var origins = Invoke<IReadOnlyList<string>>(
            "ParseOrigins",
            "ftp://localhost,http://cds.miduo.org,http://localhost:9900,https://cds.miduo.org");

        Assert.Equal(
            new[] { "http://localhost:9900", "https://cds.miduo.org" },
            origins);
    }

    private static T Invoke<T>(string name, params object?[] args)
    {
        var method = typeof(ConsoleSsoController).GetMethod(
            name,
            BindingFlags.Static | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return Assert.IsAssignableFrom<T>(method.Invoke(null, args));
    }
}
