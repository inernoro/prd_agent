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
          "data": [{ "b64_json": "redacted" }, { "url": "https://example.test/image.png" }],
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
        Assert.True(result.HasReportedUsage);
    }

    [Fact]
    public void Parse_GeminiImageResponse_CollectsUsageAndNativeFinishReason()
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
              "parts": [{ "inlineData": { "mimeType": "image/png", "data": "redacted" } }]
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
