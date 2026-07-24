using System.Reflection;
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
    public void RedirectValidation_ShouldAllowOnlyConfiguredHttpsCallback(string redirectUri, bool expected)
    {
        var origins = Invoke<IReadOnlyList<string>>(
            "ParseOrigins",
            "https://cds.miduo.org,*.miduo.org");
        var args = new object?[] { redirectUri, origins, null };
        var valid = Invoke<bool>("TryValidateRedirect", args);

        Assert.Equal(expected, valid);
        Assert.Equal(expected ? redirectUri : "", args[2]);
    }

    [Fact]
    public void ClientCredentialComparison_ShouldRejectDifferentValues()
    {
        Assert.True(Invoke<bool>("FixedEquals", "client-secret", "client-secret"));
        Assert.False(Invoke<bool>("FixedEquals", "client-secret", "client-secret-2"));
        Assert.False(Invoke<bool>("FixedEquals", "client-secret", null));
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
