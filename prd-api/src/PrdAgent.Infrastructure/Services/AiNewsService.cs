using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

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

    // 单次 LLM 调用最多解读多少条（控制 token 与延迟，前端按需分批请求）。
    private const int CommentaryBatchSize = 6;

    private readonly IHttpClientFactory _httpFactory;
    private readonly IMemoryCache _cache;
    private readonly ILogger<AiNewsService> _logger;
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;

    public AiNewsService(
        IHttpClientFactory httpFactory,
        IMemoryCache cache,
        ILogger<AiNewsService> logger,
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext)
    {
        _httpFactory = httpFactory;
        _cache = cache;
        _logger = logger;
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
    }

    // 后台刷新去重哨兵。AiNewsService 是 Scoped（每请求新实例），故用 static 跨实例去重，
    // 保证同一时刻最多一个后台拉取，避免 stale 期间每个请求都甩一个 FetchAsync。
    private static int _refreshing;

    public async Task<AiNewsFeed> GetLatestAsync(CancellationToken ct = default)
    {
        // 真 serve-stale-while-revalidate（之前是「过期即同步阻塞拉外网」，每 5 分钟第一个用户必卡）：
        // 1) 新鲜命中 → 立即返回
        if (_cache.TryGetValue<AiNewsFeed>(CacheKey, out var fresh) && fresh != null)
        {
            return fresh;
        }

        // 2) 有 stale（6h 内拉成功过）→ 立即返回旧值 + 后台静默刷新，用户永不阻塞在外网拉取上
        if (_cache.TryGetValue<AiNewsFeed>(StaleKey, out var stale) && stale != null)
        {
            TriggerBackgroundRefresh();
            return new AiNewsFeed
            {
                Items = stale.Items,
                Total = stale.Total,
                GeneratedAt = stale.GeneratedAt,
                Degraded = false,
                Stale = true,
            };
        }

        // 3) 彻底冷（首次启动 / 超 6h 没人访问且预热器也没拉到）→ 只能同步拉一次
        try
        {
            return await RefreshAndCacheAsync(ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[AiNews] 冷缓存同步拉取失败且无 stale 可回退");
            return new AiNewsFeed { Degraded = true };
        }
    }

    /// <summary>拉取上游并写入新鲜/陈旧两层缓存。供冷路径、后台刷新、预热器共用。</summary>
    public async Task<AiNewsFeed> RefreshAndCacheAsync(CancellationToken ct = default)
    {
        var sw = Stopwatch.StartNew();
        var feed = await FetchAsync(ct);
        sw.Stop();
        _cache.Set(CacheKey, feed, FreshTtl);
        _cache.Set(StaleKey, feed, StaleTtl);
        // 成功路径计时日志：以前成功零日志，「慢但成功」无法检测。此行让外网拉取耗时可见。
        _logger.LogInformation("[AiNews] 上游资讯拉取完成 items={Items} elapsed={Elapsed}ms", feed.Total, sw.ElapsedMilliseconds);
        return feed;
    }

    private void TriggerBackgroundRefresh()
    {
        if (Interlocked.CompareExchange(ref _refreshing, 1, 0) != 0) return; // 已有刷新在跑，跳过
        // 后台刷新与请求生命周期解耦（server-authority：客户端断开不取消），仅用单例依赖。
        _ = Task.Run(async () =>
        {
            try
            {
                await RefreshAndCacheAsync(CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[AiNews] 后台刷新失败（继续沿用 stale 缓存）");
            }
            finally
            {
                Interlocked.Exchange(ref _refreshing, 0);
            }
        });
    }

    public async Task<Dictionary<string, string>> EnrichCommentaryAsync(
        IReadOnlyList<string> ids, string userId, CancellationToken ct = default)
    {
        var result = new Dictionary<string, string>();
        var wanted = ids.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        if (wanted.Count == 0) return result;

        // 1) 命中缓存
        var cached = await _db.AiNewsEnrichments
            .Find(Builders<AiNewsEnrichment>.Filter.In(x => x.Id, wanted))
            .ToListAsync(ct);
        foreach (var c in cached)
        {
            if (!string.IsNullOrWhiteSpace(c.Commentary)) result[c.Id] = c.Commentary;
        }

        // 2) 未命中的，从当前 feed 取标题后批量调 LLM
        var missing = wanted.Where(id => !result.ContainsKey(id)).ToList();
        if (missing.Count == 0) return result;

        var feed = await GetLatestAsync(ct);
        var byId = feed.Items
            .Where(i => !string.IsNullOrWhiteSpace(i.Id))
            .GroupBy(i => i.Id)
            .ToDictionary(g => g.Key, g => g.First());
        var toGen = missing.Where(byId.ContainsKey).Select(id => byId[id]).ToList();
        if (toGen.Count == 0) return result;

        for (var i = 0; i < toGen.Count; i += CommentaryBatchSize)
        {
            var batch = toGen.Skip(i).Take(CommentaryBatchSize).ToList();
            try
            {
                var (gen, model) = await GenerateCommentaryBatchAsync(batch, userId, ct);
                if (gen.Count == 0) continue;

                var docs = new List<AiNewsEnrichment>();
                foreach (var (id, text) in gen)
                {
                    if (string.IsNullOrWhiteSpace(text)) continue;
                    result[id] = text;
                    var item = byId.TryGetValue(id, out var it) ? it : null;
                    docs.Add(new AiNewsEnrichment
                    {
                        Id = id,
                        Title = item?.Title ?? "",
                        Commentary = text,
                        Model = model,
                        CreatedAt = DateTime.UtcNow,
                    });
                }
                // 落库（upsert，只 $set 解读相关字段，避免覆盖已抓取的 Excerpt）
                foreach (var d in docs)
                {
                    await _db.AiNewsEnrichments.UpdateOneAsync(
                        Builders<AiNewsEnrichment>.Filter.Eq(x => x.Id, d.Id),
                        Builders<AiNewsEnrichment>.Update
                            .Set(x => x.Commentary, d.Commentary)
                            .Set(x => x.Model, d.Model)
                            .SetOnInsert(x => x.Title, d.Title)
                            .SetOnInsert(x => x.CreatedAt, DateTime.UtcNow),
                        new UpdateOptions { IsUpsert = true },
                        ct);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[AiNews] 生成一句话解读失败（batch {Idx}），跳过本批", i / CommentaryBatchSize);
            }
        }

        return result;
    }

    public async Task<Dictionary<string, string>> EnrichExcerptAsync(
        IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        var result = new Dictionary<string, string>();
        var wanted = ids.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        if (wanted.Count == 0) return result;

        // 命中缓存：Excerpt != null 表示已抓过（空串=抓了但没有，避免反复抓）
        var cached = await _db.AiNewsEnrichments
            .Find(Builders<AiNewsEnrichment>.Filter.In(x => x.Id, wanted))
            .ToListAsync(ct);
        var fetchedIds = new HashSet<string>();
        foreach (var c in cached)
        {
            if (c.Excerpt != null)
            {
                fetchedIds.Add(c.Id);
                if (c.Excerpt.Length > 0) result[c.Id] = c.Excerpt;
            }
        }

        var missing = wanted.Where(id => !fetchedIds.Contains(id)).ToList();
        if (missing.Count == 0) return result;

        var feed = await GetLatestAsync(ct);
        var byId = feed.Items
            .Where(i => !string.IsNullOrWhiteSpace(i.Id))
            .GroupBy(i => i.Id)
            .ToDictionary(g => g.Key, g => g.First());
        var toFetch = missing.Where(byId.ContainsKey).ToList();
        if (toFetch.Count == 0) return result;

        // 并发抓取（限流）。区分「抓到了（含确实没 meta）」与「抓取失败（瞬时/被拦）」：
        // 只有真正抓到（Fetched=true）才写缓存，失败的不落库，留待后续重试，避免瞬时故障被永久缓存为「无摘要」。
        using var sem = new SemaphoreSlim(6);
        var tasks = toFetch.Select(async id =>
        {
            await sem.WaitAsync(ct);
            try
            {
                var (ok, ex) = await FetchExcerptAsync(byId[id].Url, ct);
                return (Id: id, Fetched: ok, Excerpt: ex);
            }
            catch
            {
                return (Id: id, Fetched: false, Excerpt: "");
            }
            finally
            {
                sem.Release();
            }
        });
        var fetched = await Task.WhenAll(tasks);

        foreach (var (id, ok, ex) in fetched)
        {
            if (!ok) continue; // 抓取失败：不缓存，下次可重试
            if (ex.Length > 0) result[id] = ex;
            await _db.AiNewsEnrichments.UpdateOneAsync(
                Builders<AiNewsEnrichment>.Filter.Eq(x => x.Id, id),
                Builders<AiNewsEnrichment>.Update
                    .Set(x => x.Excerpt, ex)
                    .SetOnInsert(x => x.Title, byId[id].Title)
                    .SetOnInsert(x => x.CreatedAt, DateTime.UtcNow),
                new UpdateOptions { IsUpsert = true },
                ct);
        }
        return result;
    }

    /// <summary>
    /// 抓取目标页 meta 摘要。返回 (Fetched, Excerpt)：
    /// Fetched=true 表示成功取到页面（Excerpt 可能为空串=确实没 meta，可缓存）；
    /// Fetched=false 表示请求失败/被拦/非 2xx（瞬时性，不缓存、待重试）。
    /// </summary>
    private async Task<(bool Fetched, string Excerpt)> FetchExcerptAsync(string url, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(url)) return (false, "");
        var client = _httpFactory.CreateClient("AiNews");
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.TryAddWithoutValidation("User-Agent",
            "Mozilla/5.0 (compatible; PrdAgentNewsBot/1.0; +https://miduo.org)");
        req.Headers.TryAddWithoutValidation("Accept", "text/html,application/xhtml+xml");

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(5));

        using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token);
        if (!resp.IsSuccessStatusCode) return (false, ""); // 非 2xx（含重定向被禁/被拦）：瞬时性，不缓存
        var mediaType = resp.Content.Headers.ContentType?.MediaType ?? "";
        // 非 HTML（PDF/图片等）是稳定属性，算「抓到但无摘要」，缓存空串避免反复抓
        if (!mediaType.Contains("html", StringComparison.OrdinalIgnoreCase)) return (true, "");

        // 只读 head 区域（前 ~256KB 足够拿到 <meta>）
        await using var stream = await resp.Content.ReadAsStreamAsync(cts.Token);
        var buf = new byte[256 * 1024];
        var read = 0;
        int n;
        while (read < buf.Length && (n = await stream.ReadAsync(buf.AsMemory(read, buf.Length - read), cts.Token)) > 0)
        {
            read += n;
        }
        var html = Encoding.UTF8.GetString(buf, 0, read);
        return (true, ExtractMetaDescription(html) ?? ""); // 抓到了；摘要可能为空（页面无 meta）
    }

    private static readonly string[] DescKeys = { "og:description", "twitter:description", "description" };

    /// <summary>从 HTML 抠 meta 描述，按 og &gt; twitter &gt; name=description 优先级，解码 + 截断。</summary>
    private static string? ExtractMetaDescription(string html)
    {
        if (string.IsNullOrEmpty(html)) return null;
        foreach (var key in DescKeys)
        {
            // content 在 key 之后
            var m = Regex.Match(html,
                $"<meta[^>]*(?:property|name)\\s*=\\s*[\"']{Regex.Escape(key)}[\"'][^>]*content\\s*=\\s*[\"']([^\"']*)[\"']",
                RegexOptions.IgnoreCase | RegexOptions.Singleline);
            if (!m.Success)
            {
                // content 在 key 之前
                m = Regex.Match(html,
                    $"<meta[^>]*content\\s*=\\s*[\"']([^\"']*)[\"'][^>]*(?:property|name)\\s*=\\s*[\"']{Regex.Escape(key)}[\"']",
                    RegexOptions.IgnoreCase | RegexOptions.Singleline);
            }
            if (m.Success)
            {
                var text = WebUtility.HtmlDecode(m.Groups[1].Value).Trim();
                // 部分站点 meta 里实体被双重编码（&amp;ldquo;），再解一次
                if (Regex.IsMatch(text, "&(?:[a-zA-Z]+|#\\d+);"))
                {
                    text = WebUtility.HtmlDecode(text).Trim();
                }
                text = Regex.Replace(text, "\\s+", " ");
                if (text.Length >= 8)
                {
                    return text.Length > 140 ? text[..140].TrimEnd() + "…" : text;
                }
            }
        }
        return null;
    }

    private async Task<(Dictionary<string, string> Map, string Model)> GenerateCommentaryBatchAsync(
        List<AiNewsItem> batch, string userId, CancellationToken ct)
    {
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: "ai-news-commentary",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Admin.AiNews.Commentary));

        // 用 1..N 的序号代替哈希 id（模型无法可靠回显 40 位哈希），返回后按序号映射回真实 id。
        var listJson = new JsonArray();
        for (var i = 0; i < batch.Count; i++)
        {
            listJson.Add(new JsonObject
            {
                ["n"] = i + 1,
                ["title"] = batch[i].Title,
                ["source"] = batch[i].Source,
                ["label"] = batch[i].AiLabel,
            });
        }

        var systemPrompt =
            "你是 PrdAgent「AI 大事」资讯频道的责任编辑。下面给你一批 AI 资讯（JSON 数组，每条有序号 n、标题 title、来源 source、分类 label，没有正文）。\n" +
            "为每条写一句**中文**编辑解读 / 推荐理由，告诉读者「这条值不值得点、对谁有用、关键点是什么」。\n" +
            "要求：\n" +
            "- 每条 18~45 字，口语、犀利、有信息增量，不要复述标题原文\n" +
            "- 不确定的不要编造细节；标题信息太少就给「为什么这类消息值得关注」的角度\n" +
            "- 禁止任何 emoji\n" +
            "- 必须为每个输入序号都给一条；只输出一个 JSON 数组，元素为 {\"n\":序号,\"comment\":\"解读\"}\n" +
            "- 不要 markdown 代码围栏、不要任何多余文字";

        var gatewayBody = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = listJson.ToJsonString() },
            },
            ["temperature"] = 0.6,
            // 给足 token：部分模型（如 deepseek-v4-flash）会先思考，预算太小会把额度耗在 reasoning 上导致 content 为空。
            ["max_tokens"] = 3000,
            // 这是结构化短文本任务，不需要推理；关掉 reasoning 让 token 全给最终 JSON（OpenRouter 字段，模型不支持时忽略）。
            ["reasoning"] = new JsonObject { ["enabled"] = false },
        };

        var resp = await _gateway.SendAsync(new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Admin.AiNews.Commentary,
            ModelType = "chat",
            RequestBody = gatewayBody,
        }, ct);

        if (!resp.Success || string.IsNullOrWhiteSpace(resp.Content))
        {
            _logger.LogWarning("[AiNews] 解读 LLM 无有效返回：{Err}", resp.ErrorMessage);
            return (new(), "");
        }

        var map = ParseCommentaryByIndex(resp.Content, batch);
        if (map.Count == 0)
        {
            var preview = resp.Content.Length > 300 ? resp.Content[..300] : resp.Content;
            _logger.LogWarning("[AiNews] 解读输出解析为空，原文预览：{Preview}", preview);
        }
        return (map, resp.Resolution?.ActualModel ?? "");
    }

    /// <summary>解析 [{n,comment}]，按序号映射回 batch 的真实资讯 id。</summary>
    private static Dictionary<string, string> ParseCommentaryByIndex(string content, List<AiNewsItem> batch)
    {
        var map = new Dictionary<string, string>();
        var json = ExtractJsonArray(content);
        if (json == null) return map;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return map;
            foreach (var el in doc.RootElement.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Object) continue;
                if (!el.TryGetProperty("n", out var nEl)) continue;
                var n = nEl.ValueKind == JsonValueKind.Number && nEl.TryGetInt32(out var ni)
                    ? ni
                    : (int.TryParse(nEl.GetString(), out var ns) ? ns : 0);
                if (n < 1 || n > batch.Count) continue;
                var comment = el.TryGetProperty("comment", out var cEl) ? cEl.GetString() : null;
                if (!string.IsNullOrWhiteSpace(comment))
                {
                    map[batch[n - 1].Id] = comment!.Trim();
                }
            }
        }
        catch
        {
            // 解析失败返回空，调用方按未生成处理（并已记录原文预览）
        }
        return map;
    }

    /// <summary>从可能带围栏 / 前后缀的文本里抠出第一个 JSON 数组。</summary>
    private static string? ExtractJsonArray(string text)
    {
        var start = text.IndexOf('[');
        var end = text.LastIndexOf(']');
        if (start < 0 || end <= start) return null;
        return text.Substring(start, end - start + 1);
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
            // 仅保留绝对 http/https 链接：外部源不可信，挡掉 javascript: / data: / 协议相对等会被前端直接当 href 渲染的危险方案。
            .Where(x => IsSafeHttpUrl(x.Url) && HasTitle(x))
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

    /// <summary>仅接受绝对 http/https URL（前端会直接当 href 渲染，挡掉 javascript:/data:/相对 等危险方案）。</summary>
    private static bool IsSafeHttpUrl(string? url) =>
        !string.IsNullOrWhiteSpace(url)
        && Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

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
        AiSignals = x.AiSignals ?? new(),
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
        [JsonPropertyName("ai_signals")] public List<string>? AiSignals { get; set; }
    }
}
