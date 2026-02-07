using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.LLM.Adapters;

/// <summary>
/// Google Gemini 平台适配器
/// 支持 Google 原生 generateContent API 格式（apiyi.com 等代理商也支持）
/// 特点：
/// - 文生图/图生图/多图生图 共用同一端点 (/v1beta/models/{model}:generateContent)
/// - 尺寸用 aspectRatio + imageSize 表达，不用 WxH
/// - 图片作为 inline_data parts 嵌入请求
/// - 响应从 candidates[0].content.parts[].inlineData.data 取 base64
/// </summary>
public class GooglePlatformAdapter : IImageGenPlatformAdapter
{
    public string PlatformType => "google";

    public string ProviderNameForLog => "Google";

    /// <summary>
    /// Google 原生格式支持图生图（通过 inline_data parts）
    /// </summary>
    public bool SupportsImageToImage => true;

    /// <summary>
    /// Google 返回 inline base64，不需要强制 URL
    /// </summary>
    public bool ForceUrlResponseFormat => false;

    // ──────────────────────────────────────────────
    // 端点构建
    // ──────────────────────────────────────────────

    /// <summary>
    /// Google 文生图和图生图使用同一端点（模型名由外部注入）
    /// 这里仅返回 baseUrl，实际端点路径由 BuildGoogleEndpointPath 构建
    /// </summary>
    public string GetGenerationsEndpoint(string baseUrl) => baseUrl?.TrimEnd('/') ?? string.Empty;

    /// <summary>
    /// Google 编辑端点与生成端点相同
    /// </summary>
    public string GetEditsEndpoint(string baseUrl) => GetGenerationsEndpoint(baseUrl);

    /// <summary>
    /// 构建 Google generateContent 完整 URL
    /// </summary>
    /// <param name="baseUrl">平台 API 基础 URL（如 https://api.apiyi.com）</param>
    /// <param name="modelName">模型名称（如 gemini-3-pro-image-preview）</param>
    /// <returns>完整端点 URL</returns>
    public static string BuildGoogleEndpointUrl(string baseUrl, string modelName)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) return string.Empty;
        var raw = baseUrl.Trim();

        // 以 # 结尾 → 强制使用原地址
        if (raw.EndsWith("#", StringComparison.Ordinal))
            return raw.TrimEnd('#');

        var clean = raw.TrimEnd('/');

        // 已包含 :generateContent → 使用原地址
        if (clean.Contains(":generateContent", StringComparison.OrdinalIgnoreCase))
            return clean;

        // 已包含 /v1beta/models → 追加 {model}:generateContent
        if (clean.Contains("/v1beta/models", StringComparison.OrdinalIgnoreCase))
        {
            // 检查是否已包含模型名（如 /v1beta/models/gemini-xxx）
            var modelsIdx = clean.IndexOf("/models/", StringComparison.OrdinalIgnoreCase);
            if (modelsIdx >= 0)
            {
                var afterModels = clean[(modelsIdx + "/models/".Length)..];
                if (!string.IsNullOrWhiteSpace(afterModels))
                    return $"{clean}:generateContent";
            }
            return $"{clean}/{modelName}:generateContent";
        }

        // 已包含 /v1beta → 追加 models/{model}:generateContent
        if (clean.Contains("/v1beta", StringComparison.OrdinalIgnoreCase))
            return $"{clean}/models/{modelName}:generateContent";

        // 默认：追加完整路径
        return $"{clean}/v1beta/models/{modelName}:generateContent";
    }

    /// <summary>
    /// 构建 EndpointPath（用于 GatewayRawRequest，相对路径）
    /// </summary>
    public static string BuildGoogleEndpointPath(string modelName)
    {
        return $"v1beta/models/{modelName}:generateContent";
    }

    // ──────────────────────────────────────────────
    // 请求构建
    // ──────────────────────────────────────────────

    /// <summary>
    /// 构建 Google generateContent 请求体
    /// </summary>
    /// <param name="prompt">文本提示</param>
    /// <param name="aspectRatio">宽高比（如 16:9、1:1）</param>
    /// <param name="imageSize">图片尺寸级别（1K、2K、4K）</param>
    /// <param name="images">参考图列表（data URI 或 raw base64），null/空 表示文生图</param>
    public static JsonObject BuildGoogleRequestBody(
        string prompt,
        string? aspectRatio,
        string? imageSize,
        List<string>? images = null)
    {
        var parts = new JsonArray();

        // 先放参考图（inline_data parts）
        if (images is { Count: > 0 })
        {
            foreach (var img in images)
            {
                var (mimeType, base64Data) = ParseDataUri(img);
                parts.Add(new JsonObject
                {
                    ["inline_data"] = new JsonObject
                    {
                        ["mime_type"] = mimeType,
                        ["data"] = base64Data
                    }
                });
            }
        }

        // 文本提示
        parts.Add(new JsonObject { ["text"] = prompt });

        // generationConfig
        var imageConfig = new JsonObject();
        if (!string.IsNullOrWhiteSpace(aspectRatio))
            imageConfig["aspectRatio"] = aspectRatio;
        if (!string.IsNullOrWhiteSpace(imageSize))
            imageConfig["imageSize"] = imageSize;

        var body = new JsonObject
        {
            ["contents"] = new JsonArray
            {
                new JsonObject { ["parts"] = parts }
            },
            ["generationConfig"] = new JsonObject
            {
                ["responseModalities"] = new JsonArray { "IMAGE" },
                ["imageConfig"] = imageConfig
            }
        };

        return body;
    }

    // ──────────────────────────────────────────────
    // 响应解析
    // ──────────────────────────────────────────────

    /// <summary>
    /// 从 Google generateContent 响应中提取图片 base64 列表
    /// 响应格式：{ candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }
    /// </summary>
    public static List<(string Base64, string MimeType)> ParseGoogleResponseImages(string responseBody)
    {
        var results = new List<(string, string)>();
        if (string.IsNullOrWhiteSpace(responseBody)) return results;

        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;

        if (!root.TryGetProperty("candidates", out var candidates) ||
            candidates.ValueKind != JsonValueKind.Array)
            return results;

        foreach (var candidate in candidates.EnumerateArray())
        {
            if (!candidate.TryGetProperty("content", out var content)) continue;
            if (!content.TryGetProperty("parts", out var parts) ||
                parts.ValueKind != JsonValueKind.Array) continue;

            foreach (var part in parts.EnumerateArray())
            {
                if (!part.TryGetProperty("inlineData", out var inlineData) &&
                    !part.TryGetProperty("inline_data", out inlineData))
                    continue;

                var mimeType = "image/png";
                if (inlineData.TryGetProperty("mimeType", out var mt) ||
                    inlineData.TryGetProperty("mime_type", out mt))
                {
                    mimeType = mt.GetString() ?? "image/png";
                }

                if (inlineData.TryGetProperty("data", out var dataEl) &&
                    dataEl.ValueKind == JsonValueKind.String)
                {
                    var b64 = dataEl.GetString();
                    if (!string.IsNullOrWhiteSpace(b64))
                        results.Add((b64!, mimeType));
                }
            }
        }

        return results;
    }

    // ──────────────────────────────────────────────
    // 尺寸映射
    // ──────────────────────────────────────────────

    /// <summary>
    /// Google 支持的宽高比
    /// </summary>
    private static readonly (string Ratio, double Value)[] SupportedAspectRatios =
    {
        ("1:1", 1.0),
        ("16:9", 16.0 / 9.0),
        ("9:16", 9.0 / 16.0),
        ("4:3", 4.0 / 3.0),
        ("3:4", 3.0 / 4.0),
        ("3:2", 3.0 / 2.0),
        ("2:3", 2.0 / 3.0),
        ("21:9", 21.0 / 9.0),
        ("5:4", 5.0 / 4.0),
        ("4:5", 4.0 / 5.0),
    };

    /// <summary>
    /// 将 WxH 尺寸转为 Google 的 aspectRatio + imageSize
    /// </summary>
    /// <param name="size">WxH 格式（如 1024x1024）或 aspectRatio 格式（如 16:9）</param>
    /// <returns>(aspectRatio, imageSize)</returns>
    public static (string AspectRatio, string ImageSize) ParseSizeToGoogleParams(string? size)
    {
        if (string.IsNullOrWhiteSpace(size)) return ("1:1", "1K");

        var s = size.Trim();

        // 已经是 aspectRatio 格式（如 "16:9"）
        if (Regex.IsMatch(s, @"^\d+:\d+$"))
        {
            var match = SupportedAspectRatios.FirstOrDefault(ar => ar.Ratio == s);
            return (match.Ratio ?? "1:1", "1K");
        }

        // WxH 格式
        var m = Regex.Match(s, @"^(\d+)\s*[xX×]\s*(\d+)$");
        if (m.Success &&
            int.TryParse(m.Groups[1].Value, out var w) &&
            int.TryParse(m.Groups[2].Value, out var h) &&
            w > 0 && h > 0)
        {
            var aspectRatio = FindClosestAspectRatio(w, h);
            var imageSize = MapToImageSizeLabel(w, h);
            return (aspectRatio, imageSize);
        }

        // 无法解析，使用默认值
        return ("1:1", "1K");
    }

    /// <summary>
    /// 找到最接近的 Google 支持的宽高比
    /// </summary>
    private static string FindClosestAspectRatio(int w, int h)
    {
        var target = (double)w / h;
        var closest = SupportedAspectRatios
            .OrderBy(ar => Math.Abs(ar.Value - target))
            .First();
        return closest.Ratio;
    }

    /// <summary>
    /// 根据像素尺寸映射到 Google 的 imageSize 级别
    /// </summary>
    private static string MapToImageSizeLabel(int w, int h)
    {
        var maxDim = Math.Max(w, h);
        if (maxDim >= 3840) return "4K";
        if (maxDim >= 1920) return "2K";
        return "1K";
    }

    // ──────────────────────────────────────────────
    // 辅助方法
    // ──────────────────────────────────────────────

    /// <summary>
    /// 解析 data URI 或 raw base64
    /// </summary>
    private static (string MimeType, string Base64) ParseDataUri(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) return ("image/png", string.Empty);

        if (input.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var mimeType = "image/png";
            var semiIdx = input.IndexOf(';');
            if (semiIdx > 5) mimeType = input[5..semiIdx];

            var commaIdx = input.IndexOf(',');
            var base64 = commaIdx >= 0 && commaIdx + 1 < input.Length
                ? input[(commaIdx + 1)..]
                : input;
            return (mimeType, base64);
        }

        return ("image/png", input);
    }

    // ──────────────────────────────────────────────
    // IImageGenPlatformAdapter 接口实现
    // （Google 主要通过专用分支处理，以下是兜底实现）
    // ──────────────────────────────────────────────

    public object BuildGenerationRequest(
        string model, string prompt, int n, string? size, string? responseFormat,
        Dictionary<string, object>? sizeParams = null)
    {
        // 兜底：构建 Google 格式请求体（供非专用分支使用时的安全网）
        var (aspectRatio, imageSize) = ParseSizeToGoogleParams(size);
        // 返回字典格式以兼容现有序列化
        return new Dictionary<string, object>
        {
            ["_google_native"] = true,
            ["prompt"] = prompt,
            ["aspectRatio"] = aspectRatio,
            ["imageSize"] = imageSize,
        };
    }

    public object BuildEditRequest(string model, string prompt, int n, string? size, string? responseFormat)
    {
        return BuildGenerationRequest(model, prompt, n, size, responseFormat);
    }

    public string SerializeRequest(object request)
    {
        if (request is Dictionary<string, object> dict)
            return JsonSerializer.Serialize(dict);
        return JsonSerializer.Serialize(request);
    }

    /// <summary>
    /// Google 不需要 WxH 归一化（使用 aspectRatio + imageSize）
    /// 但保留原始值以便日志记录
    /// </summary>
    public string? NormalizeSize(string? size) => size?.Trim();

    /// <summary>
    /// 解析 Google 响应项（兜底：兼容 OpenAI data[] 格式的调用）
    /// 实际 Google 响应通过 ParseGoogleResponseImages 静态方法处理
    /// </summary>
    public ImageGenResponseItem ParseResponseItem(JsonElement item)
    {
        var result = new ImageGenResponseItem();

        // 尝试 Google inlineData 格式
        if (item.TryGetProperty("inlineData", out var inlineData) ||
            item.TryGetProperty("inline_data", out inlineData))
        {
            if (inlineData.TryGetProperty("data", out var dataEl))
                result.Base64 = dataEl.GetString();
        }

        // 兜底 OpenAI 兼容字段
        if (string.IsNullOrWhiteSpace(result.Base64))
        {
            if (item.TryGetProperty("b64_json", out var b64Prop))
                result.Base64 = b64Prop.GetString();
            if (item.TryGetProperty("url", out var urlProp))
                result.Url = urlProp.GetString();
        }

        return result;
    }

    public string? HandleSizeError(string errorMessage, string? currentSize) => null;
}
