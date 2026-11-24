using System.Text.Json.Nodes;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using Xunit;

namespace PrdAgent.Tests;

public sealed class FalImageLayeredTransformerTests
{
    private readonly FalImageLayeredTransformer _transformer = new();

    [Fact]
    public void TransformRequest_MapsFirstReferenceAndLayerCount()
    {
        var input = new JsonObject
        {
            ["prompt"] = "separate the subject and background",
            ["n"] = 6,
            ["image_urls"] = new JsonArray("data:image/png;base64,AAAA")
        };

        var result = _transformer.TransformRequest(input, null);

        Assert.Equal("data:image/png;base64,AAAA", result["image_url"]?.GetValue<string>());
        Assert.Equal(6, result["num_layers"]?.GetValue<int>());
        Assert.Equal("png", result["output_format"]?.GetValue<string>());
        Assert.Null(result["image_urls"]);
        Assert.Null(result["model"]);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(4, 4)]
    [InlineData(20, 10)]
    public void TransformRequest_ClampsLayerCount(int requested, int expected)
    {
        var input = new JsonObject
        {
            ["n"] = requested,
            ["image_urls"] = new JsonArray("https://example.com/source.png")
        };

        var result = _transformer.TransformRequest(input, null);

        Assert.Equal(expected, result["num_layers"]?.GetValue<int>());
    }

    [Fact]
    public void TransformResponse_MapsEveryRgbaLayer()
    {
        var input = new JsonObject
        {
            ["images"] = new JsonArray
            {
                new JsonObject { ["url"] = "https://example.com/layer-1.png", ["content_type"] = "image/png" },
                new JsonObject { ["url"] = "https://example.com/layer-2.png", ["content_type"] = "image/png" }
            }
        };

        var result = _transformer.TransformResponse(input, null);
        var data = Assert.IsType<JsonArray>(result["data"]);

        Assert.Equal(2, data.Count);
        Assert.Equal("https://example.com/layer-1.png", data[0]?["url"]?.GetValue<string>());
        Assert.Equal("https://example.com/layer-2.png", data[1]?["url"]?.GetValue<string>());
    }
}
