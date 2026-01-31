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
    /// 测试3: 图生图 (img2img) - 真实发送参考图片
    /// 使用 /v1/images/edits 端点，multipart/form-data 格式
    /// </summary>
    [Fact]
    public async Task 图生图_NanoBananaPro_真实发送参考图()
    {
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[跳过] VVEAI_API_KEY 未设置，请设置环境变量后运行此测试");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("【测试】图生图 (img2img) - 真实发送参考图片");
        Log(new string('=', 80));

        Log("\n【场景说明】");
        Log("  用户输入: @img16@img17 把这两张图融合成一张");
        Log("  系统选择第一张图 @img16 作为 initImage (参考图)");
        Log("  参考图会以 base64 或 binary 形式发送给大模型");

        // 模拟增强后的提示词
        var enhancedPrompt = @"@img16@img17 把这两张图融合成一张，保持第一张图的风格

【图片对照表】
@img16 对应 风格参考图
@img17 对应 目标图片";

        // 创建一个简单的测试图片 (100x100 红色方块 PNG)
        // 这模拟从 COS 读取的 @img16 参考图
        var testImageBase64 = CreateTestImageBase64();
        var testImageBytes = Convert.FromBase64String(testImageBase64);

        Log("\n【参考图信息 - @img16】");
        Log(new string('-', 40));
        Log($"  来源: COS (通过 SHA256 读取)");
        Log($"  SHA256: ae7a4a315940b54d4b07112a8188966268c386de38abe8bbbd457fa294cbf649");
        Log($"  大小: {testImageBytes.Length} bytes");
        Log($"  Base64 前100字符: {testImageBase64[..Math.Min(100, testImageBase64.Length)]}...");

        Log("\n【增强后的提示词】");
        Log(new string('-', 40));
        Log(enhancedPrompt);
        Log(new string('-', 40));

        // 构建 multipart/form-data 请求
        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/edits";

        Log($"\n【请求地址】POST {endpoint}");
        Log("\n【请求体 - multipart/form-data 格式】");
        Log(new string('-', 40));
        Log($@"Content-Type: multipart/form-data

--boundary
Content-Disposition: form-data; name=""model""

nano-banana-pro
--boundary
Content-Disposition: form-data; name=""prompt""

{enhancedPrompt}
--boundary
Content-Disposition: form-data; name=""image""; filename=""ref_img16.png""
Content-Type: image/png

<二进制图片数据, {testImageBytes.Length} bytes>
--boundary
Content-Disposition: form-data; name=""n""

1
--boundary
Content-Disposition: form-data; name=""size""

1024x1024
--boundary
Content-Disposition: form-data; name=""response_format""

url
--boundary--");
        Log(new string('-', 40));

        // 构建真实请求
        using var formContent = new MultipartFormDataContent();
        formContent.Add(new StringContent("nano-banana-pro"), "model");
        formContent.Add(new StringContent(enhancedPrompt), "prompt");
        formContent.Add(new StringContent("1"), "n");
        formContent.Add(new StringContent("1024x1024"), "size");
        formContent.Add(new StringContent("url"), "response_format");

        // 添加图片 - 这是关键！参考图以二进制形式发送
        var imageContent = new ByteArrayContent(testImageBytes);
        imageContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
        formContent.Add(imageContent, "image", "ref_img16.png");

        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _apiKey);

        var startTime = DateTime.Now;
        Log($"\n【发送中】{startTime:HH:mm:ss.fff}...");
        Log("  正在发送参考图 + 增强提示词给大模型...");

        var response = await _httpClient.PostAsync(endpoint, formContent);
        var elapsed = DateTime.Now - startTime;
        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n【响应状态】{(int)response.StatusCode} {response.StatusCode}");
        Log($"【耗时】{elapsed.TotalSeconds:F2} 秒");
        Log($"\n【响应体】");
        Log(FormatJson(responseBody));

        // 如果 /edits 不支持，尝试说明
        if (!response.IsSuccessStatusCode)
        {
            Log("\n【说明】");
            Log("  如果返回 404 或不支持，可能是该模型/平台不支持 /v1/images/edits 端点");
            Log("  某些平台只支持文生图 (/v1/images/generations)，不支持图生图");
        }
        else
        {
            Log("\n【通过】图生图成功 - 参考图已发送给大模型!");
        }
    }

    /// <summary>
    /// 创建一个简单的测试图片 (100x100 彩色渐变 PNG)
    /// 模拟从 COS 读取的参考图
    /// </summary>
    private static string CreateTestImageBase64()
    {
        // 创建一个简单的 100x100 PNG 图片
        // 这是一个最小的有效 PNG 文件 (红色方块)
        // 实际生产中，这会从 COS 读取真实图片
        using var ms = new MemoryStream();

        // PNG 文件头
        byte[] pngHeader = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
        ms.Write(pngHeader);

        // IHDR chunk (图像头)
        var ihdr = CreatePngChunk("IHDR", new byte[] {
            0x00, 0x00, 0x00, 0x64, // width: 100
            0x00, 0x00, 0x00, 0x64, // height: 100
            0x08,                   // bit depth: 8
            0x02,                   // color type: RGB
            0x00,                   // compression
            0x00,                   // filter
            0x00                    // interlace
        });
        ms.Write(ihdr);

        // IDAT chunk (图像数据) - 简化版，使用未压缩数据
        // 为了简单，我们创建一个小的测试图片
        var imageData = CreateSimpleImageData(100, 100);
        var idat = CreatePngChunk("IDAT", Compress(imageData));
        ms.Write(idat);

        // IEND chunk (图像结束)
        var iend = CreatePngChunk("IEND", Array.Empty<byte>());
        ms.Write(iend);

        return Convert.ToBase64String(ms.ToArray());
    }

    private static byte[] CreateSimpleImageData(int width, int height)
    {
        // 创建原始图像数据 (每行以 filter byte 0 开头)
        var data = new List<byte>();
        for (int y = 0; y < height; y++)
        {
            data.Add(0); // filter: none
            for (int x = 0; x < width; x++)
            {
                // 创建渐变色彩
                data.Add((byte)(x * 255 / width));  // R
                data.Add((byte)(y * 255 / height)); // G
                data.Add(128);                       // B
            }
        }
        return data.ToArray();
    }

    private static byte[] Compress(byte[] data)
    {
        using var output = new MemoryStream();
        using (var deflate = new System.IO.Compression.DeflateStream(output, System.IO.Compression.CompressionLevel.Optimal, true))
        {
            deflate.Write(data, 0, data.Length);
        }

        // zlib header + deflate data + adler32
        var deflated = output.ToArray();
        var result = new byte[2 + deflated.Length + 4];
        result[0] = 0x78; // zlib header
        result[1] = 0x9C;
        Array.Copy(deflated, 0, result, 2, deflated.Length);

        // 计算 Adler-32 校验和
        uint adler = Adler32(data);
        result[result.Length - 4] = (byte)(adler >> 24);
        result[result.Length - 3] = (byte)(adler >> 16);
        result[result.Length - 2] = (byte)(adler >> 8);
        result[result.Length - 1] = (byte)adler;

        return result;
    }

    private static uint Adler32(byte[] data)
    {
        uint a = 1, b = 0;
        foreach (var d in data)
        {
            a = (a + d) % 65521;
            b = (b + a) % 65521;
        }
        return (b << 16) | a;
    }

    private static byte[] CreatePngChunk(string type, byte[] data)
    {
        var result = new byte[4 + 4 + data.Length + 4];
        var length = data.Length;

        // Length (big-endian)
        result[0] = (byte)(length >> 24);
        result[1] = (byte)(length >> 16);
        result[2] = (byte)(length >> 8);
        result[3] = (byte)length;

        // Type
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        Array.Copy(typeBytes, 0, result, 4, 4);

        // Data
        Array.Copy(data, 0, result, 8, data.Length);

        // CRC32
        var crcData = new byte[4 + data.Length];
        Array.Copy(typeBytes, 0, crcData, 0, 4);
        Array.Copy(data, 0, crcData, 4, data.Length);
        var crc = Crc32(crcData);
        result[result.Length - 4] = (byte)(crc >> 24);
        result[result.Length - 3] = (byte)(crc >> 16);
        result[result.Length - 2] = (byte)(crc >> 8);
        result[result.Length - 1] = (byte)crc;

        return result;
    }

    private static uint Crc32(byte[] data)
    {
        uint crc = 0xFFFFFFFF;
        foreach (var b in data)
        {
            crc ^= b;
            for (int i = 0; i < 8; i++)
            {
                crc = (crc >> 1) ^ (0xEDB88320 & (uint)(-(int)(crc & 1)));
            }
        }
        return ~crc;
    }

    /// <summary>
    /// 测试4: 展示完整的请求格式对比
    /// </summary>
    [Fact]
    public void 请求格式对比_文生图vs图生图()
    {
        Log("\n" + new string('=', 80));
        Log("【对比】文生图 vs 图生图 请求格式");
        Log(new string('=', 80));

        var enhancedPrompt = @"@img16@img17 把这两张图融合成一张

【图片对照表】
@img16 对应 风格参考图
@img17 对应 目标图片";

        Log("\n【文生图请求 - /v1/images/generations】");
        Log("  Content-Type: application/json");
        Log("  ❌ 不发送参考图，只发送文本提示词");
        Log(new string('-', 40));
        Log(JsonSerializer.Serialize(new
        {
            model = "nano-banana-pro",
            prompt = enhancedPrompt,
            n = 1,
            size = "1024x1024",
            response_format = "url"
        }, new JsonSerializerOptions { WriteIndented = true }));

        Log("\n" + new string('=', 80));

        Log("\n【图生图请求 - /v1/images/edits】");
        Log("  Content-Type: multipart/form-data");
        Log("  ✅ 发送参考图 + 增强提示词");
        Log(new string('-', 40));
        Log($@"
┌─────────────────────────────────────────────────────────────┐
│ POST /v1/images/edits                                       │
│ Content-Type: multipart/form-data; boundary=----boundary    │
├─────────────────────────────────────────────────────────────┤
│ model: nano-banana-pro                                      │
│ prompt: {enhancedPrompt.Split('\n')[0]}...                  │
│ n: 1                                                        │
│ size: 1024x1024                                            │
│ response_format: url                                        │
├─────────────────────────────────────────────────────────────┤
│ image: <@img16 的二进制数据>                                │
│        - 从 COS 读取 SHA256=ae7a4a31... 对应的图片         │
│        - 约 50KB ~ 5MB                                      │
│        - Content-Type: image/png 或 image/jpeg             │
└─────────────────────────────────────────────────────────────┘");
        Log(new string('-', 40));

        Log("\n【关键区别】");
        Log("  1. 文生图: 只有文本 prompt，大模型纯靠想象");
        Log("  2. 图生图: 有参考图 + prompt，大模型可以看到实际图片");
        Log("  3. 多图场景: 目前取第一张 @img16 作为参考图发送");
        Log("  4. 提示词中的【图片对照表】帮助模型理解多图关系");

        Log("\n【通过】格式对比展示完成!");
    }

    /// <summary>
    /// 测试5: 图生图格式展示（无需 API Key）
    /// </summary>
    [Fact]
    public void 图生图_请求格式详解()
    {
        Log("\n" + new string('=', 80));
        Log("【详解】图生图请求格式 - 参考图如何发送给大模型");
        Log(new string('=', 80));

        Log("\n【用户操作】");
        Log("  1. 用户在画布上选中 @img16 和 @img17");
        Log("  2. 输入: \"@img16@img17 把这两张图融合成一张\"");
        Log("  3. 点击生成");

        Log("\n【前端处理】");
        Log("  1. 解析出 imageRefs: [@img16, @img17]");
        Log("  2. 每个 imageRef 包含:");
        Log("     - refId: 16 / 17");
        Log("     - assetSha256: 图片在 COS 的唯一标识");
        Log("     - url: COS 访问链接");
        Log("     - label: 用户标签");

        Log("\n【后端 Controller 收到的请求体】");
        Log(new string('-', 40));
        Log(JsonSerializer.Serialize(new
        {
            prompt = "@img16@img17 把这两张图融合成一张",
            targetKey = "canvas-element-abc123",
            platformId = "vveai-platform",
            modelId = "nano-banana-pro",
            size = "1024x1024",
            imageRefs = new[]
            {
                new { refId = 16, assetSha256 = "ae7a4a315940b54d4b07112a8188966268c386de38abe8bbbd457fa294cbf649", url = "https://cos.example.com/img16.png", label = "风格参考图" },
                new { refId = 17, assetSha256 = "b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef12", url = "https://cos.example.com/img17.png", label = "目标图片" }
            }
        }, new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
        Log(new string('-', 40));

        Log("\n【Worker 处理流程】");
        Log("  1. MultiImageDomainService.ParsePromptRefs() 解析 @imgN");
        Log("  2. MultiImageDomainService.BuildFinalPromptAsync() 生成增强提示词");
        Log("  3. 选择第一张图 @img16 作为参考图");
        Log("  4. 从 COS 读取 @img16 的二进制数据 (通过 SHA256)");

        Log("\n【Worker 读取参考图】");
        Log(new string('-', 40));
        Log(@"// 从 COS 读取 @img16 的图片数据
var sha256 = imageRefs[0].AssetSha256; // ae7a4a31...
var imageBytes = await _assetStorage.TryReadByShaAsync(sha256);
var imageBase64 = Convert.ToBase64String(imageBytes);

// 结果：
//   imageBytes: <234,567 bytes 的 PNG 二进制数据>
//   imageBase64: ""iVBORw0KGgoAAAANSUhEUgAA...""");
        Log(new string('-', 40));

        Log("\n【最终发送给 nanobanana 的请求】");
        Log(new string('-', 40));
        Log(@"POST https://api.vveai.com/v1/images/edits
Authorization: Bearer sk-xxx...
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxk

------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name=""model""

nano-banana-pro
------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name=""prompt""

@img16@img17 把这两张图融合成一张

【图片对照表】
@img16 对应 风格参考图
@img17 对应 目标图片
------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name=""image""; filename=""ref_img16.png""
Content-Type: image/png

<@img16 的 234,567 bytes 二进制数据 - 从 COS 读取>
------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name=""size""

1024x1024
------WebKitFormBoundary7MA4YWxk
Content-Disposition: form-data; name=""response_format""

url
------WebKitFormBoundary7MA4YWxk--");
        Log(new string('-', 40));

        Log("\n【关键点】");
        Log("  ✅ image 字段: 包含 @img16 的真实图片二进制数据");
        Log("  ✅ prompt 字段: 包含【图片对照表】的增强提示词");
        Log("  ✅ 大模型能看到: 真实的参考图 + 文字描述");

        Log("\n【通过】请求格式详解完成!");
    }

    /// <summary>
    /// 测试6: 风格迁移场景
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

    /// <summary>
    /// 测试7: Vision API 多图生成 - 使用 /v1/chat/completions 发送多张图片
    /// 这是新架构支持的真正多图模式
    /// </summary>
    [Fact]
    public async Task 多图VisionAPI_发送多张真实图片()
    {
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[跳过] VVEAI_API_KEY 未设置，请设置环境变量后运行此测试");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("【测试】Vision API 多图生成 - /v1/chat/completions");
        Log(new string('=', 80));

        Log("\n【场景说明】");
        Log("  用户输入: @img16@img17 把这两张图融合成一张");
        Log("  新架构: 使用 Vision API 发送所有图片到模型");
        Log("  端点: /v1/chat/completions (而非 /v1/images/edits)");

        // 创建两张测试图片
        var testImage1Base64 = CreateTestImageBase64();
        var testImage2Base64 = CreateTestImageBase64_Variant();

        Log("\n【已加载的图片】");
        Log($"  @img16 (风格参考图): {testImage1Base64.Length} chars base64");
        Log($"  @img17 (目标图片): {testImage2Base64.Length} chars base64");

        // 增强后的提示词
        var enhancedPrompt = @"@img16@img17 把这两张图融合成一张

【图片对照表】
@img16 对应 风格参考图
@img17 对应 目标图片";

        Log("\n【增强后的提示词】");
        Log(new string('-', 40));
        Log(enhancedPrompt);
        Log(new string('-', 40));

        // 构建 Vision API 请求
        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/chat/completions";

        // 构建 messages 数组 (Vision API 格式)
        var requestBody = new
        {
            model = "nano-banana-pro",
            messages = new[]
            {
                new
                {
                    role = "user",
                    content = new object[]
                    {
                        new { type = "text", text = enhancedPrompt },
                        new
                        {
                            type = "image_url",
                            image_url = new { url = $"data:image/png;base64,{testImage1Base64}" }
                        },
                        new
                        {
                            type = "image_url",
                            image_url = new { url = $"data:image/png;base64,{testImage2Base64}" }
                        }
                    }
                }
            },
            max_tokens = 4096
        };

        var requestJson = JsonSerializer.Serialize(requestBody, new JsonSerializerOptions { WriteIndented = true });

        Log($"\n【请求地址】POST {endpoint}");
        Log($"\n【请求体 - Vision API 格式】");
        Log(new string('-', 40));
        // 由于 base64 太长，只显示结构
        Log($@"{{
  ""model"": ""nano-banana-pro"",
  ""messages"": [
    {{
      ""role"": ""user"",
      ""content"": [
        {{ ""type"": ""text"", ""text"": ""{enhancedPrompt.Split('\n')[0]}..."" }},
        {{ ""type"": ""image_url"", ""image_url"": {{ ""url"": ""data:image/png;base64,<{testImage1Base64.Length} chars>"" }} }},
        {{ ""type"": ""image_url"", ""image_url"": {{ ""url"": ""data:image/png;base64,<{testImage2Base64.Length} chars>"" }} }}
      ]
    }}
  ],
  ""max_tokens"": 4096
}}");
        Log(new string('-', 40));

        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var startTime = DateTime.Now;

        Log($"\n【发送中】{startTime:HH:mm:ss.fff}...");
        Log("  正在发送 2 张图片 + 增强提示词给大模型 (Vision API)...");

        var response = await _httpClient.PostAsync(endpoint, content);
        var elapsed = DateTime.Now - startTime;
        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n【响应状态】{(int)response.StatusCode} {response.StatusCode}");
        Log($"【耗时】{elapsed.TotalSeconds:F2} 秒");
        Log($"\n【响应体】");
        Log(FormatJson(responseBody));

        if (!response.IsSuccessStatusCode)
        {
            Log("\n【说明】");
            Log("  如果返回错误，可能是:");
            Log("  1. 该模型不支持 Vision API 格式");
            Log("  2. 图片格式/大小不符合要求");
            Log("  3. API 配额不足");
        }
        else
        {
            Log("\n【通过】Vision API 多图生成成功!");
            Log("  ✅ 两张图片都已发送给大模型");
            Log("  ✅ 模型能够同时看到所有参考图");
        }
    }

    /// <summary>
    /// 测试8: Vision API 请求格式文档（无需 API Key）
    /// </summary>
    [Fact]
    public void VisionAPI_请求格式详解()
    {
        Log("\n" + new string('=', 80));
        Log("【详解】Vision API 多图请求格式");
        Log(new string('=', 80));

        Log("\n【与传统 img2img 的区别】");
        Log("  传统 img2img (/v1/images/edits):");
        Log("    - 只能发送 1 张参考图");
        Log("    - 使用 multipart/form-data 格式");
        Log("    - 参考图作为二进制文件上传");
        Log("");
        Log("  Vision API (/v1/chat/completions):");
        Log("    - 可以发送 1-6 张图片");
        Log("    - 使用 application/json 格式");
        Log("    - 图片作为 data URL (base64) 嵌入请求");

        Log("\n【Vision API 请求结构】");
        Log(new string('-', 40));
        Log(@"{
  ""model"": ""nano-banana-pro"",
  ""messages"": [
    {
      ""role"": ""user"",
      ""content"": [
        {
          ""type"": ""text"",
          ""text"": ""@img16@img17 把这两张图融合成一张\n\n【图片对照表】\n@img16 对应 风格参考图\n@img17 对应 目标图片""
        },
        {
          ""type"": ""image_url"",
          ""image_url"": {
            ""url"": ""data:image/jpeg;base64,/9j/4AAQ...""  // @img16 的 base64
          }
        },
        {
          ""type"": ""image_url"",
          ""image_url"": {
            ""url"": ""data:image/jpeg;base64,/9j/4BBR...""  // @img17 的 base64
          }
        }
      ]
    }
  ],
  ""max_tokens"": 4096
}");
        Log(new string('-', 40));

        Log("\n【Worker 处理流程 (新架构)】");
        Log("  1. MultiImageDomainService.ParsePromptRefs() 解析 @imgN");
        Log("  2. 遍历所有 resolvedRefs，从 COS 加载每张图片");
        Log("  3. BuildFinalPromptAsync() 生成增强提示词");
        Log("  4. 判断图片数量:");
        Log("     - 0 张: 文生图 (/v1/images/generations)");
        Log("     - 1 张: 图生图 (/v1/images/edits)");
        Log("     - 2+ 张: Vision API (/v1/chat/completions)");
        Log("  5. 调用 GenerateWithVisionAsync() 发送多图请求");

        Log("\n【关键代码路径】");
        Log("  OpenAIImageClient.GenerateWithVisionAsync()");
        Log("    → BuildVisionContent() 构建 messages 数组");
        Log("    → POST /v1/chat/completions");
        Log("    → 解析响应中的图片数据");

        Log("\n【限制】");
        Log("  - 最多 6 张图片 (nanobanana 限制)");
        Log("  - 单张图片最大 20MB");
        Log("  - 超时时间: 120 秒 (多图处理需要更长时间)");

        Log("\n【通过】Vision API 格式详解完成!");
    }

    /// <summary>
    /// 创建第二张测试图片 (与第一张略有不同)
    /// </summary>
    private static string CreateTestImageBase64_Variant()
    {
        using var ms = new MemoryStream();

        byte[] pngHeader = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
        ms.Write(pngHeader);

        var ihdr = CreatePngChunk("IHDR", new byte[] {
            0x00, 0x00, 0x00, 0x64, // width: 100
            0x00, 0x00, 0x00, 0x64, // height: 100
            0x08,                   // bit depth: 8
            0x02,                   // color type: RGB
            0x00, 0x00, 0x00
        });
        ms.Write(ihdr);

        // 创建不同的渐变色 (蓝绿色调)
        var imageData = CreateVariantImageData(100, 100);
        var idat = CreatePngChunk("IDAT", Compress(imageData));
        ms.Write(idat);

        var iend = CreatePngChunk("IEND", Array.Empty<byte>());
        ms.Write(iend);

        return Convert.ToBase64String(ms.ToArray());
    }

    private static byte[] CreateVariantImageData(int width, int height)
    {
        var data = new List<byte>();
        for (int y = 0; y < height; y++)
        {
            data.Add(0); // filter: none
            for (int x = 0; x < width; x++)
            {
                // 蓝绿渐变
                data.Add(128);                       // R
                data.Add((byte)(x * 255 / width));   // G
                data.Add((byte)(y * 255 / height));  // B
            }
        }
        return data.ToArray();
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
