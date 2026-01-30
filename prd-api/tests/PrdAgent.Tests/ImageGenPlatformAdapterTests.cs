using System.Text.Json;
using PrdAgent.Infrastructure.LLM.Adapters;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 平台适配器单元测试
/// </summary>
public class ImageGenPlatformAdapterTests
{
    #region Factory Tests

    [Theory]
    [InlineData("https://api.openai.com/v1", null, "openai")]
    [InlineData("https://ark.cn-beijing.volces.com", null, "volces")]
    [InlineData("https://ark.cn-shanghai.volces.com/api/v3", null, "volces")]
    [InlineData("https://custom-gateway.example.com", null, "openai")] // fallback to openai
    public void GetAdapter_ByUrl_ReturnsCorrectAdapter(string apiUrl, string? modelName, string expectedPlatformType)
    {
        var adapter = ImageGenPlatformAdapterFactory.GetAdapter(apiUrl, modelName);
        Assert.Equal(expectedPlatformType, adapter.PlatformType);
    }

    [Theory]
    [InlineData("doubao-seedream-4-5-pro", "volces")]
    [InlineData("doubao-seedream-4-0", "volces")]
    [InlineData("doubao-seedream-3-0", "volces")]
    [InlineData("dall-e-3", "openai")]
    [InlineData("unknown-model", "openai")] // fallback to openai
    public void GetAdapter_ByModelName_ReturnsCorrectAdapter(string modelName, string expectedPlatformType)
    {
        var adapter = ImageGenPlatformAdapterFactory.GetAdapter("https://custom-gateway.example.com", modelName);
        Assert.Equal(expectedPlatformType, adapter.PlatformType);
    }

    [Theory]
    [InlineData("volces", "volces")]
    [InlineData("openai", "openai")]
    [InlineData("unknown", "openai")] // fallback to openai
    public void GetAdapter_ByExplicitPlatformType_ReturnsCorrectAdapter(string platformType, string expectedPlatformType)
    {
        var adapter = ImageGenPlatformAdapterFactory.GetAdapter("https://api.example.com", null, platformType);
        Assert.Equal(expectedPlatformType, adapter.PlatformType);
    }

    [Theory]
    [InlineData("https://ark.cn-beijing.volces.com", true)]
    [InlineData("https://ark.cn-shanghai.volces.com/api/v3/images/generations", true)]
    [InlineData("https://api.openai.com/v1", false)]
    [InlineData("https://custom.example.com", false)]
    [InlineData("http://localhost:5000", false)]
    public void IsVolcesApi_ReturnsCorrectResult(string apiUrl, bool expected)
    {
        Assert.Equal(expected, ImageGenPlatformAdapterFactory.IsVolcesApi(apiUrl));
    }

    #endregion

    #region OpenAI Adapter Tests

    [Fact]
    public void OpenAIAdapter_Properties_AreCorrect()
    {
        var adapter = new OpenAIPlatformAdapter();
        Assert.Equal("openai", adapter.PlatformType);
        Assert.Equal("OpenAI", adapter.ProviderNameForLog);
        Assert.True(adapter.SupportsImageToImage);
        Assert.False(adapter.ForceUrlResponseFormat);
    }

    [Theory]
    [InlineData("https://api.openai.com/v1", "/v1/images/generations")]
    public void OpenAIAdapter_GetGenerationsEndpoint_ReturnsCorrectPath(string baseUrl, string expected)
    {
        var adapter = new OpenAIPlatformAdapter();
        Assert.Equal(expected, adapter.GetGenerationsEndpoint(baseUrl));
    }

    [Fact]
    public void OpenAIAdapter_BuildGenerationRequest_ReturnsValidDictionary()
    {
        var adapter = new OpenAIPlatformAdapter();
        var request = adapter.BuildGenerationRequest("dall-e-3", "A cat", 1, "1024x1024", "b64_json");

        Assert.IsType<Dictionary<string, object>>(request);
        var dict = (Dictionary<string, object>)request;

        Assert.Equal("dall-e-3", dict["model"]);
        Assert.Equal("A cat", dict["prompt"]);
        Assert.Equal(1, dict["n"]);
        Assert.Equal("1024x1024", dict["size"]);
        Assert.Equal("b64_json", dict["response_format"]);
    }

    [Fact]
    public void OpenAIAdapter_BuildGenerationRequest_WithSizeParams_UsesCustomParams()
    {
        var adapter = new OpenAIPlatformAdapter();
        var sizeParams = new Dictionary<string, object>
        {
            ["width"] = 1024,
            ["height"] = 768
        };
        var request = adapter.BuildGenerationRequest("flux-pro", "A dog", 1, null, null, sizeParams);

        var dict = (Dictionary<string, object>)request;
        Assert.Equal(1024, dict["width"]);
        Assert.Equal(768, dict["height"]);
        Assert.False(dict.ContainsKey("size"));
    }

    [Fact]
    public void OpenAIAdapter_NormalizeSize_ReturnsInputUnchanged()
    {
        var adapter = new OpenAIPlatformAdapter();
        Assert.Equal("1024x1024", adapter.NormalizeSize("1024x1024"));
        Assert.Equal("512x512", adapter.NormalizeSize(" 512x512 "));
        Assert.Null(adapter.NormalizeSize(null));
    }

    [Fact]
    public void OpenAIAdapter_HandleSizeError_ReturnsNull()
    {
        var adapter = new OpenAIPlatformAdapter();
        // OpenAI adapter doesn't do automatic size adjustment
        Assert.Null(adapter.HandleSizeError("size must be at least 1024x1024", "512x512"));
    }

    [Fact]
    public void OpenAIAdapter_SerializeRequest_WorksWithDictionary()
    {
        var adapter = new OpenAIPlatformAdapter();
        var request = adapter.BuildGenerationRequest("dall-e-3", "test", 1, "1024x1024", null);
        var json = adapter.SerializeRequest(request);

        Assert.Contains("\"model\":\"dall-e-3\"", json);
        Assert.Contains("\"prompt\":\"test\"", json);
    }

    #endregion

    #region Volces Adapter Tests

    [Fact]
    public void VolcesAdapter_Properties_AreCorrect()
    {
        var adapter = new VolcesPlatformAdapter();
        Assert.Equal("volces", adapter.PlatformType);
        Assert.Equal("Volces", adapter.ProviderNameForLog);
        Assert.False(adapter.SupportsImageToImage);
        Assert.True(adapter.ForceUrlResponseFormat);
    }

    [Theory]
    [InlineData("https://ark.cn-beijing.volces.com", "https://ark.cn-beijing.volces.com/api/v3/images/generations")]
    [InlineData("https://ark.cn-beijing.volces.com/", "https://ark.cn-beijing.volces.com/api/v3/images/generations")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "https://ark.cn-beijing.volces.com/api/v3/images/generations")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/", "https://ark.cn-beijing.volces.com/api/v3/images/generations")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/images/generations#", "https://ark.cn-beijing.volces.com/api/v3/images/generations")] // force exact url
    public void VolcesAdapter_GetGenerationsEndpoint_ReturnsCorrectPath(string baseUrl, string expected)
    {
        var adapter = new VolcesPlatformAdapter();
        Assert.Equal(expected, adapter.GetGenerationsEndpoint(baseUrl));
    }

    [Fact]
    public void VolcesAdapter_BuildGenerationRequest_ReturnsValidDictionary()
    {
        var adapter = new VolcesPlatformAdapter();
        var request = adapter.BuildGenerationRequest("doubao-seedream-4-5-pro", "A cat", 1, "1024x1024", "b64_json");

        Assert.IsType<Dictionary<string, object>>(request);
        var dict = (Dictionary<string, object>)request;

        Assert.Equal("doubao-seedream-4-5-pro", dict["model"]);
        Assert.Equal("A cat", dict["prompt"]);
        Assert.Equal(1, dict["n"]);
        // Volces normalizes size to 1920x1920 minimum
        Assert.Equal("1920x1920", dict["size"]);
        // Volces forces url response format
        Assert.Equal("url", dict["response_format"]);
        // Volces-specific fields
        Assert.Equal("disabled", dict["sequential_image_generation"]);
        Assert.False((bool)dict["stream"]);
        Assert.True((bool)dict["watermark"]);
    }

    [Theory]
    [InlineData("512x512", "1920x1920")] // below minimum
    [InlineData("1024x1024", "1920x1920")] // below minimum
    [InlineData("1920x1080", "1920x1920")] // below minimum (pixels < 3,686,400)
    [InlineData("1920x1920", "1920x1920")] // exactly minimum
    [InlineData("2048x2048", "2048x2048")] // above minimum
    [InlineData("4096x4096", "4096x4096")] // high res
    [InlineData(null, "1920x1920")] // null defaults to minimum
    [InlineData("", "1920x1920")] // empty defaults to minimum
    [InlineData("2K", "2K")] // K suffix preserved
    [InlineData("4K", "4K")] // K suffix preserved
    public void VolcesAdapter_NormalizeSize_HandlesMinimumRequirement(string? input, string expected)
    {
        var adapter = new VolcesPlatformAdapter();
        Assert.Equal(expected, adapter.NormalizeSize(input));
    }

    [Theory]
    [InlineData("size must be at least 1920x1920", "1024x1024", "1920x1920")]
    [InlineData("The size is at least 3686400 pixels", "512x512", "1920x1920")]
    [InlineData("random error message", "512x512", null)]
    [InlineData("size must be at least 1920x1920", "1920x1920", null)] // already at minimum
    public void VolcesAdapter_HandleSizeError_ReturnsCorrectSuggestion(string errorMsg, string currentSize, string? expected)
    {
        var adapter = new VolcesPlatformAdapter();
        Assert.Equal(expected, adapter.HandleSizeError(errorMsg, currentSize));
    }

    [Fact]
    public void VolcesAdapter_SerializeRequest_WorksWithDictionary()
    {
        var adapter = new VolcesPlatformAdapter();
        var request = adapter.BuildGenerationRequest("doubao-seedream-4-5-pro", "test", 1, "2048x2048", null);
        var json = adapter.SerializeRequest(request);

        Assert.Contains("\"model\":\"doubao-seedream-4-5-pro\"", json);
        Assert.Contains("\"prompt\":\"test\"", json);
        Assert.Contains("\"watermark\":true", json);
    }

    #endregion

    #region Response Parsing Tests

    [Fact]
    public void OpenAIAdapter_ParseResponseItem_ExtractsFields()
    {
        var adapter = new OpenAIPlatformAdapter();
        var json = JsonDocument.Parse(@"{
            ""url"": ""https://example.com/image.png"",
            ""b64_json"": ""base64data"",
            ""revised_prompt"": ""A beautiful cat""
        }");

        var result = adapter.ParseResponseItem(json.RootElement);

        Assert.Equal("https://example.com/image.png", result.Url);
        Assert.Equal("base64data", result.Base64);
        Assert.Equal("A beautiful cat", result.RevisedPrompt);
    }

    [Fact]
    public void VolcesAdapter_ParseResponseItem_ExtractsFields()
    {
        var adapter = new VolcesPlatformAdapter();
        var json = JsonDocument.Parse(@"{
            ""url"": ""https://volces.example.com/image.png"",
            ""revised_prompt"": ""A cute cat"",
            ""size"": ""1920x1920""
        }");

        var result = adapter.ParseResponseItem(json.RootElement);

        Assert.Equal("https://volces.example.com/image.png", result.Url);
        Assert.Null(result.Base64); // Volces doesn't return base64
        Assert.Equal("A cute cat", result.RevisedPrompt);
        Assert.Equal("1920x1920", result.ActualSize);
    }

    #endregion
}
