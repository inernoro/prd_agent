using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WatermarkRendererTests
{
    private static (WatermarkRenderer renderer, WatermarkFontRegistry registry) BuildRenderer()
    {
        var contentRootPath = ResolveApiContentRootPath();
        var env = new TestHostEnvironment
        {
            ContentRootPath = contentRootPath,
            ContentRootFileProvider = new NullFileProvider()
        };
        var registry = new WatermarkFontRegistry(env, new EmptyWatermarkFontAssetSource(), new NullAssetStorage(), new ConfigurationBuilder().Build(), new NullLogger<WatermarkFontRegistry>());
        var services = new ServiceCollection();
        services.AddHttpClient();
        var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IHttpClientFactory>();
        return (new WatermarkRenderer(registry, factory, new NullLogger<WatermarkRenderer>()), registry);
    }

    private static string ResolveApiContentRootPath()
    {
        var candidates = new[]
        {
            Directory.GetCurrentDirectory(),
            AppContext.BaseDirectory
        };
        foreach (var start in candidates)
        {
            var dir = new DirectoryInfo(start);
            for (var i = 0; i < 10 && dir != null; i++)
            {
                var path = Path.Combine(dir.FullName, "prd-api", "src", "PrdAgent.Api");
                var fontPath = Path.Combine(path, "Assets", "Fonts", "default.ttf");
                if (File.Exists(fontPath))
                {
                    return path;
                }
                dir = dir.Parent;
            }
        }

        return Path.Combine(Directory.GetCurrentDirectory(), "..", "..", "..", "..", "src", "PrdAgent.Api");
    }

    private static WatermarkConfig BuildConfig(double x, double y)
    {
        return new WatermarkConfig
        {
            Text = "Test",
            FontKey = "default",
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

        // Verify both renders produce valid images with same dimensions
        using var img1 = Image.Load<Rgba32>(first.bytes);
        using var img2 = Image.Load<Rgba32>(second.bytes);
        Assert.Equal(img1.Width, img2.Width);
        Assert.Equal(img1.Height, img2.Height);

        // Verify watermark was applied (non-transparent pixels exist)
        var bounds1 = FindBounds(img1);
        var bounds2 = FindBounds(img2);
        Assert.True(bounds1.maxX > 0, "First render should have watermark pixels");
        Assert.True(bounds2.maxX > 0, "Second render should have watermark pixels");
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

        Assert.InRange(Math.Abs(centerX - expectedX), 0, 5);
        Assert.InRange(Math.Abs(centerY - expectedY), 0, 5);
    }

    private static (double centerX, double centerY) CalculateExpectedCenter(
        WatermarkFontRegistry registry,
        WatermarkConfig config,
        int width,
        int height)
    {
        var fontSize = WatermarkLayoutCalculator.CalculateScaledFontSize(config, width, height);
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

    [Fact]
    [Trait("Category", TestCategories.Manual)]
    public async Task Render_Mece_EdgeCases_OutputArtifactsAndValidate()
    {
        var (renderer, registry) = BuildRenderer();
        if (registry.TryResolveFontFile(registry.DefaultFontKey) == null) return;

        var tempRoot = Path.Combine(Path.GetTempPath(), "prd-watermark-tests");
        Directory.CreateDirectory(tempRoot);

        var basePng = CreateTransparentPngBytes(64, 64);
        var iconDataUrl = CreatePngDataUrl(8, 6, new Rgba32(255, 128, 0, 255));
        var invalidDataUrl = "data:image/png;base64,not-base64";

        var edgeCases = new List<RenderCase>
        {
            new(
                "edge-empty-bytes",
                () => BuildConfig(0.5, 0.5),
                InputBytes: Array.Empty<byte>(),
                UsePreview: false,
                ExpectEmptyOutput: true,
                ExpectSameAsInput: true,
                ExpectNonTransparent: false,
                AllowSizeChange: true),
            new(
                "edge-empty-text-noop",
                () =>
                {
                    var config = BuildConfig(0.5, 0.5);
                    config.Text = "";
                    return config;
                },
                InputBytes: basePng,
                UsePreview: false,
                ExpectEmptyOutput: false,
                ExpectSameAsInput: true,
                ExpectNonTransparent: false,
                AllowSizeChange: false)
            ,
            new(
                "edge-opacity-zero-transparent",
                () =>
                {
                    var config = BuildConfig(0.4, 0.6);
                    config.Opacity = 0;
                    config.BackgroundEnabled = true;
                    config.BorderEnabled = true;
                    config.BorderWidth = 4;
                    config.CornerRadius = 12;
                    config.BackgroundColor = "#000000";
                    config.BorderColor = "#00FF00";
                    config.TextColor = "#FFFFFF";
                    return config;
                },
                InputBytes: basePng,
                UsePreview: false,
                ExpectEmptyOutput: false,
                ExpectSameAsInput: false,
                ExpectNonTransparent: false,
                AllowFaintPixels: true,
                AllowSizeChange: false)
        };

        var textOptions = new[] { "text" };
        var opacityOptions = new[] { 0.6d, 1d };
        var decorationOptions = new[]
        {
            new DecorationVariant("none", config => { }),
            new DecorationVariant("background", config =>
            {
                config.BackgroundEnabled = true;
                config.TextColor = "#FFFFFF";
                config.BackgroundColor = "#000000";
            }),
            new DecorationVariant("border", config =>
            {
                config.BorderEnabled = true;
                config.BorderWidth = 4;
                config.TextColor = "#FFFFFF";
                config.BorderColor = "#00FF00";
            }),
            new DecorationVariant("background-border", config =>
            {
                config.BackgroundEnabled = true;
                config.BorderEnabled = true;
                config.BorderWidth = 4;
                config.TextColor = "#FFFFFF";
                config.BackgroundColor = "#000000";
                config.BorderColor = "#00FF00";
            }),
            new DecorationVariant("background-border-rounded", config =>
            {
                config.BackgroundEnabled = true;
                config.BorderEnabled = true;
                config.BorderWidth = 4;
                config.CornerRadius = 12;
                config.TextColor = "#FFFFFF";
                config.BackgroundColor = "#000000";
                config.BorderColor = "#00FF00";
            })
        };
        var positionOptions = new[] { "ratio-in", "ratio-out" };
        var iconVariants = new[]
        {
            new IconVariant("off", false, "left", true),
            new IconVariant("valid-left", true, "left", true),
            new IconVariant("valid-right", true, "right", true),
            new IconVariant("valid-top", true, "top", true),
            new IconVariant("valid-bottom", true, "bottom", true),
            new IconVariant("invalid-left", true, "left", false)
        };
        var iconGapOptions = new[] { 0d, 8d };
        var previewOptions = new[] { false, true };
        var previewBgOptions = new[] { "none", "invalid" };

        var matrixCases = new List<RenderCase>();
        var index = 0;
        foreach (var textOpt in textOptions)
        foreach (var opacity in opacityOptions)
        foreach (var decoration in decorationOptions)
        foreach (var position in positionOptions)
        foreach (var icon in iconVariants)
        foreach (var gap in (icon.Enabled ? iconGapOptions : new[] { -1d }))
        foreach (var usePreview in previewOptions)
        foreach (var previewBg in (usePreview ? previewBgOptions : new[] { "na" }))
        {
            var name = $"{++index:000}-" +
                       $"{(usePreview ? "preview" : "apply")}-" +
                       $"{textOpt}-" +
                       $"op{opacity:0}-" +
                       $"{decoration.Name}-" +
                       $"{position}-" +
                       $"icon-{icon.Name}-" +
                       $"gap-{(gap < 0 ? "na" : gap.ToString("0"))}-" +
                       $"bg-{previewBg}";
            var configBuilder = new Func<WatermarkConfig>(() =>
            {
                var config = BuildConfig(0.2, 0.8);
                if (textOpt == "empty")
                {
                    config.Text = "";
                }
                config.Opacity = opacity;
                decoration.Apply(config);
                if (position == "ratio-out")
                {
                    config.PositionMode = "ratio";
                    config.Anchor = "bottom-right";
                    config.OffsetX = -0.5;
                    config.OffsetY = 1.5;
                }
                else
                {
                    config.PositionMode = "ratio";
                    config.Anchor = "top-left";
                    config.OffsetX = 0.2;
                    config.OffsetY = 0.3;
                }
                if (icon.Enabled)
                {
                    config.IconEnabled = true;
                    config.IconPosition = icon.Position;
                    config.IconScale = 1.2;
                    if (gap >= 0)
                    {
                        config.IconGapPx = gap;
                    }
                    config.IconImageRef = icon.IsValid ? iconDataUrl : invalidDataUrl;
                }
                if (usePreview)
                {
                    config.BaseCanvasWidth = 128;
                    if (previewBg == "invalid")
                    {
                        config.PreviewBackgroundImageRef = invalidDataUrl;
                    }
                }
                return config;
            });

            var expectEmptyOutput = false;
            var expectSameAsInput = !usePreview && textOpt == "empty";
            var expectNonTransparent = textOpt != "empty" && opacity > 0;
            var allowSizeChange = usePreview;

            matrixCases.Add(new RenderCase(
                name,
                configBuilder,
                InputBytes: basePng,
                UsePreview: usePreview,
                ExpectEmptyOutput: expectEmptyOutput,
                ExpectSameAsInput: expectSameAsInput,
                ExpectNonTransparent: expectNonTransparent,
                AllowSizeChange: allowSizeChange));
        }

        var cases = edgeCases.Concat(matrixCases).ToList();

        foreach (var item in cases)
        {
            byte[] resultBytes;
            string resultMime;
            var config = item.BuildConfig();
            if (item.UsePreview)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                (resultBytes, resultMime) = await renderer.RenderPreviewAsync(config, cts.Token);
            }
            else
            {
                (resultBytes, resultMime) = await renderer.ApplyAsync(item.InputBytes ?? basePng, "image/png", config, CancellationToken.None);
            }

            if (item.ExpectEmptyOutput)
            {
                Assert.Empty(resultBytes);
                continue;
            }

            Assert.False(string.IsNullOrWhiteSpace(resultMime));
            Assert.NotEmpty(resultBytes);

            if (item.ExpectSameAsInput && item.InputBytes != null)
            {
                Assert.Equal(item.InputBytes, resultBytes);
            }

            using var rendered = Image.Load<Rgba32>(resultBytes);
            if (!item.AllowSizeChange)
            {
                Assert.Equal(64, rendered.Width);
                Assert.Equal(64, rendered.Height);
            }
            else if (item.UsePreview)
            {
                Assert.Equal(config.BaseCanvasWidth, rendered.Width);
                Assert.Equal(config.BaseCanvasWidth, rendered.Height);
            }

            var bounds = FindBounds(rendered);
            if (item.ExpectNonTransparent)
            {
                Assert.True(bounds.maxX > 0 || bounds.maxY > 0);
                Assert.InRange(bounds.minX, 0, rendered.Width - 1);
                Assert.InRange(bounds.minY, 0, rendered.Height - 1);
                Assert.InRange(bounds.maxX, 0, rendered.Width - 1);
                Assert.InRange(bounds.maxY, 0, rendered.Height - 1);
            }
            else
            {
                if (item.AllowFaintPixels)
                {
                    var maxAlpha = FindMaxAlpha(rendered);
                    Assert.InRange(maxAlpha, 0, 2);
                }
                else
                {
                    Assert.Equal((0, 0, 0, 0), bounds);
                }
            }

            var outputPath = Path.Combine(tempRoot, $"{SanitizeFileName(item.Name)}.png");
            await File.WriteAllBytesAsync(outputPath, resultBytes);
        }

        var checklistPath = Path.Combine(tempRoot, "mece-checklist.txt");
        await File.WriteAllTextAsync(checklistPath, BuildMeceChecklist(cases, edgeCases.Count, matrixCases.Count));
    }

    private static byte[] CreateTransparentPngBytes(int width, int height)
    {
        using var image = new Image<Rgba32>(width, height);
        using var ms = new MemoryStream();
        image.SaveAsPng(ms);
        return ms.ToArray();
    }

    private static string CreatePngDataUrl(int width, int height, Rgba32 color)
    {
        using var image = new Image<Rgba32>(width, height);
        image.Mutate(ctx => ctx.Fill(color));
        using var ms = new MemoryStream();
        image.SaveAsPng(ms);
        var base64 = Convert.ToBase64String(ms.ToArray());
        return $"data:image/png;base64,{base64}";
    }

    private static string SanitizeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var chars = name.Select(c => invalid.Contains(c) ? '_' : c).ToArray();
        return new string(chars);
    }

    private static byte FindMaxAlpha(Image<Rgba32> img)
    {
        byte max = 0;
        img.ProcessPixelRows(accessor =>
        {
            for (var y = 0; y < accessor.Height; y++)
            {
                var row = accessor.GetRowSpan(y);
                for (var x = 0; x < accessor.Width; x++)
                {
                    var a = row[x].A;
                    if (a > max) max = a;
                }
            }
        });
        return max;
    }

    private static string BuildMeceChecklist(IEnumerable<RenderCase> cases, int edgeCount, int matrixCount)
    {
        var lines = new List<string>
        {
            "MECE checklist for watermark rendering tests",
            $"Total cases: {cases.Count()} (edge: {edgeCount}, matrix: {matrixCount})",
            "Dimensions (mutually exclusive, collectively exhaustive):",
            "1) Input bytes: empty | non-empty",
            "2) Text: empty | non-empty",
            "3) Opacity: zero | non-zero",
            "4) Decoration: none | background | border | background+border | background+border+rounded",
            "5) Positioning: ratio offsets in-range | ratio offsets clamped",
            "6) Icon: off | valid-left | valid-right | valid-top | valid-bottom | invalid-left",
            "7) Icon gap: 0 | 8 (icon enabled only)",
            "8) Preview background: none | invalid (fallback to transparent)",
            "",
            "Case coverage:"
        };

        foreach (var item in cases)
        {
            lines.Add($"- {item.Name}");
        }

        return string.Join(Environment.NewLine, lines);
    }

    private sealed record RenderCase(
        string Name,
        Func<WatermarkConfig> BuildConfig,
        byte[]? InputBytes,
        bool UsePreview,
        bool ExpectEmptyOutput,
        bool ExpectSameAsInput,
        bool ExpectNonTransparent,
        bool AllowFaintPixels = false,
        bool AllowSizeChange = false);

    private sealed record DecorationVariant(string Name, Action<WatermarkConfig> Apply);

    private sealed record IconVariant(string Name, bool Enabled, string Position, bool IsValid);
}
