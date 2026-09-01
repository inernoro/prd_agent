using System.Text.Json.Nodes;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Infrastructure.LLM.Adapters;

namespace PrdAgent.Infrastructure.LlmGateway.ImageGen;

/// <summary>把上游图片协议收敛为 data[]；MAP 不再判断供应商响应格式。</summary>
public static class GatewayImageResponseNormalizer
{
    public static GatewayRawResponse Normalize(GatewayRawResponse response)
    {
        if (!response.Success) return response;
        try
        {
            var root = JsonNode.Parse(response.Content ?? "")?.AsObject();
            var data = new JsonArray();
            if (root?["data"] is JsonArray standard)
                foreach (var item in standard.OfType<JsonObject>())
                    Add(data, item["b64_json"]?.GetValue<string>() ?? item["base64"]?.GetValue<string>(),
                        item["url"]?.GetValue<string>(), item["media_type"]?.GetValue<string>(), item["revised_prompt"]?.GetValue<string>());
            if (root?["candidates"] is JsonArray)
                foreach (var (base64, mime) in GooglePlatformAdapter.ParseGoogleResponseImages(response.Content!))
                    Add(data, base64, null, mime, null);
            if (root?["choices"] is JsonArray choices)
                foreach (var choice in choices)
                    if (choice?["message"]?["images"] is JsonArray images)
                        foreach (var item in images)
                        {
                            var imageUrl = item?["image_url"];
                            Add(data, null, imageUrl is JsonObject obj ? obj["url"]?.GetValue<string>() : imageUrl?.GetValue<string>(), null, null);
                        }
            if (data.Count == 0) return Failure(response, "IMAGE_GEN_MISSING_IMAGE", "生图服务未返回图片，请稍后重试。");
            return new GatewayRawResponse
            {
                Success = true, StatusCode = response.StatusCode, ContentType = "application/json",
                Content = new JsonObject { ["data"] = data }.ToJsonString(),
                Resolution = response.Resolution, DurationMs = response.DurationMs, LogId = response.LogId,
            };
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or InvalidOperationException or FormatException or ArgumentException)
        {
            return Failure(response, "IMAGE_GEN_INVALID_RESPONSE", "生图结果无法读取，请稍后重试。");
        }
    }

    private static GatewayRawResponse Failure(GatewayRawResponse response, string code, string message) => new()
    {
        Success = false, StatusCode = 502, ErrorCode = code, ErrorMessage = message,
        Resolution = response.Resolution, DurationMs = response.DurationMs, LogId = response.LogId,
    };

    private static void Add(JsonArray data, string? base64, string? url, string? mime, string? revised)
    {
        var inline = base64?.StartsWith("data:", StringComparison.OrdinalIgnoreCase) == true ? base64
            : url?.StartsWith("data:", StringComparison.OrdinalIgnoreCase) == true ? url : null;
        if (inline is not null)
        {
            var comma = inline.IndexOf(',');
            var semicolon = inline.IndexOf(';');
            if (comma < 0 || semicolon < 5 || semicolon > comma) throw new FormatException();
            mime = inline[5..semicolon]; base64 = inline[(comma + 1)..]; url = null;
        }
        if (string.IsNullOrWhiteSpace(base64) && string.IsNullOrWhiteSpace(url)) return;
        data.Add(new JsonObject { ["b64_json"] = base64, ["url"] = url, ["media_type"] = mime, ["revised_prompt"] = revised });
    }
}
