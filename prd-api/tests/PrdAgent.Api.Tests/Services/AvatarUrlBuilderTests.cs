using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class AvatarUrlBuilderTests
{
    [Fact]
    public void Build_LocalProvider_ShouldUseServedLocalAssetsPrefix()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASSETS_PROVIDER"] = "local",
            ["R2_PUBLIC_BASE_URL"] = "https://r2.example.test",
            ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://cos.example.test",
        });

        AvatarUrlBuilder.ResolvePublicBaseUrl(configuration).ShouldBe("/local-assets");
        AvatarUrlBuilder.Build(configuration, "Alice.PNG")
            .ShouldBe("/local-assets/icon/backups/head/alice.png");
    }

    [Theory]
    [InlineData("cloudflareR2", "R2_PUBLIC_BASE_URL", "https://r2.example.test/base/")]
    [InlineData("tencentCos", "TENCENT_COS_PUBLIC_BASE_URL", "https://cos.example.test/base/")]
    public void Build_CloudProvider_ShouldUseMatchingConfiguredBase(
        string provider,
        string baseUrlKey,
        string baseUrl)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASSETS_PROVIDER"] = provider,
            [baseUrlKey] = baseUrl,
        });

        AvatarUrlBuilder.Build(configuration, "avatar.webp")
            .ShouldBe($"{baseUrl.TrimEnd('/')}/icon/backups/head/avatar.webp");
    }

    [Fact]
    public void Build_UnknownProvider_ShouldNotFallBackToAnotherEnvironment()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASSETS_PROVIDER"] = "unknown",
            ["R2_PUBLIC_BASE_URL"] = "https://r2.example.test",
            ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://cos.example.test",
        });

        AvatarUrlBuilder.ResolvePublicBaseUrl(configuration).ShouldBeNull();
        AvatarUrlBuilder.Build(configuration, "avatar.png").ShouldBeNull();
    }

    [Theory]
    [InlineData("cloudflareR2", "TENCENT_COS_PUBLIC_BASE_URL", "https://cos.example.test")]
    [InlineData("tencentCos", "R2_PUBLIC_BASE_URL", "https://r2.example.test")]
    public void Build_CloudProviderMissingOwnBase_ShouldNotBorrowAnotherEnvironment(
        string provider,
        string otherBaseUrlKey,
        string otherBaseUrl)
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASSETS_PROVIDER"] = provider,
            [otherBaseUrlKey] = otherBaseUrl,
        });

        AvatarUrlBuilder.ResolvePublicBaseUrl(configuration).ShouldBeNull();
        AvatarUrlBuilder.Build(configuration, "avatar.png").ShouldBeNull();
    }

    private static IConfiguration BuildConfiguration(Dictionary<string, string?> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();
}
