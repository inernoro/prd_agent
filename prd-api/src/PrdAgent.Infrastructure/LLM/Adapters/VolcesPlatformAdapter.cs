using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.LLM.Adapters;

/// <summary>
/// 火山引擎（Volces）平台适配器
/// 支持火山引擎的 Ark API（豆包等模型）
/// </summary>
public class VolcesPlatformAdapter : IImageGenPlatformAdapter
{
    /// <summary>
    /// Volces 最小像素要求：3,686,400（1920x1920）
    /// </summary>
    public const long MinPixels = 3686400;

    public string PlatformType => "volces";

    public string ProviderNameForLog => "Volces";

    /// <summary>
    /// Volces/豆包 不支持 images/edits（图生图）
    /// </summary>
    public bool SupportsImageToImage => false;

    /// <summary>
    /// Volces 强制使用 URL 响应格式（不支持 b64_json）
    /// </summary>
    public bool ForceUrlResponseFormat => true;

    public string GetGenerationsEndpoint(string baseUrl)
    {
        return BuildVolcesEndpoint(baseUrl, "images/generations");
    }

    public string GetEditsEndpoint(string baseUrl)
    {
        // Volces 不支持 images/edits，但仍提供端点以备将来
        return BuildVolcesEndpoint(baseUrl, "images/edits");
    }

    public object BuildGenerationRequest(
        string model,
        string prompt,
        int n,
        string? size,
        string? responseFormat,
        Dictionary<string, object>? sizeParams = null)
    {
        // Volces 强制使用 url 响应格式
        var volcesResponseFormat = "url";
        var normalizedSize = NormalizeSize(size);

        var request = new Dictionary<string, object>
        {
            ["model"] = model,
            ["prompt"] = prompt.Trim(),
            ["n"] = n,
            ["response_format"] = volcesResponseFormat,
            ["sequential_image_generation"] = "disabled",
            ["stream"] = false,
            ["watermark"] = true
        };

        // 优先使用适配器配置的尺寸参数
        if (sizeParams != null && sizeParams.Count > 0)
        {
            foreach (var kv in sizeParams)
            {
                request[kv.Key] = kv.Value;
            }
        }
        else if (!string.IsNullOrWhiteSpace(normalizedSize))
        {
            request["size"] = normalizedSize;
        }

        return request;
    }

    public object BuildEditRequest(
        string model,
        string prompt,
        int n,
        string? size,
        string? responseFormat)
    {
        // Volces 不支持图生图，但仍提供实现以备将来
        return new VolcesImageEditRequest
        {
            Model = model,
            Prompt = prompt.Trim(),
            N = n,
            Size = NormalizeSize(size),
            ResponseFormat = "url",
            Watermark = true
        };
    }

    public string SerializeRequest(object request)
    {
        if (request is Dictionary<string, object> dict)
        {
            return JsonSerializer.Serialize(dict);
        }
        return JsonSerializer.Serialize(request);
    }

    /// <summary>
    /// Volces 尺寸归一化：最小 1920x1920（3,686,400 像素）
    /// </summary>
    public string? NormalizeSize(string? size)
    {
        var raw = (size ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw)) return "1920x1920";

        // 已经是 2K/4K 等标签则原样透传
        if (raw.EndsWith("K", StringComparison.OrdinalIgnoreCase)) return raw;

        // 解析 WxH
        var m = Regex.Match(raw, @"^\s*(\d+)\s*[xX]\s*(\d+)\s*$");
        if (m.Success &&
            int.TryParse(m.Groups[1].Value, out var w) &&
            int.TryParse(m.Groups[2].Value, out var h) &&
            w > 0 && h > 0)
        {
            var pixels = (long)w * h;
            if (pixels < MinPixels) return "1920x1920";
            return $"{w}x{h}";
        }

        // 其他未知格式：兜底到最小可用
        return "1920x1920";
    }

    public ImageGenResponseItem ParseResponseItem(JsonElement item)
    {
        var result = new ImageGenResponseItem();

        if (item.TryGetProperty("url", out var urlProp))
        {
            result.Url = urlProp.GetString();
        }
        // Volces 可能返回实际尺寸
        if (item.TryGetProperty("size", out var sizeProp))
        {
            result.ActualSize = sizeProp.GetString();
        }
        if (item.TryGetProperty("revised_prompt", out var revisedProp))
        {
            result.RevisedPrompt = revisedProp.GetString();
        }

        return result;
    }

    /// <summary>
    /// 处理 Volces 尺寸错误：自动升级到 1920x1920
    /// </summary>
    public string? HandleSizeError(string errorMessage, string? currentSize)
    {
        if (string.IsNullOrWhiteSpace(errorMessage)) return null;

        // 检测是否是尺寸太小的错误
        if (errorMessage.Contains("size", StringComparison.OrdinalIgnoreCase) &&
            errorMessage.Contains("at least", StringComparison.OrdinalIgnoreCase))
        {
            // 如果当前尺寸不是 1920x1920，则建议升级
            if (!string.Equals(currentSize, "1920x1920", StringComparison.OrdinalIgnoreCase))
            {
                return "1920x1920";
            }
        }

        return null;
    }

    /// <summary>
    /// 构建 Volces 端点路径
    /// </summary>
    private static string BuildVolcesEndpoint(string baseUrl, string capabilityPath)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) return string.Empty;
        if (string.IsNullOrWhiteSpace(capabilityPath)) return string.Empty;

        var raw = baseUrl.Trim();
        var cap = capabilityPath.Trim().TrimStart('/');

        // 规则二：以 # 结尾 - 强制使用原地址（不做任何拼接）
        if (raw.EndsWith("#", StringComparison.Ordinal))
        {
            return raw.TrimEnd('#');
        }

        if (Uri.TryCreate(raw, UriKind.Absolute, out var u))
        {
            var path = (u.AbsolutePath ?? string.Empty).TrimEnd('/');

            // 若 baseUrl 已经是完整的能力 endpoint，则直接使用
            if (path.EndsWith("/" + cap, StringComparison.OrdinalIgnoreCase))
            {
                return raw;
            }

            // 获取 scheme + host 部分
            var schemeAndHost = $"{u.Scheme}://{u.Host}";
            if (!u.IsDefaultPort)
            {
                schemeAndHost += $":{u.Port}";
            }

            // 检测并移除路径中重复的 /api/v3 前缀
            // 例如：/api/v3/api/v3 → /api/v3
            var normalizedPath = path;
            while (normalizedPath.Contains("/api/v3/api/v3", StringComparison.OrdinalIgnoreCase))
            {
                normalizedPath = normalizedPath.Replace("/api/v3/api/v3", "/api/v3", StringComparison.OrdinalIgnoreCase);
            }

            // 若路径已包含 /api/v3，直接拼接能力路径
            if (normalizedPath.Contains("/api/v3", StringComparison.OrdinalIgnoreCase))
            {
                // 确保路径以 /api/v3 结尾（移除后续多余部分）
                var apiV3Index = normalizedPath.IndexOf("/api/v3", StringComparison.OrdinalIgnoreCase);
                var basePath = normalizedPath.Substring(0, apiV3Index + 7); // "/api/v3" 长度是 7
                return $"{schemeAndHost}{basePath}/{cap}";
            }

            // 否则补上 /api/v3
            return $"{schemeAndHost}{normalizedPath}/api/v3/{cap}";
        }

        // 兜底：无法解析为 URI 时的简单处理
        // 移除可能存在的重复 /api/v3
        var cleanedRaw = raw.TrimEnd('/');
        if (cleanedRaw.Contains("/api/v3/api/v3", StringComparison.OrdinalIgnoreCase))
        {
            cleanedRaw = cleanedRaw.Replace("/api/v3/api/v3", "/api/v3", StringComparison.OrdinalIgnoreCase);
        }

        if (cleanedRaw.Contains("/api/v3", StringComparison.OrdinalIgnoreCase))
        {
            // 已有 /api/v3，直接拼接
            return cleanedRaw + "/" + cap;
        }

        // 补上 /api/v3
        return cleanedRaw + "/api/v3/" + cap;
    }
}

/// <summary>
/// Volces 图生图请求
/// </summary>
internal class VolcesImageEditRequest
{
    public string? Model { get; set; }
    public string? Prompt { get; set; }
    public int N { get; set; } = 1;
    public string? Size { get; set; }
    [JsonPropertyName("response_format")]
    public string? ResponseFormat { get; set; }
    public bool? Watermark { get; set; }
}
