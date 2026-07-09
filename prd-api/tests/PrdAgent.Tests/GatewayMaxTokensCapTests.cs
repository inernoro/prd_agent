using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public class GatewayMaxTokensCapTests
{
    [Fact]
    public void ApplyResolvedMaxTokensCap_ReducesRequestValue_WhenModelDeclaresLowerLimit()
    {
        var body = new JsonObject { ["max_tokens"] = 4096 };
        var resolution = new ModelResolutionResult
        {
            Success = true,
            ActualModel = "HealthGPT-L14",
            MaxTokens = 1024
        };

        var applied = LlmGateway.ApplyResolvedMaxTokensCap(body, resolution);

        Assert.Equal(1024, applied);
        Assert.Equal(1024, body["max_tokens"]!.GetValue<int>());
    }

    [Fact]
    public void ApplyResolvedMaxTokensCap_KeepsRequestValue_WhenItIsWithinModelLimit()
    {
        var body = new JsonObject { ["max_tokens"] = 512 };
        var resolution = new ModelResolutionResult
        {
            Success = true,
            ActualModel = "HealthGPT-L14",
            MaxTokens = 1024
        };

        var applied = LlmGateway.ApplyResolvedMaxTokensCap(body, resolution);

        Assert.Null(applied);
        Assert.Equal(512, body["max_tokens"]!.GetValue<int>());
    }

    [Fact]
    public void ApplyResolvedMaxTokensCap_DoesNotChangeRequest_WhenModelLimitIsUnknown()
    {
        var body = new JsonObject { ["max_tokens"] = 4096 };
        var resolution = new ModelResolutionResult
        {
            Success = true,
            ActualModel = "unknown-model",
            MaxTokens = null
        };

        var applied = LlmGateway.ApplyResolvedMaxTokensCap(body, resolution);

        Assert.Null(applied);
        Assert.Equal(4096, body["max_tokens"]!.GetValue<int>());
    }

    [Fact]
    public void ApplyResolvedMaxTokensCap_AddsModelLimit_WhenRequestOmitsMaxTokens()
    {
        var body = new JsonObject();
        var resolution = new ModelResolutionResult
        {
            Success = true,
            ActualModel = "claude-compatible",
            MaxTokens = 1024
        };

        var applied = LlmGateway.ApplyResolvedMaxTokensCap(body, resolution);

        Assert.Equal(1024, applied);
        Assert.Equal(1024, body["max_tokens"]!.GetValue<int>());
    }
}
