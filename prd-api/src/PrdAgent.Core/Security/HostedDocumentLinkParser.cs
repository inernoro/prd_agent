using System.Net;
using System.Text.RegularExpressions;

namespace PrdAgent.Core.Security;

public sealed record HostedDocumentLink(string Kind, string Value, string? SelectedSiteId = null);

/// <summary>只解析可信本站地址；不访问 URL，也不把分享凭证作为目标文档的授权。</summary>
public static class HostedDocumentLinkParser
{
    private static readonly Regex Links = new(@"https?://[^\s<>""'\[\]()]+|(?<![\w/])/(?:s/|web-pages\?)[^\s<>""'\[\]()]+", RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromMilliseconds(100));

    public static IReadOnlyList<HostedDocumentLink> Extract(string? content, IEnumerable<string> trustedOrigins)
    {
        if (string.IsNullOrEmpty(content)) return Array.Empty<HostedDocumentLink>();
        var origins = trustedOrigins.Select(x => Uri.TryCreate(x, UriKind.Absolute, out var u) ? u.GetLeftPart(UriPartial.Authority) : null)
            .Where(x => x != null).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var result = new List<HostedDocumentLink>();
        foreach (Match match in Links.Matches(WebUtility.HtmlDecode(content)))
        {
            var raw = match.Value.TrimEnd('.', ',', ';', ':', '!', '?', '。', '，', '；', '！', '？', '）', '》', '】');
            var absolute = raw.StartsWith("http", StringComparison.OrdinalIgnoreCase);
            if (!Uri.TryCreate(absolute ? raw : "https://reference.invalid" + raw, UriKind.Absolute, out var uri)
                || uri.UserInfo.Length > 0 || (absolute && !origins.Contains(uri.GetLeftPart(UriPartial.Authority)))) continue;
            var query = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
                .Select(p => p.Split('=', 2)).GroupBy(p => Uri.UnescapeDataString(p[0]))
                .ToDictionary(g => g.Key, g => g.Last().Length > 1 ? Uri.UnescapeDataString(g.Last()[1]) : string.Empty);
            query.TryGetValue("siteId", out var selected);
            var path = uri.AbsolutePath.TrimEnd('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
            HostedDocumentLink? link = null;
            if (uri.AbsolutePath.TrimEnd('/') == "/web-pages")
            {
                var id = query.GetValueOrDefault("openSite") ?? query.GetValueOrDefault("focusSite");
                if (!string.IsNullOrWhiteSpace(id)) link = new("site", id);
            }
            else if (path.Length == 3 && path[0] == "s" && path[1] == "wp") link = new("token", path[2], selected);
            else if (path.Length == 2 && path[0] == "s") link = new(long.TryParse(path[1], out _) ? "sequence" : "token", path[1], selected);
            if (link != null && link.Value.Length <= 128 && !result.Contains(link)) result.Add(link);
            if (result.Count >= 20) break;
        }
        return result;
    }
}
