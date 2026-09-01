using System.Text.Json;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.Infrastructure.LLM.Adapters;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class OpenAIImageResponseFormatTests
{
    [Theory]
    [InlineData("gpt-image-1")]
    [InlineData("gpt-image-1-mini")]
    [InlineData("gpt-image-1.5")]
    [InlineData("gpt-image-2")]
    [InlineData("gpt-image-2-2026-04-21")]
    [InlineData("gpt-image-2-all")]
    [InlineData("chatgpt-image-latest")]
    public void GptImage_GenerationAndEdit_OmitUnsupportedResponseFormat(string model)
    {
        var adapter = new OpenAIPlatformAdapter();
        foreach (var format in new[] { "url", "b64_json" })
        {
            var generation = adapter.BuildGenerationRequest(model, "白桃", 1, "1024x1024", format);
            var built = ImageGenRequestBuilder.BuildStandardGeneration(model, "白桃", 1, "1024x1024", format, adapter);
            Assert.Null(built.EffectiveResponseFormat);
            using var json = JsonDocument.Parse(adapter.SerializeRequest(generation));
            Assert.False(json.RootElement.TryGetProperty("response_format", out _));
            Assert.Equal(model, json.RootElement.GetProperty("model").GetString());
            Assert.Equal("1024x1024", json.RootElement.GetProperty("size").GetString());

            var edit = adapter.BuildEditRequest(model, "白桃", 1, "1024x1024", format);
            using var editJson = JsonDocument.Parse(adapter.SerializeRequest(edit));
            Assert.Equal(JsonValueKind.Null, editJson.RootElement.GetProperty("response_format").ValueKind);
        }
    }

    [Theory]
    [InlineData("dall-e-2")]
    [InlineData("dall-e-3")]
    [InlineData("other-compatible-image")]
    public void OtherModels_PreserveRequestedResponseFormat(string model)
    {
        var adapter = new OpenAIPlatformAdapter();
        var request = adapter.BuildGenerationRequest(model, "白桃", 1, "1024x1024", "url");
        using var json = JsonDocument.Parse(adapter.SerializeRequest(request));
        Assert.Equal("url", json.RootElement.GetProperty("response_format").GetString());
    }
}
