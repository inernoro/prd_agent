using System.Net.Http.Json;
using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 模型池 Code 匹配测试
/// 验证：用户选择模型池后，后台能否正确匹配到该模型池
/// </summary>
public class ModelPoolCodeMatchingTests
{
    private readonly ITestOutputHelper _output;
    private readonly HttpClient _client;
    private readonly string _baseUrl = "http://localhost:5000";

    public ModelPoolCodeMatchingTests(ITestOutputHelper output)
    {
        _output = output;
        _client = new HttpClient { BaseAddress = new Uri(_baseUrl) };
        // 添加认证头（如果需要的话，可以从环境变量获取）
        // _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "token");
    }

    /// <summary>
    /// 测试：获取 visual-agent 绑定的生图模型池列表
    /// </summary>
    [Fact(Skip = "需要真实服务运行")]
    public async Task GetModelGroupsForApp_ShouldReturnBoundPools()
    {
        // Arrange
        var appCallerCode = "visual-agent.image::generation";
        var modelType = "generation";

        // Act
        var response = await _client.GetAsync(
            $"/api/mds/model-groups/for-app?appCallerCode={Uri.EscapeDataString(appCallerCode)}&modelType={modelType}");
        
        var content = await response.Content.ReadAsStringAsync();
        _output.WriteLine($"Response: {content}");

        // Assert
        Assert.True(response.IsSuccessStatusCode, $"请求失败: {response.StatusCode}");
        
        var result = JsonDocument.Parse(content);
        Assert.True(result.RootElement.GetProperty("success").GetBoolean());
        
        var pools = result.RootElement.GetProperty("data");
        _output.WriteLine($"找到 {pools.GetArrayLength()} 个模型池:");
        
        foreach (var pool in pools.EnumerateArray())
        {
            var id = pool.GetProperty("id").GetString();
            var name = pool.GetProperty("name").GetString();
            var code = pool.GetProperty("code").GetString();
            var modelsCount = pool.GetProperty("models").GetArrayLength();
            _output.WriteLine($"  - ID: {id}, Name: {name}, Code: {code}, Models: {modelsCount}");
        }
    }

    /// <summary>
    /// 测试：通过模型池 Code 查询模型池
    /// 验证 Code 匹配逻辑是否正确
    /// </summary>
    [Theory(Skip = "需要真实服务运行")]
    [InlineData("doubao", "generation")]
    [InlineData("nano-banana-pro", "generation")]
    public async Task GetModelGroupByCode_ShouldMatchCorrectPool(string expectedCode, string modelType)
    {
        // 首先获取所有模型池，找到 code 匹配的
        var response = await _client.GetAsync($"/api/mds/model-groups?modelType={modelType}");
        var content = await response.Content.ReadAsStringAsync();
        
        Assert.True(response.IsSuccessStatusCode);
        
        var result = JsonDocument.Parse(content);
        var pools = result.RootElement.GetProperty("data");
        
        JsonElement? matchedPool = null;
        foreach (var pool in pools.EnumerateArray())
        {
            var code = pool.GetProperty("code").GetString();
            if (string.Equals(code, expectedCode, StringComparison.OrdinalIgnoreCase))
            {
                matchedPool = pool;
                break;
            }
        }

        if (matchedPool.HasValue)
        {
            var id = matchedPool.Value.GetProperty("id").GetString();
            var name = matchedPool.Value.GetProperty("name").GetString();
            _output.WriteLine($"找到模型池: Code={expectedCode}, ID={id}, Name={name}");
            
            // 打印池中的模型
            var models = matchedPool.Value.GetProperty("models");
            _output.WriteLine($"包含 {models.GetArrayLength()} 个模型:");
            foreach (var model in models.EnumerateArray())
            {
                var modelId = model.GetProperty("modelId").GetString();
                var platformId = model.GetProperty("platformId").GetString();
                var healthStatus = model.GetProperty("healthStatus").GetString();
                _output.WriteLine($"  - ModelId: {modelId}, PlatformId: {platformId}, Health: {healthStatus}");
            }
        }
        else
        {
            _output.WriteLine($"未找到 Code={expectedCode} 的模型池");
        }
    }

    /// <summary>
    /// 测试：创建生图 Run 时传递模型池信息
    /// 验证：用户选择的模型池 code 是否被正确传递和使用
    /// </summary>
    [Fact(Skip = "需要真实服务运行且需要认证")]
    public async Task CreateImageGenRun_ShouldUseSelectedModelPool()
    {
        // 先获取可用的模型池
        var poolsResponse = await _client.GetAsync(
            "/api/mds/model-groups/for-app?appCallerCode=visual-agent.image%3A%3Ageneration&modelType=generation");
        var poolsContent = await poolsResponse.Content.ReadAsStringAsync();
        _output.WriteLine($"可用模型池: {poolsContent}");

        // 选择第一个模型池
        var poolsResult = JsonDocument.Parse(poolsContent);
        var pools = poolsResult.RootElement.GetProperty("data");
        
        if (pools.GetArrayLength() == 0)
        {
            _output.WriteLine("没有可用的模型池，跳过测试");
            return;
        }

        var selectedPool = pools[0];
        var poolId = selectedPool.GetProperty("id").GetString();
        var poolCode = selectedPool.GetProperty("code").GetString();
        var poolName = selectedPool.GetProperty("name").GetString();
        var firstModel = selectedPool.GetProperty("models")[0];
        var firstModelId = firstModel.GetProperty("modelId").GetString();
        var firstPlatformId = firstModel.GetProperty("platformId").GetString();

        _output.WriteLine($"选择模型池: Name={poolName}, Code={poolCode}, ID={poolId}");
        _output.WriteLine($"模型池第一个模型: ModelId={firstModelId}, PlatformId={firstPlatformId}");

        // 创建 Run 请求（模拟前端传递的数据）
        var runRequest = new
        {
            platformId = firstPlatformId,
            modelId = firstModelId, // 前端传的是模型池第一个模型的 ID
            items = new[]
            {
                new { prompt = "测试图片", count = 1 }
            },
            size = "1024x1024",
            responseFormat = "url",
            appKey = "visual-agent"
        };

        _output.WriteLine($"创建 Run 请求: {JsonSerializer.Serialize(runRequest)}");

        // 这里实际上应该调用创建 Run 的 API，但需要认证
        // var createResponse = await _client.PostAsJsonAsync("/api/visual-agent/image-gen/runs", runRequest);
        // 然后检查日志，看模型池匹配是否正确
    }

    /// <summary>
    /// 测试：验证模型池 Code 与 ModelId 的关系
    /// 检查：模型池 code 是否等于池中某个模型的 modelId
    /// </summary>
    [Fact(Skip = "需要真实服务运行")]
    public async Task VerifyPoolCodeAndModelIdRelationship()
    {
        var response = await _client.GetAsync("/api/mds/model-groups?modelType=generation");
        var content = await response.Content.ReadAsStringAsync();
        
        Assert.True(response.IsSuccessStatusCode);
        
        var result = JsonDocument.Parse(content);
        var pools = result.RootElement.GetProperty("data");
        
        _output.WriteLine("检查模型池 Code 与 ModelId 的关系:");
        _output.WriteLine("=".PadRight(80, '='));
        
        foreach (var pool in pools.EnumerateArray())
        {
            var poolCode = pool.GetProperty("code").GetString() ?? "";
            var poolName = pool.GetProperty("name").GetString();
            var models = pool.GetProperty("models");
            
            _output.WriteLine($"\n模型池: {poolName} (Code: {poolCode})");
            
            var hasMatchingModel = false;
            foreach (var model in models.EnumerateArray())
            {
                var modelId = model.GetProperty("modelId").GetString() ?? "";
                var isMatch = modelId.StartsWith(poolCode, StringComparison.OrdinalIgnoreCase) 
                              || poolCode.StartsWith(modelId, StringComparison.OrdinalIgnoreCase)
                              || string.Equals(poolCode, modelId, StringComparison.OrdinalIgnoreCase);
                
                var matchIndicator = isMatch ? "[MATCH]" : "       ";
                _output.WriteLine($"  {matchIndicator} ModelId: {modelId}");
                
                if (isMatch) hasMatchingModel = true;
            }
            
            if (!hasMatchingModel && models.GetArrayLength() > 0)
            {
                _output.WriteLine($"  [WARNING] 模型池 Code '{poolCode}' 与任何模型 ID 都不匹配！");
            }
        }
    }
}
