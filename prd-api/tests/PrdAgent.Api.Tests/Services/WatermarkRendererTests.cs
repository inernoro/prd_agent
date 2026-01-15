using System.Security.Cryptography;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WatermarkRendererTests
{
    private static WatermarkRenderer BuildRenderer()
    {
        var env = new TestHostEnvironment
        {
            ContentRootPath = Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "..", "..", "src", "PrdAgent.Api"),
            ContentRootFileProvider = new NullFileProvider()
        };
        var registry = new WatermarkFontRegistry(env, new NullLogger<WatermarkFontRegistry>());
        var services = new ServiceCollection();
        services.AddHttpClient();
        var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IHttpClientFactory>();
        return new WatermarkRenderer(registry, factory, new NullLogger<WatermarkRenderer>());
    }

    private static WatermarkSpec BuildSpec(double x, double y)
    {
        return new WatermarkSpec
        {
            Enabled = true,
            Text = "Test",
            FontKey = "dejavu-sans",
            FontSizePx = 24,
            Opacity = 1,
            PosXRatio = x,
            PosYRatio = y,
            BaseCanvasWidth = 320,
            Color = "#FFFFFF"
        };
    }

    [Fact]
    public async Task Render_ShouldBeStable()
    {
        var renderer = BuildRenderer();
        var spec = BuildSpec(0.5, 0.5);

        using var image = new Image<Rgba32>(400, 400);
        await using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);
        var bytes = ms.ToArray();

        var first = await renderer.ApplyAsync(bytes, "image/png", spec, CancellationToken.None);
        var second = await renderer.ApplyAsync(bytes, "image/png", spec, CancellationToken.None);

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
        var renderer = BuildRenderer();
        var spec = BuildSpec(x, y);

        using var image = new Image<Rgba32>(width, height);
        await using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);
        var bytes = ms.ToArray();

        var result = await renderer.ApplyAsync(bytes, "image/png", spec, CancellationToken.None);
        using var rendered = Image.Load<Rgba32>(result.bytes);

        var bounds = FindBounds(rendered);
        var centerX = (bounds.minX + bounds.maxX) / 2d;
        var centerY = (bounds.minY + bounds.maxY) / 2d;
        var expectedX = x * width;
        var expectedY = y * width;

        Assert.InRange(Math.Abs(centerX - expectedX), 0, 2);
        Assert.InRange(Math.Abs(centerY - expectedY), 0, 2);
    }

    private static (int minX, int minY, int maxX, int maxY) FindBounds(Image<Rgba32> img)
    {
        var minX = img.Width;
        var minY = img.Height;
        var maxX = 0;
        var maxY = 0;
        for (var y = 0; y < img.Height; y++)
        {
            var row = img.GetPixelRowSpan(y);
            for (var x = 0; x < img.Width; x++)
            {
                if (row[x].A == 0) continue;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
        if (minX == img.Width) return (0, 0, 0, 0);
        return (minX, minY, maxX, maxY);
    }
}
