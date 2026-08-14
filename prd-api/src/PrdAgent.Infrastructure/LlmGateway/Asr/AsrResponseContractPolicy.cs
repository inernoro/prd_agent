using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.LlmGateway.Asr;

public static class AsrResponseContractPolicy
{
    public static string? ExtractCompactTranscript(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.TryGetProperty("text", out var text)
            && text.ValueKind == JsonValueKind.String)
        {
            return Normalize(text.GetString());
        }

        if (!root.TryGetProperty("choices", out var choices)
            || choices.ValueKind != JsonValueKind.Array
            || choices.GetArrayLength() == 0
            || !choices[0].TryGetProperty("message", out var message)
            || !message.TryGetProperty("content", out var content))
        {
            return null;
        }

        if (content.ValueKind == JsonValueKind.String)
            return Normalize(content.GetString());
        if (content.ValueKind != JsonValueKind.Array) return null;

        var parts = content.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String
                ? item.GetString()
                : item.ValueKind == JsonValueKind.Object
                    && item.TryGetProperty("text", out var partText)
                    && partText.ValueKind == JsonValueKind.String
                    ? partText.GetString()
                    : null)
            .Where(part => !string.IsNullOrWhiteSpace(part))
            .Select(part => part!.Trim());
        return Normalize(string.Join("\n", parts));
    }

    private static string? Normalize(string? value)
    {
        var normalized = value?.Trim();
        if (string.IsNullOrWhiteSpace(normalized)) return null;
        var sentinel = normalized.Trim(' ', '\t', '\r', '\n', '.', '。', '!', '！', '?', '？', '"', '\'', '`');
        return TranscribeNoteText.IsNoSpeechSentinel(sentinel)
            ? null
            : normalized;
    }
}
