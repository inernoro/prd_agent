using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WatermarkFontRegistryTests
{
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

    [Fact]
    public void ResolveFont_ShouldUseSystemFallback_WhenDefaultTtfMissing()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "prd-watermark-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(tempRoot, "Assets", "Fonts"));
        try
        {
            var env = new TestHostEnvironment
            {
                ContentRootPath = tempRoot,
                ContentRootFileProvider = new NullFileProvider()
            };
            var logger = new ListLogger<WatermarkFontRegistry>();
            var registry = new WatermarkFontRegistry(env, new EmptyWatermarkFontAssetSource(), new NullAssetStorage(), new ConfigurationBuilder().Build(), logger);
            Assert.Null(registry.TryResolveFontFile(registry.DefaultFontKey));

            try
            {
                var resolved = registry.ResolveFont(registry.DefaultFontKey, 18);
                Assert.NotNull(resolved.Font);
                Assert.True(resolved.FallbackUsed);
                Assert.Contains("system font", resolved.FallbackReason ?? string.Empty, StringComparison.OrdinalIgnoreCase);
            }
            catch (FileNotFoundException)
            {
                // 极少数无 SixLabors 可枚举系统字体的环境
            }
        }
        finally
        {
            try
            {
                Directory.Delete(tempRoot, recursive: true);
            }
            catch
            {
                // ignore
            }
        }
    }
}
