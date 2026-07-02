using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Security;

public static class PlatformApiKeyPolicy
{
    public const string OptionalStatus = "optional";

    public static bool IsApiKeyOptional(LLMPlatform platform)
    {
        if (string.Equals(platform.ProviderId, "stub", StringComparison.OrdinalIgnoreCase))
            return true;

        if (string.Equals(platform.Name, "Stub 开发桩", StringComparison.OrdinalIgnoreCase))
            return true;

        return IsStubApiUrl(platform.ApiUrl);
    }

    private static bool IsStubApiUrl(string? apiUrl)
    {
        if (string.IsNullOrWhiteSpace(apiUrl))
            return false;

        if (Uri.TryCreate(apiUrl, UriKind.Absolute, out var uri))
            return uri.AbsolutePath.Contains("/api/v1/stub", StringComparison.OrdinalIgnoreCase);

        return apiUrl.Contains("/api/v1/stub", StringComparison.OrdinalIgnoreCase);
    }
}
