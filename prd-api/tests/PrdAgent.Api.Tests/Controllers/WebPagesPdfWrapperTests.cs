using System.Reflection;
using PrdAgent.Api.Controllers.Api;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class WebPagesPdfWrapperTests
{
    [Fact]
    public void PdfWrapper_UsesHighDprCanvas_OnMobileDisplays()
    {
        var html = BuildPdfWrapper("demo report.pdf", "Demo Report");

        Assert.Contains("Math.min(Math.max(window.devicePixelRatio || 1, 1), 3)", html);
        Assert.Contains("maxBitmapPixels", html);
        Assert.Contains("Math.sqrt(maxBitmapPixels / estimatedPixels)", html);
        Assert.DoesNotContain("Math.min(window.devicePixelRatio || 1, 2)", html);
    }

    [Fact]
    public void PdfWrapper_FillsOpaqueCanvasBackground_BeforeRendering()
    {
        var html = BuildPdfWrapper("demo.pdf", "Demo");

        Assert.Contains("getContext(\"2d\", { alpha: false })", html);
        Assert.Contains("ctx.fillStyle = \"#fff\"", html);
        Assert.Contains("ctx.fillRect(0, 0, canvas.width, canvas.height)", html);
    }

    private static string BuildPdfWrapper(string assetName, string title)
    {
        var method = typeof(WebPagesController).GetMethod(
            "BuildPdfWrapper",
            BindingFlags.NonPublic | BindingFlags.Static);

        Assert.NotNull(method);
        return Assert.IsType<string>(method!.Invoke(null, new object[] { assetName, title }));
    }
}
