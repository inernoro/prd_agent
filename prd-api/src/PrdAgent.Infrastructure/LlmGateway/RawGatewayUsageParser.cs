using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Infrastructure.LlmGateway;

internal sealed record RawGatewayOutputImage(
    string Base64Data,
    string MimeType);

internal sealed record RawGatewayUsage(
    int? InputTokens,
    int? OutputTokens,
    int? ImageSuccessCount,
    string? FinishReason,
    decimal? ProviderReportedCost,
    string? ProviderCostCurrency,
    IReadOnlyList<RawGatewayOutputImage> OutputImages)
{
    public bool HasReportedUsage =>
        InputTokens is not null
        || OutputTokens is not null
        || ImageSuccessCount is not null
        || ProviderReportedCost is not null;
}

internal static class RawGatewayUsageParser
{
    private const int MaxStoredImageCount = 10;
    private const int MaxBase64CharsPerImage = 35_000_000;
    private const int MaxBase64CharsTotal = 70_000_000;

    internal static RawGatewayUsage Parse(string responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody))
            return Empty();

        try
        {
            using var document = JsonDocument.Parse(responseBody);
            var root = document.RootElement;
            var usage = TryGetObject(root, "usage");
            var usageMetadata = TryGetObject(root, "usageMetadata");

            var inputTokens =
                ReadInt(usage, "prompt_tokens", "input_tokens", "promptTokenCount")
                ?? ReadInt(usageMetadata, "promptTokenCount", "inputTokenCount");
            var outputTokens =
                ReadInt(usage, "completion_tokens", "output_tokens", "candidatesTokenCount")
                ?? ReadInt(usageMetadata, "candidatesTokenCount", "outputTokenCount");
            var providerReportedCost =
                ReadDecimal(usage, "cost", "cost_usd", "total_cost")
                ?? ReadDecimal(root, "cost", "cost_usd", "total_cost");
            var providerCostCurrency =
                ReadString(usage, "currency", "cost_currency")
                ?? ReadString(root, "currency", "cost_currency")
                ?? (providerReportedCost is null ? null : "USD");

            var imageSuccessCount = CountImages(root);
            var outputImages = ExtractOutputImages(root);
            var finishReason = ReadFinishReason(root);
            if (string.IsNullOrWhiteSpace(finishReason) && imageSuccessCount is > 0)
                finishReason = "completed";

            return new RawGatewayUsage(
                inputTokens,
                outputTokens,
                imageSuccessCount,
                finishReason,
                providerReportedCost,
                providerCostCurrency?.Trim().ToUpperInvariant(),
                outputImages);
        }
        catch (JsonException)
        {
            return Empty();
        }
    }

    internal static string RedactImagePayloadsForLog(string responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody)) return responseBody;
        try
        {
            var node = JsonNode.Parse(responseBody);
            if (node is null) return responseBody;
            RedactImagePayloads(node, parentPropertyName: null);
            return node.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        }
        catch (JsonException)
        {
            return responseBody;
        }
    }

    private static RawGatewayUsage Empty() => new(null, null, null, null, null, null, []);

    private static JsonElement? TryGetObject(JsonElement element, string name)
    {
        return TryGetProperty(element, name, out var value) && value.ValueKind == JsonValueKind.Object
            ? value
            : null;
    }

    private static int? ReadInt(JsonElement? element, params string[] names)
    {
        if (element is null) return null;
        foreach (var name in names)
        {
            if (!TryGetProperty(element.Value, name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
                return number;
            if (value.ValueKind == JsonValueKind.String
                && int.TryParse(value.GetString(), out number))
                return number;
        }
        return null;
    }

    private static decimal? ReadDecimal(JsonElement? element, params string[] names)
    {
        if (element is null) return null;
        foreach (var name in names)
        {
            if (!TryGetProperty(element.Value, name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number))
                return number;
            if (value.ValueKind == JsonValueKind.String
                && decimal.TryParse(
                    value.GetString(),
                    System.Globalization.NumberStyles.Number,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out number))
                return number;
        }
        return null;
    }

    private static string? ReadString(JsonElement? element, params string[] names)
    {
        if (element is null) return null;
        foreach (var name in names)
        {
            if (TryGetProperty(element.Value, name, out var value)
                && value.ValueKind == JsonValueKind.String)
                return value.GetString();
        }
        return null;
    }

    private static string? ReadFinishReason(JsonElement root)
    {
        if (TryGetProperty(root, "choices", out var choices)
            && choices.ValueKind == JsonValueKind.Array
            && choices.GetArrayLength() > 0)
        {
            var first = choices[0];
            var reason = ReadString(first, "finish_reason", "native_finish_reason", "stop_reason");
            if (!string.IsNullOrWhiteSpace(reason)) return reason;
        }

        if (TryGetProperty(root, "candidates", out var candidates)
            && candidates.ValueKind == JsonValueKind.Array
            && candidates.GetArrayLength() > 0)
        {
            var reason = ReadString(candidates[0], "finishReason", "finish_reason");
            if (!string.IsNullOrWhiteSpace(reason)) return reason;
        }

        return ReadString(root, "finish_reason", "stop_reason", "status");
    }

    private static int? CountImages(JsonElement root)
    {
        var count = 0;
        if (TryGetProperty(root, "data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Object
                    && (HasProperty(item, "url") || HasProperty(item, "b64_json") || HasProperty(item, "image_url")))
                    count++;
            }
        }

        if (TryGetProperty(root, "images", out var images) && images.ValueKind == JsonValueKind.Array)
            count += images.GetArrayLength();

        if (TryGetProperty(root, "candidates", out var candidates) && candidates.ValueKind == JsonValueKind.Array)
        {
            foreach (var candidate in candidates.EnumerateArray())
            {
                if (!TryGetProperty(candidate, "content", out var content)
                    || !TryGetProperty(content, "parts", out var parts)
                    || parts.ValueKind != JsonValueKind.Array)
                    continue;

                foreach (var part in parts.EnumerateArray())
                {
                    if (HasProperty(part, "inlineData")
                        || HasProperty(part, "inline_data")
                        || HasProperty(part, "fileData")
                        || HasProperty(part, "file_data"))
                        count++;
                }
            }
        }

        return count > 0 ? count : null;
    }

    private static IReadOnlyList<RawGatewayOutputImage> ExtractOutputImages(JsonElement root)
    {
        var images = new List<RawGatewayOutputImage>();
        var totalChars = 0;

        void Add(string? encoded, string? mimeType)
        {
            if (images.Count >= MaxStoredImageCount || string.IsNullOrWhiteSpace(encoded)) return;
            var payload = encoded.Trim();
            var mime = NormalizeMimeType(mimeType);
            if (TrySplitDataUrl(payload, out var dataUrlMime, out var dataUrlPayload))
            {
                payload = dataUrlPayload;
                mime = NormalizeMimeType(dataUrlMime);
            }

            if (payload.Length < 4
                || payload.Length > MaxBase64CharsPerImage
                || totalChars + payload.Length > MaxBase64CharsTotal)
                return;

            totalChars += payload.Length;
            images.Add(new RawGatewayOutputImage(payload, mime));
        }

        if (TryGetProperty(root, "data", out var data) && data.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in data.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                Add(ReadString(item, "b64_json", "image_base64"), ReadString(item, "media_type", "mime_type"));
                if (TryGetProperty(item, "image_url", out var imageUrl))
                {
                    if (imageUrl.ValueKind == JsonValueKind.String)
                        Add(imageUrl.GetString(), ReadString(item, "media_type", "mime_type"));
                    else if (imageUrl.ValueKind == JsonValueKind.Object)
                        Add(ReadString(imageUrl, "url"), ReadString(item, "media_type", "mime_type"));
                }
            }
        }

        if (TryGetProperty(root, "images", out var rawImages) && rawImages.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in rawImages.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                    Add(item.GetString(), null);
                else if (item.ValueKind == JsonValueKind.Object)
                    Add(
                        ReadString(item, "b64_json", "data", "url"),
                        ReadString(item, "media_type", "mime_type", "mimeType"));
            }
        }

        if (TryGetProperty(root, "candidates", out var candidates) && candidates.ValueKind == JsonValueKind.Array)
        {
            foreach (var candidate in candidates.EnumerateArray())
            {
                if (!TryGetProperty(candidate, "content", out var content)
                    || !TryGetProperty(content, "parts", out var parts)
                    || parts.ValueKind != JsonValueKind.Array)
                    continue;

                foreach (var part in parts.EnumerateArray())
                {
                    foreach (var propertyName in new[] { "inlineData", "inline_data" })
                    {
                        if (!TryGetProperty(part, propertyName, out var inlineData)
                            || inlineData.ValueKind != JsonValueKind.Object)
                            continue;
                        Add(
                            ReadString(inlineData, "data"),
                            ReadString(inlineData, "mimeType", "mime_type"));
                    }
                }
            }
        }

        return images;
    }

    private static bool TrySplitDataUrl(string value, out string mimeType, out string base64)
    {
        mimeType = string.Empty;
        base64 = string.Empty;
        if (!value.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return false;
        var marker = value.IndexOf(";base64,", StringComparison.OrdinalIgnoreCase);
        if (marker <= 5) return false;
        mimeType = value[5..marker];
        base64 = value[(marker + 8)..];
        return true;
    }

    private static string NormalizeMimeType(string? mimeType)
    {
        var normalized = mimeType?.Trim().ToLowerInvariant();
        return normalized is not null && normalized.StartsWith("image/", StringComparison.Ordinal)
            ? normalized
            : "image/png";
    }

    private static void RedactImagePayloads(JsonNode node, string? parentPropertyName)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj.ToList())
            {
                var isDirectBase64 = property.Key.Equals("b64_json", StringComparison.OrdinalIgnoreCase)
                    || property.Key.Equals("image_base64", StringComparison.OrdinalIgnoreCase);
                var isInlineData = parentPropertyName is not null
                    && (parentPropertyName.Equals("inlineData", StringComparison.OrdinalIgnoreCase)
                        || parentPropertyName.Equals("inline_data", StringComparison.OrdinalIgnoreCase));
                if (isDirectBase64 || (isInlineData && property.Key.Equals("data", StringComparison.OrdinalIgnoreCase)))
                {
                    obj[property.Key] = "[IMAGE_BASE64_REDACTED]";
                    continue;
                }

                if (property.Value is JsonValue value
                    && value.TryGetValue<string>(out var text)
                    && text.StartsWith("data:image/", StringComparison.OrdinalIgnoreCase))
                {
                    obj[property.Key] = "[IMAGE_DATA_URL_REDACTED]";
                    continue;
                }

                if (property.Value is not null)
                    RedactImagePayloads(property.Value, property.Key);
            }
            return;
        }

        if (node is JsonArray array)
        {
            foreach (var child in array)
            {
                if (child is not null) RedactImagePayloads(child, parentPropertyName);
            }
        }
    }

    private static bool HasProperty(JsonElement element, string name) =>
        TryGetProperty(element, name, out _);

    private static bool TryGetProperty(JsonElement element, string name, out JsonElement value)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in element.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    value = property.Value;
                    return true;
                }
            }
        }

        value = default;
        return false;
    }
}
