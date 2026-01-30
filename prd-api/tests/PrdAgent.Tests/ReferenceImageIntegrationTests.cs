using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 底图/参考图功能集成测试（真实请求）
/// 
/// 运行前设置环境变量：
///   export VVEAI_API_KEY="your-vveai-api-key"
///   export TEST_ADMIN_TOKEN="your-admin-jwt-token"
///   export TEST_API_BASE_URL="http://localhost:5000" (可选，默认 http://localhost:5000)
/// 
/// 运行命令（本地测试，CI 跳过）：
///   dotnet test tests/PrdAgent.Tests --filter "FullyQualifiedName~ReferenceImageRealTest" --no-build -v n
/// 
/// 图片保存位置：tests/PrdAgent.Tests/GeneratedImages/reference-image/{timestamp}.png
/// </summary>
[Trait("Category", "Integration")]
[Trait("Skip", "CI")] // CI 环境跳过
public class ReferenceImageIntegrationTests
{
    private readonly ITestOutputHelper _output;

    // 图片保存目录
    private static readonly string ImageOutputDir = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "GeneratedImages", "reference-image");

    // 从环境变量读取配置
    private static readonly string? VveaiApiKey = Environment.GetEnvironmentVariable("VVEAI_API_KEY");
    private static readonly string? AdminToken = Environment.GetEnvironmentVariable("TEST_ADMIN_TOKEN");
    private static readonly string ApiBaseUrl = Environment.GetEnvironmentVariable("TEST_API_BASE_URL") ?? "http://localhost:5000";

    // 测试用的参考图（使用公开的测试图片 URL）
    private const string TestReferenceImageUrl = "https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=512";

    // 默认参考图风格提示词
    private const string DefaultReferencePrompt = "请参考图中的风格、色调、构图和视觉元素来生成图片，保持整体美学风格的一致性。";

    public ReferenceImageIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
        Directory.CreateDirectory(ImageOutputDir);
    }

    private void EnsureEnvVar(string? value, string envVarName)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            _output.WriteLine($"[ERROR] 环境变量 {envVarName} 未设置");
            _output.WriteLine($"  请执行: export {envVarName}=\"your-value\"");
            throw new InvalidOperationException($"环境变量 {envVarName} 未设置");
        }
    }

    /// <summary>
    /// 测试：创建底图配置 -> 激活 -> 使用底图生成图片
    /// </summary>
    [Fact]
    public async Task ReferenceImageRealTest_CreateAndGenerate()
    {
        EnsureEnvVar(AdminToken, "TEST_ADMIN_TOKEN");
        _output.WriteLine("========================================");
        _output.WriteLine("底图/参考图功能集成测试");
        _output.WriteLine("========================================");

        using var httpClient = new HttpClient { BaseAddress = new Uri(ApiBaseUrl) };
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken);

        // 1. 下载测试参考图
        _output.WriteLine("\n[步骤 1] 下载测试参考图...");
        byte[] refImageBytes;
        using (var downloadClient = new HttpClient())
        {
            refImageBytes = await downloadClient.GetByteArrayAsync(TestReferenceImageUrl);
        }
        _output.WriteLine($"  下载完成，图片大小: {refImageBytes.Length / 1024} KB");

        // 保存参考图到本地
        var refImagePath = Path.Combine(ImageOutputDir, "reference_source.jpg");
        await File.WriteAllBytesAsync(refImagePath, refImageBytes);
        _output.WriteLine($"  参考图保存到: {refImagePath}");

        // 2. 创建底图配置
        _output.WriteLine("\n[步骤 2] 创建底图配置...");
        var configName = $"测试底图配置_{DateTime.Now:yyyyMMdd_HHmmss}";
        var createContent = new MultipartFormDataContent();
        createContent.Add(new StringContent(configName), "name");
        createContent.Add(new StringContent(DefaultReferencePrompt), "prompt");
        createContent.Add(new ByteArrayContent(refImageBytes), "file", "reference.jpg");

        var createResponse = await httpClient.PostAsync("/api/literary-agent/config/reference-images", createContent);
        var createJson = await createResponse.Content.ReadAsStringAsync();
        _output.WriteLine($"  响应状态: {createResponse.StatusCode}");
        _output.WriteLine($"  响应内容: {createJson}");

        if (!createResponse.IsSuccessStatusCode)
        {
            _output.WriteLine("  [ERROR] 创建底图配置失败");
            return;
        }

        var createResult = JsonDocument.Parse(createJson);
        var configId = createResult.RootElement.GetProperty("data").GetProperty("config").GetProperty("id").GetString();
        var imageUrl = createResult.RootElement.GetProperty("data").GetProperty("config").GetProperty("imageUrl").GetString();
        _output.WriteLine($"  配置 ID: {configId}");
        _output.WriteLine($"  底图 URL: {imageUrl}");

        // 3. 激活底图配置
        _output.WriteLine("\n[步骤 3] 激活底图配置...");
        var activateResponse = await httpClient.PostAsync($"/api/literary-agent/config/reference-images/{configId}/activate", null);
        var activateJson = await activateResponse.Content.ReadAsStringAsync();
        _output.WriteLine($"  响应状态: {activateResponse.StatusCode}");

        if (!activateResponse.IsSuccessStatusCode)
        {
            _output.WriteLine("  [ERROR] 激活底图配置失败");
            return;
        }

        // 4. 获取当前激活的配置（验证）
        _output.WriteLine("\n[步骤 4] 验证当前激活的配置...");
        var activeResponse = await httpClient.GetAsync("/api/literary-agent/config/reference-images/active");
        var activeJson = await activeResponse.Content.ReadAsStringAsync();
        _output.WriteLine($"  响应内容: {activeJson}");

        // 5. 调用生图 API（通过旧 API 方式，会自动使用激活的底图配置）
        _output.WriteLine("\n[步骤 5] 使用底图生成图片...");
        _output.WriteLine($"  提示词: 一只可爱的橘猫坐在木桌上，柔和的光线");

        // 注意：这里需要生图模型配置才能实际生成
        // 如果没有配置生图模型，可以跳过这一步
        var generateRequest = new
        {
            items = new[]
            {
                new { prompt = "一只可爱的橘猫坐在木桌上，柔和的光线，高品质", count = 1, size = "1024x1024" }
            },
            size = "1024x1024",
            responseFormat = "url",
            maxConcurrency = 1,
            appKey = "literary-agent"
        };

        var generateContent = new StringContent(JsonSerializer.Serialize(generateRequest), Encoding.UTF8, "application/json");
        var generateResponse = await httpClient.PostAsync("/api/visual-agent/image-gen/runs", generateContent);
        var generateJson = await generateResponse.Content.ReadAsStringAsync();
        _output.WriteLine($"  响应状态: {generateResponse.StatusCode}");
        _output.WriteLine($"  响应内容: {generateJson}");

        if (generateResponse.IsSuccessStatusCode)
        {
            var genResult = JsonDocument.Parse(generateJson);
            if (genResult.RootElement.GetProperty("data").TryGetProperty("runId", out var runIdProp))
            {
                var runId = runIdProp.GetString();
                _output.WriteLine($"  Run ID: {runId}");
                _output.WriteLine($"  请等待 Worker 完成后查看生成结果...");
                
                // 等待一段时间后查询结果
                _output.WriteLine("\n[步骤 6] 等待生图完成...");
                await Task.Delay(15000); // 等待 15 秒
                
                var resultResponse = await httpClient.GetAsync($"/api/visual-agent/image-gen/runs/{runId}?includeItems=true&includeImages=true");
                var resultJson = await resultResponse.Content.ReadAsStringAsync();
                _output.WriteLine($"  Run 状态: {resultJson}");
                
                // 尝试提取生成的图片 URL
                try
                {
                    var resultDoc = JsonDocument.Parse(resultJson);
                    var items = resultDoc.RootElement.GetProperty("data").GetProperty("items");
                    foreach (var item in items.EnumerateArray())
                    {
                        if (item.TryGetProperty("url", out var urlProp) && urlProp.GetString() is { } url && !string.IsNullOrEmpty(url))
                        {
                            _output.WriteLine($"\n========================================");
                            _output.WriteLine($"生成的图片 URL: {url}");
                            _output.WriteLine($"========================================");
                        }
                    }
                }
                catch (Exception ex)
                {
                    _output.WriteLine($"  解析结果时出错: {ex.Message}");
                }
            }
        }
        else
        {
            _output.WriteLine("  [WARN] 生图请求失败（可能需要配置生图模型）");
        }

        // 7. 清理：删除测试配置
        _output.WriteLine("\n[步骤 7] 清理测试数据...");
        var deleteResponse = await httpClient.DeleteAsync($"/api/literary-agent/config/reference-images/{configId}");
        _output.WriteLine($"  删除响应状态: {deleteResponse.StatusCode}");

        _output.WriteLine("\n========================================");
        _output.WriteLine("测试完成！");
        _output.WriteLine("========================================");
    }

    /// <summary>
    /// 测试：列出所有底图配置
    /// </summary>
    [Fact]
    public async Task ReferenceImageRealTest_ListConfigs()
    {
        EnsureEnvVar(AdminToken, "TEST_ADMIN_TOKEN");
        
        using var httpClient = new HttpClient { BaseAddress = new Uri(ApiBaseUrl) };
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken);

        _output.WriteLine("获取所有底图配置列表...");
        var response = await httpClient.GetAsync("/api/literary-agent/config/reference-images");
        var json = await response.Content.ReadAsStringAsync();
        
        _output.WriteLine($"响应状态: {response.StatusCode}");
        _output.WriteLine($"响应内容: {json}");

        if (response.IsSuccessStatusCode)
        {
            var doc = JsonDocument.Parse(json);
            var items = doc.RootElement.GetProperty("data").GetProperty("items");
            _output.WriteLine($"\n配置数量: {items.GetArrayLength()}");
            
            foreach (var item in items.EnumerateArray())
            {
                var name = item.GetProperty("name").GetString();
                var isActive = item.GetProperty("isActive").GetBoolean();
                var imgUrl = item.TryGetProperty("imageUrl", out var urlProp) ? urlProp.GetString() : null;
                
                _output.WriteLine($"\n配置: {name}");
                _output.WriteLine($"  激活状态: {(isActive ? "是" : "否")}");
                _output.WriteLine($"  图片 URL: {imgUrl ?? "无"}");
            }
        }
    }

    /// <summary>
    /// 测试：获取当前激活的底图配置
    /// </summary>
    [Fact]
    public async Task ReferenceImageRealTest_GetActiveConfig()
    {
        EnsureEnvVar(AdminToken, "TEST_ADMIN_TOKEN");
        
        using var httpClient = new HttpClient { BaseAddress = new Uri(ApiBaseUrl) };
        httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", AdminToken);

        _output.WriteLine("获取当前激活的底图配置...");
        var response = await httpClient.GetAsync("/api/literary-agent/config/reference-images/active");
        var json = await response.Content.ReadAsStringAsync();
        
        _output.WriteLine($"响应状态: {response.StatusCode}");
        _output.WriteLine($"响应内容: {json}");

        if (response.IsSuccessStatusCode)
        {
            var doc = JsonDocument.Parse(json);
            var config = doc.RootElement.GetProperty("data").GetProperty("config");
            
            if (config.ValueKind == JsonValueKind.Null)
            {
                _output.WriteLine("\n当前没有激活的底图配置");
            }
            else
            {
                var name = config.GetProperty("name").GetString();
                var prompt = config.GetProperty("prompt").GetString();
                var imgUrl = config.TryGetProperty("imageUrl", out var urlProp) ? urlProp.GetString() : null;
                
                _output.WriteLine($"\n当前激活的配置:");
                _output.WriteLine($"  名称: {name}");
                _output.WriteLine($"  提示词: {prompt}");
                _output.WriteLine($"  图片 URL: {imgUrl ?? "无"}");
            }
        }
    }
}
