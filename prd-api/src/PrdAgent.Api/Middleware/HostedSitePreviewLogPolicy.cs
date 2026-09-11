namespace PrdAgent.Api.Middleware;

/// <summary>
/// Preview file access carries a bearer capability in its URL. Only project a log-safe
/// copy; never mutate the request used by routing, authorization or file resolution.
/// </summary>
public static class HostedSitePreviewLogPolicy
{
    public const string FilesPath = "/api/hosted-site-preview-files";
    public const string AccessPath = "/api/hosted-site-preview-access";

    public static (string Path, string Query, bool Sensitive) Project(string path, string? query)
    {
        var decoded = Uri.UnescapeDataString(path);
        foreach (var prefix in new[] { FilesPath, AccessPath })
        {
            if (decoded.Equals(prefix, StringComparison.OrdinalIgnoreCase)
                || decoded.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase))
                return (prefix + "/[redacted]", "", true);
        }

        return (path, query ?? "", false);
    }
}
