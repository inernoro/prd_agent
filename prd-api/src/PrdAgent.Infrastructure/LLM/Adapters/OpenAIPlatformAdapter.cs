using System.Text.Json;
using System.Text.Json.Serialization;

namespace PrdAgent.Infrastructure.LLM.Adapters;

/// <summary>
/// OpenAI 兼容平台适配器
/// 支持标准 OpenAI API 格式，也兼容大部分 OpenAI 兼容网关
/// </summary>
public class OpenAIPlatformAdapter : IImageGenPlatformAdapter
{
    public string PlatformType => "openai";

    public string ProviderNameForLog => "OpenAI";

    public bool SupportsImageToImage => true;

    public bool ForceUrlResponseFormat => false;

    public string GetGenerationsEndpoint(string baseUrl)
    {
        return BuildOpenAIEndpoint(baseUrl, "images/generations");
    }

    public string GetEditsEndpoint(string baseUrl)
    {
        return BuildOpenAIEndpoint(baseUrl, "images/edits");
    }

    /// <summary>
    /// 构建 OpenAI 兼容端点路径
    /// 支持以下场景：
    /// 1. 无路径：补上 /v1
    /// 2. 已有 /v1：直接拼接能力路径
    /// 3. 已有完整路径（如 /api/v1/open-platform）：保留并拼接能力路径
    /// 4. # 结尾：强制使用原地址
    /// 5. 重复路径（如 /v1/v1）：去重后拼接
    /// </summary>
    private static string BuildOpenAIEndpoint(string baseUrl, string capabilityPath)
    {
        if (string.IsNullOrWhiteSpace(baseUrl)) return string.Empty;
        if (string.IsNullOrWhiteSpace(capabilityPath)) return string.Empty;

        var raw = baseUrl.Trim();
        var cap = capabilityPath.Trim().TrimStart('/');

        // 规则：以 # 结尾 - 强制使用原地址（不做任何拼接）
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

            // 检测并移除路径中重复的 /v1/v1 前缀
            var normalizedPath = path;
            while (normalizedPath.Contains("/v1/v1", StringComparison.OrdinalIgnoreCase))
            {
                normalizedPath = normalizedPath.Replace("/v1/v1", "/v1", StringComparison.OrdinalIgnoreCase);
            }

            // 若路径已包含 /v1，直接拼接能力路径
            if (normalizedPath.Contains("/v1", StringComparison.OrdinalIgnoreCase))
            {
                return $"{schemeAndHost}{normalizedPath}/{cap}";
            }

            // 否则补上 /v1
            return $"{schemeAndHost}{normalizedPath}/v1/{cap}";
        }

        // 兜底：无法解析为 URI 时的简单处理
        var cleanedRaw = raw.TrimEnd('/');
        // 移除可能存在的重复 /v1
        if (cleanedRaw.Contains("/v1/v1", StringComparison.OrdinalIgnoreCase))
        {
            cleanedRaw = cleanedRaw.Replace("/v1/v1", "/v1", StringComparison.OrdinalIgnoreCase);
        }

        if (cleanedRaw.Contains("/v1", StringComparison.OrdinalIgnoreCase))
        {
            return cleanedRaw + "/" + cap;
        }

        return cleanedRaw + "/v1/" + cap;
    }

    public object BuildGenerationRequest(
        string model,
        string prompt,
        int n,
        string? size,
        string? responseFormat,
        Dictionary<string, object>? sizeParams = null)
    {
        // 使用 Dictionary 支持动态尺寸参数格式
        var request = new Dictionary<string, object>
        {
            ["model"] = model,
            ["prompt"] = prompt.Trim(),
            ["n"] = n
        };

        if (!string.IsNullOrWhiteSpace(responseFormat))
        {
            request["response_format"] = responseFormat.Trim();
        }

        // 优先使用适配器配置的尺寸参数（可能是 width/height 分开）
        if (sizeParams != null && sizeParams.Count > 0)
        {
            foreach (var kv in sizeParams)
            {
                request[kv.Key] = kv.Value;
            }
        }
        else if (!string.IsNullOrWhiteSpace(size))
        {
            request["size"] = size.Trim();
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
        return new OpenAIImageEditRequest
        {
            Model = model,
            Prompt = prompt.Trim(),
            N = n,
            Size = size?.Trim(),
            ResponseFormat = responseFormat?.Trim()
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

    public string? NormalizeSize(string? size)
    {
        // OpenAI 不需要特殊的尺寸归一化
        return size?.Trim();
    }

    public ImageGenResponseItem ParseResponseItem(JsonElement item)
    {
        var result = new ImageGenResponseItem();

        if (item.TryGetProperty("url", out var urlProp))
        {
            result.Url = urlProp.GetString();
        }
        if (item.TryGetProperty("b64_json", out var b64Prop))
        {
            result.Base64 = b64Prop.GetString();
        }
        if (item.TryGetProperty("revised_prompt", out var revisedProp))
        {
            result.RevisedPrompt = revisedProp.GetString();
        }

        return result;
    }

    public string? HandleSizeError(string errorMessage, string? currentSize)
    {
        // OpenAI 通常不需要自动尺寸调整，由白名单缓存机制处理
        return null;
    }
}

/// <summary>
/// OpenAI 图生图请求
/// </summary>
internal class OpenAIImageEditRequest
{
    public string? Model { get; set; }
    public string? Prompt { get; set; }
    public int N { get; set; } = 1;
    public string? Size { get; set; }
    [JsonPropertyName("response_format")]
    public string? ResponseFormat { get; set; }
}
