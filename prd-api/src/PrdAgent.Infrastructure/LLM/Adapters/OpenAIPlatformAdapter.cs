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

            // 若已包含 /v1（作为 base），则直接拼接能力路径
            if (path.Contains("/v1", StringComparison.OrdinalIgnoreCase))
            {
                return raw.TrimEnd('/') + "/" + cap;
            }
        }

        // 默认补上 /v1
        return raw.TrimEnd('/') + "/v1/" + cap;
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
