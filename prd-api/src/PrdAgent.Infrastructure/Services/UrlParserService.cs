using System.Net;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// URL 解析服务实现 — 支持短视频平台短链解析 + OG meta 提取
/// </summary>
public class UrlParserService : IUrlParserService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<UrlParserService> _logger;

    /// <summary>
    /// 平台识别规则：域名模式 → (平台标识, 默认内容类型)
    /// </summary>
    private static readonly (string Pattern, string Platform, string ContentType)[] PlatformRules =
    {
        ("v.douyin.com", Platforms.Douyin, ContentTypes.Video),
        ("douyin.com", Platforms.Douyin, ContentTypes.Video),
        ("v.kuaishou.com", Platforms.Kuaishou, ContentTypes.Video),
        ("kuaishou.com", Platforms.Kuaishou, ContentTypes.Video),
        ("b23.tv", Platforms.Bilibili, ContentTypes.Video),
        ("bilibili.com", Platforms.Bilibili, ContentTypes.Video),
        ("xhslink.com", Platforms.Xiaohongshu, ContentTypes.Article),
        ("xiaohongshu.com", Platforms.Xiaohongshu, ContentTypes.Article),
        ("mp.weixin.qq.com", Platforms.Wechat, ContentTypes.Article),
    };

    public UrlParserService(IHttpClientFactory httpClientFactory, ILogger<UrlParserService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public bool IsKnownPlatform(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        return PlatformRules.Any(r => url.Contains(r.Pattern, StringComparison.OrdinalIgnoreCase));
    }

    public async Task<UrlParseResult> ParseAsync(string url, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(url))
            return UrlParseResult.Fail(url ?? "", "URL 不能为空");

        // 尝试从文本中提取 URL（快捷指令可能传入包含 URL 的文本）
        var extractedUrl = ExtractUrl(url);
        if (extractedUrl == null)
            return UrlParseResult.Fail(url, "未找到有效的 URL");

        try
        {
            // 识别平台
            var (platform, defaultContentType) = IdentifyPlatform(extractedUrl);

            // 解析短链 → 获取真实 URL
            var resolvedUrl = await ResolveShortUrlAsync(extractedUrl, ct);

            // 获取页面 HTML 并提取 OG meta
            var ogMeta = await FetchOgMetaAsync(resolvedUrl ?? extractedUrl, ct);

            return new UrlParseResult
            {
                Success = true,
                SourceUrl = extractedUrl,
                ResolvedUrl = resolvedUrl != extractedUrl ? resolvedUrl : null,
                ContentType = ogMeta.Type ?? defaultContentType,
                Platform = platform,
                Title = ogMeta.Title,
                Description = ogMeta.Description,
                CoverUrl = ogMeta.Image,
                Author = ogMeta.Author,
                VideoUrl = ogMeta.VideoUrl,
                Metadata = ogMeta.Extra
            };
        }
        catch (TaskCanceledException)
        {
            return UrlParseResult.Fail(extractedUrl, "请求超时");
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "URL 解析 HTTP 错误: {Url}", extractedUrl);
            // 降级：至少保存原始 URL
            var (platform, contentType) = IdentifyPlatform(extractedUrl);
            return new UrlParseResult
            {
                Success = true, // 标记为成功，因为至少可以保存 URL
                SourceUrl = extractedUrl,
                ContentType = contentType,
                Platform = platform,
                Error = $"无法获取页面信息: {ex.Message}"
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "URL 解析异常: {Url}", extractedUrl);
            return UrlParseResult.Fail(extractedUrl, $"解析失败: {ex.Message}");
        }
    }

    /// <summary>
    /// 从文本中提取第一个 URL
    /// </summary>
    private static string? ExtractUrl(string text)
    {
        // 如果本身就是 URL
        if (Uri.TryCreate(text.Trim(), UriKind.Absolute, out var directUri)
            && (directUri.Scheme == "http" || directUri.Scheme == "https"))
        {
            return text.Trim();
        }

        // 从文本中正则提取
        var match = Regex.Match(text, @"https?://[^\s<>\""']+", RegexOptions.IgnoreCase);
        return match.Success ? match.Value : null;
    }

    /// <summary>
    /// 识别平台
    /// </summary>
    private static (string Platform, string ContentType) IdentifyPlatform(string url)
    {
        foreach (var rule in PlatformRules)
        {
            if (url.Contains(rule.Pattern, StringComparison.OrdinalIgnoreCase))
                return (rule.Platform, rule.ContentType);
        }
        return (Platforms.Other, ContentTypes.Link);
    }

    /// <summary>
    /// 解析短链（跟随 302 重定向获取最终 URL）
    /// </summary>
    private async Task<string?> ResolveShortUrlAsync(string url, CancellationToken ct)
    {
        // 只对已知短链域名做跳转跟随
        var shortDomains = new[] { "v.douyin.com", "v.kuaishou.com", "b23.tv", "xhslink.com" };
        if (!shortDomains.Any(d => url.Contains(d, StringComparison.OrdinalIgnoreCase)))
            return url;

        try
        {
            var client = CreateNoRedirectClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");

            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);

            if (response.StatusCode is HttpStatusCode.Redirect
                or HttpStatusCode.MovedPermanently
                or HttpStatusCode.TemporaryRedirect
                or HttpStatusCode.PermanentRedirect)
            {
                var location = response.Headers.Location?.ToString();
                if (!string.IsNullOrEmpty(location))
                {
                    // 可能是相对路径
                    if (!location.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    {
                        var baseUri = new Uri(url);
                        location = new Uri(baseUri, location).ToString();
                    }
                    _logger.LogDebug("短链跳转: {From} → {To}", url, location);
                    return location;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "短链解析失败: {Url}", url);
        }

        return url;
    }

    /// <summary>
    /// 获取页面 HTML 并提取 OG meta 标签
    /// </summary>
    private async Task<OgMetadata> FetchOgMetaAsync(string url, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient("UrlParser");
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("User-Agent",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
        request.Headers.Add("Accept", "text/html,application/xhtml+xml");
        request.Headers.Add("Accept-Language", "zh-CN,zh;q=0.9");

        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        // 只读取前 100KB（避免大页面占用过多内存）
        var content = await ReadLimitedAsync(response.Content, 100 * 1024, ct);

        return ParseOgMeta(content);
    }

    /// <summary>
    /// 限制读取 HTML 内容大小
    /// </summary>
    private static async Task<string> ReadLimitedAsync(HttpContent content, int maxBytes, CancellationToken ct)
    {
        using var stream = await content.ReadAsStreamAsync(ct);
        var buffer = new byte[maxBytes];
        var totalRead = 0;
        int bytesRead;
        while (totalRead < maxBytes &&
               (bytesRead = await stream.ReadAsync(buffer.AsMemory(totalRead, maxBytes - totalRead), ct)) > 0)
        {
            totalRead += bytesRead;
        }
        return System.Text.Encoding.UTF8.GetString(buffer, 0, totalRead);
    }

    /// <summary>
    /// 从 HTML 中解析 OG meta 标签
    /// </summary>
    private static OgMetadata ParseOgMeta(string html)
    {
        var meta = new OgMetadata();

        // og:title
        meta.Title = ExtractMetaContent(html, "og:title")
                     ?? ExtractMetaContent(html, "twitter:title")
                     ?? ExtractHtmlTitle(html);

        // og:description
        meta.Description = ExtractMetaContent(html, "og:description")
                           ?? ExtractMetaContent(html, "description");

        // og:image
        meta.Image = ExtractMetaContent(html, "og:image")
                     ?? ExtractMetaContent(html, "twitter:image");

        // og:type → 映射到我们的 contentType
        var ogType = ExtractMetaContent(html, "og:type");
        meta.Type = ogType switch
        {
            "video" or "video.other" => ContentTypes.Video,
            "article" => ContentTypes.Article,
            "image" => ContentTypes.Image,
            _ => null // 保持默认
        };

        // og:video
        meta.VideoUrl = ExtractMetaContent(html, "og:video")
                        ?? ExtractMetaContent(html, "og:video:url");

        // author
        meta.Author = ExtractMetaContent(html, "author")
                      ?? ExtractMetaContent(html, "og:article:author");

        return meta;
    }

    /// <summary>
    /// 从 HTML 中提取指定 meta 标签的 content 值
    /// </summary>
    private static string? ExtractMetaContent(string html, string nameOrProperty)
    {
        // 匹配 <meta property="og:title" content="xxx"> 或 <meta name="description" content="xxx">
        var pattern = $@"<meta\s+(?:[^>]*?\s+)?(?:property|name)\s*=\s*[""']{Regex.Escape(nameOrProperty)}[""']\s+(?:[^>]*?\s+)?content\s*=\s*[""']([^""']*?)[""']";
        var match = Regex.Match(html, pattern, RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (match.Success) return WebUtility.HtmlDecode(match.Groups[1].Value.Trim());

        // 反向顺序：content 在前
        pattern = $@"<meta\s+(?:[^>]*?\s+)?content\s*=\s*[""']([^""']*?)[""']\s+(?:[^>]*?\s+)?(?:property|name)\s*=\s*[""']{Regex.Escape(nameOrProperty)}[""']";
        match = Regex.Match(html, pattern, RegexOptions.IgnoreCase | RegexOptions.Singleline);
        return match.Success ? WebUtility.HtmlDecode(match.Groups[1].Value.Trim()) : null;
    }

    /// <summary>
    /// 从 HTML 中提取 title 标签
    /// </summary>
    private static string? ExtractHtmlTitle(string html)
    {
        var match = Regex.Match(html, @"<title[^>]*>(.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        return match.Success ? WebUtility.HtmlDecode(match.Groups[1].Value.Trim()) : null;
    }

    /// <summary>
    /// 创建不自动跟随重定向的 HttpClient
    /// </summary>
    private HttpClient CreateNoRedirectClient()
    {
        var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate
        };
        var client = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(10)
        };
        return client;
    }

    private class OgMetadata
    {
        public string? Title { get; set; }
        public string? Description { get; set; }
        public string? Image { get; set; }
        public string? Type { get; set; }
        public string? VideoUrl { get; set; }
        public string? Author { get; set; }
        public Dictionary<string, string> Extra { get; set; } = new();
    }
}
