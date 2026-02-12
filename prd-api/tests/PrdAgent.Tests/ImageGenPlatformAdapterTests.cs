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
    [InlineData("https://open-platform.example.com/api/v1/open-platform", "https://open-platform.example.com/api/v1/open-platform/images/generations", "开放平台风格")]
    [InlineData("https://open-platform.example.com/api", "https://open-platform.example.com/api/v1/images/generations", "仅 /api 路径")]
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
            ("https://open-platform.example.com/api", "仅 /api 路径"),
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

    #region Gateway Integration Tests (URL 拼接链路验证)

    /// <summary>
    /// 模拟 Gateway 的 URL 拼接逻辑，验证不会出现重复路径
    /// 这是 Volces 404 错误的回归测试
    ///
    /// 实际调用链：
    /// 1. OpenAIImageClient.GenerateAsync() 调用 platformAdapter.GetGenerationsEndpoint(apiUrl)
    /// 2. 提取 endpointPath（应该只是能力路径，如 "images/generations"）
    /// 3. Gateway.SendRawAsync() 拼接 baseUrl + endpointPath
    ///
    /// 错误场景（已修复）：
    /// - endpointPath = "/api/v3/images/generations"（包含版本前缀）
    /// - Gateway 拼接：baseUrl(/api/v3) + endpointPath(/api/v3/images/generations)
    /// - 结果：/api/v3/api/v3/images/generations（重复！）
    /// </summary>
    [Theory]
    // Volces 场景
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "images/generations",
        "https://ark.cn-beijing.volces.com/api/v3/images/generations", "Volces 标准场景")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/", "images/generations",
        "https://ark.cn-beijing.volces.com/api/v3/images/generations", "Volces 末尾斜杠")]
    [InlineData("https://ark.cn-beijing.volces.com", "images/generations",
        "https://ark.cn-beijing.volces.com/images/generations", "Volces 无版本前缀")]
    // OpenAI 场景
    [InlineData("https://api.openai.com/v1", "images/generations",
        "https://api.openai.com/v1/images/generations", "OpenAI 标准场景")]
    [InlineData("https://api.openai.com/v1/", "images/generations",
        "https://api.openai.com/v1/images/generations", "OpenAI 末尾斜杠")]
    [InlineData("https://gateway.example.com/api/v1/open-platform", "images/generations",
        "https://gateway.example.com/api/v1/open-platform/images/generations", "开放平台网关")]
    public void GatewayUrlConstruction_NoPathDuplication(string baseUrl, string endpointPath, string expected, string scenario)
    {
        // 模拟 Gateway 的 URL 拼接逻辑（LlmGateway.cs:332-335）
        var baseUrlTrimmed = baseUrl.TrimEnd('/');
        var actual = string.IsNullOrWhiteSpace(endpointPath)
            ? $"{baseUrlTrimmed}/v1/chat/completions"
            : $"{baseUrlTrimmed}{(endpointPath.StartsWith("/") ? "" : "/")}{endpointPath}";

        _output.WriteLine($"[Gateway 拼接测试] {scenario}");
        _output.WriteLine($"  baseUrl: {baseUrl}");
        _output.WriteLine($"  endpointPath: {endpointPath}");
        _output.WriteLine($"  预期: {expected}");
        _output.WriteLine($"  实际: {actual}");
        _output.WriteLine($"  结果: {(actual == expected ? "✅ PASS" : "❌ FAIL")}");
        _output.WriteLine("");

        Assert.Equal(expected, actual);

        // 额外验证：确保没有重复的版本前缀
        Assert.DoesNotContain("/api/v3/api/v3", actual);
        Assert.DoesNotContain("/v1/v1", actual);
    }

    /// <summary>
    /// 回归测试：验证旧的错误场景不会再发生
    /// 这些是实际导致 404 错误的 URL 组合
    /// </summary>
    [Theory]
    // 错误场景：endpointPath 包含完整路径（这是旧代码的 bug）
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "/api/v3/images/generations",
        "错误：endpointPath 不应包含版本前缀")]
    [InlineData("https://api.openai.com/v1", "/v1/images/generations",
        "错误：endpointPath 不应包含版本前缀")]
    public void GatewayUrlConstruction_DetectBadEndpointPath(string baseUrl, string badEndpointPath, string errorDescription)
    {
        // 模拟 Gateway 拼接
        var baseUrlTrimmed = baseUrl.TrimEnd('/');
        var result = $"{baseUrlTrimmed}{(badEndpointPath.StartsWith("/") ? "" : "/")}{badEndpointPath}";

        _output.WriteLine($"[回归测试 - 检测错误的 endpointPath]");
        _output.WriteLine($"  {errorDescription}");
        _output.WriteLine($"  baseUrl: {baseUrl}");
        _output.WriteLine($"  badEndpointPath: {badEndpointPath}");
        _output.WriteLine($"  结果 URL: {result}");
        _output.WriteLine("");

        // 验证这种组合会导致重复路径（这是我们要避免的）
        var hasDuplicateVolces = result.Contains("/api/v3/api/v3");
        var hasDuplicateOpenAI = result.Contains("/v1/v1");

        _output.WriteLine($"  是否有重复路径: {(hasDuplicateVolces || hasDuplicateOpenAI ? "是 ❌（这就是 bug！）" : "否")}");

        // 这个测试的目的是记录错误场景，帮助理解 bug
        // 实际修复是在 OpenAIImageClient 中让 endpointPath 只使用能力路径
        Assert.True(hasDuplicateVolces || hasDuplicateOpenAI,
            "此测试用于演示错误的 endpointPath 会导致重复路径");
    }

    /// <summary>
    /// 验证正确的 endpointPath 使用方式
    /// endpointPath 应该只是能力路径（如 "images/generations"），不包含版本前缀
    /// </summary>
    [Fact]
    public void EndpointPath_ShouldBeCapabilityPathOnly()
    {
        // 正确的 endpointPath 值
        var correctEndpointPaths = new[]
        {
            "images/generations",
            "images/edits",
            "chat/completions",
            "embeddings",
            "audio/transcriptions",
        };

        // 错误的 endpointPath 值（包含版本前缀）
        var incorrectEndpointPaths = new[]
        {
            "/v1/images/generations",
            "/api/v3/images/generations",
            "v1/images/generations",
            "api/v3/images/generations",
        };

        _output.WriteLine("=== endpointPath 规范 ===");
        _output.WriteLine("");
        _output.WriteLine("✅ 正确的 endpointPath（仅能力路径）:");
        foreach (var path in correctEndpointPaths)
        {
            _output.WriteLine($"   - {path}");
            Assert.DoesNotContain("/v1", path);
            Assert.DoesNotContain("/api/v3", path);
            Assert.DoesNotContain("v1/", path);
            Assert.DoesNotContain("api/v3/", path);
        }

        _output.WriteLine("");
        _output.WriteLine("❌ 错误的 endpointPath（包含版本前缀）:");
        foreach (var path in incorrectEndpointPaths)
        {
            _output.WriteLine($"   - {path}");
            var hasVersionPrefix = path.Contains("v1") || path.Contains("api/v3");
            Assert.True(hasVersionPrefix, $"{path} 应该包含版本前缀（用于演示错误示例）");
        }

        _output.WriteLine("");
        _output.WriteLine("📌 规则：Gateway 会自动拼接 baseUrl（已包含版本前缀）+ endpointPath");
        _output.WriteLine("   如果 endpointPath 也包含版本前缀，就会导致重复！");
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
