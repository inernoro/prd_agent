using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// fal.ai 图片编辑转换器
/// 标准 OpenAI 图片生成格式 ↔ fal.ai Nano Banana Pro Edit 格式
/// </summary>
public class FalImageEditTransformer : IExchangeTransformer
{
    public string TransformerType => "fal-image-edit";

    /// <summary>
    /// OpenAI 图片生成格式 → fal.ai 图片编辑格式
    ///
    /// OpenAI input:
    /// { "prompt": "...", "model": "...", "n": 1, "size": "1024x1024", "response_format": "url" }
    ///
    /// fal.ai output:
    /// { "prompt": "...", "num_images": 1, "image_urls": [...], "resolution": "1K", "output_format": "png" }
    /// </summary>
    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        var falBody = new JsonObject();

        // prompt → prompt (直传)
        if (standardBody.TryGetPropertyValue("prompt", out var prompt))
            falBody["prompt"] = prompt?.DeepClone();

        // n → num_images
        if (standardBody.TryGetPropertyValue("n", out var n))
            falBody["num_images"] = n?.DeepClone();
        else
            falBody["num_images"] = 1;

        // image_urls: 从 config 或 standardBody 的扩展字段获取
        if (standardBody.TryGetPropertyValue("image_urls", out var imageUrls))
        {
            falBody["image_urls"] = imageUrls?.DeepClone();
        }
        else if (config?.TryGetValue("image_urls", out var configUrls) == true)
        {
            falBody["image_urls"] = JsonNode.Parse(System.Text.Json.JsonSerializer.Serialize(configUrls));
        }

        // size → aspect_ratio + resolution
        if (standardBody.TryGetPropertyValue("size", out var sizeNode))
        {
            var size = sizeNode?.GetValue<string>();
            if (!string.IsNullOrEmpty(size))
            {
                var (aspectRatio, resolution) = ParseSize(size);
                falBody["aspect_ratio"] = aspectRatio;
                falBody["resolution"] = resolution;
            }
        }

        // response_format → output_format
        if (standardBody.TryGetPropertyValue("response_format", out var formatNode))
        {
            var format = formatNode?.GetValue<string>();
            falBody["output_format"] = format == "b64_json" ? "png" : "png";
        }
        else
        {
            falBody["output_format"] = "png";
        }

        // 透传 fal.ai 原生字段（如果调用方直接传了的话）
        foreach (var falField in new[] { "seed", "safety_tolerance", "sync_mode", "enable_web_search", "limit_generations" })
        {
            if (standardBody.TryGetPropertyValue(falField, out var val))
                falBody[falField] = val?.DeepClone();
        }

        // 移除不需要的字段
        falBody.Remove("model");

        return falBody;
    }

    /// <summary>
    /// fal.ai 响应格式 → OpenAI 图片生成响应格式
    ///
    /// fal.ai input:
    /// { "images": [{ "url": "...", "content_type": "image/png" }], "description": "..." }
    ///
    /// OpenAI output:
    /// { "created": 123, "data": [{ "url": "..." }] }
    /// </summary>
    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
    {
        var openaiResponse = new JsonObject
        {
            ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };

        var dataArray = new JsonArray();

        if (rawResponse.TryGetPropertyValue("images", out var images) &&
            images is JsonArray imagesArr)
        {
            foreach (var img in imagesArr)
            {
                if (img is JsonObject imgObj)
                {
                    var dataItem = new JsonObject();

                    if (imgObj.TryGetPropertyValue("url", out var url))
                        dataItem["url"] = url?.DeepClone();

                    // 保留 fal.ai 额外信息作为扩展字段
                    if (imgObj.TryGetPropertyValue("content_type", out var ct))
                        dataItem["content_type"] = ct?.DeepClone();

                    dataArray.Add(dataItem);
                }
            }
        }

        openaiResponse["data"] = dataArray;

        // 保留 description 作为扩展字段
        if (rawResponse.TryGetPropertyValue("description", out var desc))
            openaiResponse["description"] = desc?.DeepClone();

        return openaiResponse;
    }

    private static (string aspectRatio, string resolution) ParseSize(string size)
    {
        // OpenAI size: "1024x1024", "1792x1024", "1024x1792"
        var parts = size.Split('x');
        if (parts.Length != 2 ||
            !int.TryParse(parts[0], out var w) ||
            !int.TryParse(parts[1], out var h))
        {
            return ("1:1", "1K");
        }

        // Determine aspect ratio
        var ratio = (double)w / h;
        var aspectRatio = ratio switch
        {
            > 2.0 => "21:9",
            > 1.6 => "16:9",
            > 1.4 => "3:2",
            > 1.2 => "4:3",
            > 1.05 => "5:4",
            > 0.95 => "1:1",
            > 0.75 => "4:5",
            > 0.6 => "3:4",
            > 0.5 => "2:3",
            _ => "9:16"
        };

        // Determine resolution
        var maxDim = Math.Max(w, h);
        var resolution = maxDim switch
        {
            >= 3840 => "4K",
            >= 1920 => "2K",
            _ => "1K"
        };

        return (aspectRatio, resolution);
    }
}
