using System.Security.Cryptography;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Image)]
public class WatermarkRendererTests
{
    private static (WatermarkRenderer renderer, WatermarkFontRegistry registry) BuildRenderer()
    {
        var env = new TestHostEnvironment
        {
            ContentRootPath = Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "..", "..", "src", "PrdAgent.Api"),
            ContentRootFileProvider = new NullFileProvider()
        };
        var registry = new WatermarkFontRegistry(env, new EmptyWatermarkFontAssetSource(), new NullAssetStorage(), new NullLogger<WatermarkFontRegistry>());
        var services = new ServiceCollection();
        services.AddHttpClient();
        var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IHttpClientFactory>();
        return (new WatermarkRenderer(registry, factory, new NullLogger<WatermarkRenderer>()), registry);
    }

    private static WatermarkConfig BuildConfig(double x, double y)
    {
        return new WatermarkConfig
        {
            Text = "Test",
            FontKey = "dejavu-sans",
            FontSizePx = 24,
            Opacity = 1,
            PositionMode = "ratio",
            Anchor = "top-left",
            OffsetX = x,
            OffsetY = y,
            BaseCanvasWidth = 320,
            TextColor = "#FFFFFF"
        };
    }

    [Fact]
    public async Task Render_ShouldBeStable()
    {
        var (renderer, registry) = BuildRenderer();
        if (registry.TryResolveFontFile(registry.DefaultFontKey) == null) return;
        var config = BuildConfig(0.5, 0.5);

        using var image = new Image<Rgba32>(400, 400);
        await using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);
        var bytes = ms.ToArray();

        var first = await renderer.ApplyAsync(bytes, "image/png", config, CancellationToken.None);
        var second = await renderer.ApplyAsync(bytes, "image/png", config, CancellationToken.None);

        var hash1 = SHA256.HashData(first.bytes);
        var hash2 = SHA256.HashData(second.bytes);
        Assert.Equal(hash1, hash2);
    }

    [Theory]
    [InlineData(512, 512, 0.2, 0.8)]
    [InlineData(1024, 576, 0.5, 0.5)]
    [InlineData(768, 1152, 0.85, 0.85)]
    [InlineData(900, 1600, 0.5, 0.2)]
    public async Task Render_ShouldPlaceTextCenterConsistently(int width, int height, double x, double y)
    {
        var (renderer, registry) = BuildRenderer();
        if (registry.TryResolveFontFile(registry.DefaultFontKey) == null) return;
        var config = BuildConfig(x, y);

        using var image = new Image<Rgba32>(width, height);
        await using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);
        var bytes = ms.ToArray();

        var result = await renderer.ApplyAsync(bytes, "image/png", config, CancellationToken.None);
        using var rendered = Image.Load<Rgba32>(result.bytes);

        var bounds = FindBounds(rendered);
        var centerX = (bounds.minX + bounds.maxX) / 2d;
        var centerY = (bounds.minY + bounds.maxY) / 2d;
        var (expectedX, expectedY) = CalculateExpectedCenter(registry, config, width, height);

        Assert.InRange(Math.Abs(centerX - expectedX), 0, 2);
        Assert.InRange(Math.Abs(centerY - expectedY), 0, 2);
    }

    private static (double centerX, double centerY) CalculateExpectedCenter(
        WatermarkFontRegistry registry,
        WatermarkConfig config,
        int width,
        int height)
    {
        var fontSize = WatermarkLayoutCalculator.CalculateScaledFontSize(config, width);
        var font = registry.ResolveFont(config.FontKey, fontSize).Font;
        var textOptions = new TextOptions(font)
        {
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Top
        };
        var textSize = TextMeasurer.MeasureSize(config.Text, textOptions);
        var textHeight = textSize.Height;
        var textWidth = textSize.Width;

        var gap = textHeight / 4d;
        var iconWidth = config.IconEnabled ? textHeight + gap : 0d;
        var padding = (config.BackgroundEnabled || config.BorderEnabled) ? textHeight * 0.3d : 0d;
        var watermarkWidth = textWidth + iconWidth + padding * 2d;
        var watermarkHeight = textHeight + padding * 2d;
        var (left, top) = WatermarkLayoutCalculator.CalculateWatermarkTopLeft(config, width, height, watermarkWidth, watermarkHeight);
        var textLeft = left + iconWidth + padding;
        var textTop = top + padding;
        return (textLeft + textWidth / 2d, textTop + textHeight / 2d);
    }

    private static (int minX, int minY, int maxX, int maxY) FindBounds(Image<Rgba32> img)
    {
        var minX = img.Width;
        var minY = img.Height;
        var maxX = 0;
        var maxY = 0;
        img.ProcessPixelRows(accessor =>
        {
            for (var y = 0; y < accessor.Height; y++)
            {
                var row = accessor.GetRowSpan(y);
                for (var x = 0; x < accessor.Width; x++)
                {
                    if (row[x].A == 0) continue;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        });
        if (minX == img.Width) return (0, 0, 0, 0);
        return (minX, minY, maxX, maxY);
    }
}
