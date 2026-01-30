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
        return "/v1/images/generations";
    }

    public string GetEditsEndpoint(string baseUrl)
    {
        return "/v1/images/edits";
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
