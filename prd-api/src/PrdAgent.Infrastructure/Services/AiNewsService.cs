using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 首页「AI 大事早知道」资讯雷达。
///
/// 设计：
/// - 数据源是外部公共静态 JSON（ai-news-radar，GitHub Pages，每 30 分钟自更新，免鉴权、无 API Key）。
/// - 前端不直连外站（遵守「前端无业务状态」+ 规避 GitHub Pages 对终端用户的可用性/CORS 波动），统一走本服务代理。
/// - 双层缓存：FreshTtl(5min) 命中直接返回；上游拉取失败时回退到 StaleTtl(6h) 的上次成功结果并打 stale 标记。
/// - 上游彻底不可达且无任何缓存时返回 Degraded=true，前端走空态而非报错（外部免费源固有边界）。
/// </summary>
public class AiNewsService : IAiNewsService
{
    private const string FeedUrl = "https://learnprompt.github.io/ai-news-radar/data/latest-24h.json";
    private const string CacheKey = "AiNews:Latest24h";
    private const string StaleKey = "AiNews:Latest24h:Stale";
    private static readonly TimeSpan FreshTtl = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan StaleTtl = TimeSpan.FromHours(6);
    // 更新中心「AI 大事」时间线支持「加载更多」往下翻，放宽返回上限（首页 teaser 只取头部几条）。
    private const int MaxItems = 200;

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly IHttpClientFactory _httpFactory;
    private readonly IMemoryCache _cache;
    private readonly ILogger<AiNewsService> _logger;

    public AiNewsService(IHttpClientFactory httpFactory, IMemoryCache cache, ILogger<AiNewsService> logger)
    {
        _httpFactory = httpFactory;
        _cache = cache;
        _logger = logger;
    }

    public async Task<AiNewsFeed> GetLatestAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue<AiNewsFeed>(CacheKey, out var fresh) && fresh != null)
        {
            return fresh;
        }

        try
        {
            var feed = await FetchAsync(ct);
            _cache.Set(CacheKey, feed, FreshTtl);
            _cache.Set(StaleKey, feed, StaleTtl);
            return feed;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AiNews] 拉取上游资讯失败，尝试回退 stale 缓存");
            if (_cache.TryGetValue<AiNewsFeed>(StaleKey, out var stale) && stale != null)
            {
                return new AiNewsFeed
                {
                    Items = stale.Items,
                    Total = stale.Total,
                    GeneratedAt = stale.GeneratedAt,
                    Degraded = false,
                    Stale = true,
                };
            }
            return new AiNewsFeed { Degraded = true };
        }
    }

    private async Task<AiNewsFeed> FetchAsync(CancellationToken ct)
    {
        var client = _httpFactory.CreateClient("AiNews");
        using var resp = await client.GetAsync(FeedUrl, HttpCompletionOption.ResponseHeadersRead, ct);
        resp.EnsureSuccessStatusCode();

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        var raw = await JsonSerializer.DeserializeAsync<UpstreamFeed>(stream, JsonOpts, ct);
        if (raw == null)
        {
            throw new InvalidOperationException("上游资讯 JSON 解析为空");
        }

        // 新格式顶层 items；兼容历史 items_ai 字段名。
        var source = raw.Items ?? raw.ItemsAi ?? new List<UpstreamItem>();

        var items = source
            .Where(x => !string.IsNullOrWhiteSpace(x.Url) && HasTitle(x))
            .Select(MapItem)
            // 按可用时间倒序（优先 published_at，缺失用 first_seen_at）。
            .OrderByDescending(x => ParseTime(x.PublishedAt) ?? ParseTime(x.FirstSeenAt) ?? DateTimeOffset.MinValue)
            .Take(MaxItems)
            .ToList();

        return new AiNewsFeed
        {
            Items = items,
            Total = raw.TotalItems > 0 ? raw.TotalItems : items.Count,
            GeneratedAt = raw.GeneratedAt,
            Degraded = false,
            Stale = false,
        };
    }

    private static bool HasTitle(UpstreamItem x) =>
        !string.IsNullOrWhiteSpace(x.TitleZh)
        || !string.IsNullOrWhiteSpace(x.Title)
        || !string.IsNullOrWhiteSpace(x.TitleEn);

    private static AiNewsItem MapItem(UpstreamItem x) => new()
    {
        Id = x.Id ?? "",
        // 中文优先：title_zh > title > title_en。
        Title = FirstNonEmpty(x.TitleZh, x.Title, x.TitleEn) ?? "",
        Url = x.Url ?? "",
        Source = x.Source ?? x.SiteName ?? "",
        SiteName = x.SiteName ?? "",
        PublishedAt = x.PublishedAt,
        FirstSeenAt = x.FirstSeenAt,
        AiLabel = x.AiLabel ?? "",
        AiScore = x.AiScore,
    };

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    private static DateTimeOffset? ParseTime(string? iso) =>
        DateTimeOffset.TryParse(iso, out var t) ? t : null;

    // ── 上游 JSON 形状（snake_case）──

    private sealed class UpstreamFeed
    {
        [JsonPropertyName("generated_at")] public string? GeneratedAt { get; set; }
        [JsonPropertyName("total_items")] public int TotalItems { get; set; }
        [JsonPropertyName("items")] public List<UpstreamItem>? Items { get; set; }
        [JsonPropertyName("items_ai")] public List<UpstreamItem>? ItemsAi { get; set; }
    }

    private sealed class UpstreamItem
    {
        [JsonPropertyName("id")] public string? Id { get; set; }
        [JsonPropertyName("site_name")] public string? SiteName { get; set; }
        [JsonPropertyName("source")] public string? Source { get; set; }
        [JsonPropertyName("title")] public string? Title { get; set; }
        [JsonPropertyName("title_zh")] public string? TitleZh { get; set; }
        [JsonPropertyName("title_en")] public string? TitleEn { get; set; }
        [JsonPropertyName("url")] public string? Url { get; set; }
        [JsonPropertyName("published_at")] public string? PublishedAt { get; set; }
        [JsonPropertyName("first_seen_at")] public string? FirstSeenAt { get; set; }
        [JsonPropertyName("ai_label")] public string? AiLabel { get; set; }
        [JsonPropertyName("ai_score")] public double AiScore { get; set; }
    }
}
