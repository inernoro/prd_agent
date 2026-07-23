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
        var outputImage = Assert.Single(result.OutputImages);
        Assert.Equal("aGVsbG8=", outputImage.Base64Data);
        Assert.Equal("image/webp", outputImage.MimeType);
        Assert.True(result.HasReportedUsage);
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
        Assert.Single(result.OutputImages);
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
}
