using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public sealed class RawGatewayUsageParserTests
{
    [Fact]
    public void Parse_OpenAiImageResponse_CollectsUsageCostImagesAndFinishReason()
    {
        const string response = """
        {
          "data": [
            { "b64_json": "aGVsbG8=", "media_type": "image/webp" },
            { "url": "https://example.test/image.png" }
          ],
          "usage": {
            "prompt_tokens": 12,
            "completion_tokens": 34,
            "cost": 0.015,
            "currency": "usd"
          }
        }
        """;

        var result = RawGatewayUsageParser.Parse(response);

        Assert.Equal(12, result.InputTokens);
        Assert.Equal(34, result.OutputTokens);
        Assert.Equal(2, result.ImageSuccessCount);
        Assert.Equal("completed", result.FinishReason);
        Assert.Equal(0.015m, result.ProviderReportedCost);
        Assert.Equal("USD", result.ProviderCostCurrency);
        Assert.Collection(
            result.OutputImages,
            outputImage =>
            {
                Assert.Equal("aGVsbG8=", outputImage.Base64Data);
                Assert.Null(outputImage.SourceUrl);
                Assert.Equal("image/webp", outputImage.MimeType);
            },
            outputImage =>
            {
                Assert.Null(outputImage.Base64Data);
                Assert.Equal("https://example.test/image.png", outputImage.SourceUrl);
            });
        Assert.True(result.HasReportedUsage);
    }

    [Fact]
    public void Parse_UrlOnlyImageResponse_CollectsDisplayableImageWithoutTreatingUrlAsBase64()
    {
        const string response = """
        {
          "data": [{
            "image_url": { "url": "https://cdn.example.test/generated.webp" },
            "media_type": "image/webp"
          }]
        }
        """;

        var result = RawGatewayUsageParser.Parse(response);

        Assert.Equal(1, result.ImageSuccessCount);
        var outputImage = Assert.Single(result.OutputImages);
        Assert.Null(outputImage.Base64Data);
        Assert.Equal("https://cdn.example.test/generated.webp", outputImage.SourceUrl);
        Assert.Equal("image/webp", outputImage.MimeType);
    }

    [Fact]
    public void Parse_OpenRouterDocumentedImageResponse_PreservesReportedUsageWithoutInventingPromptCount()
    {
        const string response = """
        {
          "data": [{
            "b64_json": "aGVsbG8=",
            "media_type": "image/png"
          }],
          "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 4175,
            "total_tokens": 4175,
            "cost": 0.04
          }
        }
        """;

        var result = RawGatewayUsageParser.Parse(response);

        Assert.Equal(0, result.InputTokens);
        Assert.Equal(4175, result.OutputTokens);
        Assert.Equal(1, result.ImageSuccessCount);
        Assert.Equal(0.04m, result.ProviderReportedCost);
        Assert.Equal("USD", result.ProviderCostCurrency);
        var outputImage = Assert.Single(result.OutputImages);
        Assert.Null(outputImage.SourceUrl);
    }

    [Fact]
    public void Parse_GeminiImageResponse_CollectsUsageNativeFinishReasonAndPayload()
    {
        const string response = """
        {
          "usageMetadata": {
            "promptTokenCount": 19,
            "candidatesTokenCount": 8
          },
          "candidates": [{
            "finishReason": "STOP",
            "content": {
              "parts": [{ "inlineData": { "mimeType": "image/png", "data": "aGVsbG8=" } }]
            }
          }]
        }
        """;

        var result = RawGatewayUsageParser.Parse(response);

        Assert.Equal(19, result.InputTokens);
        Assert.Equal(8, result.OutputTokens);
        Assert.Equal(1, result.ImageSuccessCount);
        Assert.Equal("STOP", result.FinishReason);
        Assert.Null(result.ProviderReportedCost);
        Assert.Single(result.OutputImages);
    }

    [Fact]
    public void RedactImagePayloadsForLog_RemovesBase64ButKeepsUsage()
    {
        const string response = """
        {
          "data": [{ "b64_json": "aGVsbG8=", "media_type": "image/png" }],
          "usage": { "completion_tokens": 42 }
        }
        """;

        var redacted = RawGatewayUsageParser.RedactImagePayloadsForLog(response);

        Assert.DoesNotContain("aGVsbG8=", redacted);
        Assert.Contains("[IMAGE_BASE64_REDACTED]", redacted);
        Assert.Contains("\"completion_tokens\": 42", redacted);
    }

    [Fact]
    public void Parse_InvalidOrUnreportedResponse_RemainsUnknown()
    {
        var result = RawGatewayUsageParser.Parse("""{"data":[{"revised_prompt":"safe"}]}""");

        Assert.Null(result.InputTokens);
        Assert.Null(result.OutputTokens);
        Assert.Null(result.ImageSuccessCount);
        Assert.Null(result.FinishReason);
        Assert.Null(result.ProviderReportedCost);
        Assert.False(result.HasReportedUsage);
    }

    /// <summary>
    /// Responses 那套接口把缓存明细挂在 input_tokens_details 下，不是 prompt_tokens_details。
    ///
    /// 只认后者的话，走 Responses 的调用拿不到缓存这一截，而 input_tokens 里**含着**它——
    /// 每个命中缓存的 token 都按输入全价收，账与预算一起虚高。这是行为断言，不是扫源码：
    /// 判据换个等价写法（改常量、改读取顺序）也得给出同一个答案。
    /// </summary>
    [Theory]
    [InlineData("input_tokens_details")]
    [InlineData("inputTokensDetails")]
    [InlineData("prompt_tokens_details")]
    [InlineData("promptTokensDetails")]
    public void Parse_ReadsCachedTokensFromEitherUsageDetailShape(string detailsField)
    {
        var response = $$"""
        {
          "usage": {
            "input_tokens": 1000,
            "output_tokens": 20,
            "{{detailsField}}": { "cached_tokens": 800 }
          }
        }
        """;

        var result = RawGatewayUsageParser.Parse(response);

        Assert.Equal(1000, result.InputTokens);
        Assert.Equal(800, result.CacheReadInputTokens);
    }
}
