using System.Text.Json.Nodes;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.LlmGateway.Transformers;

/// <summary>
/// 火山方舟 Seedance 视频生成转换器。
/// 输入沿用 MAP 现有 OpenRouter 视频标准形状：
///   { model, prompt, frame_images, aspect_ratio, resolution, duration, generate_audio, seed }
/// 输出转换为 OpenRouterVideoClient 可识别的形状：
///   submit/status 均保留 id；成功状态映射为 completed + unsigned_urls。
/// </summary>
public class VolcengineVideoTransformer : IExchangeTransformer
{
    public string TransformerType => "volcengine-video";

    public string? ResolveTargetUrl(string baseUrl, JsonObject standardBody, Dictionary<string, object>? config)
    {
        var operation = ReadString(standardBody, "_gateway_operation", "operation");
        if (!string.Equals(operation, "status", StringComparison.OrdinalIgnoreCase))
            return null;

        var taskId = ReadString(standardBody, "task_id", "taskId", "id");
        if (string.IsNullOrWhiteSpace(taskId))
            return baseUrl.TrimEnd('/');

        return $"{baseUrl.TrimEnd('/')}/{Uri.EscapeDataString(taskId)}";
    }

    public JsonObject TransformRequest(JsonObject standardBody, Dictionary<string, object>? config)
    {
        var operation = ReadString(standardBody, "_gateway_operation", "operation");
        if (string.Equals(operation, "status", StringComparison.OrdinalIgnoreCase))
            return new JsonObject();

        if (standardBody.TryGetPropertyValue("content", out var existingContent)
            && existingContent is JsonArray)
        {
            var clone = CloneObjectWithoutGatewayFields(standardBody);
            RemoveOpenRouterOnlyFields(clone);
            return clone;
        }

        var body = new JsonObject();
        CopyString(standardBody, body, "model");
        CopyString(standardBody, body, "resolution");
        CopyNumber(standardBody, body, "duration");
        CopyBool(standardBody, body, "generate_audio");
        CopyNumber(standardBody, body, "seed");

        var ratio = ReadString(standardBody, "ratio", "aspect_ratio", "aspectRatio");
        if (!string.IsNullOrWhiteSpace(ratio))
            body["ratio"] = ratio;

        var content = new JsonArray();
        var prompt = ReadString(standardBody, "prompt");
        if (!string.IsNullOrWhiteSpace(prompt))
        {
            content.Add(new JsonObject
            {
                ["type"] = "text",
                ["text"] = prompt,
            });
        }

        if (standardBody.TryGetPropertyValue("frame_images", out var frameImagesNode)
            && frameImagesNode is JsonArray frameImages)
        {
            foreach (var node in frameImages)
            {
                if (node is not JsonObject frame) continue;
                var url = ReadNestedImageUrl(frame);
                if (string.IsNullOrWhiteSpace(url)) continue;
                var image = new JsonObject
                {
                    ["type"] = "image_url",
                    ["image_url"] = new JsonObject { ["url"] = url },
                };
                var frameType = ReadString(frame, "frame_type", "frameType", "role");
                if (!string.IsNullOrWhiteSpace(frameType))
                    image["role"] = frameType;
                content.Add(image);
            }
        }

        body["content"] = content;
        return body;
    }

    public JsonObject TransformResponse(JsonObject rawResponse, Dictionary<string, object>? config)
    {
        var status = NormalizeStatus(ReadString(rawResponse, "status"));
        var output = new JsonObject();

        var id = ReadString(rawResponse, "id", "task_id", "taskId", "generation_id");
        if (!string.IsNullOrWhiteSpace(id))
        {
            output["id"] = id;
            output["generation_id"] = id;
        }

        if (!string.IsNullOrWhiteSpace(status))
            output["status"] = status;

        var videoUrl = ReadVideoUrl(rawResponse);
        if (!string.IsNullOrWhiteSpace(videoUrl))
            output["unsigned_urls"] = new JsonArray(videoUrl);

        if (rawResponse.TryGetPropertyValue("usage", out var usage))
            output["usage"] = usage?.DeepClone();

        if (rawResponse.TryGetPropertyValue("error", out var error))
            output["error"] = error?.DeepClone();

        return output;
    }

    private static string? NormalizeStatus(string? status)
    {
        if (string.IsNullOrWhiteSpace(status)) return null;
        return status.Trim().ToLowerInvariant() switch
        {
            "succeeded" or "success" or "completed" => "completed",
            "queued" or "created" or "pending" => "pending",
            "running" or "processing" or "in_progress" => "in_progress",
            "failed" => "failed",
            "cancelled" or "canceled" => "cancelled",
            "expired" => "expired",
            var other => other,
        };
    }

    private static JsonObject CloneObjectWithoutGatewayFields(JsonObject source)
    {
        var clone = new JsonObject();
        foreach (var (key, value) in source)
        {
            if (key.StartsWith("_gateway_", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.Equals(key, "operation", StringComparison.OrdinalIgnoreCase)) continue;
            clone[key] = value?.DeepClone();
        }
        return clone;
    }

    private static void RemoveOpenRouterOnlyFields(JsonObject body)
    {
        body.Remove("prompt");
        body.Remove("frame_images");
        body.Remove("aspect_ratio");
        body.Remove("aspectRatio");
    }

    private static string? ReadNestedImageUrl(JsonObject frame)
    {
        if (frame.TryGetPropertyValue("image_url", out var imageUrlNode))
        {
            if (imageUrlNode is JsonObject imageUrlObj)
                return ReadString(imageUrlObj, "url");
            if (imageUrlNode is JsonValue imageUrlValue && imageUrlValue.TryGetValue<string>(out var url))
                return url;
        }
        return ReadString(frame, "url");
    }

    private static string? ReadVideoUrl(JsonObject raw)
    {
        if (raw.TryGetPropertyValue("content", out var contentNode)
            && contentNode is JsonObject content)
        {
            var url = ReadString(content, "video_url", "videoUrl", "url");
            if (!string.IsNullOrWhiteSpace(url)) return url;
        }

        if (raw.TryGetPropertyValue("data", out var dataNode)
            && dataNode is JsonObject data)
        {
            var url = ReadVideoUrl(data);
            if (!string.IsNullOrWhiteSpace(url)) return url;
        }

        return ReadString(raw, "video_url", "videoUrl", "result_url", "resultUrl", "download_url", "downloadUrl");
    }

    private static string? ReadString(JsonObject obj, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (!obj.TryGetPropertyValue(key, out var node) || node == null)
                continue;
            if (node is JsonValue value && value.TryGetValue<string>(out var str))
                return str;
        }
        return null;
    }

    private static void CopyString(JsonObject from, JsonObject to, string key)
    {
        var value = ReadString(from, key);
        if (!string.IsNullOrWhiteSpace(value))
            to[key] = value;
    }

    private static void CopyNumber(JsonObject from, JsonObject to, string key)
    {
        if (!from.TryGetPropertyValue(key, out var node) || node == null)
            return;
        to[key] = node.DeepClone();
    }

    private static void CopyBool(JsonObject from, JsonObject to, string key)
    {
        if (!from.TryGetPropertyValue(key, out var node) || node == null)
            return;
        to[key] = node.DeepClone();
    }
}
