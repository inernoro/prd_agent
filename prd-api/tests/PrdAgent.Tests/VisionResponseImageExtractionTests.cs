using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 多图生图通用 Vision 分支响应解析测试（VisionChatCompletionImageExtractor）。
/// 背景：gemini 系模型经 OpenAI 兼容聚合网关（PlatformType=openai）返回图片时，
/// 图片可能在 choices[0].message.images[]（OpenRouter / LiteLLM 风格）或
/// message.content 多模态数组里，旧实现只把 content 当纯字符串解析，
/// 导致「Vision API 响应格式不支持」。本套测试覆盖全部响应形态（纯解析、无 HTTP/DB）。
/// </summary>
public class VisionResponseImageExtractionTests
{
    private const string DataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    private const string HttpsUrl = "https://cdn.example.com/gen/abc123.png";

    /// <summary>fixture 模板占位替换（避免插值原始字符串对 JSON 花括号的转义陷阱）</summary>
    private static string J(string template) =>
        template.Replace("__DATA__", DataUri).Replace("__URL__", HttpsUrl);

    // ---------- 优先级 1：message.images[]（OpenRouter / LiteLLM 风格） ----------

    [Fact]
    public void ImagesArray_DataUri_Extracted()
    {
        var json = J("""
        {"choices":[{"message":{"role":"assistant","content":"这是为你生成的图片",
          "images":[{"type":"image_url","image_url":{"url":"__DATA__"}}]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(DataUri, images[0]);
    }

    [Fact]
    public void ImagesArray_HttpsUrl_Extracted()
    {
        var json = J("""
        {"choices":[{"message":{"role":"assistant","content":null,
          "images":[{"image_url":{"url":"__URL__"}}]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(HttpsUrl, images[0]);
    }

    [Fact]
    public void ImagesArray_PlainStringEntries_Tolerated()
    {
        var json = J("""
        {"choices":[{"message":{"role":"assistant","images":["__DATA__","__URL__"]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Equal(2, images.Count);
        Assert.Equal(DataUri, images[0]);
        Assert.Equal(HttpsUrl, images[1]);
    }

    [Fact]
    public void ImagesArray_ImageUrlAsPlainString_Tolerated()
    {
        var json = J("""
        {"choices":[{"message":{"images":[{"type":"image_url","image_url":"__URL__"}]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(HttpsUrl, images[0]);
    }

    [Fact]
    public void ImagesArray_TakesPriorityOverStringContent()
    {
        var json = J("""
        {"choices":[{"message":{"content":"__URL__",
          "images":[{"image_url":{"url":"__DATA__"}}]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(DataUri, images[0]);
    }

    // ---------- 优先级 2：content 纯字符串（回归：与旧行为一致） ----------

    [Fact]
    public void StringContent_DataUrl_Extracted_Regression()
    {
        var json = J("""
        {"choices":[{"message":{"role":"assistant","content":"__DATA__"}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(DataUri, images[0]);
    }

    [Fact]
    public void StringContent_HttpUrl_Extracted_Regression()
    {
        var json = J("""
        {"choices":[{"message":{"content":"__URL__"}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(HttpsUrl, images[0]);
    }

    [Fact]
    public void StringContent_MarkdownImage_Extracted_Regression()
    {
        var json = J("""
        {"choices":[{"message":{"content":"给你生成好了 ![result](__URL__) 请查收"}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(HttpsUrl, images[0]);
    }

    [Fact]
    public void StringContent_MarkdownDataUrl_Extracted_Regression()
    {
        var json = J("""
        {"choices":[{"message":{"content":"![img](__DATA__)"}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(DataUri, images[0]);
    }

    [Fact]
    public void StringContent_EmbeddedJsonUrl_Extracted_Regression()
    {
        var json = J("""
        {"choices":[{"message":{"content":"{\"url\":\"__URL__\"}"}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(HttpsUrl, images[0]);
    }

    [Fact]
    public void StringContent_EmbeddedJsonB64_WrappedAsDataUrl_Regression()
    {
        var json = """
        {"choices":[{"message":{"content":"{\"b64_json\":\"iVBORw0KGgo=\"}"}}]}
        """;

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal("data:image/png;base64,iVBORw0KGgo=", images[0]);
    }

    // ---------- 优先级 3：content 多模态数组（本次修复的核心形态） ----------

    [Fact]
    public void MultimodalContentArray_ImageUrlAndText_Extracted()
    {
        var json = J("""
        {"choices":[{"message":{"role":"assistant","content":[
          {"type":"image_url","image_url":{"url":"__DATA__"}},
          {"type":"text","text":"已按两张参考图合成"}
        ]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out var text, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(DataUri, images[0]);
        Assert.Equal("已按两张参考图合成", text);
    }

    [Fact]
    public void MultimodalContentArray_MultipleImages_AllExtracted()
    {
        var json = J("""
        {"choices":[{"message":{"content":[
          {"type":"image_url","image_url":{"url":"__DATA__"}},
          {"type":"image_url","image_url":{"url":"__URL__"}}
        ]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Equal(2, images.Count);
        Assert.Equal(DataUri, images[0]);
        Assert.Equal(HttpsUrl, images[1]);
    }

    [Fact]
    public void MultimodalContentArray_ImageUrlAsPlainString_Tolerated()
    {
        var json = J("""
        {"choices":[{"message":{"content":[{"type":"image_url","image_url":"__URL__"}]}}]}
        """);

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out _);

        Assert.True(ok);
        Assert.Single(images);
        Assert.Equal(HttpsUrl, images[0]);
    }

    [Fact]
    public void MultimodalContentArray_OnlyText_ReturnsFalse_WithTextFallback()
    {
        var json = """
        {"choices":[{"message":{"content":[
          {"type":"text","text":"抱歉，"},
          {"type":"text","text":"我无法生成这张图片"}
        ]}}]}
        """;

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out var text, out var diagnostics);

        Assert.False(ok);
        Assert.Empty(images);
        Assert.Equal("抱歉，我无法生成这张图片", text);
        Assert.Contains("多模态数组", diagnostics);
    }

    // ---------- 无图场景与诊断信息 ----------

    [Fact]
    public void PureTextStringContent_ReturnsFalse_WithTextFallback()
    {
        var json = """
        {"choices":[{"message":{"content":"这是一段纯文本描述，没有任何图片"}}]}
        """;

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out var text, out var diagnostics);

        Assert.False(ok);
        Assert.Empty(images);
        Assert.Equal("这是一段纯文本描述，没有任何图片", text);
        Assert.Contains("字符串", diagnostics);
        Assert.Contains("images[]", diagnostics);
    }

    [Fact]
    public void EmptyChoices_ReturnsFalse()
    {
        var ok = VisionChatCompletionImageExtractor.TryExtractImages(
            """{"choices":[]}""", out var images, out _, out var diagnostics);

        Assert.False(ok);
        Assert.Empty(images);
        Assert.Contains("choices", diagnostics);
    }

    [Fact]
    public void MissingChoices_ReturnsFalse()
    {
        var ok = VisionChatCompletionImageExtractor.TryExtractImages(
            """{"error":{"message":"upstream error"}}""", out var images, out _, out var diagnostics);

        Assert.False(ok);
        Assert.Empty(images);
        Assert.Contains("choices", diagnostics);
    }

    [Fact]
    public void InvalidJson_ReturnsFalse()
    {
        var ok = VisionChatCompletionImageExtractor.TryExtractImages(
            "not-a-json-body", out var images, out _, out var diagnostics);

        Assert.False(ok);
        Assert.Empty(images);
        Assert.Contains("JSON", diagnostics);
    }

    [Fact]
    public void EmptyBody_ReturnsFalse()
    {
        var ok = VisionChatCompletionImageExtractor.TryExtractImages(
            "", out var images, out _, out var diagnostics);

        Assert.False(ok);
        Assert.Empty(images);
        Assert.False(string.IsNullOrWhiteSpace(diagnostics));
    }

    [Fact]
    public void Diagnostics_EnumerateImagesArrayPresence_WhenNoUsableImage()
    {
        // images[] 存在但项不可用（既非 data: 也非 http），content 缺失
        var json = """
        {"choices":[{"message":{"images":[{"image_url":{"url":"ftp://bad"}}]}}]}
        """;

        var ok = VisionChatCompletionImageExtractor.TryExtractImages(json, out var images, out _, out var diagnostics);

        Assert.False(ok);
        Assert.Empty(images);
        Assert.Contains("images[]", diagnostics);
        Assert.Contains("content", diagnostics);
    }
}
