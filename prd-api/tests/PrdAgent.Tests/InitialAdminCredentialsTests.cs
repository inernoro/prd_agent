using Microsoft.Extensions.Configuration;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Tests;

public sealed class InitialAdminCredentialsTests
{
    [Fact]
    public void Resolve_ShouldPreferDedicatedBootstrapCredentials()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            [InitialAdminCredentials.UsernameKey] = "bootstrap_admin",
            [InitialAdminCredentials.PasswordKey] = "Dedicated123456",
            ["ROOT_ACCESS_USERNAME"] = "root_admin",
            ["ROOT_ACCESS_PASSWORD"] = "RootPassword123456",
        });

        var result = InitialAdminCredentials.Resolve(configuration);

        Assert.Equal("bootstrap_admin", result.Username);
        Assert.Equal("Dedicated123456", result.Password);
    }

    [Fact]
    public void Resolve_ShouldUseConfiguredRootPairAsDeploymentFallback()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ROOT_ACCESS_USERNAME"] = "root_admin",
            ["ROOT_ACCESS_PASSWORD"] = "RootPassword123456",
        });

        var result = InitialAdminCredentials.Resolve(configuration);

        Assert.Equal("root_admin", result.Username);
        Assert.Equal("RootPassword123456", result.Password);
    }

    [Fact]
    public void Resolve_ShouldFailClosedWhenNoDeploymentCredentialsExist()
    {
        var error = Assert.Throws<InvalidOperationException>(
            () => InitialAdminCredentials.Resolve(BuildConfiguration(new Dictionary<string, string?>())));

        Assert.Contains(InitialAdminCredentials.UsernameKey, error.Message);
        Assert.Contains(InitialAdminCredentials.PasswordKey, error.Message);
    }

    [Theory]
    [InlineData("only_username", null)]
    [InlineData(null, "OnlyPassword123")]
    public void Resolve_ShouldRejectPartialDedicatedCredentials(string? username, string? password)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            [InitialAdminCredentials.UsernameKey] = username,
            [InitialAdminCredentials.PasswordKey] = password,
            ["ROOT_ACCESS_USERNAME"] = "root_admin",
            ["ROOT_ACCESS_PASSWORD"] = "RootPassword123456",
        });

        var error = Assert.Throws<InvalidOperationException>(
            () => InitialAdminCredentials.Resolve(configuration));

        Assert.Contains("缺一不可", error.Message);
    }

    [Theory]
    [InlineData("abc", "StrongPassword123")]
    [InlineData("valid_admin", "short")]
    [InlineData("valid_admin", "OnlyLettersPassword")]
    public void Resolve_ShouldRejectInvalidCredentialStrength(string username, string password)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            [InitialAdminCredentials.UsernameKey] = username,
            [InitialAdminCredentials.PasswordKey] = password,
        });

        Assert.Throws<InvalidOperationException>(
            () => InitialAdminCredentials.Resolve(configuration));
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();
}
