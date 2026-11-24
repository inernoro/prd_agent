using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// fal.ai Qwen-Image-Layered 转换器。
/// 将标准图生图请求映射为单图语义分层请求，并把 RGBA 图层列表映射回标准 data[]。
/// </summary>
public sealed class FalImageLayeredTransformer : IExchangeTransformer
{
    public string TransformerType => "fal-image-layered";

    public string? ResolveTargetUrl(
        string baseUrl,
        JsonObject standardBody,
        Dictionary<string, object>? config)
        => baseUrl.TrimEnd('/');

    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        var falBody = new JsonObject
        {
            ["num_layers"] = ResolveLayerCount(standardBody),
            ["output_format"] = "png",
            ["enable_safety_checker"] = true,
            ["acceleration"] = "regular"
        };

        if (standardBody.TryGetPropertyValue("image_url", out var singleImage)
            && singleImage is JsonValue)
        {
            falBody["image_url"] = singleImage.DeepClone();
        }
        else if (standardBody.TryGetPropertyValue("image_urls", out var images)
                 && images is JsonArray imageArray
                 && imageArray.Count > 0)
        {
            falBody["image_url"] = imageArray[0]?.DeepClone();
        }

        if (standardBody.TryGetPropertyValue("prompt", out var prompt)
            && prompt is JsonValue)
        {
            falBody["prompt"] = prompt.DeepClone();
        }

        foreach (var field in new[]
                 {
                     "seed", "negative_prompt", "num_inference_steps", "guidance_scale",
                     "sync_mode", "enable_safety_checker", "acceleration"
                 })
        {
            if (standardBody.TryGetPropertyValue(field, out var value) && value != null)
                falBody[field] = value.DeepClone();
        }

        return falBody;
    }

    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
    {
        var data = new JsonArray();
        if (rawResponse.TryGetPropertyValue("images", out var images)
            && images is JsonArray imageArray)
        {
            foreach (var image in imageArray.OfType<JsonObject>())
            {
                var item = new JsonObject();
                if (image.TryGetPropertyValue("url", out var url))
                    item["url"] = url?.DeepClone();
                if (image.TryGetPropertyValue("content_type", out var contentType))
                    item["content_type"] = contentType?.DeepClone();
                data.Add(item);
            }
        }

        return new JsonObject
        {
            ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            ["data"] = data
        };
    }

    private static int ResolveLayerCount(JsonObject standardBody)
    {
        if (standardBody.TryGetPropertyValue("num_layers", out var explicitCount)
            && explicitCount is JsonValue explicitValue
            && explicitValue.TryGetValue<int>(out var configured))
        {
            return Math.Clamp(configured, 1, 10);
        }

        if (standardBody.TryGetPropertyValue("n", out var standardCount)
            && standardCount is JsonValue standardValue
            && standardValue.TryGetValue<int>(out var requested))
        {
            return Math.Clamp(requested, 1, 10);
        }

        return 4;
    }
}
