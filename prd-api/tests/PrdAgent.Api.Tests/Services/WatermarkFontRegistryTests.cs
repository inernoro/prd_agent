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
        var registry = new WatermarkFontRegistry(env, logger);

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
        var registry = new WatermarkFontRegistry(env, logger);

        var resolved = registry.ResolveFont(registry.DefaultFontKey, 24);

        Assert.NotNull(resolved.Font);
        Assert.False(resolved.FallbackUsed);
    }
}
