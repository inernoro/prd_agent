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

    #region 端到端详细流程测试（带完整日志输出）

    /// <summary>
    /// 端到端测试：模拟真实的多图请求流程，打印所有环节
    /// 运行命令: dotnet test --filter "EndToEnd_MultiImage_FullFlowWithLogging" --logger "console;verbosity=detailed"
    /// </summary>
    [Fact]
    public async Task EndToEnd_MultiImage_FullFlowWithLogging()
    {
        Console.WriteLine("\n" + new string('=', 80));
        Console.WriteLine("【多图参考功能端到端测试】");
        Console.WriteLine(new string('=', 80));

        // ========== 1. 模拟前端输入 ==========
        Console.WriteLine("\n【步骤1】模拟前端输入");
        Console.WriteLine(new string('-', 40));

        var userPrompt = "@img16@img17 把这两张图融合成一张";
        var imageRefs = new List<ImageRefInput>
        {
            new()
            {
                RefId = 16,
                AssetSha256 = "ae7a4a315940b54d4b07112a8188966268c386de38abe8bbbd457fa294cbf649",
                Url = "https://example.com/style-ref.jpg",
                Label = "风格参考图"
            },
            new()
            {
                RefId = 17,
                AssetSha256 = "b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef12",
                Url = "https://example.com/target.jpg",
                Label = "目标图片"
            }
        };

        Console.WriteLine($"用户输入 Prompt: \"{userPrompt}\"");
        Console.WriteLine($"前端传递的 imageRefs ({imageRefs.Count} 张):");
        foreach (var img in imageRefs)
        {
            Console.WriteLine($"  - @img{img.RefId}: {img.Label}");
            Console.WriteLine($"    SHA256: {img.AssetSha256}");
            Console.WriteLine($"    URL: {img.Url}");
        }

        // ========== 2. 解析 @imgN 引用 ==========
        Console.WriteLine("\n【步骤2】解析 @imgN 引用 (MultiImageDomainService.ParsePromptRefs)");
        Console.WriteLine(new string('-', 40));

        var parseResult = _service.ParsePromptRefs(userPrompt, imageRefs);

        Console.WriteLine($"解析结果:");
        Console.WriteLine($"  IsValid: {parseResult.IsValid}");
        Console.WriteLine($"  IsMultiImage: {parseResult.IsMultiImage}");
        Console.WriteLine($"  IsSingleImage: {parseResult.IsSingleImage}");
        Console.WriteLine($"  IsTextOnly: {parseResult.IsTextOnly}");
        Console.WriteLine($"  原始 Prompt: \"{parseResult.OriginalPrompt}\"");
        Console.WriteLine($"  提到的 RefIds (按出现顺序): [{string.Join(", ", parseResult.MentionedRefIds)}]");
        Console.WriteLine($"  解析出的图片引用 ({parseResult.ResolvedRefs.Count} 张):");
        foreach (var r in parseResult.ResolvedRefs)
        {
            Console.WriteLine($"    - @img{r.RefId}: {r.Label} (出现顺序: {r.OccurrenceOrder})");
            Console.WriteLine($"      SHA256: {r.AssetSha256}");
        }
        if (parseResult.Warnings.Count > 0)
        {
            Console.WriteLine($"  警告: {string.Join("; ", parseResult.Warnings)}");
        }
        if (parseResult.Errors.Count > 0)
        {
            Console.WriteLine($"  错误: {string.Join("; ", parseResult.Errors)}");
        }

        // ========== 3. 意图分析（规则匹配） ==========
        Console.WriteLine("\n【步骤3】意图分析 (MultiImageDomainService.TryMatchByRules)");
        Console.WriteLine(new string('-', 40));

        var intentResult = _service.TryMatchByRules(userPrompt, parseResult.ResolvedRefs);

        Console.WriteLine($"意图分析结果:");
        Console.WriteLine($"  Success: {intentResult?.Success}");
        Console.WriteLine($"  Confidence: {intentResult?.Confidence}");
        Console.WriteLine($"  ImageRefCount: {intentResult?.ImageRefCount}");
        Console.WriteLine($"  原始 Prompt: \"{intentResult?.OriginalPrompt}\"");

        // ========== 4. 构建最终 Prompt ==========
        Console.WriteLine("\n【步骤4】构建最终 Prompt (MultiImageDomainService.BuildFinalPromptAsync)");
        Console.WriteLine(new string('-', 40));

        var finalPrompt = await _service.BuildFinalPromptAsync(userPrompt, parseResult.ResolvedRefs);

        Console.WriteLine($"最终发送给生图模型的 Prompt:");
        Console.WriteLine(new string('-', 40));
        Console.WriteLine(finalPrompt);
        Console.WriteLine(new string('-', 40));

        // ========== 5. 模拟 Worker 处理 ==========
        Console.WriteLine("\n【步骤5】模拟 Worker 处理逻辑");
        Console.WriteLine(new string('-', 40));

        var firstRef = parseResult.ResolvedRefs.FirstOrDefault();
        Console.WriteLine($"选择第一张图作为 initImage:");
        Console.WriteLine($"  RefId: @img{firstRef?.RefId}");
        Console.WriteLine($"  Label: {firstRef?.Label}");
        Console.WriteLine($"  SHA256: {firstRef?.AssetSha256}");
        Console.WriteLine($"  (Worker 会从 COS 读取此 SHA256 对应的图片作为参考图)");

        // ========== 6. 模拟发送给生图 API ==========
        Console.WriteLine("\n【步骤6】模拟发送给生图 API (OpenAIImageClient.GenerateAsync)");
        Console.WriteLine(new string('-', 40));

        Console.WriteLine($"请求参数:");
        Console.WriteLine($"  prompt: \"{finalPrompt.Replace("\n", "\\n")}\"");
        Console.WriteLine($"  initImageBase64: data:image/png;base64,<{firstRef?.AssetSha256}对应的图片>");
        Console.WriteLine($"  initImageProvided: true");
        Console.WriteLine($"  size: 1024x1024");
        Console.WriteLine($"  responseFormat: url");

        // ========== 验证 ==========
        Console.WriteLine("\n【验证】");
        Console.WriteLine(new string('-', 40));

        parseResult.IsValid.ShouldBeTrue();
        parseResult.IsMultiImage.ShouldBeTrue();
        intentResult.ShouldNotBeNull();
        intentResult!.Success.ShouldBeTrue();
        finalPrompt.ShouldContain("图片对照表");
        finalPrompt.ShouldContain("@img16 对应 风格参考图");
        finalPrompt.ShouldContain("@img17 对应 目标图片");

        Console.WriteLine("✅ 所有断言通过!");

        Console.WriteLine("\n" + new string('=', 80));
        Console.WriteLine("【测试完成】");
        Console.WriteLine(new string('=', 80) + "\n");
    }

    /// <summary>
    /// 端到端测试：单图场景
    /// 运行命令: dotnet test --filter "EndToEnd_SingleImage_FullFlowWithLogging" --logger "console;verbosity=detailed"
    /// </summary>
    [Fact]
    public async Task EndToEnd_SingleImage_FullFlowWithLogging()
    {
        Console.WriteLine("\n" + new string('=', 80));
        Console.WriteLine("【单图参考功能端到端测试】");
        Console.WriteLine(new string('=', 80));

        // ========== 1. 模拟前端输入 ==========
        Console.WriteLine("\n【步骤1】模拟前端输入");
        Console.WriteLine(new string('-', 40));

        var userPrompt = "@img1 把背景换成蓝天白云";
        var imageRefs = new List<ImageRefInput>
        {
            new()
            {
                RefId = 1,
                AssetSha256 = "abc123def456789012345678901234567890123456789012345678901234abcd",
                Url = "https://example.com/product.jpg",
                Label = "产品图片"
            }
        };

        Console.WriteLine($"用户输入 Prompt: \"{userPrompt}\"");
        Console.WriteLine($"前端传递的 imageRefs ({imageRefs.Count} 张):");
        foreach (var img in imageRefs)
        {
            Console.WriteLine($"  - @img{img.RefId}: {img.Label}");
            Console.WriteLine($"    SHA256: {img.AssetSha256}");
        }

        // ========== 2. 解析 ==========
        Console.WriteLine("\n【步骤2】解析 @imgN 引用");
        Console.WriteLine(new string('-', 40));

        var parseResult = _service.ParsePromptRefs(userPrompt, imageRefs);
        Console.WriteLine($"  IsValid: {parseResult.IsValid}");
        Console.WriteLine($"  IsSingleImage: {parseResult.IsSingleImage}");
        Console.WriteLine($"  解析出 {parseResult.ResolvedRefs.Count} 张图片引用");

        // ========== 3. 构建最终 Prompt ==========
        Console.WriteLine("\n【步骤3】构建最终 Prompt");
        Console.WriteLine(new string('-', 40));

        var finalPrompt = await _service.BuildFinalPromptAsync(userPrompt, parseResult.ResolvedRefs);

        Console.WriteLine($"单图场景，保留原始 Prompt:");
        Console.WriteLine($"  \"{finalPrompt}\"");

        // ========== 验证 ==========
        Console.WriteLine("\n【验证】");
        Console.WriteLine(new string('-', 40));

        parseResult.IsValid.ShouldBeTrue();
        parseResult.IsSingleImage.ShouldBeTrue();
        finalPrompt.ShouldBe(userPrompt); // 单图场景保留原始 prompt

        Console.WriteLine("✅ 所有断言通过!");
        Console.WriteLine("\n" + new string('=', 80) + "\n");
    }

    /// <summary>
    /// 端到端测试：风格迁移场景
    /// 运行命令: dotnet test --filter "EndToEnd_StyleTransfer_FullFlowWithLogging" --logger "console;verbosity=detailed"
    /// </summary>
    [Fact]
    public async Task EndToEnd_StyleTransfer_FullFlowWithLogging()
    {
        Console.WriteLine("\n" + new string('=', 80));
        Console.WriteLine("【风格迁移场景端到端测试】");
        Console.WriteLine(new string('=', 80));

        var userPrompt = "把 @img1 的风格应用到 @img2";
        var imageRefs = new List<ImageRefInput>
        {
            new() { RefId = 1, AssetSha256 = "style_sha256_64chars_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Label = "梵高星空.jpg" },
            new() { RefId = 2, AssetSha256 = "target_sha256_64chars_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Label = "我的照片.jpg" }
        };

        Console.WriteLine($"\n用户输入: \"{userPrompt}\"");
        Console.WriteLine($"图片列表:");
        foreach (var img in imageRefs)
            Console.WriteLine($"  @img{img.RefId}: {img.Label}");

        var parseResult = _service.ParsePromptRefs(userPrompt, imageRefs);
        Console.WriteLine($"\n解析结果: 识别到 {parseResult.ResolvedRefs.Count} 张图片");
        Console.WriteLine($"  按出现顺序: @img{parseResult.ResolvedRefs[0].RefId} → @img{parseResult.ResolvedRefs[1].RefId}");

        var finalPrompt = await _service.BuildFinalPromptAsync(userPrompt, parseResult.ResolvedRefs);

        Console.WriteLine($"\n最终 Prompt:");
        Console.WriteLine(new string('-', 40));
        Console.WriteLine(finalPrompt);
        Console.WriteLine(new string('-', 40));

        parseResult.IsMultiImage.ShouldBeTrue();
        finalPrompt.ShouldContain("图片对照表");
        finalPrompt.ShouldContain("@img1 对应 梵高星空.jpg");
        finalPrompt.ShouldContain("@img2 对应 我的照片.jpg");

        Console.WriteLine("\n✅ 测试通过!\n");
    }

    #endregion
}
