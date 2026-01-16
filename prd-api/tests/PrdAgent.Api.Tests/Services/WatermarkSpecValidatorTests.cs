using System.Text.Json;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class WatermarkSpecValidatorTests
{
    [Fact]
    public void Serialize_ShouldRoundTrip()
    {
        var config = new WatermarkConfig
        {
            Text = "test",
            FontKey = "dejavu-sans",
            FontSizePx = 24,
            Opacity = 0.5,
            PositionMode = "ratio",
            OffsetX = 0.5,
            OffsetY = 0.6,
            IconEnabled = false,
            BaseCanvasWidth = 320,
            TextColor = "#FFFFFF"
        };

        var json = JsonSerializer.Serialize(config);
        var restored = JsonSerializer.Deserialize<WatermarkConfig>(json);

        Assert.NotNull(restored);
        Assert.Equal(config.Text, restored!.Text);
        Assert.Equal(config.FontKey, restored.FontKey);
        Assert.Equal(config.FontSizePx, restored.FontSizePx);
        Assert.Equal(config.OffsetX, restored.OffsetX);
        Assert.Equal(config.OffsetY, restored.OffsetY);
    }

    [Fact]
    public void Validate_ShouldRejectInvalidOpacity()
    {
        var config = new WatermarkConfig
        {
            Text = "test",
            FontKey = "dejavu-sans",
            FontSizePx = 24,
            Opacity = 1.5,
            PositionMode = "ratio",
            OffsetX = 0.5,
            OffsetY = 0.5,
            BaseCanvasWidth = 320
        };

        var (ok, _) = WatermarkSpecValidator.Validate(config, new[] { "dejavu-sans" });
        Assert.False(ok);
    }

    [Fact]
    public void Validate_ShouldRejectInvalidFontKey()
    {
        var config = new WatermarkConfig
        {
            Text = "test",
            FontKey = "missing-font",
            FontSizePx = 24,
            Opacity = 0.7,
            PositionMode = "ratio",
            OffsetX = 0.5,
            OffsetY = 0.5,
            BaseCanvasWidth = 320
        };

        var (ok, _) = WatermarkSpecValidator.Validate(config, new[] { "dejavu-sans" });
        Assert.False(ok);
    }
}
