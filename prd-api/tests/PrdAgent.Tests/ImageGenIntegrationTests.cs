using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using PrdAgent.Infrastructure.LLM;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 本地集成测试：验证生图 API 调用（真实请求）
/// 
/// 运行前设置环境变量：
///   export VVEAI_API_KEY="your-vveai-api-key"
///   export VOLCES_API_KEY="your-volces-api-key"
/// 
/// 运行命令：
///   dotnet test tests/PrdAgent.Tests --filter "FullyQualifiedName~RealTest" --no-build -v n
/// 
/// 图片保存位置：tests/PrdAgent.Tests/GeneratedImages/{model}/{size}_{timestamp}.png
/// </summary>
[Trait("Category", "Integration")]
public class ImageGenIntegrationTests
{
    private readonly ITestOutputHelper _output;

    // 图片保存目录
    private static readonly string ImageOutputDir = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "GeneratedImages");

    // 统一提示词
    private const string TestPrompt = "A cute orange cat sitting on a wooden desk, soft lighting, high quality";

    // 从环境变量读取密钥
    private static readonly string? VveaiApiKey = Environment.GetEnvironmentVariable("VVEAI_API_KEY");
    private static readonly string? VolcesApiKey = Environment.GetEnvironmentVariable("VOLCES_API_KEY");

    private static PlatformConfig GetVveaiPlatform() => new()
    {
        Name = "VveAI",
        ApiUrl = "https://api.vveai.com",
        ApiKey = VveaiApiKey ?? throw new InvalidOperationException("请设置环境变量 VVEAI_API_KEY"),
        IsVolces = false
    };

    private static PlatformConfig GetVolcesPlatform() => new()
    {
        Name = "Volces",
        ApiUrl = "https://ark.cn-beijing.volces.com/api/v3/",
        ApiKey = VolcesApiKey ?? throw new InvalidOperationException("请设置环境变量 VOLCES_API_KEY"),
        IsVolces = true
    };

    public ImageGenIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private void EnsureApiKey(string? apiKey, string envVarName)
    {
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            _output.WriteLine($"[ERROR] 环境变量 {envVarName} 未设置");
            _output.WriteLine($"  请执行: export {envVarName}=\"your-api-key\"");
            throw new InvalidOperationException($"环境变量 {envVarName} 未设置");
        }
    }

    #region ========== 火山引擎（豆包）系列 ==========

    /// <summary>豆包 Seedream 4.5</summary>
    [Fact]
    public async Task RealTest_Volces_DoubaoSeedream45()
    {
        EnsureApiKey(VolcesApiKey, "VOLCES_API_KEY");
        await RunModelTestAsync(GetVolcesPlatform(), "doubao-seedream-4-5-251128");
    }

    /// <summary>豆包 Seedream 4.0</summary>
    [Fact]
    public async Task RealTest_Volces_DoubaoSeedream40()
    {
        EnsureApiKey(VolcesApiKey, "VOLCES_API_KEY");
        await RunModelTestAsync(GetVolcesPlatform(), "doubao-seedream-4-0-250828");
    }

    #endregion

    #region ========== VveAI（薇薇安）系列 - 有适配器配置的模型 ==========

    /// <summary>DALL-E 3 (OpenAI)</summary>
    [Fact]
    public async Task RealTest_VveAI_DallE3()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "dall-e-3");
    }

    /// <summary>DALL-E 2 (OpenAI)</summary>
    [Fact]
    public async Task RealTest_VveAI_DallE2()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "dall-e-2");
    }

    /// <summary>Nano-Banana Pro (Google Gemini)</summary>
    [Fact]
    public async Task RealTest_VveAI_NanoBananaPro()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "nano-banana-pro");
    }

    /// <summary>Flux Pro (Black Forest Labs)</summary>
    [Fact]
    public async Task RealTest_VveAI_FluxPro()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "flux-pro");
    }

    /// <summary>Flux Dev (Black Forest Labs)</summary>
    [Fact]
    public async Task RealTest_VveAI_FluxDev()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "flux-dev");
    }

    /// <summary>Stable Diffusion 3 (Stability AI)</summary>
    [Fact]
    public async Task RealTest_VveAI_StableDiffusion3()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "stable-diffusion-3-medium");
    }

    /// <summary>即梦 AI (字节跳动)</summary>
    [Fact]
    public async Task RealTest_VveAI_Jimeng()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "jimeng-image");
    }

    /// <summary>通义万相 qwen-image (阿里云)</summary>
    [Fact]
    public async Task RealTest_VveAI_QwenImage()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "qwen-image");
    }

    /// <summary>可灵 AI (快手)</summary>
    [Fact]
    public async Task RealTest_VveAI_Kling()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "kling-v1");
    }

    /// <summary>Grok-2 Image (xAI)</summary>
    [Fact]
    public async Task RealTest_VveAI_Grok2Image()
    {
        EnsureApiKey(VveaiApiKey, "VVEAI_API_KEY");
        await RunModelTestAsync(GetVveaiPlatform(), "grok-2-image");
    }

    #endregion

    #region ========== 核心测试逻辑 ==========

    private async Task RunModelTestAsync(PlatformConfig platform, string modelName)
    {
        _output.WriteLine("════════════════════════════════════════════════════════════════");
        _output.WriteLine($"  平台: {platform.Name}");
        _output.WriteLine($"  模型: {modelName}");
        _output.WriteLine($"  提示词: {TestPrompt}");
        _output.WriteLine("════════════════════════════════════════════════════════════════");
        _output.WriteLine("");

        // 创建图片保存目录
        var modelDir = Path.Combine(ImageOutputDir, SanitizeFileName(modelName));
        Directory.CreateDirectory(modelDir);
        _output.WriteLine($"图片保存目录: {Path.GetFullPath(modelDir)}");
        _output.WriteLine("");

        // 获取适配器信息
        var adapterInfo = ImageGenModelAdapterRegistry.GetAdapterInfo(modelName);
        if (adapterInfo == null)
        {
            _output.WriteLine("[WARN] 没有适配器配置，使用默认 1024x1024 测试");
            var result = await TestSingleSizeAsync(platform, modelName, "1024x1024", "1:1", "default", modelDir);
            PrintSingleResult(result);
            Assert.True(result.Success, $"测试失败: {result.ErrorMessage}");
            return;
        }

        _output.WriteLine($"适配器: {adapterInfo.AdapterName}");
        _output.WriteLine($"参数格式: {adapterInfo.SizeParamFormat}");
        _output.WriteLine("");

        // 打印白名单尺寸
        _output.WriteLine("白名单尺寸:");
        var totalSizes = 0;
        foreach (var tier in adapterInfo.SizesByResolution!)
        {
            if (tier.Value.Count > 0)
            {
                _output.WriteLine($"  [{tier.Key.ToUpper()}]: {string.Join(", ", tier.Value.Select(s => s.Size))}");
                totalSizes += tier.Value.Count;
            }
        }
        _output.WriteLine("");

        if (totalSizes == 0)
        {
            _output.WriteLine("[WARN] 没有配置白名单尺寸，跳过");
            return;
        }

        // 并发执行所有尺寸测试（最多 5 个并发）
        var allSizes = adapterInfo.SizesByResolution
            .SelectMany(tier => tier.Value.Select(s => (Tier: tier.Key, Size: s)))
            .ToList();

        _output.WriteLine($"开始并发测试 {allSizes.Count} 个尺寸（最多 5 并发）...");
        _output.WriteLine("");

        var totalStopwatch = Stopwatch.StartNew();

        // 使用 SemaphoreSlim 限制并发数
        var semaphore = new SemaphoreSlim(5);
        var tasks = allSizes.Select(async item =>
        {
            await semaphore.WaitAsync();
            try
            {
                return await TestSingleSizeAsync(platform, modelName, item.Size.Size, item.Size.AspectRatio, item.Tier, modelDir);
            }
            finally
            {
                semaphore.Release();
            }
        });

        var results = (await Task.WhenAll(tasks)).ToList();

        totalStopwatch.Stop();

        // 按 Tier 分组输出结果
        foreach (var tier in adapterInfo.SizesByResolution)
        {
            if (tier.Value.Count == 0) continue;
            _output.WriteLine($"--- {tier.Key.ToUpper()} ---");
            foreach (var sizeOpt in tier.Value)
            {
                var entry = results.FirstOrDefault(r => r.Size == sizeOpt.Size);
                if (entry != null) PrintSingleResult(entry);
            }
            _output.WriteLine("");
        }

        // 汇总
        var successCount = results.Count(r => r.Success);
        var failCount = results.Count(r => !r.Success);
        _output.WriteLine("════════════════════════════════════════════════════════════════");
        _output.WriteLine($"  汇总: 成功 {successCount}/{results.Count}, 耗时 {totalStopwatch.ElapsedMilliseconds}ms");
        _output.WriteLine($"  图片目录: {Path.GetFullPath(modelDir)}");
        _output.WriteLine("════════════════════════════════════════════════════════════════");

        if (failCount > 0)
        {
            _output.WriteLine("");
            _output.WriteLine("失败详情:");
            foreach (var fail in results.Where(r => !r.Success))
            {
                _output.WriteLine($"  - {fail.Size}: {fail.ErrorMessage}");
            }
        }

        Assert.True(successCount > 0, $"所有 {results.Count} 个尺寸都失败了");
    }

    private void PrintSingleResult(TestResultEntry entry)
    {
        var icon = entry.Success ? "[OK]" : "[FAIL]";
        var info = entry.Success 
            ? $"保存: {entry.SavedFileName}" 
            : entry.ErrorMessage;
        _output.WriteLine($"  {icon} {entry.Size} ({entry.AspectRatio}) - {entry.ElapsedMs}ms - {info}");
    }

    #endregion

    #region ========== 单次测试 ==========

    private async Task<TestResultEntry> TestSingleSizeAsync(
        PlatformConfig platform,
        string modelName,
        string size,
        string aspectRatio,
        string tier,
        string saveDir)
    {
        var entry = new TestResultEntry
        {
            Platform = platform.Name,
            ModelName = modelName,
            Size = size,
            AspectRatio = aspectRatio,
            Tier = tier
        };

        var stopwatch = Stopwatch.StartNew();

        try
        {
            using var httpClient = new HttpClient();
            httpClient.Timeout = TimeSpan.FromSeconds(180);
            httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", platform.ApiKey);

            var endpoint = platform.IsVolces
                ? $"{platform.ApiUrl.TrimEnd('/')}/images/generations"
                : $"{platform.ApiUrl.TrimEnd('/')}/v1/images/generations";

            var reqParams = ImageGenModelAdapterRegistry.BuildRequestParams(modelName, size);

            var requestDict = new Dictionary<string, object>
            {
                ["model"] = modelName,
                ["prompt"] = TestPrompt,
                ["n"] = 1,
                ["response_format"] = "url"
            };

            foreach (var kv in reqParams.SizeParams)
            {
                requestDict[kv.Key] = kv.Value;
            }

            if (platform.IsVolces)
            {
                requestDict["sequential_image_generation"] = "disabled";
                requestDict["stream"] = false;
                requestDict["watermark"] = true;
            }

            var requestJson = JsonSerializer.Serialize(requestDict);
            var content = new StringContent(requestJson, Encoding.UTF8, "application/json");

            var response = await httpClient.PostAsync(endpoint, content);
            var responseBody = await response.Content.ReadAsStringAsync();

            stopwatch.Stop();
            entry.ElapsedMs = stopwatch.ElapsedMilliseconds;

            if (!response.IsSuccessStatusCode)
            {
                entry.Success = false;
                entry.ErrorMessage = $"HTTP {(int)response.StatusCode}: {Truncate(responseBody, 150)}";
                return entry;
            }

            // 解析响应获取 URL
            using var doc = JsonDocument.Parse(responseBody);
            string? imageUrl = null;

            if (doc.RootElement.TryGetProperty("data", out var dataArray) &&
                dataArray.GetArrayLength() > 0)
            {
                var firstItem = dataArray[0];
                if (firstItem.TryGetProperty("url", out var urlProp))
                {
                    imageUrl = urlProp.GetString();
                }
            }

            if (string.IsNullOrEmpty(imageUrl))
            {
                entry.Success = false;
                entry.ErrorMessage = $"无法获取图片URL: {Truncate(responseBody, 150)}";
                return entry;
            }

            // 下载并保存图片
            var timestamp = DateTime.Now.ToString("HHmmss");
            var fileName = $"{SanitizeFileName(size)}_{timestamp}.png";
            var filePath = Path.Combine(saveDir, fileName);

            using var imageResponse = await httpClient.GetAsync(imageUrl);
            if (imageResponse.IsSuccessStatusCode)
            {
                var imageBytes = await imageResponse.Content.ReadAsByteArrayAsync();
                await File.WriteAllBytesAsync(filePath, imageBytes);
                entry.SavedFileName = fileName;
            }
            else
            {
                entry.SavedFileName = $"下载失败({imageResponse.StatusCode})";
            }

            entry.Success = true;
            entry.ImageUrl = imageUrl;
        }
        catch (TaskCanceledException)
        {
            stopwatch.Stop();
            entry.ElapsedMs = stopwatch.ElapsedMilliseconds;
            entry.Success = false;
            entry.ErrorMessage = "请求超时(180s)";
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            entry.ElapsedMs = stopwatch.ElapsedMilliseconds;
            entry.Success = false;
            entry.ErrorMessage = ex.Message;
        }

        return entry;
    }

    #endregion

    #region ========== 工具方法 ==========

    private static string Truncate(string str, int maxLen) =>
        string.IsNullOrEmpty(str) ? str : (str.Length <= maxLen ? str : str[..maxLen] + "...");

    private static string SanitizeFileName(string name) =>
        string.Join("_", name.Split(Path.GetInvalidFileNameChars()));

    #endregion

    #region ========== 数据类 ==========

    private class PlatformConfig
    {
        public string Name { get; set; } = "";
        public string ApiUrl { get; set; } = "";
        public string ApiKey { get; set; } = "";
        public bool IsVolces { get; set; }
    }

    private class TestResultEntry
    {
        public string Platform { get; set; } = "";
        public string ModelName { get; set; } = "";
        public string Size { get; set; } = "";
        public string AspectRatio { get; set; } = "";
        public string Tier { get; set; } = "";
        public bool Success { get; set; }
        public string? ImageUrl { get; set; }
        public string? SavedFileName { get; set; }
        public string? ErrorMessage { get; set; }
        public long ElapsedMs { get; set; }
    }

    #endregion
}
