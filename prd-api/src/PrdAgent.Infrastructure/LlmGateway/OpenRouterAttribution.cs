using Microsoft.Extensions.Configuration;

namespace PrdAgent.Infrastructure.LlmGateway;

internal static class OpenRouterAttribution
{
    internal static string? ResolveReferer(IConfiguration? configuration)
    {
        var raw = configuration?["OpenRouter:Referer"]
            ?? configuration?["App:FrontendBaseUrl"]
            ?? configuration?["FRONTEND_BASE_URL"]
            ?? configuration?["PUBLIC_BASE_URL"];
        if (!Uri.TryCreate(raw?.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return null;
        }

        return uri.GetLeftPart(UriPartial.Authority);
    }

    internal static void Apply(
        HttpRequestMessage request,
        string? apiUrl,
        string appCallerCode,
        string? referer)
    {
        if (string.IsNullOrWhiteSpace(apiUrl)
            || apiUrl.IndexOf("openrouter.ai", StringComparison.OrdinalIgnoreCase) < 0)
        {
            return;
        }

        if (!string.IsNullOrWhiteSpace(referer))
            request.Headers.TryAddWithoutValidation("HTTP-Referer", referer);
        if (!string.IsNullOrWhiteSpace(appCallerCode))
            request.Headers.TryAddWithoutValidation("X-OpenRouter-Title", $"G-{appCallerCode}");
    }
}
