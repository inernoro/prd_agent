using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WatermarkFontRegistryTests
{
    [Fact]
    public void DefaultFontUrl_AutoProvider_ShouldUseRuntimeSelectedR2BaseUrl()
    {
        var env = new TestHostEnvironment
        {
            ContentRootPath = Path.Combine(
                Directory.GetCurrentDirectory(),
                "..",
                "..",
                "..",
                "..",
                "src",
                "PrdAgent.Api"),
            ContentRootFileProvider = new NullFileProvider()
        };
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ASSETS_PROVIDER"] = "auto",
                ["R2_ACCOUNT_ID"] = "account",
                ["R2_ACCESS_KEY_ID"] = "access-key",
                ["R2_SECRET_ACCESS_KEY"] = "secret-key",
                ["R2_BUCKET"] = "bucket",
                ["R2_PUBLIC_BASE_URL"] = "https://r2.example.test/base/",
                ["TENCENT_COS_PUBLIC_BASE_URL"] = "https://cos.example.test",
            })
            .Build();

        var registry = new WatermarkFontRegistry(
            env,
            new EmptyWatermarkFontAssetSource(),
            new NullAssetStorage(),
            configuration,
            new ListLogger<WatermarkFontRegistry>());

        registry.DefaultFontUrl.ShouldBe(
            "https://r2.example.test/base/watermark/font/default.ttf");
    }

    [Fact]
    public void ResolveFont_ShouldFallbackAndLog()
    {
        var env = new TestHostEnvironment
        {
            ContentRootPath = Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "..", "..", "src", "PrdAgent.Api"),
            ContentRootFileProvider = new NullFileProvider()
        };
        var logger = new ListLogger<WatermarkFontRegistry>();
        var registry = new WatermarkFontRegistry(env, new EmptyWatermarkFontAssetSource(), new NullAssetStorage(), new ConfigurationBuilder().Build(), logger);
        if (registry.TryResolveFontFile(registry.DefaultFontKey) == null) return;

        var resolved = registry.ResolveFont("missing-font", 24);

        Assert.True(resolved.FallbackUsed);
        Assert.Contains("missing-font", logger.Messages.FirstOrDefault() ?? string.Empty);
    }

    [Fact]
    public void ResolveFont_ShouldLoadFontFile()
    {
        var env = new TestHostEnvironment
        {
            ContentRootPath = Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "..", "..", "src", "PrdAgent.Api"),
            ContentRootFileProvider = new NullFileProvider()
        };
        var logger = new ListLogger<WatermarkFontRegistry>();
        var registry = new WatermarkFontRegistry(env, new EmptyWatermarkFontAssetSource(), new NullAssetStorage(), new ConfigurationBuilder().Build(), logger);
        if (registry.TryResolveFontFile(registry.DefaultFontKey) == null) return;

        var resolved = registry.ResolveFont(registry.DefaultFontKey, 24);

        Assert.NotNull(resolved.Font);
        Assert.False(resolved.FallbackUsed);
    }
}
