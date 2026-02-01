using System.Text.Json;
using PrdAgent.Infrastructure.LLM.Adapters;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 平台适配器单元测试
/// </summary>
public class ImageGenPlatformAdapterTests
{
    private readonly ITestOutputHelper _output;

    public ImageGenPlatformAdapterTests(ITestOutputHelper output)
    {
        _output = output;
    }
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
    [InlineData("https://api.openai.com", "https://api.openai.com/v1/images/generations")]
    [InlineData("https://api.openai.com/v1", "https://api.openai.com/v1/images/generations")]
    [InlineData("https://api.openai.com/v1/", "https://api.openai.com/v1/images/generations")]
    [InlineData("https://custom-gateway.example.com", "https://custom-gateway.example.com/v1/images/generations")]
    [InlineData("https://custom-gateway.example.com/v1/images/generations#", "https://custom-gateway.example.com/v1/images/generations")] // force exact url
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

    /// <summary>
    /// Volces 端点构建 - 全面测试（包含所有边缘情况）
    /// </summary>
    [Theory]
    // === 基础场景 ===
    [InlineData("https://ark.cn-beijing.volces.com", "https://ark.cn-beijing.volces.com/api/v3/images/generations", "无路径")]
    [InlineData("https://ark.cn-beijing.volces.com/", "https://ark.cn-beijing.volces.com/api/v3/images/generations", "仅末尾斜杠")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "https://ark.cn-beijing.volces.com/api/v3/images/generations", "已有 /api/v3 无斜杠")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/", "https://ark.cn-beijing.volces.com/api/v3/images/generations", "已有 /api/v3/ 带斜杠")]
    // === 强制模式 (#) ===
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/images/generations#", "https://ark.cn-beijing.volces.com/api/v3/images/generations", "# 强制完整端点")]
    [InlineData("https://custom.example.com/custom/path#", "https://custom.example.com/custom/path", "# 强制自定义路径")]
    // === 重复路径场景（404 错误根因）===
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/api/v3", "https://ark.cn-beijing.volces.com/api/v3/images/generations", "重复 /api/v3/api/v3 去重")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/api/v3/", "https://ark.cn-beijing.volces.com/api/v3/images/generations", "重复 /api/v3/api/v3/ 带斜杠去重")]
    // === 不同区域 ===
    [InlineData("https://ark.cn-shanghai.volces.com", "https://ark.cn-shanghai.volces.com/api/v3/images/generations", "上海区域")]
    [InlineData("https://ark.cn-guangzhou.volces.com/api/v3", "https://ark.cn-guangzhou.volces.com/api/v3/images/generations", "广州区域")]
    // === 自定义端口 ===
    [InlineData("https://ark.cn-beijing.volces.com:8443", "https://ark.cn-beijing.volces.com:8443/api/v3/images/generations", "自定义端口")]
    [InlineData("https://ark.cn-beijing.volces.com:8443/api/v3", "https://ark.cn-beijing.volces.com:8443/api/v3/images/generations", "自定义端口+路径")]
    // === HTTP 协议 ===
    [InlineData("http://localhost:5000", "http://localhost:5000/api/v3/images/generations", "本地开发 HTTP")]
    [InlineData("http://localhost:5000/api/v3", "http://localhost:5000/api/v3/images/generations", "本地开发已有路径")]
    // === 空值/异常 ===
    [InlineData("", "", "空字符串")]
    [InlineData("   ", "", "空白字符串")]
    public void VolcesAdapter_GetGenerationsEndpoint_AllScenarios(string baseUrl, string expected, string scenario)
    {
        var adapter = new VolcesPlatformAdapter();
        var actual = adapter.GetGenerationsEndpoint(baseUrl);

        _output.WriteLine($"[Volces] {scenario}");
        _output.WriteLine($"  输入: {baseUrl}");
        _output.WriteLine($"  预期: {expected}");
        _output.WriteLine($"  实际: {actual}");
        _output.WriteLine($"  结果: {(actual == expected ? "✅ PASS" : "❌ FAIL")}");
        _output.WriteLine("");

        Assert.Equal(expected, actual);
    }

    /// <summary>
    /// OpenAI 端点构建 - 全面测试（包含所有边缘情况）
    /// </summary>
    [Theory]
    // === 基础场景 ===
    [InlineData("https://api.openai.com", "https://api.openai.com/v1/images/generations", "无路径")]
    [InlineData("https://api.openai.com/", "https://api.openai.com/v1/images/generations", "仅末尾斜杠")]
    [InlineData("https://api.openai.com/v1", "https://api.openai.com/v1/images/generations", "已有 /v1 无斜杠")]
    [InlineData("https://api.openai.com/v1/", "https://api.openai.com/v1/images/generations", "已有 /v1/ 带斜杠")]
    // === 强制模式 (#) ===
    [InlineData("https://api.openai.com/v1/images/generations#", "https://api.openai.com/v1/images/generations", "# 强制完整端点")]
    [InlineData("https://custom.example.com/custom/endpoint#", "https://custom.example.com/custom/endpoint", "# 强制自定义路径")]
    // === 重复路径场景 ===
    [InlineData("https://api.openai.com/v1/v1", "https://api.openai.com/v1/images/generations", "重复 /v1/v1 去重")]
    [InlineData("https://api.openai.com/v1/v1/", "https://api.openai.com/v1/images/generations", "重复 /v1/v1/ 带斜杠去重")]
    // === 自定义网关 ===
    [InlineData("https://gateway.example.com", "https://gateway.example.com/v1/images/generations", "自定义网关无路径")]
    [InlineData("https://gateway.example.com/v1", "https://gateway.example.com/v1/images/generations", "自定义网关已有路径")]
    [InlineData("https://gateway.example.com/api/v1", "https://gateway.example.com/api/v1/images/generations", "自定义网关 /api/v1")]
    [InlineData("https://gateway.example.com/api/v1/", "https://gateway.example.com/api/v1/images/generations", "自定义网关 /api/v1/")]
    // === 开放平台风格 URL ===
    [InlineData("https://pa.759800.com/api/v1/open-platform", "https://pa.759800.com/api/v1/open-platform/images/generations", "开放平台风格")]
    [InlineData("https://pa.759800.com/api", "https://pa.759800.com/api/v1/images/generations", "仅 /api 路径")]
    // === 自定义端口 ===
    [InlineData("https://api.openai.com:8443", "https://api.openai.com:8443/v1/images/generations", "自定义端口")]
    [InlineData("https://api.openai.com:8443/v1", "https://api.openai.com:8443/v1/images/generations", "自定义端口+路径")]
    // === HTTP 协议 ===
    [InlineData("http://localhost:5000", "http://localhost:5000/v1/images/generations", "本地开发 HTTP")]
    [InlineData("http://localhost:5000/v1", "http://localhost:5000/v1/images/generations", "本地开发已有路径")]
    // === 空值/异常 ===
    [InlineData("", "", "空字符串")]
    [InlineData("   ", "", "空白字符串")]
    public void OpenAIAdapter_GetGenerationsEndpoint_AllScenarios(string baseUrl, string expected, string scenario)
    {
        var adapter = new OpenAIPlatformAdapter();
        var actual = adapter.GetGenerationsEndpoint(baseUrl);

        _output.WriteLine($"[OpenAI] {scenario}");
        _output.WriteLine($"  输入: {baseUrl}");
        _output.WriteLine($"  预期: {expected}");
        _output.WriteLine($"  实际: {actual}");
        _output.WriteLine($"  结果: {(actual == expected ? "✅ PASS" : "❌ FAIL")}");
        _output.WriteLine("");

        Assert.Equal(expected, actual);
    }

    /// <summary>
    /// 打印所有 URL 场景的完整对照表（用于人工审核）
    /// </summary>
    [Fact]
    public void PrintAllEndpointScenarios_ForManualReview()
    {
        var volcesAdapter = new VolcesPlatformAdapter();
        var openaiAdapter = new OpenAIPlatformAdapter();

        var volcesTestCases = new[]
        {
            ("https://ark.cn-beijing.volces.com", "无路径"),
            ("https://ark.cn-beijing.volces.com/", "仅末尾斜杠"),
            ("https://ark.cn-beijing.volces.com/api/v3", "已有 /api/v3 无斜杠"),
            ("https://ark.cn-beijing.volces.com/api/v3/", "已有 /api/v3/ 带斜杠"),
            ("https://ark.cn-beijing.volces.com/api/v3/images/generations#", "# 强制完整端点"),
            ("https://ark.cn-beijing.volces.com/api/v3/api/v3", "重复路径（404根因）"),
            ("https://ark.cn-beijing.volces.com/api/v3/api/v3/", "重复路径带斜杠"),
            ("https://ark.cn-shanghai.volces.com/api/v3", "上海区域"),
            ("http://localhost:5000/api/v3", "本地开发"),
        };

        var openaiTestCases = new[]
        {
            ("https://api.openai.com", "无路径"),
            ("https://api.openai.com/", "仅末尾斜杠"),
            ("https://api.openai.com/v1", "已有 /v1 无斜杠"),
            ("https://api.openai.com/v1/", "已有 /v1/ 带斜杠"),
            ("https://api.openai.com/v1/images/generations#", "# 强制完整端点"),
            ("https://api.openai.com/v1/v1", "重复路径"),
            ("https://gateway.example.com/api/v1/open-platform", "开放平台风格"),
            ("https://pa.759800.com/api", "仅 /api 路径"),
            ("http://localhost:5000/v1", "本地开发"),
        };

        _output.WriteLine("╔════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗");
        _output.WriteLine("║                                    Volces/豆包 端点构建测试结果                                                ║");
        _output.WriteLine("╠════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");
        _output.WriteLine("║ 场景                 │ 输入 URL                                      │ 输出 Endpoint                            ║");
        _output.WriteLine("╠════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");

        foreach (var (url, desc) in volcesTestCases)
        {
            var result = volcesAdapter.GetGenerationsEndpoint(url);
            _output.WriteLine($"║ {desc,-18} │ {url,-45} │ {result,-40} ║");
        }

        _output.WriteLine("╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝");
        _output.WriteLine("");
        _output.WriteLine("╔════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗");
        _output.WriteLine("║                                    OpenAI 端点构建测试结果                                                     ║");
        _output.WriteLine("╠════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");
        _output.WriteLine("║ 场景                 │ 输入 URL                                      │ 输出 Endpoint                            ║");
        _output.WriteLine("╠════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");

        foreach (var (url, desc) in openaiTestCases)
        {
            var result = openaiAdapter.GetGenerationsEndpoint(url);
            _output.WriteLine($"║ {desc,-18} │ {url,-45} │ {result,-40} ║");
        }

        _output.WriteLine("╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝");

        // 这个测试仅用于打印，始终通过
        Assert.True(true);
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
