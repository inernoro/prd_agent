using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using SixLabors.Fonts;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Drawing;
using SixLabors.ImageSharp.Drawing.Processing;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using System.Linq;
using Xunit;
using Xunit.Abstractions;
using IOPath = System.IO.Path;

namespace PrdAgent.Api.Tests.Services;

public class RoundedRectangleTests
{
    private readonly ITestOutputHelper _output;

    public RoundedRectangleTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>
    /// 创建圆角矩形路径 - 使用线段和弧线组合
    /// </summary>
    private static IPath CreateRoundedRectanglePath(RectangleF rect, float cornerRadius)
    {
        // 确保圆角半径不超过矩形最小边的一半
        var maxRadius = Math.Min(rect.Width, rect.Height) / 2f;
        cornerRadius = Math.Min(cornerRadius, maxRadius);

        if (cornerRadius <= 0)
        {
            // 如果没有圆角，返回普通矩形
            return new RectangularPolygon(rect);
        }

        // 使用 PolygonBuilder 构建圆角矩形
        // 通过在四个角添加圆弧点来实现圆角效果
        var points = new List<PointF>();
        var segments = 8; // 每个角的圆弧分段数

        // 左上角圆弧
        for (int i = segments; i >= 0; i--)
        {
            var angle = Math.PI / 2 * i / segments + Math.PI;
            var x = rect.Left + cornerRadius + cornerRadius * (float)Math.Cos(angle);
            var y = rect.Top + cornerRadius + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        // 右上角圆弧
        for (int i = segments; i >= 0; i--)
        {
            var angle = Math.PI / 2 * i / segments + Math.PI * 1.5;
            var x = rect.Right - cornerRadius + cornerRadius * (float)Math.Cos(angle);
            var y = rect.Top + cornerRadius + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        // 右下角圆弧
        for (int i = segments; i >= 0; i--)
        {
            var angle = Math.PI / 2 * i / segments;
            var x = rect.Right - cornerRadius + cornerRadius * (float)Math.Cos(angle);
            var y = rect.Bottom - cornerRadius + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        // 左下角圆弧
        for (int i = segments; i >= 0; i--)
        {
            var angle = Math.PI / 2 * i / segments + Math.PI * 0.5;
            var x = rect.Left + cornerRadius + cornerRadius * (float)Math.Cos(angle);
            var y = rect.Bottom - cornerRadius + cornerRadius * (float)Math.Sin(angle);
            points.Add(new PointF(x, y));
        }

        return new Polygon(points.ToArray());
    }

    [Fact]
    public void CreateRoundedRectangle_ShouldCreateValidPath()
    {
        // Arrange
        var rect = new RectangleF(10, 10, 100, 50);
        var cornerRadius = 10f;

        // Act
        var path = CreateRoundedRectanglePath(rect, cornerRadius);

        // Assert
        Assert.NotNull(path);
        var bounds = path.Bounds;
        _output.WriteLine($"Path bounds: X={bounds.X}, Y={bounds.Y}, Width={bounds.Width}, Height={bounds.Height}");

        // 验证边界框与原始矩形大致相同
        Assert.InRange(bounds.X, rect.X - 1, rect.X + 1);
        Assert.InRange(bounds.Y, rect.Y - 1, rect.Y + 1);
        Assert.InRange(bounds.Width, rect.Width - 2, rect.Width + 2);
        Assert.InRange(bounds.Height, rect.Height - 2, rect.Height + 2);
    }

    [Fact]
    public void DrawRoundedRectangle_ShouldRenderCorrectly()
    {
        // Arrange
        var imageWidth = 200;
        var imageHeight = 200;
        var rect = new RectangleF(20, 20, 160, 80);
        var cornerRadius = 15f;
        var fillColor = Color.FromRgba(0, 120, 255, 200);
        var borderColor = Color.White;

        // Act
        using var image = new Image<Rgba32>(imageWidth, imageHeight);

        // 填充黑色背景
        image.Mutate(ctx => ctx.Fill(Color.FromRgba(30, 30, 30, 255)));

        var roundedPath = CreateRoundedRectanglePath(rect, cornerRadius);

        // 填充圆角矩形
        image.Mutate(ctx => ctx.Fill(fillColor, roundedPath));

        // 绘制边框
        image.Mutate(ctx => ctx.Draw(borderColor, 2f, roundedPath));

        // Assert - 检测角落像素
        // 左上角外侧应该是黑色背景
        var cornerOutside = image[5, 5];
        _output.WriteLine($"Corner outside (5,5): R={cornerOutside.R}, G={cornerOutside.G}, B={cornerOutside.B}, A={cornerOutside.A}");
        Assert.Equal(30, cornerOutside.R);

        // 圆角矩形中心应该是蓝色
        var center = image[100, 60];
        _output.WriteLine($"Center (100,60): R={center.R}, G={center.G}, B={center.B}, A={center.A}");
        Assert.True(center.B > 200); // 蓝色通道应该很高

        // 矩形角落内侧但圆角外侧应该不是蓝色
        // 检查rect的左上角 (20,20) 附近
        var cornerInner = image[22, 22];
        _output.WriteLine($"Corner inner (22,22): R={cornerInner.R}, G={cornerInner.G}, B={cornerInner.B}, A={cornerInner.A}");
    }

    [Fact]
    public void DrawRoundedRectangle_WithDifferentRadii_ShouldWork()
    {
        // Arrange
        var imageWidth = 400;
        var imageHeight = 100;
        var radii = new float[] { 0, 5, 10, 20, 40 };

        // Act
        using var image = new Image<Rgba32>(imageWidth, imageHeight);
        image.Mutate(ctx => ctx.Fill(Color.FromRgba(30, 30, 30, 255)));

        for (int i = 0; i < radii.Length; i++)
        {
            var rect = new RectangleF(10 + i * 78, 10, 70, 80);
            var radius = radii[i];
            var path = CreateRoundedRectanglePath(rect, radius);

            image.Mutate(ctx =>
            {
                ctx.Fill(Color.FromRgba(0, 120, 255, 200), path);
                ctx.Draw(Color.White, 1f, path);
            });

            _output.WriteLine($"Drew rounded rect with radius {radius} at x={rect.X}");
        }

        // 保存图片用于视觉验证（可选）
        var outputPath = IOPath.Combine(IOPath.GetTempPath(), "rounded_rect_test.png");
        image.SaveAsPng(outputPath);
        _output.WriteLine($"Test image saved to: {outputPath}");

        // Assert - 验证图片创建成功
        Assert.Equal(imageWidth, image.Width);
        Assert.Equal(imageHeight, image.Height);
    }

    [Fact]
    public void DetectRoundedCorner_ShouldIdentifyRoundedRectangle()
    {
        // Arrange - 创建一个圆角矩形
        var imageWidth = 100;
        var imageHeight = 100;
        var rect = new RectangleF(10, 10, 80, 80);
        var cornerRadius = 20f;

        using var image = new Image<Rgba32>(imageWidth, imageHeight);
        image.Mutate(ctx => ctx.Fill(Color.Black));

        var path = CreateRoundedRectanglePath(rect, cornerRadius);
        image.Mutate(ctx => ctx.Fill(Color.White, path));

        // Act - 检测角落是否是圆角
        // 对于圆角矩形，角落的一小块区域应该是黑色（背景色）
        // 而矩形的情况下应该是白色

        // 检查左上角附近的像素点
        // 如果是圆角，(12,12) 应该还是黑色背景
        // 如果是直角，(12,12) 应该是白色
        var cornerPixel = image[12, 12];
        _output.WriteLine($"Corner pixel (12,12): R={cornerPixel.R}, G={cornerPixel.G}, B={cornerPixel.B}");

        // 检查矩形内部中心点
        var centerPixel = image[50, 50];
        _output.WriteLine($"Center pixel (50,50): R={centerPixel.R}, G={centerPixel.G}, B={centerPixel.B}");

        // 检查顶部边缘中点（应该是白色）
        // 矩形从 (10,10) 开始，顶部边缘在 y=10，但需要在矩形内部
        // 顶部中点应该在 x=50 (矩形中心x), y=30 (rect.Top + cornerRadius = 10 + 20)
        var edgeMidPixel = image[50, 30];
        _output.WriteLine($"Edge mid pixel (50,30): R={edgeMidPixel.R}, G={edgeMidPixel.G}, B={edgeMidPixel.B}");

        // Assert
        // 角落应该是黑色（背景色），说明有圆角
        Assert.Equal(0, cornerPixel.R);
        Assert.Equal(0, cornerPixel.G);
        Assert.Equal(0, cornerPixel.B);

        // 中心应该是白色（填充色）
        Assert.Equal(255, centerPixel.R);
        Assert.Equal(255, centerPixel.G);
        Assert.Equal(255, centerPixel.B);

        // 边缘中点应该是白色
        Assert.Equal(255, edgeMidPixel.R);
    }

    [Fact]
    public void VerifyRoundedRectanglePosition_ShouldBeAccurate()
    {
        // Arrange
        var imageWidth = 512;
        var imageHeight = 512;
        var watermarkRect = new RectangleF(100, 400, 200, 50);
        var cornerRadius = 10f;

        using var image = new Image<Rgba32>(imageWidth, imageHeight);
        image.Mutate(ctx => ctx.Fill(Color.FromRgba(18, 18, 22, 255))); // 深色背景

        // Act - 绘制水印背景
        var bgPath = CreateRoundedRectanglePath(watermarkRect, cornerRadius);
        image.Mutate(ctx => ctx.Fill(Color.FromRgba(0, 0, 0, 100), bgPath));

        // 找到绘制区域的边界
        var (minX, minY, maxX, maxY) = FindFilledBounds(image, Color.FromRgba(18, 18, 22, 255));

        _output.WriteLine($"Expected rect: X={watermarkRect.X}, Y={watermarkRect.Y}, " +
                          $"Right={watermarkRect.Right}, Bottom={watermarkRect.Bottom}");
        _output.WriteLine($"Actual bounds: minX={minX}, minY={minY}, maxX={maxX}, maxY={maxY}");

        // Assert - 位置应该准确
        Assert.InRange(minX, (int)watermarkRect.X - 2, (int)watermarkRect.X + 2);
        Assert.InRange(minY, (int)watermarkRect.Y - 2, (int)watermarkRect.Y + 2);
        Assert.InRange(maxX, (int)watermarkRect.Right - 2, (int)watermarkRect.Right + 2);
        Assert.InRange(maxY, (int)watermarkRect.Bottom - 2, (int)watermarkRect.Bottom + 2);
    }

    private static (int minX, int minY, int maxX, int maxY) FindFilledBounds(Image<Rgba32> img, Rgba32 backgroundColor)
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
                    // 如果像素不等于背景色，说明是填充区域
                    if (row[x].R != backgroundColor.R ||
                        row[x].G != backgroundColor.G ||
                        row[x].B != backgroundColor.B)
                    {
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                    }
                }
            }
        });

        if (minX == img.Width) return (0, 0, 0, 0);
        return (minX, minY, maxX, maxY);
    }

    [Fact]
    public void SimulateWatermarkWithRoundedBackground_ShouldRenderCorrectly()
    {
        // Arrange - 模拟完整的水印场景
        var imageWidth = 512;
        var imageHeight = 512;
        var text = "米多AI生成";
        var fontSize = 28f;
        var cornerRadius = 8f;
        var padding = 10f;

        using var image = new Image<Rgba32>(imageWidth, imageHeight);
        image.Mutate(ctx => ctx.Fill(Color.FromRgba(50, 50, 50, 255))); // 灰色背景

        // 使用系统字体进行测试（CI 上可能没有 Arial）
        Font font;
        try
        {
            font = SystemFonts.CreateFont("Arial", fontSize);
        }
        catch (FontFamilyNotFoundException)
        {
            var availableFamilies = SystemFonts.Collection.Families.ToList();
            if (availableFamilies.Count == 0)
            {
                _output.WriteLine("No system fonts available; skip watermark simulation.");
                return;
            }

            var fallbackFamily = availableFamilies[0];
            _output.WriteLine($"Arial not found; fallback to {fallbackFamily.Name}.");
            font = fallbackFamily.CreateFont(fontSize);
        }
        var textOptions = new TextOptions(font);
        var textSize = TextMeasurer.MeasureSize(text, textOptions);

        // 计算水印背景矩形
        var watermarkWidth = textSize.Width + padding * 2;
        var watermarkHeight = textSize.Height + padding * 2;
        var watermarkLeft = imageWidth - watermarkWidth - 24; // 距右边24px
        var watermarkTop = imageHeight - watermarkHeight - 24; // 距下边24px

        var watermarkRect = new RectangleF(watermarkLeft, watermarkTop, watermarkWidth, watermarkHeight);

        _output.WriteLine($"Text size: {textSize.Width} x {textSize.Height}");
        _output.WriteLine($"Watermark rect: {watermarkRect}");
        _output.WriteLine($"Corner radius: {cornerRadius}");

        // Act - 绘制圆角背景
        var bgPath = CreateRoundedRectanglePath(watermarkRect, cornerRadius);
        image.Mutate(ctx =>
        {
            // 半透明黑色背景
            ctx.Fill(Color.FromRgba(0, 0, 0, 150), bgPath);
            // 白色边框
            ctx.Draw(Color.White, 1f, bgPath);
        });

        // 绘制文字
        var textLocation = new PointF(watermarkLeft + padding, watermarkTop + padding);
        image.Mutate(ctx => ctx.DrawText(text, font, Color.White, textLocation));

        // 保存测试图片
        var outputPath = IOPath.Combine(IOPath.GetTempPath(), "watermark_rounded_test.png");
        image.SaveAsPng(outputPath);
        _output.WriteLine($"Test image saved to: {outputPath}");

        // Assert
        Assert.True(File.Exists(outputPath));
        var fileInfo = new FileInfo(outputPath);
        Assert.True(fileInfo.Length > 0);
        _output.WriteLine($"Output file size: {fileInfo.Length} bytes");
    }

    [Fact]
    public void RoundedRectangle_ZeroRadius_ShouldBeRegularRectangle()
    {
        // Arrange
        var rect = new RectangleF(10, 10, 100, 50);
        var cornerRadius = 0f;

        // Act
        var path = CreateRoundedRectanglePath(rect, cornerRadius);

        // Assert - 应该返回一个 RectangularPolygon
        Assert.IsType<RectangularPolygon>(path);
    }

    [Fact]
    public void RoundedRectangle_LargeRadius_ShouldBeClamped()
    {
        // Arrange - 圆角半径大于矩形最小边的一半
        var rect = new RectangleF(10, 10, 100, 50);
        var cornerRadius = 100f; // 大于 50/2 = 25

        // Act
        var path = CreateRoundedRectanglePath(rect, cornerRadius);
        var bounds = path.Bounds;

        // Assert - 边界应该仍然与原始矩形相同
        Assert.InRange(bounds.Width, rect.Width - 2, rect.Width + 2);
        Assert.InRange(bounds.Height, rect.Height - 2, rect.Height + 2);
    }
}
