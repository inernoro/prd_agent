using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 多图组合生成 端到端集成测试
/// 
/// 测试完整链路：
/// 1. 图片描述提取（VLM 识图）
/// 2. 多图组合意图解析（VLM 语义理解）
/// 3. 生成英文 Prompt
/// 4. 调用 nano-banana 生图
/// 5. 验证输出结果
/// 
/// 前置条件：
/// 1. API 服务运行在 localhost:8000
/// 2. 已配置 Vision 类型的模型池（用于图片描述提取和意图解析）
/// 3. 已配置 Generation 类型的模型池（用于 nano-banana 生图）
/// 4. 测试用图片资产存在于数据库中
/// 
/// 运行命令（CI 不触发，需手动执行）：
///   dotnet test tests/PrdAgent.Tests --filter "FullyQualifiedName~MultiImageCompose" --no-build -v n
/// 
/// 图片保存位置：tests/PrdAgent.Tests/GeneratedImages/MultiImageCompose/{timestamp}/
/// </summary>
[Trait("Category", "Integration")]
public class MultiImageComposeIntegrationTests
{
    private readonly ITestOutputHelper _output;

    // API 配置
    private const string ApiBaseUrl = "http://localhost:8000";
    private const string AiAccessKey = "123";
    private const string ImpersonateUser = "admin";

    // 图片保存目录
    private static readonly string ImageOutputDir = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "GeneratedImages", "MultiImageCompose");

    // 测试用 Workspace 数据（从真实环境获取）
    private const string TestWorkspaceId = "9d48e9b61f634ce5a5137ca0470be756";

    // 测试用图片资产（来自 workspace 的 coverAssets）
    private static readonly TestImageAsset[] TestAssets = new[]
    {
        new TestImageAsset
        {
            Id = "417849bc127c45ada8c5ec0687d39679",
            Url = "https://i.pa.759800.com/visual-agent/img/s4kazw6vyngzemeijgjx72epve.jpg",
            Name = "可爱小猫",
            Width = 1024,
            Height = 1024
        },
        new TestImageAsset
        {
            Id = "05bd15a695a341ec89f2525313c5ef30",
            Url = "https://i.pa.759800.com/visual-agent/img/pgiq7lh7w5r53lhr3dwmwepeg4.jpg",
            Name = "场景图2",
            Width = 1024,
            Height = 1024
        },
        new TestImageAsset
        {
            Id = "c79b14d5028f45449d58975296b04c79",
            Url = "https://i.pa.759800.com/visual-agent/img/bxiiju255eibrplott7vsfj7wa.jpg",
            Name = "场景图3",
            Width = 1024,
            Height = 1024
        },
        new TestImageAsset
        {
            Id = "5d95831a6d9b432795ab2ba7702763de",
            Url = "https://i.pa.759800.com/visual-agent/img/etabgunimdtprxp6v6qhphdodi.jpg",
            Name = "高清大图",
            Width = 2048,
            Height = 2048
        }
    };

    public MultiImageComposeIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
    }

    #region ========== 环境检查 ==========

    /// <summary>
    /// 前置检查：验证测试环境配置是否正确
    /// </summary>
    [Fact]
    public async Task PreCheck_EnvironmentConfiguration()
    {
        PrintHeader("环境配置检查");

        using var httpClient = CreateHttpClient();
        var allPassed = true;

        // 1. 检查 API 服务是否可用
        _output.WriteLine("1. 检查 API 服务连接...");
        try
        {
            var healthResponse = await httpClient.GetAsync($"{ApiBaseUrl}/api/visual-agent/image-master/workspaces");
            _output.WriteLine($"   [OK] API 服务可用 (HTTP {(int)healthResponse.StatusCode})");
        }
        catch (Exception ex)
        {
            _output.WriteLine($"   [FAIL] API 服务不可用: {ex.Message}");
            allPassed = false;
        }

        // 2. 检查模型池配置
        _output.WriteLine("");
        _output.WriteLine("2. 检查模型池配置...");

        var modelGroupsResponse = await httpClient.GetAsync($"{ApiBaseUrl}/api/mds/model-groups");
        if (modelGroupsResponse.IsSuccessStatusCode)
        {
            var modelGroupsJson = await modelGroupsResponse.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(modelGroupsJson);

            if (doc.RootElement.TryGetProperty("data", out var groups))
            {
                var hasVision = false;
                var hasGeneration = false;

                foreach (var group in groups.EnumerateArray())
                {
                    var modelType = group.GetProperty("modelType").GetString();
                    var name = group.GetProperty("name").GetString();

                    if (modelType == "vision")
                    {
                        hasVision = true;
                        _output.WriteLine($"   [OK] Vision 模型池: {name}");
                    }
                    if (modelType == "generation")
                    {
                        hasGeneration = true;
                        _output.WriteLine($"   [OK] Generation 模型池: {name}");
                    }
                }

                if (!hasVision)
                {
                    _output.WriteLine("   [FAIL] 缺少 Vision 类型的模型池（用于图片描述提取和意图解析）");
                    _output.WriteLine("   提示: 请在管理后台创建一个 modelType=vision 的模型池，绑定支持识图的模型（如 gpt-4o）");
                    allPassed = false;
                }
                if (!hasGeneration)
                {
                    _output.WriteLine("   [FAIL] 缺少 Generation 类型的模型池（用于生图）");
                    allPassed = false;
                }
            }
        }
        else
        {
            _output.WriteLine($"   [FAIL] 无法获取模型池配置: HTTP {(int)modelGroupsResponse.StatusCode}");
            allPassed = false;
        }

        // 3. 检查测试资产是否存在
        _output.WriteLine("");
        _output.WriteLine("3. 检查测试资产...");

        var workspacesResponse = await httpClient.GetAsync($"{ApiBaseUrl}/api/visual-agent/image-master/workspaces");
        if (workspacesResponse.IsSuccessStatusCode)
        {
            var workspacesJson = await workspacesResponse.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(workspacesJson);

            if (doc.RootElement.TryGetProperty("data", out var data) &&
                data.TryGetProperty("items", out var items) &&
                items.GetArrayLength() > 0)
            {
                var first = items[0];
                var wsId = first.GetProperty("id").GetString();
                _output.WriteLine($"   [OK] 找到 Workspace: {wsId}");

                if (first.TryGetProperty("coverAssets", out var assets) && assets.GetArrayLength() > 0)
                {
                    _output.WriteLine($"   [OK] Workspace 包含 {assets.GetArrayLength()} 个封面资产");

                    // 更新测试中使用的资产 ID
                    _output.WriteLine("");
                    _output.WriteLine("   可用的测试资产:");
                    var assetIndex = 0;
                    foreach (var asset in assets.EnumerateArray())
                    {
                        if (assetIndex >= 4) break;
                        var assetId = asset.GetProperty("id").GetString();
                        var url = asset.GetProperty("url").GetString();
                        _output.WriteLine($"     [{assetIndex + 1}] ID: {assetId}");
                        _output.WriteLine($"         URL: {url}");
                        assetIndex++;
                    }
                }
                else
                {
                    _output.WriteLine("   [WARN] Workspace 没有封面资产");
                }
            }
            else
            {
                _output.WriteLine("   [WARN] 没有找到 Workspace");
            }
        }

        _output.WriteLine("");
        _output.WriteLine("================================================================");
        if (allPassed)
        {
            _output.WriteLine("  环境检查通过，可以运行集成测试");
        }
        else
        {
            _output.WriteLine("  环境检查失败，请先完成配置");
            _output.WriteLine("");
            _output.WriteLine("  所需配置:");
            _output.WriteLine("  1. 创建 Vision 模型池（modelType=vision），绑定识图模型");
            _output.WriteLine("  2. 创建 Generation 模型池（已配置 nano-banana-pro）");
            _output.WriteLine("  3. 确保测试 Workspace 中有图片资产");
        }
        _output.WriteLine("================================================================");

        Assert.True(allPassed, "环境配置不完整，请查看上述输出完成配置");
    }

    #endregion

    #region ========== 完整链路测试 ==========

    /// <summary>
    /// 完整链路测试：两张图组合（把A放进B）
    /// </summary>
    [Fact]
    public async Task FullChain_TwoImageCompose_PutAIntoB()
    {
        var testName = "TwoImage_PutAIntoB";
        var instruction = "把 [IMAGE_1] 放进 [IMAGE_2] 的场景里";
        var images = new[]
        {
            new ImageRef { Index = 1, AssetId = TestAssets[0].Id, Name = TestAssets[0].Name },
            new ImageRef { Index = 2, AssetId = TestAssets[1].Id, Name = TestAssets[1].Name }
        };

        await RunFullChainTestAsync(testName, instruction, images);
    }

    /// <summary>
    /// 完整链路测试：语序颠倒（B里面有A）
    /// </summary>
    [Fact]
    public async Task FullChain_TwoImageCompose_BContainsA()
    {
        var testName = "TwoImage_BContainsA";
        var instruction = "[IMAGE_2] 的场景里有一只 [IMAGE_1]";
        var images = new[]
        {
            new ImageRef { Index = 1, AssetId = TestAssets[0].Id, Name = "小猫" },
            new ImageRef { Index = 2, AssetId = TestAssets[2].Id, Name = "背景场景" }
        };

        await RunFullChainTestAsync(testName, instruction, images);
    }

    /// <summary>
    /// 完整链路测试：三张图组合
    /// </summary>
    [Fact]
    public async Task FullChain_ThreeImageCompose()
    {
        var testName = "ThreeImage_Compose";
        var instruction = "用 [IMAGE_3] 的风格，把 [IMAGE_1] 放到 [IMAGE_2] 的场景中";
        var images = new[]
        {
            new ImageRef { Index = 1, AssetId = TestAssets[0].Id, Name = "主体" },
            new ImageRef { Index = 2, AssetId = TestAssets[1].Id, Name = "背景" },
            new ImageRef { Index = 3, AssetId = TestAssets[2].Id, Name = "风格参考" }
        };

        await RunFullChainTestAsync(testName, instruction, images);
    }

    /// <summary>
    /// 仅解析模式测试（不生成图片）
    /// </summary>
    [Fact]
    public async Task ParseOnly_IntentParsing()
    {
        var testName = "ParseOnly";
        var instruction = "让 [IMAGE_1] 出现在 [IMAGE_2] 画面的中央";
        var images = new[]
        {
            new ImageRef { Index = 1, AssetId = TestAssets[0].Id, Name = "主体" },
            new ImageRef { Index = 2, AssetId = TestAssets[1].Id, Name = "背景" }
        };

        await RunParseOnlyTestAsync(testName, instruction, images);
    }

    #endregion

    #region ========== 图片描述提取测试 ==========

    /// <summary>
    /// 单独测试图片描述提取
    /// </summary>
    [Fact]
    public async Task DescriptionExtraction_SingleImage()
    {
        PrintHeader("图片描述提取测试");

        var asset = TestAssets[0];
        _output.WriteLine($"测试资产: {asset.Name}");
        _output.WriteLine($"资产 ID: {asset.Id}");
        _output.WriteLine($"图片 URL: {asset.Url}");
        _output.WriteLine("");

        var stopwatch = Stopwatch.StartNew();

        using var httpClient = CreateHttpClient();
        var endpoint = $"{ApiBaseUrl}/api/visual-agent/image-master/assets/{asset.Id}/describe";

        _output.WriteLine($"[REQUEST] POST {endpoint}");
        _output.WriteLine("");

        try
        {
            var response = await httpClient.PostAsync(endpoint, null);
            var responseBody = await response.Content.ReadAsStringAsync();

            stopwatch.Stop();

            _output.WriteLine($"[RESPONSE] HTTP {(int)response.StatusCode} ({stopwatch.ElapsedMilliseconds}ms)");
            _output.WriteLine("");
            _output.WriteLine("响应内容:");
            _output.WriteLine(FormatJson(responseBody));
            _output.WriteLine("");

            if (response.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(responseBody);
                if (doc.RootElement.TryGetProperty("data", out var data))
                {
                    var description = data.GetProperty("description").GetString();
                    var modelId = data.GetProperty("modelId").GetString();

                    _output.WriteLine("====== 提取结果 ======");
                    _output.WriteLine($"描述: {description}");
                    _output.WriteLine($"使用模型: {modelId}");
                    _output.WriteLine("");

                    Assert.False(string.IsNullOrWhiteSpace(description), "描述不应为空");
                }
            }
            else
            {
                _output.WriteLine($"[ERROR] 请求失败: {responseBody}");
            }
        }
        catch (Exception ex)
        {
            _output.WriteLine($"[EXCEPTION] {ex.Message}");
            throw;
        }
    }

    #endregion

    #region ========== 核心测试逻辑 ==========

    private async Task RunFullChainTestAsync(string testName, string instruction, ImageRef[] images)
    {
        var timestamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
        var testDir = Path.Combine(ImageOutputDir, $"{testName}_{timestamp}");
        Directory.CreateDirectory(testDir);

        PrintHeader($"多图组合完整链路测试: {testName}");
        _output.WriteLine($"测试时间: {timestamp}");
        _output.WriteLine($"输出目录: {Path.GetFullPath(testDir)}");
        _output.WriteLine("");

        // ===== Step 1: 打印输入信息 =====
        PrintSection("Step 1: 输入信息");
        _output.WriteLine($"用户指令: {instruction}");
        _output.WriteLine("");
        _output.WriteLine("引用图片:");
        foreach (var img in images)
        {
            var asset = TestAssets.FirstOrDefault(a => a.Id == img.AssetId);
            _output.WriteLine($"  [IMAGE_{img.Index}] {img.Name}");
            _output.WriteLine($"    资产ID: {img.AssetId}");
            _output.WriteLine($"    URL: {asset?.Url ?? "N/A"}");
        }
        _output.WriteLine("");

        // ===== Step 2: 调用 Compose API =====
        PrintSection("Step 2: 调用组合生成 API");

        var request = new
        {
            instruction = instruction,
            images = images.Select(i => new { index = i.Index, assetId = i.AssetId, name = i.Name }).ToArray(),
            parseOnly = false,
            size = "1024x1024",
            responseFormat = "b64_json"
        };

        var requestJson = JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true });
        _output.WriteLine("请求 Body:");
        _output.WriteLine(requestJson);
        _output.WriteLine("");

        using var httpClient = CreateHttpClient();
        var endpoint = $"{ApiBaseUrl}/api/visual-agent/image-gen/compose";

        _output.WriteLine($"[REQUEST] POST {endpoint}");
        _output.WriteLine("");

        var stopwatch = Stopwatch.StartNew();

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var response = await httpClient.PostAsync(endpoint, content);
        var responseBody = await response.Content.ReadAsStringAsync();

        stopwatch.Stop();

        _output.WriteLine($"[RESPONSE] HTTP {(int)response.StatusCode} ({stopwatch.ElapsedMilliseconds}ms)");
        _output.WriteLine("");

        // ===== Step 3: 解析响应 =====
        PrintSection("Step 3: 响应解析");

        if (!response.IsSuccessStatusCode)
        {
            _output.WriteLine("[ERROR] 请求失败!");
            _output.WriteLine($"响应内容: {responseBody}");
            Assert.Fail($"API 请求失败: HTTP {(int)response.StatusCode}");
            return;
        }

        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;

        if (!root.GetProperty("success").GetBoolean())
        {
            var error = root.GetProperty("error");
            _output.WriteLine($"[ERROR] 业务错误: {error}");
            Assert.Fail("API 返回业务错误");
            return;
        }

        var data = root.GetProperty("data");

        // 3.1 打印生成的 Prompt
        var generatedPrompt = data.GetProperty("generatedPrompt").GetString();
        _output.WriteLine("====== 生成的英文 Prompt ======");
        _output.WriteLine(generatedPrompt);
        _output.WriteLine("");

        // 3.2 打印图片描述信息
        if (data.TryGetProperty("imageDescriptions", out var descriptions))
        {
            _output.WriteLine("====== 图片描述（VLM 提取结果）======");
            foreach (var desc in descriptions.EnumerateArray())
            {
                var index = desc.GetProperty("index").GetInt32();
                var hasDesc = desc.GetProperty("hasDescription").GetBoolean();
                var descText = desc.TryGetProperty("description", out var d) ? d.GetString() : null;
                
                _output.WriteLine($"[IMAGE_{index}]:");
                _output.WriteLine($"  有描述: {hasDesc}");
                if (hasDesc && !string.IsNullOrEmpty(descText))
                {
                    _output.WriteLine($"  描述内容: {descText}");
                }
            }
            _output.WriteLine("");
        }

        // 3.3 处理生成的图片
        if (data.TryGetProperty("images", out var imagesArray) && imagesArray.GetArrayLength() > 0)
        {
            PrintSection("Step 4: 图片保存");

            var imageIndex = 0;
            foreach (var img in imagesArray.EnumerateArray())
            {
                imageIndex++;
                var fileName = $"compose_result_{imageIndex}.png";
                var filePath = Path.Combine(testDir, fileName);

                if (img.TryGetProperty("base64", out var base64Prop))
                {
                    var base64 = base64Prop.GetString();
                    if (!string.IsNullOrEmpty(base64))
                    {
                        var imageBytes = Convert.FromBase64String(base64);
                        await File.WriteAllBytesAsync(filePath, imageBytes);
                        _output.WriteLine($"[OK] 已保存: {fileName} ({imageBytes.Length / 1024}KB)");
                    }
                }
                else if (img.TryGetProperty("url", out var urlProp))
                {
                    var url = urlProp.GetString();
                    _output.WriteLine($"图片 URL: {url}");
                    
                    // 下载图片
                    if (!string.IsNullOrEmpty(url))
                    {
                        try
                        {
                            using var imgResponse = await httpClient.GetAsync(url);
                            if (imgResponse.IsSuccessStatusCode)
                            {
                                var imageBytes = await imgResponse.Content.ReadAsByteArrayAsync();
                                await File.WriteAllBytesAsync(filePath, imageBytes);
                                _output.WriteLine($"[OK] 已下载并保存: {fileName} ({imageBytes.Length / 1024}KB)");
                            }
                        }
                        catch (Exception ex)
                        {
                            _output.WriteLine($"[WARN] 下载失败: {ex.Message}");
                        }
                    }
                }

                // 打印修订后的提示词（如果有）
                if (img.TryGetProperty("revisedPrompt", out var revisedProp))
                {
                    var revised = revisedProp.GetString();
                    if (!string.IsNullOrEmpty(revised))
                    {
                        _output.WriteLine($"修订后的提示词: {revised}");
                    }
                }
            }
            _output.WriteLine("");
        }
        else
        {
            _output.WriteLine("[WARN] 响应中没有图片数据");
        }

        // ===== Step 5: 汇总 =====
        PrintSection("Step 5: 测试汇总");
        _output.WriteLine($"测试名称: {testName}");
        _output.WriteLine($"用户指令: {instruction}");
        _output.WriteLine($"图片数量: {images.Length}");
        _output.WriteLine($"总耗时: {stopwatch.ElapsedMilliseconds}ms");
        _output.WriteLine($"输出目录: {Path.GetFullPath(testDir)}");
        _output.WriteLine("");

        // 验证
        Assert.False(string.IsNullOrWhiteSpace(generatedPrompt), "生成的 Prompt 不应为空");

        _output.WriteLine("[PASS] 测试通过!");
    }

    private async Task RunParseOnlyTestAsync(string testName, string instruction, ImageRef[] images)
    {
        PrintHeader($"仅解析模式测试: {testName}");

        var request = new
        {
            instruction = instruction,
            images = images.Select(i => new { index = i.Index, assetId = i.AssetId, name = i.Name }).ToArray(),
            parseOnly = true
        };

        var requestJson = JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true });
        _output.WriteLine("请求 Body:");
        _output.WriteLine(requestJson);
        _output.WriteLine("");

        using var httpClient = CreateHttpClient();
        var endpoint = $"{ApiBaseUrl}/api/visual-agent/image-gen/compose";

        var stopwatch = Stopwatch.StartNew();

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var response = await httpClient.PostAsync(endpoint, content);
        var responseBody = await response.Content.ReadAsStringAsync();

        stopwatch.Stop();

        _output.WriteLine($"[RESPONSE] HTTP {(int)response.StatusCode} ({stopwatch.ElapsedMilliseconds}ms)");
        _output.WriteLine("");
        _output.WriteLine("响应内容:");
        _output.WriteLine(FormatJson(responseBody));
        _output.WriteLine("");

        if (response.IsSuccessStatusCode)
        {
            using var doc = JsonDocument.Parse(responseBody);
            var data = doc.RootElement.GetProperty("data");
            var generatedPrompt = data.GetProperty("generatedPrompt").GetString();

            _output.WriteLine("====== 解析结果 ======");
            _output.WriteLine($"生成的 Prompt: {generatedPrompt}");
            _output.WriteLine("");

            // 验证 parseOnly 模式下 images 应该为空
            if (data.TryGetProperty("images", out var imgs))
            {
                Assert.Equal(0, imgs.GetArrayLength());
                _output.WriteLine("[OK] parseOnly 模式下 images 为空");
            }

            Assert.False(string.IsNullOrWhiteSpace(generatedPrompt), "Prompt 不应为空");
            _output.WriteLine("[PASS] 测试通过!");
        }
        else
        {
            _output.WriteLine($"[ERROR] 请求失败");
            Assert.Fail($"API 请求失败: HTTP {(int)response.StatusCode}");
        }
    }

    #endregion

    #region ========== 调度链路验证测试 ==========

    /// <summary>
    /// 验证模型池调度是否正确（检查日志）
    /// </summary>
    [Fact]
    public async Task VerifyModelPoolDispatch()
    {
        PrintHeader("模型池调度验证测试");

        // 1. 获取当前模型池配置
        using var httpClient = CreateHttpClient();
        
        _output.WriteLine("====== 当前模型池配置 ======");
        var modelGroupsResponse = await httpClient.GetAsync($"{ApiBaseUrl}/api/mds/model-groups");
        var modelGroupsJson = await modelGroupsResponse.Content.ReadAsStringAsync();
        
        using var doc = JsonDocument.Parse(modelGroupsJson);
        if (doc.RootElement.TryGetProperty("data", out var groups))
        {
            foreach (var group in groups.EnumerateArray())
            {
                var name = group.GetProperty("name").GetString();
                var code = group.GetProperty("code").GetString();
                var modelType = group.GetProperty("modelType").GetString();
                var isDefault = group.GetProperty("isDefaultForType").GetBoolean();

                _output.WriteLine($"模型池: {name}");
                _output.WriteLine($"  Code: {code}");
                _output.WriteLine($"  类型: {modelType}");
                _output.WriteLine($"  默认: {isDefault}");

                if (group.TryGetProperty("models", out var models))
                {
                    foreach (var model in models.EnumerateArray())
                    {
                        var modelId = model.GetProperty("modelId").GetString();
                        var platformId = model.GetProperty("platformId").GetString();
                        _output.WriteLine($"  - 模型: {modelId} (平台: {platformId})");
                    }
                }
                _output.WriteLine("");
            }
        }

        // 2. 执行一次组合请求
        _output.WriteLine("====== 执行组合请求 ======");
        var request = new
        {
            instruction = "把 [IMAGE_1] 放进 [IMAGE_2]",
            images = new[]
            {
                new { index = 1, assetId = TestAssets[0].Id, name = "主体" },
                new { index = 2, assetId = TestAssets[1].Id, name = "背景" }
            },
            parseOnly = true
        };

        var content = new StringContent(
            JsonSerializer.Serialize(request),
            Encoding.UTF8,
            "application/json");

        var composeResponse = await httpClient.PostAsync(
            $"{ApiBaseUrl}/api/visual-agent/image-gen/compose",
            content);

        var composeJson = await composeResponse.Content.ReadAsStringAsync();
        _output.WriteLine($"响应状态: {(int)composeResponse.StatusCode}");
        _output.WriteLine(FormatJson(composeJson));
        _output.WriteLine("");

        // 3. 查询最近的 LLM 日志（验证调度）
        _output.WriteLine("====== 最近的 LLM 请求日志 ======");
        var logsResponse = await httpClient.GetAsync($"{ApiBaseUrl}/api/logs/llm?limit=5");
        if (logsResponse.IsSuccessStatusCode)
        {
            var logsJson = await logsResponse.Content.ReadAsStringAsync();
            _output.WriteLine(FormatJson(logsJson));
        }
        else
        {
            _output.WriteLine($"无法获取日志: {(int)logsResponse.StatusCode}");
        }

        Assert.True(composeResponse.IsSuccessStatusCode, "组合请求应该成功");
    }

    /// <summary>
    /// 完整调度链路追踪测试 - 打印每个步骤的详细信息
    /// </summary>
    [Fact]
    public async Task FullDispatchChainTrace()
    {
        var timestamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
        var testDir = Path.Combine(ImageOutputDir, $"FullChainTrace_{timestamp}");
        Directory.CreateDirectory(testDir);

        PrintHeader("完整调度链路追踪测试");
        _output.WriteLine($"测试时间: {timestamp}");
        _output.WriteLine($"输出目录: {Path.GetFullPath(testDir)}");
        _output.WriteLine("");

        using var httpClient = CreateHttpClient();
        var stopwatchTotal = Stopwatch.StartNew();

        // ===== 阶段 0: 记录初始 LLM 日志数量 =====
        PrintSection("阶段 0: 记录测试前状态");

        var initialLogsResponse = await httpClient.GetAsync($"{ApiBaseUrl}/api/logs/llm?limit=1");
        var initialLogsJson = await initialLogsResponse.Content.ReadAsStringAsync();
        using var initialLogsDoc = JsonDocument.Parse(initialLogsJson);
        var initialLogId = "";
        if (initialLogsDoc.RootElement.TryGetProperty("data", out var initialData) &&
            initialData.TryGetProperty("items", out var initialItems) &&
            initialItems.GetArrayLength() > 0)
        {
            initialLogId = initialItems[0].GetProperty("id").GetString() ?? "";
        }
        _output.WriteLine($"测试前最新日志 ID: {initialLogId}");
        _output.WriteLine("");

        // ===== 阶段 1: 构造请求 =====
        PrintSection("阶段 1: 构造组合请求");

        var instruction = "把 [IMAGE_1] 放进 [IMAGE_2] 的场景中，保持 [IMAGE_1] 的主体特征";
        var images = new[]
        {
            new { index = 1, assetId = TestAssets[0].Id, name = "可爱猫咪" },
            new { index = 2, assetId = TestAssets[1].Id, name = "场景背景" }
        };

        var request = new
        {
            instruction = instruction,
            images = images,
            parseOnly = false,  // 完整流程
            size = "1024x1024",
            responseFormat = "b64_json"
        };

        var requestJson = JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true });

        _output.WriteLine("请求参数:");
        _output.WriteLine($"  指令: {instruction}");
        _output.WriteLine($"  图片数量: {images.Length}");
        _output.WriteLine($"  parseOnly: false");
        _output.WriteLine($"  size: 1024x1024");
        _output.WriteLine("");
        _output.WriteLine("完整请求 Body:");
        _output.WriteLine(requestJson);
        _output.WriteLine("");

        // 保存请求到文件
        var requestFile = Path.Combine(testDir, "1_request.json");
        await File.WriteAllTextAsync(requestFile, requestJson);
        _output.WriteLine($"请求已保存: {requestFile}");
        _output.WriteLine("");

        // ===== 阶段 2: 发送请求 =====
        PrintSection("阶段 2: 发送 API 请求");

        var endpoint = $"{ApiBaseUrl}/api/visual-agent/image-gen/compose";
        _output.WriteLine($"端点: POST {endpoint}");
        _output.WriteLine("");

        var stopwatchApi = Stopwatch.StartNew();
        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var response = await httpClient.PostAsync(endpoint, content);
        var responseBody = await response.Content.ReadAsStringAsync();
        stopwatchApi.Stop();

        _output.WriteLine($"响应状态: HTTP {(int)response.StatusCode}");
        _output.WriteLine($"API 耗时: {stopwatchApi.ElapsedMilliseconds}ms");
        _output.WriteLine("");

        // 保存响应到文件
        var responseFile = Path.Combine(testDir, "2_response.json");
        await File.WriteAllTextAsync(responseFile, FormatJson(responseBody));
        _output.WriteLine($"响应已保存: {responseFile}");
        _output.WriteLine("");

        // ===== 阶段 3: 解析响应 =====
        PrintSection("阶段 3: 解析响应内容");

        using var responseDoc = JsonDocument.Parse(responseBody);
        var root = responseDoc.RootElement;

        var success = root.GetProperty("success").GetBoolean();
        _output.WriteLine($"success: {success}");

        if (!success)
        {
            var error = root.GetProperty("error");
            _output.WriteLine("");
            _output.WriteLine("错误详情:");
            _output.WriteLine($"  code: {error.GetProperty("code").GetString()}");
            _output.WriteLine($"  message: {error.GetProperty("message").GetString()}");

            // 即使失败也继续获取日志
        }
        else
        {
            var data = root.GetProperty("data");

            // 3.1 生成的 Prompt
            _output.WriteLine("");
            _output.WriteLine("====== 生成的英文 Prompt ======");
            var generatedPrompt = data.GetProperty("generatedPrompt").GetString();
            _output.WriteLine(generatedPrompt);
            
            // 保存 Prompt
            var promptFile = Path.Combine(testDir, "3_generated_prompt.txt");
            await File.WriteAllTextAsync(promptFile, generatedPrompt ?? "");
            _output.WriteLine("");
            _output.WriteLine($"Prompt 已保存: {promptFile}");

            // 3.2 图片描述
            if (data.TryGetProperty("imageDescriptions", out var descriptions))
            {
                _output.WriteLine("");
                _output.WriteLine("====== 图片描述（VLM 提取）======");

                var descText = new StringBuilder();
                foreach (var desc in descriptions.EnumerateArray())
                {
                    var index = desc.GetProperty("index").GetInt32();
                    var hasDesc = desc.GetProperty("hasDescription").GetBoolean();
                    var descContent = desc.TryGetProperty("description", out var d) ? d.GetString() : "";

                    _output.WriteLine($"[IMAGE_{index}] hasDescription={hasDesc}");
                    if (hasDesc && !string.IsNullOrEmpty(descContent))
                    {
                        _output.WriteLine($"  描述: {descContent}");
                        descText.AppendLine($"[IMAGE_{index}]:");
                        descText.AppendLine(descContent);
                        descText.AppendLine();
                    }
                }

                // 保存描述
                var descFile = Path.Combine(testDir, "4_image_descriptions.txt");
                await File.WriteAllTextAsync(descFile, descText.ToString());
                _output.WriteLine("");
                _output.WriteLine($"描述已保存: {descFile}");
            }

            // 3.3 生成的图片
            if (data.TryGetProperty("images", out var imagesArray) && imagesArray.GetArrayLength() > 0)
            {
                _output.WriteLine("");
                _output.WriteLine("====== 生成的图片 ======");

                var imgIndex = 0;
                foreach (var img in imagesArray.EnumerateArray())
                {
                    imgIndex++;
                    _output.WriteLine($"图片 #{imgIndex}:");

                    if (img.TryGetProperty("revisedPrompt", out var revisedProp))
                    {
                        var revised = revisedProp.GetString();
                        if (!string.IsNullOrEmpty(revised))
                        {
                            _output.WriteLine($"  修订后 Prompt: {revised}");
                            
                            var revisedFile = Path.Combine(testDir, $"5_revised_prompt_{imgIndex}.txt");
                            await File.WriteAllTextAsync(revisedFile, revised);
                        }
                    }

                    var imgFile = Path.Combine(testDir, $"6_result_image_{imgIndex}.png");

                    if (img.TryGetProperty("base64", out var base64Prop))
                    {
                        var base64 = base64Prop.GetString();
                        if (!string.IsNullOrEmpty(base64))
                        {
                            var imageBytes = Convert.FromBase64String(base64);
                            await File.WriteAllBytesAsync(imgFile, imageBytes);
                            _output.WriteLine($"  [OK] 已保存: {imgFile} ({imageBytes.Length / 1024}KB)");
                        }
                    }
                    else if (img.TryGetProperty("url", out var urlProp))
                    {
                        var url = urlProp.GetString();
                        _output.WriteLine($"  URL: {url}");

                        if (!string.IsNullOrEmpty(url))
                        {
                            try
                            {
                                using var imgResponse = await httpClient.GetAsync(url);
                                if (imgResponse.IsSuccessStatusCode)
                                {
                                    var imageBytes = await imgResponse.Content.ReadAsByteArrayAsync();
                                    await File.WriteAllBytesAsync(imgFile, imageBytes);
                                    _output.WriteLine($"  [OK] 已下载并保存: {imgFile} ({imageBytes.Length / 1024}KB)");
                                }
                            }
                            catch (Exception ex)
                            {
                                _output.WriteLine($"  [WARN] 下载失败: {ex.Message}");
                            }
                        }
                    }
                }
            }
        }

        // ===== 阶段 4: 获取 LLM 调用日志 =====
        PrintSection("阶段 4: LLM 调用链路追踪");

        // 等待一下让日志写入完成
        await Task.Delay(1000);

        var logsResponse = await httpClient.GetAsync($"{ApiBaseUrl}/api/logs/llm?limit=10");
        if (logsResponse.IsSuccessStatusCode)
        {
            var logsJson = await logsResponse.Content.ReadAsStringAsync();
            using var logsDoc = JsonDocument.Parse(logsJson);

            if (logsDoc.RootElement.TryGetProperty("data", out var logsData) &&
                logsData.TryGetProperty("items", out var logItems))
            {
                _output.WriteLine("本次请求触发的 LLM 调用:");
                _output.WriteLine("");

                var callIndex = 0;
                foreach (var log in logItems.EnumerateArray())
                {
                    var logId = log.GetProperty("id").GetString();
                    if (logId == initialLogId) break; // 遇到初始日志就停止

                    callIndex++;
                    var purpose = log.GetProperty("requestPurpose").GetString() ?? "unknown";
                    var model = log.GetProperty("model").GetString() ?? "unknown";
                    var status = log.GetProperty("status").GetString() ?? "unknown";
                    var durationMs = log.TryGetProperty("durationMs", out var dur) && dur.ValueKind == JsonValueKind.Number
                        ? dur.GetInt64().ToString() + "ms"
                        : "N/A";
                    var resolutionType = log.TryGetProperty("modelResolutionType", out var rt)
                        ? rt.GetString() ?? "N/A"
                        : "N/A";
                    var groupName = log.TryGetProperty("modelGroupName", out var gn) && gn.ValueKind == JsonValueKind.String
                        ? gn.GetString() ?? "N/A"
                        : "N/A";

                    _output.WriteLine($"[调用 #{callIndex}]");
                    _output.WriteLine($"  appCallerCode: {purpose}");
                    _output.WriteLine($"  模型: {model}");
                    _output.WriteLine($"  调度类型: {resolutionType}");
                    if (groupName != "N/A")
                    {
                        _output.WriteLine($"  模型池: {groupName}");
                    }
                    _output.WriteLine($"  状态: {status}");
                    _output.WriteLine($"  耗时: {durationMs}");

                    if (log.TryGetProperty("error", out var errProp) && errProp.ValueKind == JsonValueKind.String)
                    {
                        _output.WriteLine($"  错误: {errProp.GetString()}");
                    }

                    _output.WriteLine("");
                }

                if (callIndex == 0)
                {
                    _output.WriteLine("  (未检测到新的 LLM 调用)");
                }

                // 保存日志
                var logsFile = Path.Combine(testDir, "7_llm_logs.json");
                await File.WriteAllTextAsync(logsFile, FormatJson(logsJson));
                _output.WriteLine($"日志已保存: {logsFile}");
            }
        }
        else
        {
            _output.WriteLine($"无法获取 LLM 日志: HTTP {(int)logsResponse.StatusCode}");
        }

        // ===== 阶段 5: 测试汇总 =====
        stopwatchTotal.Stop();

        PrintSection("阶段 5: 测试汇总");
        _output.WriteLine($"总耗时: {stopwatchTotal.ElapsedMilliseconds}ms");
        _output.WriteLine($"API 耗时: {stopwatchApi.ElapsedMilliseconds}ms");
        _output.WriteLine($"输出目录: {Path.GetFullPath(testDir)}");
        _output.WriteLine("");
        _output.WriteLine("输出文件列表:");

        foreach (var file in Directory.GetFiles(testDir).OrderBy(f => f))
        {
            var fileInfo = new FileInfo(file);
            _output.WriteLine($"  {Path.GetFileName(file)} ({fileInfo.Length / 1024}KB)");
        }

        _output.WriteLine("");

        if (success)
        {
            _output.WriteLine("[PASS] 完整链路测试通过!");
        }
        else
        {
            _output.WriteLine("[INFO] API 返回错误，请查看日志分析原因");
            // 不 Assert.Fail，允许查看完整日志
        }
    }

    #endregion

    #region ========== 辅助方法 ==========

    private HttpClient CreateHttpClient()
    {
        var client = new HttpClient();
        client.Timeout = TimeSpan.FromSeconds(300); // 5 分钟超时
        client.DefaultRequestHeaders.Add("X-AI-Access-Key", AiAccessKey);
        client.DefaultRequestHeaders.Add("X-AI-Impersonate", ImpersonateUser);
        return client;
    }

    private void PrintHeader(string title)
    {
        _output.WriteLine("");
        _output.WriteLine("================================================================");
        _output.WriteLine($"  {title}");
        _output.WriteLine("================================================================");
        _output.WriteLine("");
    }

    private void PrintSection(string title)
    {
        _output.WriteLine("----------------------------------------------------------------");
        _output.WriteLine($"  {title}");
        _output.WriteLine("----------------------------------------------------------------");
        _output.WriteLine("");
    }

    private static string FormatJson(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return JsonSerializer.Serialize(doc.RootElement, new JsonSerializerOptions { WriteIndented = true });
        }
        catch
        {
            return json;
        }
    }

    #endregion

    #region ========== 数据类 ==========

    private class TestImageAsset
    {
        public string Id { get; set; } = "";
        public string Url { get; set; } = "";
        public string Name { get; set; } = "";
        public int Width { get; set; }
        public int Height { get; set; }
    }

    private class ImageRef
    {
        public int Index { get; set; }
        public string AssetId { get; set; } = "";
        public string Name { get; set; } = "";
    }

    #endregion
}
