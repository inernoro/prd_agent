using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
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
    public void Build_AutoProviderWithR2Credentials_ShouldUseR2BaseUrl()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["ASSETS_PROVIDER"] = "auto",
            ["R2_ACCOUNT_ID"] = "account",
            ["R2_ACCESS_KEY_ID"] = "access-key",
            ["R2_SECRET_ACCESS_KEY"] = "secret-key",
            ["R2_BUCKET"] = "bucket",
            ["R2_PUBLIC_BASE_URL"] = "https://r2.example.test",
            ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://cos.example.test",
        });

        AssetStorageProviderResolver.ResolveProviderName(configuration)
            .ShouldBe(AssetStorageProviderResolver.CloudflareR2);
        AvatarUrlBuilder.Build(configuration, "avatar.png")
            .ShouldBe("https://r2.example.test/icon/backups/head/avatar.png");
    }

    [Fact]
    public void Build_UnsetProviderWithTencentCredentials_ShouldUseTencentBaseUrl()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["TENCENT_COS_BUCKET"] = "bucket",
            ["TENCENT_COS_REGION"] = "ap-test",
            ["TENCENT_COS_SECRET_ID"] = "secret-id",
            ["TENCENT_COS_SECRET_KEY"] = "secret-key",
            ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://cos.example.test",
            ["R2_PUBLIC_BASE_URL"] = "https://r2.example.test",
        });

        AssetStorageProviderResolver.ResolveProviderName(configuration)
            .ShouldBe(AssetStorageProviderResolver.TencentCos);
        AvatarUrlBuilder.Build(configuration, "avatar.png")
            .ShouldBe("https://cos.example.test/icon/backups/head/avatar.png");
    }

    [Fact]
    public void Build_UnsetProviderWithoutCloudCredentials_ShouldUseLocalBaseUrl()
    {
        var configuration = BuildConfiguration(new Dictionary<string, string?>
        {
            ["R2_PUBLIC_BASE_URL"] = "https://r2.example.test",
            ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://cos.example.test",
        });

        AssetStorageProviderResolver.ResolveProviderName(configuration)
            .ShouldBe(AssetStorageProviderResolver.Local);
        AvatarUrlBuilder.Build(configuration, "avatar.png")
            .ShouldBe("/local-assets/icon/backups/head/avatar.png");
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
