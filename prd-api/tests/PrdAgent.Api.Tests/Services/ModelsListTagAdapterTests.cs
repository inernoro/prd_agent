using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class ModelsListTagAdapterTests
{
    [Fact]
    public void InferTags_ArkEmbedding_ShouldReturnEmbedding()
    {
        var endpoint = "https://ark.cn-beijing.volces.com/api/v3/models";
        var tags = ModelsListTagAdapter.InferTags(
            providerId: "volces",
            endpoint: endpoint,
            modelId: "doubao-embedding-text-240715",
            domain: "Embedding",
            taskTypes: new[] { "TextEmbedding" },
            functionCalling: null,
            inputModalities: new[] { "text" },
            outputModalities: null,
            out var unknownReason);

        Assert.Null(unknownReason);
        Assert.NotNull(tags);
        Assert.Contains("embedding", tags!);
    }

    [Fact]
    public void InferTags_ArkFunctionCalling_ShouldReturnFunctionCalling()
    {
        var endpoint = "https://ark.cn-beijing.volces.com/api/v3/models";
        var tags = ModelsListTagAdapter.InferTags(
            providerId: "volces",
            endpoint: endpoint,
            modelId: "doubao-pro-32k-240828",
            domain: "LLM",
            taskTypes: new[] { "TextGeneration" },
            functionCalling: true,
            inputModalities: new[] { "text" },
            outputModalities: new[] { "text" },
            out var unknownReason);

        Assert.Null(unknownReason);
        Assert.NotNull(tags);
        Assert.Contains("function_calling", tags!);
        Assert.Contains("reasoning", tags!);
    }

    [Fact]
    public void InferTags_NonArk_ShouldReturnNull()
    {
        var tags = ModelsListTagAdapter.InferTags(
            providerId: "openai",
            endpoint: "https://api.openai.com/v1/models",
            modelId: "gpt-4o",
            domain: "LLM",
            taskTypes: new[] { "TextGeneration" },
            functionCalling: true,
            inputModalities: new[] { "text" },
            outputModalities: new[] { "text" },
            out var unknownReason);

        Assert.Null(tags);
        Assert.Null(unknownReason);
    }

    [Fact]
    public void InferTags_ArkHasSignalsButNoMapping_ShouldReturnUnknownReason()
    {
        var endpoint = "https://ark.cn-beijing.volces.com/api/v3/models";
        var tags = ModelsListTagAdapter.InferTags(
            providerId: "volces",
            endpoint: endpoint,
            modelId: "some-new-model",
            domain: "Router",
            taskTypes: new[] { "SomethingNew" },
            functionCalling: null,
            inputModalities: new[] { "text" },
            outputModalities: null,
            out var unknownReason);

        Assert.Null(tags);
        Assert.NotNull(unknownReason);
        Assert.Contains("domain=Router", unknownReason);
    }
}


