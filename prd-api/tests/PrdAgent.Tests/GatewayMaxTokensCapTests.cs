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

    [Theory]
    [InlineData("gpt-6.1-sol")]
    [InlineData("openai/gpt-6.1-sol")]
    public void ConfirmedGpt61SolBudgetKeepsSmallestCapAndRemovesLegacyFields(string model)
    {
        var body = new JsonObject { ["messages"] = new JsonArray(), ["max_tokens"] = 500,
            ["max_completion_tokens"] = 300, ["max_output_tokens"] = 100 };
        LlmGateway.ApplyResolvedMaxTokensCap(body, new ModelResolutionResult
            { Success = true, ActualModel = model, Protocol = "openai", MaxTokens = 128 });
        Assert.Equal(100, body["max_completion_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_tokens")); Assert.False(body.ContainsKey("max_output_tokens"));
    }

    // 反面：非 GPT-5 家族仍写 max_tokens，别把改名扩散到不需要的模型上。
    [Theory]
    [InlineData("gpt-4o")]
    [InlineData("gpt-4.1-mini")]
    [InlineData("gpt-50-imaginary")]
    [InlineData("gpt-6.1-sol-future")]
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

    // ── GPT-5 家族的字段收编（Exchange 原始请求路径不走 chat 兼容改写，只走这里）──

    private static ModelResolutionResult Gpt5(string model, int? maxTokens = 1024) => new()
    {
        Success = true,
        ActualModel = model,
        Protocol = "openai",
        MaxTokens = maxTokens,
    };

    private static JsonObject ChatBody(int maxTokens) => new()
    {
        ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "hi" }),
        ["max_tokens"] = maxTokens,
    };

    [Theory]
    [InlineData("gpt-5")]
    [InlineData("gpt-5-mini")]
    [InlineData("gpt-5.2")]
    [InlineData("gpt-5.6-sol")]
    public void 限流之后不许两个字段同时留在请求体里(string model)
    {
        // Exchange 的原始请求路径只调 cap、不调 chat 兼容改写。cap 往 max_completion_tokens
        // 写完之后如果不把 max_tokens 收掉，两个字段一起发出去，OpenAI 兼容上游直接拒——
        // 而这条路径上没有任何别的地方会收它。
        var body = ChatBody(4096);

        LlmGateway.ApplyResolvedMaxTokensCap(body, Gpt5(model));

        Assert.False(body.ContainsKey("max_tokens"), $"{model}: max_tokens 应该已经被收编掉");
        Assert.Equal(1024, body["max_completion_tokens"]!.GetValue<int>());
    }

    [Fact]
    public void 调用方要的值低于上限时_收编后要保留他的值_不许被上限顶上去()
    {
        // 收编之前，cap 看的是 max_completion_tokens、看不见 max_tokens，于是按「目标字段
        // 不存在」把上限整个塞进去——调用方明明只要 500，最后发出去 1024。
        var body = ChatBody(500);

        var applied = LlmGateway.ApplyResolvedMaxTokensCap(body, Gpt5("gpt-5.2"));

        Assert.Null(applied);
        Assert.False(body.ContainsKey("max_tokens"));
        Assert.Equal(500, body["max_completion_tokens"]!.GetValue<int>());
    }

    [Fact]
    public void 没有上限时也要收编_否则原始请求照样带着_max_tokens_发出去()
    {
        var body = ChatBody(500);

        LlmGateway.ApplyResolvedMaxTokensCap(body, Gpt5("gpt-5.2", maxTokens: null));

        Assert.False(body.ContainsKey("max_tokens"));
        Assert.Equal(500, body["max_completion_tokens"]!.GetValue<int>());
    }

    [Fact]
    public void 不是_GPT5_家族的照旧用_max_tokens()
    {
        // 边界：收编只对 GPT-5 家族 + OpenAI 协议 + chat 请求体成立，别把别人的字段也改了。
        var body = ChatBody(4096);

        LlmGateway.ApplyResolvedMaxTokensCap(body, new ModelResolutionResult
        {
            Success = true,
            ActualModel = "gpt-4o",
            Protocol = "openai",
            MaxTokens = 1024,
        });

        Assert.Equal(1024, body["max_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_completion_tokens"));
    }

    [Fact]
    public void 不是_chat_请求体的照旧用_max_tokens()
    {
        // 没有 messages 的（补全、嵌入等）不适用这条改名。
        var body = new JsonObject { ["prompt"] = "hi", ["max_tokens"] = 4096 };

        LlmGateway.ApplyResolvedMaxTokensCap(body, Gpt5("gpt-5.2"));

        Assert.Equal(1024, body["max_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_completion_tokens"));
    }
    [Theory]
    [InlineData("o1")]
    [InlineData("o1-mini")]
    [InlineData("o1-preview-2024-09-12")]
    [InlineData("o3")]
    [InlineData("o3-mini-2025-01-31")]
    [InlineData("openai/o4-mini-2025-04-16")]
    public void KnownReasoningChat_UsesSmallestBudgetWithOrWithoutModelCap(string model)
    {
        foreach (var modelCap in new int?[] { null, 1024, 64 })
        {
            var body = ChatBody(128);
            body["max_completion_tokens"] = 512;
            body["max_output_tokens"] = 256;
            LlmGateway.ApplyResolvedMaxTokensCap(body, Gpt5(model, modelCap));
            Assert.Equal(Math.Min(128, modelCap ?? int.MaxValue), body["max_completion_tokens"]!.GetValue<int>());
            Assert.False(body.ContainsKey("max_tokens"));
            Assert.False(body.ContainsKey("max_output_tokens"));
        }
    }

    [Theory]
    [InlineData("o30")]
    [InlineData("o3-future")]
    [InlineData("o3-2025-02-30")]
    [InlineData("o4")]
    [InlineData("o4-mini-extra")]
    [InlineData("other-reasoning")]
    public void UnknownReasoningNames_AreNotGuessed(string model)
    {
        var body = ChatBody(128);
        LlmGateway.ApplyResolvedMaxTokensCap(body, Gpt5(model));
        Assert.Equal(128, body["max_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_completion_tokens"));
    }

    [Fact]
    public void ReasoningName_DoesNotRewriteOtherProtocolOrNonChatBody()
    {
        var body = ChatBody(128);
        var resolution = new ModelResolutionResult
        { Success = true, ActualModel = "o3", Protocol = "claude", MaxTokens = 1024 };
        LlmGateway.ApplyResolvedMaxTokensCap(body, resolution);
        Assert.Equal(128, body["max_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_completion_tokens"));
        body = new JsonObject { ["prompt"] = "synthetic", ["max_tokens"] = 128 };
        LlmGateway.ApplyResolvedMaxTokensCap(body, Gpt5("o3"));
        Assert.Equal(128, body["max_tokens"]!.GetValue<int>());
        Assert.False(body.ContainsKey("max_completion_tokens"));
    }

}
