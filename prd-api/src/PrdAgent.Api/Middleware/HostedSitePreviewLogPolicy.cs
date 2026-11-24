using System.Text.RegularExpressions;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// Preview file access carries a bearer capability in its URL. Only project a log-safe
/// copy; never mutate the request used by routing, authorization or file resolution.
/// </summary>
public static class HostedSitePreviewLogPolicy
{
    public const string FilesPath = "/api/hosted-site-preview-files";
    public const string AccessPath = "/api/hosted-site-preview-access";
    private const string SharesPath = "/api/web-pages/shares";
    private const string ShareCreatePath = "/api/web-pages/share";
    private static readonly Regex SiteShareLogs = new("^/api/web-pages/[^/]+/share-logs/?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    public static (string Path, string Query, bool Sensitive) Project(string path, string? query)
    {
        var decoded = Uri.UnescapeDataString(path);
        if (decoded.TrimEnd('/').Equals(ShareCreatePath, StringComparison.OrdinalIgnoreCase))
            return (ShareCreatePath, "", true);
        if (SiteShareLogs.IsMatch(decoded))
            return ("/api/web-pages/:siteId/share-logs", "", true);
        foreach (var prefix in new[] { FilesPath, AccessPath, SharesPath })
        {
            if (decoded.Equals(prefix, StringComparison.OrdinalIgnoreCase)
                || decoded.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
                return (prefix + "/[redacted]", "", true);
        }

        return (path, query ?? "", false);
    }
}
