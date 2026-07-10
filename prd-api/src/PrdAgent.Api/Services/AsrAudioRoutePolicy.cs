namespace PrdAgent.Api.Services;

internal static class AsrAudioRoutePolicy
{
    public static bool ShouldUseChatAudio(string? model, string? protocol, string? platformType)
    {
        if (string.IsNullOrWhiteSpace(model)) return false;

        var m = model.Trim().ToLowerInvariant();
        if (m.Contains("whisper")) return false;
        var modelSupportsAudioInput = m.Contains("audio") || m.Contains("gemini");
        if (!modelSupportsAudioInput) return false;

        var normalizedProtocol = Normalize(protocol);
        if (normalizedProtocol != null)
        {
            return normalizedProtocol switch
            {
                "openai" or "openai-compatible" or "openrouter" => true,
                _ => false
            };
        }

        var normalizedPlatform = Normalize(platformType);
        return normalizedPlatform is not ("google" or "gemini" or "anthropic" or "claude" or "exchange");
    }

    private static string? Normalize(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant();
        return string.IsNullOrWhiteSpace(normalized) || normalized == "unknown"
            ? null
            : normalized;
    }
}
