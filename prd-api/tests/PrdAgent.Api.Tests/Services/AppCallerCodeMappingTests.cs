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
            "literary-agent" => AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,  // 默认文生图（无参考图）
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
    public void LiteraryAgent_ShouldMapTo_LiteraryAgentIllustrationText2Img()
    {
        // Arrange
        var appKey = "literary-agent";
        var expectedCode = "literary-agent.illustration.text2img::generation"; // 默认文生图

        // Act
        var actualCode = ResolveAppCallerCode(appKey);

        // Assert
        Assert.Equal(expectedCode, actualCode);
        Assert.Equal(AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, actualCode);
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
    [InlineData("visual-agent.image.text2img::generation")]
    [InlineData("visual-agent.image.img2img::generation")]
    [InlineData("visual-agent.image.vision::generation")]
    [InlineData("literary-agent.illustration.text2img::generation")]
    [InlineData("literary-agent.illustration.img2img::generation")]
    [InlineData("prd-agent-web.lab::generation")]
    [InlineData("prd-agent-web.model-lab.run::chat")]
    [InlineData("prd-agent-web.platforms.reclassify::intent")]
    [InlineData("prd-agent-web.prompts.optimize::chat")]
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

        var literaryAgentText2Img = AppCallerRegistry.LiteraryAgent.Illustration.Text2Img;
        var literaryAgentImg2Img = AppCallerRegistry.LiteraryAgent.Illustration.Img2Img;

        Assert.Contains("illustration", literaryAgentText2Img);
        Assert.Contains("illustration", literaryAgentImg2Img);
        Assert.DoesNotContain(".image::", literaryAgentText2Img);
        Assert.DoesNotContain(".image::", literaryAgentImg2Img);
    }

    /// <summary>
    /// 审计测试：确保所有注册的 AppCallerCode 都遵循标准格式
    /// 格式：{app}.{feature}[.{subfeature}]...::modelType
    /// </summary>
    [Fact]
    public void AllRegisteredAppCallerCodes_ShouldFollowStandardFormat()
    {
        var definitions = AppCallerRegistrationService.GetAllDefinitions();
        var validModelTypes = new[] { "chat", "intent", "vision", "generation", "embedding", "rerank", "code", "long-context" };

        foreach (var def in definitions)
        {
            // 1. 必须包含 ::
            Assert.True(
                def.AppCode.Contains("::"),
                $"AppCallerCode '{def.AppCode}' 缺少 '::modelType' 后缀");

            // 2. :: 后面必须是有效的 modelType
            var parts = def.AppCode.Split("::");
            Assert.Equal(2, parts.Length);

            var modelType = parts[1];
            Assert.True(
                validModelTypes.Contains(modelType),
                $"AppCallerCode '{def.AppCode}' 的 modelType '{modelType}' 不在有效列表中: [{string.Join(", ", validModelTypes)}]");

            // 3. :: 前面必须是 app.feature 格式（至少包含一个点）
            var pathPart = parts[0];
            Assert.True(
                pathPart.Contains('.'),
                $"AppCallerCode '{def.AppCode}' 的路径部分 '{pathPart}' 应该是 'app.feature' 格式");

            // 4. 不能以 :: 开头或以 . 开头
            Assert.False(
                def.AppCode.StartsWith("::") || def.AppCode.StartsWith("."),
                $"AppCallerCode '{def.AppCode}' 格式不正确");
        }
    }

    /// <summary>
    /// 审计测试：确保每个 AppCallerCode 都有 DisplayName
    /// </summary>
    [Fact]
    public void AllRegisteredAppCallerCodes_ShouldHaveDisplayName()
    {
        var definitions = AppCallerRegistrationService.GetAllDefinitions();

        foreach (var def in definitions)
        {
            Assert.False(
                string.IsNullOrWhiteSpace(def.DisplayName),
                $"AppCallerCode '{def.AppCode}' 缺少 DisplayName");
        }
    }

    /// <summary>
    /// 审计测试：确保每个 AppCallerCode 的 ModelTypes 与 :: 后缀一致
    /// </summary>
    [Fact]
    public void AllRegisteredAppCallerCodes_ModelTypesShouldMatchSuffix()
    {
        var definitions = AppCallerRegistrationService.GetAllDefinitions();

        foreach (var def in definitions)
        {
            var parts = def.AppCode.Split("::");
            if (parts.Length != 2) continue;

            var suffixModelType = parts[1];

            Assert.True(
                def.ModelTypes.Contains(suffixModelType),
                $"AppCallerCode '{def.AppCode}' 的 ModelTypes [{string.Join(", ", def.ModelTypes)}] 应该包含后缀 '{suffixModelType}'");
        }
    }
}
