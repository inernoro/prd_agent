using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// vveai nano-banana-pro 真实 API 集成测试
///
/// 运行命令 (PowerShell):
/// $env:VVEAI_API_KEY = "你的API密钥"
/// $env:VVEAI_BASE_URL = "https://api.vveai.com"
/// cd prd-api
/// dotnet test --filter "VveaiImageGenIntegrationTests" --logger "console;verbosity=detailed"
/// </summary>
public class VveaiImageGenIntegrationTests : IDisposable
{
    private readonly ITestOutputHelper _output;
    private readonly HttpClient _httpClient;
    private readonly string? _apiKey;
    private readonly string _baseUrl;

    public VveaiImageGenIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
        _apiKey = Environment.GetEnvironmentVariable("VVEAI_API_KEY");
        _baseUrl = Environment.GetEnvironmentVariable("VVEAI_BASE_URL") ?? "https://api.vveai.com";

        _httpClient = new HttpClient
        {
            Timeout = TimeSpan.FromMinutes(5) // 生图可能需要较长时间
        };

        Log($"[初始化] VVEAI_BASE_URL: {_baseUrl}");
        Log($"[初始化] VVEAI_API_KEY: {(_apiKey != null ? $"{_apiKey[..Math.Min(8, _apiKey.Length)]}..." : "(未设置)")}");
    }

    private void Log(string message)
    {
        _output.WriteLine(message);
        Console.WriteLine(message);
    }

    public void Dispose()
    {
        _httpClient.Dispose();
    }

    /// <summary>
    /// 测试1: 基础文生图 - nano-banana-pro
    /// </summary>
    [Fact]
    public async Task 文生图_NanoBananaPro_应返回图片URL()
    {
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[跳过] VVEAI_API_KEY 未设置，请设置环境变量后运行此测试");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("【测试】文生图 - nano-banana-pro");
        Log(new string('=', 80));

        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/generations";
        var requestBody = new
        {
            model = "nano-banana-pro",
            prompt = "一只可爱的橘猫坐在窗台上，阳光洒落，数字艺术风格",
            n = 1,
            size = "1024x1024",
            response_format = "url"
        };

        var requestJson = JsonSerializer.Serialize(requestBody, new JsonSerializerOptions { WriteIndented = true });

        Log($"\n【请求地址】POST {endpoint}");
        Log($"\n【请求体 - 发送给 nanobanana 的内容】");
        Log(new string('-', 40));
        Log(requestJson);
        Log(new string('-', 40));

        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var startTime = DateTime.Now;

        Log($"\n【发送中】{startTime:HH:mm:ss.fff}...");

        var response = await _httpClient.PostAsync(endpoint, content);
        var elapsed = DateTime.Now - startTime;
        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n【响应状态】{(int)response.StatusCode} {response.StatusCode}");
        Log($"【耗时】{elapsed.TotalSeconds:F2} 秒");
        Log($"\n【响应体】");
        Log(FormatJson(responseBody));

        Assert.True(response.IsSuccessStatusCode, $"API 返回错误: {responseBody}");
        Assert.Contains("url", responseBody.ToLower());

        Log("\n【通过】文生图成功!");
    }

    /// <summary>
    /// 测试2: 多图参考提示词 - 模拟 @img16@img17 场景
    /// </summary>
    [Fact]
    public async Task 多图参考提示词_NanoBananaPro_应返回图片URL()
    {
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[跳过] VVEAI_API_KEY 未设置，请设置环境变量后运行此测试");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("【测试】多图参考提示词 - nano-banana-pro");
        Log(new string('=', 80));

        // 模拟 MultiImageDomainService 生成的增强提示词
        var enhancedPrompt = @"@img16@img17 把这两张图融合成一张

【图片对照表】
@img16 对应 风格参考图
@img17 对应 目标图片";

        Log("\n【用户原始输入】");
        Log("  Prompt: @img16@img17 把这两张图融合成一张");
        Log("  ImageRefs:");
        Log("    @img16: 风格参考图 (sha=ae7a4a31...)");
        Log("    @img17: 目标图片 (sha=b2c3d4e5...)");

        Log("\n【MultiImageDomainService 处理后的增强提示词】");
        Log(new string('-', 40));
        Log(enhancedPrompt);
        Log(new string('-', 40));

        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/generations";
        var requestBody = new
        {
            model = "nano-banana-pro",
            prompt = enhancedPrompt,
            n = 1,
            size = "1024x1024",
            response_format = "url"
        };

        var requestJson = JsonSerializer.Serialize(requestBody, new JsonSerializerOptions { WriteIndented = true });

        Log($"\n【请求地址】POST {endpoint}");
        Log($"\n【请求体 - 发送给 nanobanana 的 JSON】");
        Log(new string('-', 40));
        Log(requestJson);
        Log(new string('-', 40));

        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var startTime = DateTime.Now;

        Log($"\n【发送中】{startTime:HH:mm:ss.fff}...");

        var response = await _httpClient.PostAsync(endpoint, content);
        var elapsed = DateTime.Now - startTime;
        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n【响应状态】{(int)response.StatusCode} {response.StatusCode}");
        Log($"【耗时】{elapsed.TotalSeconds:F2} 秒");
        Log($"\n【响应体】");
        Log(FormatJson(responseBody));

        Assert.True(response.IsSuccessStatusCode, $"API 返回错误: {responseBody}");

        Log("\n【通过】多图参考提示词生图成功!");
    }

    /// <summary>
    /// 测试3: 图生图 (img2img) - 带参考图的请求
    /// 注意: 这需要 /v1/images/edits 端点支持
    /// </summary>
    [Fact]
    public async Task 图生图_NanoBananaPro_展示请求格式()
    {
        Log("\n" + new string('=', 80));
        Log("【测试】图生图 (img2img) 请求格式展示");
        Log(new string('=', 80));

        Log("\n【场景说明】");
        Log("  用户输入: @img16@img17 把这两张图融合成一张");
        Log("  系统选择第一张图 @img16 作为 initImage (参考图)");

        // 模拟增强后的提示词
        var enhancedPrompt = @"@img16@img17 把这两张图融合成一张

【图片对照表】
@img16 对应 风格参考图
@img17 对应 目标图片";

        Log("\n【图生图请求格式 - multipart/form-data】");
        Log(new string('-', 40));
        Log(@"POST /v1/images/edits HTTP/1.1
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary

------WebKitFormBoundary
Content-Disposition: form-data; name=""model""

nano-banana-pro
------WebKitFormBoundary
Content-Disposition: form-data; name=""prompt""

" + enhancedPrompt.Replace("\n", "\n") + @"
------WebKitFormBoundary
Content-Disposition: form-data; name=""image""; filename=""init.png""
Content-Type: image/png

<@img16 对应的图片二进制数据，从 COS 读取>
------WebKitFormBoundary
Content-Disposition: form-data; name=""n""

1
------WebKitFormBoundary
Content-Disposition: form-data; name=""size""

1024x1024
------WebKitFormBoundary
Content-Disposition: form-data; name=""response_format""

url
------WebKitFormBoundary--");
        Log(new string('-', 40));

        Log("\n【OpenAIImageClient 日志输出】");
        Log(new string('-', 40));
        Log(@"[OpenAIImageClient] 发送图生图请求:
  端点: https://api.vveai.com/v1/images/edits
  模型: nano-banana-pro
  提供者: openai
  提示词: @img16@img17 把这两张图融合成一张\n\n【图片对照表】\n@img16 对应 风格参考图\n@img17 对应 目标图片
  参考图大小: 234567 bytes
  请求类型: multipart/form-data (img2img)");
        Log(new string('-', 40));

        Log("\n【说明】");
        Log("  1. 文生图使用 /v1/images/generations (application/json)");
        Log("  2. 图生图使用 /v1/images/edits (multipart/form-data)");
        Log("  3. 多图场景当前只取第一张作为 initImage");
        Log("  4. 增强提示词包含【图片对照表】供模型理解多图关系");

        // 如果有 API Key，尝试真实调用
        if (!string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("\n【真实 API 调用 - 文生图模式】");

            var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/generations";
            var requestBody = new
            {
                model = "nano-banana-pro",
                prompt = enhancedPrompt,
                n = 1,
                size = "1024x1024",
                response_format = "url"
            };

            var requestJson = JsonSerializer.Serialize(requestBody, new JsonSerializerOptions { WriteIndented = true });
            Log($"  请求体:\n{requestJson}");

            _httpClient.DefaultRequestHeaders.Clear();
            _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

            var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
            var startTime = DateTime.Now;

            Log($"\n  发送中 {startTime:HH:mm:ss}...");

            var response = await _httpClient.PostAsync(endpoint, content);
            var elapsed = DateTime.Now - startTime;
            var responseBody = await response.Content.ReadAsStringAsync();

            Log($"  状态: {(int)response.StatusCode}");
            Log($"  耗时: {elapsed.TotalSeconds:F2} 秒");
            Log($"  响应: {FormatJson(responseBody)}");
        }
        else
        {
            Log("\n[跳过真实调用] VVEAI_API_KEY 未设置");
        }

        Log("\n【通过】图生图请求格式展示完成!");
    }

    /// <summary>
    /// 测试4: 风格迁移场景
    /// </summary>
    [Fact]
    public async Task 风格迁移_NanoBananaPro_应返回图片URL()
    {
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[跳过] VVEAI_API_KEY 未设置，请设置环境变量后运行此测试");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("【测试】风格迁移场景 - nano-banana-pro");
        Log(new string('=', 80));

        var enhancedPrompt = @"把 @img1 的风格应用到 @img2

【图片对照表】
@img1 对应 梵高星空.jpg (风格来源)
@img2 对应 我的照片.jpg (目标图片)

请将目标照片转换为梵高星空的艺术风格，包含旋转的笔触和鲜艳的蓝黄色调。";

        Log("\n【用户原始输入】");
        Log("  Prompt: 把 @img1 的风格应用到 @img2");
        Log("  ImageRefs:");
        Log("    @img1: 梵高星空.jpg");
        Log("    @img2: 我的照片.jpg");

        Log("\n【增强后的提示词】");
        Log(new string('-', 40));
        Log(enhancedPrompt);
        Log(new string('-', 40));

        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/generations";
        var requestBody = new
        {
            model = "nano-banana-pro",
            prompt = enhancedPrompt,
            n = 1,
            size = "1024x1024",
            response_format = "url"
        };

        var requestJson = JsonSerializer.Serialize(requestBody, new JsonSerializerOptions { WriteIndented = true });

        Log($"\n【请求体 - 发送给 nanobanana】");
        Log(new string('-', 40));
        Log(requestJson);
        Log(new string('-', 40));

        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var startTime = DateTime.Now;

        Log($"\n【发送中】{startTime:HH:mm:ss.fff}...");

        var response = await _httpClient.PostAsync(endpoint, content);
        var elapsed = DateTime.Now - startTime;
        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n【响应状态】{(int)response.StatusCode} {response.StatusCode}");
        Log($"【耗时】{elapsed.TotalSeconds:F2} 秒");
        Log($"\n【响应体】");
        Log(FormatJson(responseBody));

        Assert.True(response.IsSuccessStatusCode, $"API 返回错误: {responseBody}");

        Log("\n【通过】风格迁移生图成功!");
    }

    private static string FormatJson(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            return JsonSerializer.Serialize(doc, new JsonSerializerOptions { WriteIndented = true });
        }
        catch
        {
            return json;
        }
    }
}
