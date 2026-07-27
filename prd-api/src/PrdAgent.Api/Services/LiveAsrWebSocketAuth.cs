namespace PrdAgent.Api.Services;

public static class LiveAsrWebSocketAuth
{
    public const string ApplicationProtocol = "map-live-asr";
    public const string BearerProtocolPrefix = "bearer.";
    public const string PathSuffix = "/live-transcription";

    public static string? ExtractToken(PathString path, string? protocols)
    {
        if (!path.Value?.EndsWith(PathSuffix, StringComparison.OrdinalIgnoreCase) ?? true)
            return null;
        if (string.IsNullOrWhiteSpace(protocols))
            return null;

        foreach (var protocol in protocols.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (protocol.StartsWith(BearerProtocolPrefix, StringComparison.Ordinal)
                && protocol.Length > BearerProtocolPrefix.Length)
            {
                return protocol[BearerProtocolPrefix.Length..];
            }
        }
        return null;
    }
}
