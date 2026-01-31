using Microsoft.Extensions.Logging;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models.MultiImage;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// MultiImageDomainService 单元测试
///
/// 测试策略：
/// 1. 解析 @imgN 引用
/// 2. 验证引用与实际图片的匹配
/// 3. 意图分析（规则匹配）
/// 4. 构建最终 prompt
/// </summary>
public class MultiImageDomainServiceTests
{
    private readonly IMultiImageDomainService _service;
    private readonly Mock<ILogger<MultiImageDomainService>> _loggerMock;

    public MultiImageDomainServiceTests()
    {
        _loggerMock = new Mock<ILogger<MultiImageDomainService>>();
        _service = new MultiImageDomainService(_loggerMock.Object);
    }

    #region ParsePromptRefs Tests

    [Fact]
    public void ParsePromptRefs_EmptyPrompt_ReturnsInvalid()
    {
        var result = _service.ParsePromptRefs("", null);

        result.IsValid.ShouldBeFalse();
        result.Errors.ShouldContain(e => e.Contains("不能为空"));
    }

    [Fact]
    public void ParsePromptRefs_NoRefs_ReturnsValidWithEmptyRefs()
    {
        var result = _service.ParsePromptRefs("生成一张风景图", null);

        result.IsValid.ShouldBeTrue();
        result.ResolvedRefs.ShouldBeEmpty();
        result.MentionedRefIds.ShouldBeEmpty();
        result.IsTextOnly.ShouldBeTrue();
    }

    [Fact]
    public void ParsePromptRefs_SingleRef_ParsesCorrectly()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Url = "http://example.com/1.jpg", Label = "风景图" }
        };

        var result = _service.ParsePromptRefs("修改 @img1 的背景", imageRefs);

        result.IsValid.ShouldBeTrue();
        result.MentionedRefIds.ShouldBe(new[] { 1 });
        result.ResolvedRefs.Count.ShouldBe(1);
        result.ResolvedRefs[0].RefId.ShouldBe(1);
        result.ResolvedRefs[0].Label.ShouldBe("风景图");
        result.IsSingleImage.ShouldBeTrue();
    }

    [Fact]
    public void ParsePromptRefs_MultipleRefs_ParsesInOrder()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Label = "目标图" },
            new() { RefId = 2, AssetSha256 = "sha2", Label = "风格图" }
        };

        var result = _service.ParsePromptRefs("把 @img2 的风格应用到 @img1", imageRefs);

        result.IsValid.ShouldBeTrue();
        // 按出现顺序：@img2 先出现
        result.MentionedRefIds.ShouldBe(new[] { 2, 1 });
        result.ResolvedRefs.Count.ShouldBe(2);
        result.ResolvedRefs[0].RefId.ShouldBe(2); // @img2 先出现
        result.ResolvedRefs[1].RefId.ShouldBe(1); // @img1 后出现
        result.IsMultiImage.ShouldBeTrue();
    }

    [Fact]
    public void ParsePromptRefs_DuplicateRefs_DeduplicatesInResolvedRefs()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Label = "图片1" }
        };

        var result = _service.ParsePromptRefs("对比 @img1 修改前后，再看看 @img1", imageRefs);

        result.IsValid.ShouldBeTrue();
        // MentionedRefIds 保留所有出现
        result.MentionedRefIds.ShouldBe(new[] { 1, 1 });
        // ResolvedRefs 去重
        result.ResolvedRefs.Count.ShouldBe(1);
    }

    [Fact]
    public void ParsePromptRefs_RefNotFound_AddsWarning()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Label = "图片1" }
        };

        var result = _service.ParsePromptRefs("修改 @img99 的背景", imageRefs);

        result.IsValid.ShouldBeTrue(); // 警告不是错误
        result.Warnings.ShouldContain(w => w.Contains("@img99"));
        result.ResolvedRefs.ShouldBeEmpty();
    }

    [Fact]
    public void ParsePromptRefs_MixedExistingAndMissing_PartialResolve()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Label = "存在的图片" }
        };

        var result = _service.ParsePromptRefs("融合 @img1 和 @img99", imageRefs);

        result.IsValid.ShouldBeTrue();
        result.ResolvedRefs.Count.ShouldBe(1);
        result.ResolvedRefs[0].RefId.ShouldBe(1);
        result.Warnings.ShouldContain(w => w.Contains("@img99"));
    }

    [Fact]
    public void ParsePromptRefs_CaseInsensitive_ParsesCorrectly()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Label = "图片1" }
        };

        var result = _service.ParsePromptRefs("修改 @IMG1 的背景", imageRefs);

        result.IsValid.ShouldBeTrue();
        result.ResolvedRefs.Count.ShouldBe(1);
    }

    [Fact]
    public void ParsePromptRefs_ComplexPrompt_ParsesAllRefs()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Label = "主图" },
            new() { RefId = 2, AssetSha256 = "sha2", Label = "背景" },
            new() { RefId = 3, AssetSha256 = "sha3", Label = "装饰" }
        };

        var prompt = "把 @img1 放在 @img2 的中间，然后在四周添加 @img3 的元素";
        var result = _service.ParsePromptRefs(prompt, imageRefs);

        result.IsValid.ShouldBeTrue();
        result.MentionedRefIds.ShouldBe(new[] { 1, 2, 3 });
        result.ResolvedRefs.Count.ShouldBe(3);
    }

    #endregion

    #region TryMatchByRules Tests

    [Fact]
    public void TryMatchByRules_TextOnly_ReturnsOriginalPrompt()
    {
        var refs = new List<ResolvedImageRef>();
        var prompt = "生成一张美丽的风景图";

        var result = _service.TryMatchByRules(prompt, refs);

        result.ShouldNotBeNull();
        result.Success.ShouldBeTrue();
        result.EnhancedPrompt.ShouldBe(prompt);
        result.Confidence.ShouldBe(1.0);
    }

    [Fact]
    public void TryMatchByRules_SingleImage_ReplacesRefWithDescription()
    {
        var refs = new List<ResolvedImageRef>
        {
            new() { RefId = 1, Label = "产品图", OccurrenceOrder = 0 }
        };
        var prompt = "修改 @img1 的背景为蓝色";

        var result = _service.TryMatchByRules(prompt, refs);

        result.ShouldNotBeNull();
        result.Success.ShouldBeTrue();
        result.EnhancedPrompt.ShouldContain("产品图");
        result.EnhancedPrompt.ShouldNotContain("@img1");
    }

    [Fact]
    public void TryMatchByRules_MultiImage_BuildsReferenceTable()
    {
        var refs = new List<ResolvedImageRef>
        {
            new() { RefId = 1, Label = "目标图", OccurrenceOrder = 1 },
            new() { RefId = 2, Label = "风格图", OccurrenceOrder = 0 }
        };
        var prompt = "把 @img2 的风格应用到 @img1";

        var result = _service.TryMatchByRules(prompt, refs);

        result.ShouldNotBeNull();
        result.Success.ShouldBeTrue();
        result.EnhancedPrompt.ShouldContain("图片对照表");
        result.EnhancedPrompt.ShouldContain("@img1 对应 目标图");
        result.EnhancedPrompt.ShouldContain("@img2 对应 风格图");
        result.Confidence.ShouldBe(0.8);
    }

    #endregion

    #region BuildFinalPromptAsync Tests

    [Fact]
    public async Task BuildFinalPromptAsync_TextOnly_ReturnsOriginal()
    {
        var refs = new List<ResolvedImageRef>();
        var prompt = "生成一张风景图";

        var result = await _service.BuildFinalPromptAsync(prompt, refs);

        result.ShouldBe(prompt);
    }

    [Fact]
    public async Task BuildFinalPromptAsync_SingleImage_ReturnsOriginal()
    {
        var refs = new List<ResolvedImageRef>
        {
            new() { RefId = 1, Label = "产品图" }
        };
        var prompt = "修改 @img1 的背景";

        var result = await _service.BuildFinalPromptAsync(prompt, refs);

        // 单图场景保留原始 prompt
        result.ShouldBe(prompt);
    }

    [Fact]
    public async Task BuildFinalPromptAsync_MultiImage_ReturnsEnhancedPrompt()
    {
        var refs = new List<ResolvedImageRef>
        {
            new() { RefId = 1, Label = "目标图", OccurrenceOrder = 0 },
            new() { RefId = 2, Label = "风格图", OccurrenceOrder = 1 }
        };
        var prompt = "把 @img1 和 @img2 融合";

        var result = await _service.BuildFinalPromptAsync(prompt, refs);

        result.ShouldContain("图片对照表");
        result.ShouldContain(prompt); // 保留原始 prompt
    }

    #endregion

    #region Integration Tests

    [Fact]
    public void FullFlow_SingleImage_WorksCorrectly()
    {
        // 模拟前端传入
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 16, AssetSha256 = "abc123", Url = "http://example.com/16.jpg", Label = "产品图片" }
        };
        var prompt = "@img16 换个背景";

        // 解析
        var parseResult = _service.ParsePromptRefs(prompt, imageRefs);
        parseResult.IsValid.ShouldBeTrue();
        parseResult.IsSingleImage.ShouldBeTrue();
        parseResult.ResolvedRefs[0].RefId.ShouldBe(16);

        // 意图分析
        var intentResult = _service.TryMatchByRules(prompt, parseResult.ResolvedRefs);
        intentResult.ShouldNotBeNull();
        intentResult.Success.ShouldBeTrue();
    }

    [Fact]
    public void FullFlow_MultiImage_WorksCorrectly()
    {
        // 模拟前端传入（用户输入 @img16@img17）
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 16, AssetSha256 = "sha16", Url = "http://example.com/16.jpg", Label = "风格参考" },
            new() { RefId = 17, AssetSha256 = "sha17", Url = "http://example.com/17.jpg", Label = "目标图片" }
        };
        var prompt = "@img16@img17";

        // 解析
        var parseResult = _service.ParsePromptRefs(prompt, imageRefs);
        parseResult.IsValid.ShouldBeTrue();
        parseResult.IsMultiImage.ShouldBeTrue();
        parseResult.MentionedRefIds.ShouldBe(new[] { 16, 17 });

        // 意图分析
        var intentResult = _service.TryMatchByRules(prompt, parseResult.ResolvedRefs);
        intentResult.ShouldNotBeNull();
        intentResult.Success.ShouldBeTrue();
        intentResult.EnhancedPrompt.ShouldContain("图片对照表");
        intentResult.EnhancedPrompt.ShouldContain("@img16 对应 风格参考");
        intentResult.EnhancedPrompt.ShouldContain("@img17 对应 目标图片");
    }

    [Fact]
    public void FullFlow_StyleTransfer_WorksCorrectly()
    {
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "sha1", Label = "风景背景.jpg" },
            new() { RefId = 2, AssetSha256 = "sha2", Label = "产品图.jpg" }
        };
        var prompt = "把 @img1 的风格应用到 @img2";

        var parseResult = _service.ParsePromptRefs(prompt, imageRefs);
        parseResult.IsValid.ShouldBeTrue();

        var intentResult = _service.TryMatchByRules(prompt, parseResult.ResolvedRefs);
        intentResult.ShouldNotBeNull();
        intentResult.EnhancedPrompt.ShouldContain("把 @img1 的风格应用到 @img2");
        intentResult.EnhancedPrompt.ShouldContain("@img1 对应 风景背景.jpg");
        intentResult.EnhancedPrompt.ShouldContain("@img2 对应 产品图.jpg");
    }

    #endregion
}
