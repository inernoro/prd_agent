using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// Real API integration test for vveai nano-banana-pro model
///
/// Run with PowerShell:
/// $env:VVEAI_API_KEY = "your-api-key-here"
/// $env:VVEAI_BASE_URL = "https://api.vveai.com"  # or your vveai endpoint
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
            Timeout = TimeSpan.FromMinutes(5) // Image generation can take a while
        };

        Log($"[Init] VVEAI_BASE_URL: {_baseUrl}");
        Log($"[Init] VVEAI_API_KEY: {(_apiKey != null ? $"{_apiKey[..Math.Min(8, _apiKey.Length)]}..." : "(not set)")}");
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
    /// Test 1: Basic text-to-image generation with nano-banana-pro
    /// </summary>
    [Fact]
    public async Task TextToImage_NanoBananaPro_ShouldGenerateImage()
    {
        // Skip if no API key
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[SKIP] VVEAI_API_KEY not set. Set environment variable to run this test.");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("[Test] Text-to-Image with nano-banana-pro");
        Log(new string('=', 80));

        // Build request
        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/generations";
        var request = new
        {
            model = "nano-banana-pro",
            prompt = "A beautiful sunset over mountains, digital art style, vibrant colors",
            n = 1,
            size = "1024x1024",
            response_format = "url"
        };

        var requestJson = JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true });

        Log($"\n[Request] POST {endpoint}");
        Log($"[Request Body]\n{requestJson}");

        // Send request
        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var startTime = DateTime.Now;

        Log($"\n[Sending] {startTime:HH:mm:ss.fff}...");

        var response = await _httpClient.PostAsync(endpoint, content);
        var elapsed = DateTime.Now - startTime;

        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n[Response] Status: {(int)response.StatusCode} {response.StatusCode}");
        Log($"[Response] Time: {elapsed.TotalSeconds:F2}s");
        Log($"[Response Body]\n{FormatJson(responseBody)}");

        // Verify
        Assert.True(response.IsSuccessStatusCode, $"API returned error: {responseBody}");
        Assert.Contains("url", responseBody.ToLower());

        Log("\n[PASS] Text-to-image generation successful!");
    }

    /// <summary>
    /// Test 2: Multi-image reference prompt (simulating @img16@img17 scenario)
    /// Tests that the enhanced prompt with image reference table works
    /// </summary>
    [Fact]
    public async Task MultiImagePrompt_NanoBananaPro_ShouldGenerateImage()
    {
        // Skip if no API key
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[SKIP] VVEAI_API_KEY not set. Set environment variable to run this test.");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("[Test] Multi-Image Reference Prompt with nano-banana-pro");
        Log(new string('=', 80));

        // Simulate the enhanced prompt that MultiImageDomainService would generate
        var enhancedPrompt = @"@img16@img17 Merge these two images into one

---
[Image Reference Table / 图片对照表]
@img16 corresponds to Style Reference Image
@img17 corresponds to Target Image
---

Please analyze the style from the first image and apply it to the second image, creating a harmonious fusion.";

        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/generations";
        var request = new
        {
            model = "nano-banana-pro",
            prompt = enhancedPrompt,
            n = 1,
            size = "1024x1024",
            response_format = "url"
        };

        var requestJson = JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true });

        Log($"\n[Request] POST {endpoint}");
        Log($"[Request Body]\n{requestJson}");

        // Send request
        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var startTime = DateTime.Now;

        Log($"\n[Sending] {startTime:HH:mm:ss.fff}...");

        var response = await _httpClient.PostAsync(endpoint, content);
        var elapsed = DateTime.Now - startTime;

        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n[Response] Status: {(int)response.StatusCode} {response.StatusCode}");
        Log($"[Response] Time: {elapsed.TotalSeconds:F2}s");
        Log($"[Response Body]\n{FormatJson(responseBody)}");

        // Verify
        Assert.True(response.IsSuccessStatusCode, $"API returned error: {responseBody}");
        Assert.Contains("url", responseBody.ToLower());

        Log("\n[PASS] Multi-image reference prompt generation successful!");
    }

    /// <summary>
    /// Test 3: Style transfer prompt
    /// </summary>
    [Fact]
    public async Task StyleTransferPrompt_NanoBananaPro_ShouldGenerateImage()
    {
        // Skip if no API key
        if (string.IsNullOrWhiteSpace(_apiKey))
        {
            Log("[SKIP] VVEAI_API_KEY not set. Set environment variable to run this test.");
            return;
        }

        Log("\n" + new string('=', 80));
        Log("[Test] Style Transfer Prompt with nano-banana-pro");
        Log(new string('=', 80));

        // Simulate style transfer enhanced prompt
        var enhancedPrompt = @"Apply the style from @img1 to @img2

---
[Image Reference Table / 图片对照表]
@img1 corresponds to Van Gogh Starry Night.jpg (style source)
@img2 corresponds to My Photo.jpg (target image)
---

Create an image that transforms the target photo using the artistic style of Van Gogh's Starry Night, with swirling brushstrokes and vibrant blues and yellows.";

        var endpoint = $"{_baseUrl.TrimEnd('/')}/v1/images/generations";
        var request = new
        {
            model = "nano-banana-pro",
            prompt = enhancedPrompt,
            n = 1,
            size = "1024x1024",
            response_format = "url"
        };

        var requestJson = JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true });

        Log($"\n[Request] POST {endpoint}");
        Log($"[Request Body]\n{requestJson}");

        // Send request
        _httpClient.DefaultRequestHeaders.Clear();
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

        var content = new StringContent(requestJson, Encoding.UTF8, "application/json");
        var startTime = DateTime.Now;

        Log($"\n[Sending] {startTime:HH:mm:ss.fff}...");

        var response = await _httpClient.PostAsync(endpoint, content);
        var elapsed = DateTime.Now - startTime;

        var responseBody = await response.Content.ReadAsStringAsync();

        Log($"\n[Response] Status: {(int)response.StatusCode} {response.StatusCode}");
        Log($"[Response] Time: {elapsed.TotalSeconds:F2}s");
        Log($"[Response Body]\n{FormatJson(responseBody)}");

        // Verify
        Assert.True(response.IsSuccessStatusCode, $"API returned error: {responseBody}");

        Log("\n[PASS] Style transfer prompt generation successful!");
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
