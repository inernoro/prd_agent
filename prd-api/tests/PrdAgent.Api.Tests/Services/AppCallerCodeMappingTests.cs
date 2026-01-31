using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// AppCallerCode 映射测试（CI 可运行）
/// 验证：不同 appKey 映射到正确的 AppCallerCode
///
/// 背景：文学创作和视觉创作使用不同的 AppCallerCode 命名：
/// - visual-agent -> visual-agent.image.text2img::generation (默认文生图)
/// - literary-agent -> literary-agent.illustration::generation（注意是 illustration，不是 image）
///
/// 如果映射错误，会导致模型池匹配失败。
/// </summary>
public class AppCallerCodeMappingTests
{
    /// <summary>
    /// 模拟 ImageGenRunWorker/ImageGenController 中的 appCallerCode 映射逻辑
    /// </summary>
    private static string ResolveAppCallerCode(string? appKey)
    {
        if (string.IsNullOrWhiteSpace(appKey))
            return AppCallerRegistry.Admin.Lab.Generation;

        return appKey switch
        {
            "visual-agent" => AppCallerRegistry.VisualAgent.Image.Text2Img,  // 默认文生图
            "literary-agent" => AppCallerRegistry.LiteraryAgent.Illustration.Generation,
            _ => $"{appKey}.image::generation"
        };
    }

    [Fact]
    public void VisualAgent_ShouldMapTo_VisualAgentText2Img()
    {
        // Arrange
        var appKey = "visual-agent";
        var expectedCode = "visual-agent.image.text2img::generation";

        // Act
        var actualCode = ResolveAppCallerCode(appKey);

        // Assert
        Assert.Equal(expectedCode, actualCode);
        Assert.Equal(AppCallerRegistry.VisualAgent.Image.Text2Img, actualCode);
    }

    [Fact]
    public void LiteraryAgent_ShouldMapTo_LiteraryAgentIllustrationGeneration()
    {
        // Arrange
        var appKey = "literary-agent";
        var expectedCode = "literary-agent.illustration::generation"; // 注意：是 illustration，不是 image

        // Act
        var actualCode = ResolveAppCallerCode(appKey);

        // Assert
        Assert.Equal(expectedCode, actualCode);
        Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Generation, actualCode);
    }

    [Fact]
    public void LiteraryAgent_ShouldNotMapTo_ImageGeneration()
    {
        // Arrange
        var appKey = "literary-agent";
        var wrongCode = "literary-agent.image::generation"; // 这是错误的映射

        // Act
        var actualCode = ResolveAppCallerCode(appKey);

        // Assert - 确保不会映射到错误的 code
        Assert.NotEqual(wrongCode, actualCode);
    }

    [Fact]
    public void NullAppKey_ShouldFallbackToLabGeneration()
    {
        // Act
        var actualCode = ResolveAppCallerCode(null);

        // Assert
        Assert.Equal(AppCallerRegistry.Admin.Lab.Generation, actualCode);
    }

    [Fact]
    public void EmptyAppKey_ShouldFallbackToLabGeneration()
    {
        // Act
        var actualCode = ResolveAppCallerCode("");

        // Assert
        Assert.Equal(AppCallerRegistry.Admin.Lab.Generation, actualCode);
    }

    [Fact]
    public void UnknownAppKey_ShouldUseDefaultPattern()
    {
        // Arrange
        var appKey = "custom-agent";

        // Act
        var actualCode = ResolveAppCallerCode(appKey);

        // Assert - 未知 appKey 使用默认模式
        Assert.Equal("custom-agent.image::generation", actualCode);
    }

    /// <summary>
    /// 验证 AppCallerRegistry 中定义的常量值正确
    /// </summary>
    [Theory]
    [InlineData("visual-agent.image::generation")]
    [InlineData("literary-agent.illustration::generation")]
    [InlineData("prd-agent-web.lab::generation")]
    public void AppCallerRegistry_ShouldContainExpectedCodes(string expectedCode)
    {
        // 获取所有注册的 AppCaller 定义
        var definitions = AppCallerRegistrationService.GetAllDefinitions();
        
        // Assert
        Assert.Contains(definitions, d => d.AppCode == expectedCode);
    }

    /// <summary>
    /// 验证所有生图相关的 AppCallerCode 都使用 generation 模型类型
    /// </summary>
    [Fact]
    public void AllImageGenAppCallers_ShouldRequireGenerationModelType()
    {
        var definitions = AppCallerRegistrationService.GetAllDefinitions();
        
        var imageGenCallers = definitions.Where(d => 
            d.AppCode.EndsWith("::generation") || 
            d.AppCode.Contains("image::generation") ||
            d.AppCode.Contains("illustration::generation"));

        foreach (var caller in imageGenCallers)
        {
            Assert.True(
                caller.ModelTypes.Contains("generation"),
                $"AppCaller {caller.AppCode} should require 'generation' model type, but has: [{string.Join(", ", caller.ModelTypes)}]");
        }
    }

    /// <summary>
    /// 回归测试：确保文学创作的 AppCallerCode 命名正确
    /// 这个测试是为了防止将来有人错误地将 literary-agent 映射到 .image::generation
    /// </summary>
    [Fact]
    public void RegressionTest_LiteraryAgentNamingConvention()
    {
        // 文学创作使用 "illustration" 而不是 "image"
        // 因为文学创作的生图场景是"配图"，不是通用的"图片生成"
        
        var literaryAgentCode = AppCallerRegistry.LiteraryAgent.Illustration.Generation;
        
        Assert.Contains("illustration", literaryAgentCode);
        Assert.DoesNotContain(".image::", literaryAgentCode);
    }
}
