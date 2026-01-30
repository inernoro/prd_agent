using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using PrdAgent.Infrastructure.LLM.Adapters;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 平台适配器集成测试（手动触发）
/// 需要真实 API Key，CI 不执行
/// 
/// 运行命令：
///   dotnet test --filter "Category=Manual"
/// </summary>
[Trait("Category", "Manual")]
[Trait("Category", "Integration")]
public class ImageGenPlatformAdapterIntegrationTests
{
    private readonly ITestOutputHelper _output;
    private readonly IConfiguration _config;

    public ImageGenPlatformAdapterIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
        _config = new ConfigurationBuilder()
            .AddJsonFile("appsettings.json", optional: true)
            .AddJsonFile("appsettings.Development.json", optional: true)
            .AddEnvironmentVariables()
            .Build();
    }

    #region OpenAI Platform Tests

    /// <summary>
    /// 测试 OpenAI DALL-E 3 文生图
    /// 需要配置 LLM:OpenAIApiKey 和 LLM:OpenAIApiUrl
    /// </summary>
    [Fact]
    public async Task OpenAI_DallE3_GenerateImage_ReturnsValidResponse()
    {
        // Arrange
        var apiKey = _config["LLM:OpenAIApiKey"];
        var apiUrl = _config["LLM:OpenAIApiUrl"] ?? "https://api.openai.com/v1";

        if (string.IsNullOrEmpty(apiKey))
        {
            _output.WriteLine("Skipped: LLM:OpenAIApiKey not configured");
            return;
        }

        var adapter = ImageGenPlatformAdapterFactory.GetAdapter(apiUrl, "dall-e-3");
        Assert.Equal("openai", adapter.PlatformType);

        var request = adapter.BuildGenerationRequest(
            model: "dall-e-3",
            prompt: "A simple test image of a red circle on white background",
            n: 1,
            size: "1024x1024",
            responseFormat: "url"
        );

        var json = adapter.SerializeRequest(request);
        _output.WriteLine($"Request JSON: {json}");

        // Act
        using var httpClient = new HttpClient();
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        httpClient.Timeout = TimeSpan.FromSeconds(120);

        var endpoint = adapter.GetGenerationsEndpoint(apiUrl);
        var fullUrl = apiUrl.TrimEnd('/') + endpoint;
        _output.WriteLine($"Endpoint: {fullUrl}");

        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var response = await httpClient.PostAsync(fullUrl, content);

        var body = await response.Content.ReadAsStringAsync();
        _output.WriteLine($"Response Status: {(int)response.StatusCode}");
        _output.WriteLine($"Response Body (truncated): {body[..Math.Min(500, body.Length)]}...");

        // Assert
        Assert.True(response.IsSuccessStatusCode, $"API call failed: {body}");

        var doc = JsonDocument.Parse(body);
        Assert.True(doc.RootElement.TryGetProperty("data", out var dataArray));
        Assert.True(dataArray.GetArrayLength() > 0);

        var firstItem = dataArray[0];
        var result = adapter.ParseResponseItem(firstItem);
        Assert.False(string.IsNullOrEmpty(result.Url), "Should return URL");
        _output.WriteLine($"Generated image URL: {result.Url}");
        if (!string.IsNullOrEmpty(result.RevisedPrompt))
        {
            _output.WriteLine($"Revised prompt: {result.RevisedPrompt}");
        }
    }

    /// <summary>
    /// 测试 OpenAI DALL-E 3 不同尺寸
    /// </summary>
    [Theory]
    [InlineData("1024x1024")]
    [InlineData("1792x1024")]
    [InlineData("1024x1792")]
    public async Task OpenAI_DallE3_DifferentSizes_Works(string size)
    {
        var apiKey = _config["LLM:OpenAIApiKey"];
        var apiUrl = _config["LLM:OpenAIApiUrl"] ?? "https://api.openai.com/v1";

        if (string.IsNullOrEmpty(apiKey))
        {
            _output.WriteLine("Skipped: LLM:OpenAIApiKey not configured");
            return;
        }

        var adapter = new OpenAIPlatformAdapter();
        var request = adapter.BuildGenerationRequest("dall-e-3", "A test circle", 1, size, "url");
        var json = adapter.SerializeRequest(request);

        using var httpClient = new HttpClient();
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        httpClient.Timeout = TimeSpan.FromSeconds(120);

        var endpoint = adapter.GetGenerationsEndpoint(apiUrl);
        var fullUrl = apiUrl.TrimEnd('/') + endpoint;

        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var response = await httpClient.PostAsync(fullUrl, content);
        var body = await response.Content.ReadAsStringAsync();

        _output.WriteLine($"Size {size}: Status {(int)response.StatusCode}");
        Assert.True(response.IsSuccessStatusCode, $"Failed for size {size}: {body}");
    }

    #endregion

    #region Volces Platform Tests

    /// <summary>
    /// 测试火山引擎豆包 Seedream 文生图
    /// 需要配置 LLM:VolcesApiKey 和 LLM:VolcesApiUrl
    /// </summary>
    [Fact]
    public async Task Volces_DoubaoSeedream_GenerateImage_ReturnsValidResponse()
    {
        // Arrange
        var apiKey = _config["LLM:VolcesApiKey"];
        var apiUrl = _config["LLM:VolcesApiUrl"] ?? "https://ark.cn-beijing.volces.com";
        var modelName = _config["LLM:VolcesImageModel"] ?? "doubao-seedream-4-5-pro";

        if (string.IsNullOrEmpty(apiKey))
        {
            _output.WriteLine("Skipped: LLM:VolcesApiKey not configured");
            return;
        }

        var adapter = ImageGenPlatformAdapterFactory.GetAdapter(apiUrl, modelName);
        Assert.Equal("volces", adapter.PlatformType);

        var request = adapter.BuildGenerationRequest(
            model: modelName,
            prompt: "A simple test image of a blue square on white background",
            n: 1,
            size: "1920x1920",
            responseFormat: "url"
        );

        var json = adapter.SerializeRequest(request);
        _output.WriteLine($"Request JSON: {json}");

        // Act
        using var httpClient = new HttpClient();
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        httpClient.Timeout = TimeSpan.FromSeconds(180);

        var endpoint = adapter.GetGenerationsEndpoint(apiUrl);
        _output.WriteLine($"Endpoint: {endpoint}");

        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var response = await httpClient.PostAsync(endpoint, content);

        var body = await response.Content.ReadAsStringAsync();
        _output.WriteLine($"Response Status: {(int)response.StatusCode}");
        _output.WriteLine($"Response Body (truncated): {body[..Math.Min(500, body.Length)]}...");

        // Assert
        Assert.True(response.IsSuccessStatusCode, $"API call failed: {body}");

        var doc = JsonDocument.Parse(body);
        Assert.True(doc.RootElement.TryGetProperty("data", out var dataArray));
        Assert.True(dataArray.GetArrayLength() > 0);

        var firstItem = dataArray[0];
        var result = adapter.ParseResponseItem(firstItem);
        Assert.False(string.IsNullOrEmpty(result.Url), "Should return URL");
        _output.WriteLine($"Generated image URL: {result.Url}");
    }

    /// <summary>
    /// 测试 Volces 尺寸自动归一化
    /// </summary>
    [Theory]
    [InlineData("1024x1024", "1920x1920")] // auto upgrade to minimum
    [InlineData("2048x2048", "2048x2048")] // keep as is
    public void Volces_SizeNormalization_Works(string requestedSize, string expectedSize)
    {
        var apiKey = _config["LLM:VolcesApiKey"];
        var apiUrl = _config["LLM:VolcesApiUrl"] ?? "https://ark.cn-beijing.volces.com";
        var modelName = _config["LLM:VolcesImageModel"] ?? "doubao-seedream-4-5-pro";

        if (string.IsNullOrEmpty(apiKey))
        {
            _output.WriteLine("Skipped: LLM:VolcesApiKey not configured");
            return;
        }

        var adapter = new VolcesPlatformAdapter();
        var normalizedSize = adapter.NormalizeSize(requestedSize);
        Assert.Equal(expectedSize, normalizedSize);

        var request = adapter.BuildGenerationRequest(modelName, "A test", 1, requestedSize, "url");
        var dict = (Dictionary<string, object>)request;

        // Verify the request has the normalized size
        Assert.Equal(expectedSize, dict["size"]?.ToString());
        _output.WriteLine($"Requested: {requestedSize}, Normalized: {dict["size"]}");
    }

    /// <summary>
    /// 测试 Volces 不同模型
    /// </summary>
    [Theory]
    [InlineData("doubao-seedream-4-5-pro")]
    [InlineData("doubao-seedream-4-0")]
    public void Volces_DifferentModels_AdapterSelection(string modelName)
    {
        var apiUrl = "https://ark.cn-beijing.volces.com";
        var adapter = ImageGenPlatformAdapterFactory.GetAdapter(apiUrl, modelName);

        Assert.Equal("volces", adapter.PlatformType);
        Assert.False(adapter.SupportsImageToImage);
        Assert.True(adapter.ForceUrlResponseFormat);

        _output.WriteLine($"Model {modelName}: Adapter type = {adapter.PlatformType}");
    }

    #endregion

    #region Error Handling Tests

    /// <summary>
    /// 测试 Volces 尺寸错误自动重试建议
    /// </summary>
    [Theory]
    [InlineData("size must be at least 1920x1920 pixels", "512x512", "1920x1920")]
    [InlineData("The requested size 1024x1024 is too small", "1024x1024", "1920x1920")]
    public void Volces_SizeError_ReturnsSuggestion(string errorMessage, string currentSize, string? expectedSuggestion)
    {
        var adapter = new VolcesPlatformAdapter();
        var suggestion = adapter.HandleSizeError(errorMessage, currentSize);

        if (expectedSuggestion != null)
        {
            Assert.Equal(expectedSuggestion, suggestion);
            _output.WriteLine($"Error '{errorMessage}' -> Suggestion: {suggestion}");
        }
        else
        {
            Assert.Null(suggestion);
            _output.WriteLine($"Error '{errorMessage}' -> No suggestion (already at minimum or unrecognized error)");
        }
    }

    #endregion

    #region Cross-Platform Comparison Tests

    /// <summary>
    /// 对比不同平台的请求格式差异
    /// </summary>
    [Fact]
    public void CompareRequestFormats_BetweenPlatforms()
    {
        var openaiAdapter = new OpenAIPlatformAdapter();
        var volcesAdapter = new VolcesPlatformAdapter();

        var openaiReq = openaiAdapter.BuildGenerationRequest("dall-e-3", "A cat", 1, "1024x1024", "b64_json");
        var volcesReq = volcesAdapter.BuildGenerationRequest("doubao-seedream-4-5-pro", "A cat", 1, "1024x1024", "b64_json");

        var openaiJson = openaiAdapter.SerializeRequest(openaiReq);
        var volcesJson = volcesAdapter.SerializeRequest(volcesReq);

        _output.WriteLine("=== OpenAI Request ===");
        _output.WriteLine(openaiJson);
        _output.WriteLine("\n=== Volces Request ===");
        _output.WriteLine(volcesJson);

        // Verify differences
        var openaiDict = (Dictionary<string, object>)openaiReq;
        var volcesDict = (Dictionary<string, object>)volcesReq;

        // OpenAI respects the requested response format
        Assert.Equal("b64_json", openaiDict["response_format"]);
        // Volces forces url
        Assert.Equal("url", volcesDict["response_format"]);

        // OpenAI keeps the requested size
        Assert.Equal("1024x1024", openaiDict["size"]);
        // Volces normalizes to minimum 1920x1920
        Assert.Equal("1920x1920", volcesDict["size"]);

        // Volces has additional fields
        Assert.True(volcesDict.ContainsKey("watermark"));
        Assert.True(volcesDict.ContainsKey("stream"));
        Assert.True(volcesDict.ContainsKey("sequential_image_generation"));
    }

    #endregion
}
