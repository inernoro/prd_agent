using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway;
using Xunit;
using PrdAgent.Core.LlmGateway;

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

    // 实测催生的用例：对话默认池里 18 个 gpt-5.0–5.5 成员全部调不通，报
    // "Unsupported parameter: 'max_tokens' is not supported with this model"。
    // 字段改名当时只认 gpt-5.6，而「向我提问」固定发 max_tokens=2048，于是整条家族成了地雷。
    [Theory]
    [InlineData("gpt-5")]
    [InlineData("gpt-5-mini")]
    [InlineData("gpt-5-nano-2025-08-07")]
    [InlineData("gpt-5.1")]
    [InlineData("gpt-5.2-2025-12-11")]
    [InlineData("gpt-5.4-mini")]
    [InlineData("gpt-5.5")]
    [InlineData("gpt-5.6-sol")]
    [InlineData("openai/gpt-5.4")]
    public void ApplyResolvedMaxTokensCap_WritesMaxCompletionTokens_ForWholeGpt5Family(string model)
    {
        var body = new JsonObject { ["messages"] = new JsonArray() };
        var resolution = new ModelResolutionResult
        {
            Success = true,
            ActualModel = model,
            Protocol = "openai",
            MaxTokens = 1024
        };

        LlmGateway.ApplyResolvedMaxTokensCap(body, resolution);

        Assert.Equal(1024, body["max_completion_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_tokens"));
    }

    // 反面：非 GPT-5 家族仍写 max_tokens，别把改名扩散到不需要的模型上。
    [Theory]
    [InlineData("gpt-4o")]
    [InlineData("gpt-4.1-mini")]
    [InlineData("gpt-50-imaginary")]
    [InlineData("anthropic/claude-opus-5")]
    public void ApplyResolvedMaxTokensCap_KeepsMaxTokens_ForNonGpt5Models(string model)
    {
        var body = new JsonObject { ["messages"] = new JsonArray() };
        var resolution = new ModelResolutionResult
        {
            Success = true,
            ActualModel = model,
            Protocol = "openai",
            MaxTokens = 1024
        };

        LlmGateway.ApplyResolvedMaxTokensCap(body, resolution);

        Assert.Equal(1024, body["max_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_completion_tokens"));
    }
}
