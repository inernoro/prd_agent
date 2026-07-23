using System.Text.Json;

namespace PrdAgent.Infrastructure.LlmGateway;

internal sealed record RawGatewayUsage(
    int? InputTokens,
    int? OutputTokens,
    int? ImageSuccessCount,
    string? FinishReason,
    decimal? ProviderReportedCost,
    string? ProviderCostCurrency)
{
    public bool HasReportedUsage =>
        InputTokens is not null
        || OutputTokens is not null
        || ImageSuccessCount is not null
        || ProviderReportedCost is not null;
}

internal static class RawGatewayUsageParser
{
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
            var finishReason = ReadFinishReason(root);
            if (string.IsNullOrWhiteSpace(finishReason) && imageSuccessCount is > 0)
                finishReason = "completed";

            return new RawGatewayUsage(
                inputTokens,
                outputTokens,
                imageSuccessCount,
                finishReason,
                providerReportedCost,
                providerCostCurrency?.Trim().ToUpperInvariant());
        }
        catch (JsonException)
        {
            return Empty();
        }
    }

    private static RawGatewayUsage Empty() => new(null, null, null, null, null, null);

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
