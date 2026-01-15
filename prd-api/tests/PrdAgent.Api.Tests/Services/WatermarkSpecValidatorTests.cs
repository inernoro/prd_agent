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
        var spec = new WatermarkSpec
        {
            Enabled = true,
            Text = "test",
            FontKey = "dejavu-sans",
            FontSizePx = 24,
            Opacity = 0.5,
            PosXRatio = 0.5,
            PosYRatio = 0.6,
            IconEnabled = false,
            BaseCanvasWidth = 320,
            ModelKey = "default",
            Color = "#FFFFFF"
        };

        var json = JsonSerializer.Serialize(spec);
        var restored = JsonSerializer.Deserialize<WatermarkSpec>(json);

        Assert.NotNull(restored);
        Assert.Equal(spec.Text, restored!.Text);
        Assert.Equal(spec.FontKey, restored.FontKey);
        Assert.Equal(spec.FontSizePx, restored.FontSizePx);
        Assert.Equal(spec.PosXRatio, restored.PosXRatio);
        Assert.Equal(spec.PosYRatio, restored.PosYRatio);
    }

    [Fact]
    public void Validate_ShouldRejectInvalidOpacity()
    {
        var spec = new WatermarkSpec
        {
            Enabled = true,
            Text = "test",
            FontKey = "dejavu-sans",
            FontSizePx = 24,
            Opacity = 1.5,
            PosXRatio = 0.5,
            PosYRatio = 0.5,
            BaseCanvasWidth = 320
        };

        var (ok, _) = WatermarkSpecValidator.Validate(spec, new[] { "dejavu-sans" });
        Assert.False(ok);
    }

    [Fact]
    public void Validate_ShouldRejectInvalidFontKey()
    {
        var spec = new WatermarkSpec
        {
            Enabled = true,
            Text = "test",
            FontKey = "missing-font",
            FontSizePx = 24,
            Opacity = 0.7,
            PosXRatio = 0.5,
            PosYRatio = 0.5,
            BaseCanvasWidth = 320
        };

        var (ok, _) = WatermarkSpecValidator.Validate(spec, new[] { "dejavu-sans" });
        Assert.False(ok);
    }
}
