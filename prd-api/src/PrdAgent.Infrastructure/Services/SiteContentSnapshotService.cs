using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 站点正文快照实现。四种站点形状分别取材，统一出纯文本。
///
/// HTML 转文本刻意放在服务端：匿名分享页的前端拿不到可靠正文（跨域），
/// 更重要的是**上下文构成必须由服务端说了算**——如果让前端把"网页内容"传上来，
/// 访客就能伪造一段正文诱导模型说出站点里根本没有的话。
/// </summary>
public class SiteContentSnapshotService : ISiteContentSnapshotService
{
    /// <summary>喂给模型的正文总预算（字符）。约 1.5-2 万 token 量级，给回答留足空间。</summary>
    private const int TotalBudget = 24000;

    /// <summary>单个文件最多贡献多少字符，防止一个巨型文件把预算吃光、其它文件一个字进不去。</summary>
    private const int PerFileBudget = 8000;

    /// <summary>一个站点最多取几个正文文件，避免几百个碎文件把每个文件的固定开销放大。</summary>
    private const int MaxFilesPerSite = 12;

    /// <summary>
    /// 单个文件最多下载多少字节，超过直接不下。
    ///
    /// 这是**安全上限**不是体验上限：托管上传允许到 500MB，而提问端点匿名可达
    /// （拿着公开分享 token 就能打）。没有这道闸的话，一个内含超大 .txt/.json 的站点
    /// 会让每次未命中缓存的提问都把几百 MB 读进内存、再对整串跑正则，
    /// 反复打就是把 API 拖垮。PerFileBudget 只截**抽完之后**的文本，拦不住下载与抽取本身。
    ///
    /// 判据用的是我们自己入库时记的 Size，不是对端自报的 Content-Length，可信。
    /// </summary>
    private const long MaxFileDownloadBytes = 2L * 1024 * 1024;

    /// <summary>缓存时长。内容变了 ContentVersion 会变、缓存键随之改变，所以这里可以放长。</summary>
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(30);

    /// <summary>正文类扩展名白名单：脚本/样式/图片/媒体一律不进上下文（占预算且对回答无用）。</summary>
    private static readonly HashSet<string> TextualExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".html", ".htm", ".md", ".markdown", ".txt", ".json", ".csv", ".xml",
    };

    private readonly IAssetStorage _storage;
    private readonly IFileContentExtractor _extractor;
    private readonly IMemoryCache _cache;
    private readonly ILogger<SiteContentSnapshotService> _logger;
    private readonly IHttpClientFactory? _httpClientFactory;

    public SiteContentSnapshotService(
        IAssetStorage storage,
        IFileContentExtractor extractor,
        IMemoryCache cache,
        ILogger<SiteContentSnapshotService> logger,
        IHttpClientFactory? httpClientFactory = null)
    {
        _storage = storage;
        _extractor = extractor;
        _cache = cache;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
    }

    public async Task<SiteContentSnapshot> GetAsync(HostedSite site, CancellationToken ct = default)
    {
        // 缓存键带内容版本：重新上传会换版本 → 自动击穿；改标题等元数据不动版本 → 继续命中。
        // 与 SiteUrl 的 ?v= 指纹同一个口径（EffectiveContentVersion），不另立标准。
        var version = site.ContentVersion == default ? site.CreatedAt : site.ContentVersion;
        var cacheKey = $"site-ask-snapshot:{site.Id}:{version.Ticks}";
        if (_cache.TryGetValue<SiteContentSnapshot>(cacheKey, out var cached) && cached != null)
            return cached;

        var snapshot = await BuildAsync(site, ct);

        // 只缓存"确定的结论"。对象存储抖一下就把 30 分钟的空快照钉死在缓存里，
        // 存储恢复之后每次提问照样吃 ASK_NO_CONTENT，而配额已经先扣掉了。
        // 「这页确实没有正文」是事实，可以缓存；「这次没读回来」不是。
        if (!snapshot.TransientFailure)
            _cache.Set(cacheKey, snapshot, CacheTtl);

        return snapshot;
    }

    private async Task<SiteContentSnapshot> BuildAsync(HostedSite site, CancellationToken ct)
    {
        var result = new SiteContentSnapshot { SiteId = site.Id };

        // 不支持提问的站点形态（目前只有视频包装站）走唯一判定源，
        // 与「配置接口拒绝打开开关」「面板灰掉开关」是同一个答案，不许各判各的。
        var unsupported = AskAccessPolicy.UnsupportedReason(site.WrappedAssetType);
        if (unsupported != null)
        {
            result.Unavailable = unsupported;
            return result;
        }

        var files = site.Files ?? new List<HostedSiteFile>();
        var (picked, droppedByCap) = SelectFiles(site, files);
        if (picked.Count == 0)
        {
            result.Unavailable = "这个页面没有可供阅读的文字内容。";
            return result;
        }

        // 被数量上限挡在门外的文件也算截断——它们连读都没读，更谈不上进 prompt
        if (droppedByCap > 0) result.Truncated = true;

        var sb = new StringBuilder();
        var totalChars = 0;
        var used = 0;
        // 读失败与"确实没有正文"必须分开：前者是暂时的，后者是这个站点的事实。
        // 混作一谈会让一次对象存储抖动被当成"这页没内容"缓存半小时。
        var downloadFailed = false;

        foreach (var file in picked)
        {
            ct.ThrowIfCancellationRequested();
            if (used >= TotalBudget) { result.Truncated = true; break; }

            byte[]? bytes;
            try
            {
                bytes = await _storage.TryDownloadBytesAsync(file.CosKey, ct);
                // 存量站点可能仍指向旧 COS，而当前环境已经切到 R2。Mongo 里的 CosKey
                // 在当前 Provider 下会 404，但入口 SiteUrl 仍然可读。只对入口文件走这条
                // 有界公网回退：它是系统创建时落库的地址，不接受访客请求传入 URL；其余
                // 文件仍坚持从当前存储读取，避免把任意站点资源下载扩大成外连面。
                if (bytes == null && IsEntryFile(site, file))
                    bytes = await TryDownloadLegacyEntryAsync(site, file, ct);
            }
            catch (Exception ex)
            {
                // 单个文件读不回来不该让整站问答挂掉——跳过并继续，最后按"有没有攒到正文"判定
                _logger.LogWarning(ex, "站点正文快照：读取对象失败 site={SiteId} key={Key}", site.Id, file.CosKey);
                downloadFailed = true;
                continue;
            }
            if (bytes == null)
            {
                // null = 取不到这个对象（存储抖动 / key 失效），与"文件本身是空的"不同
                downloadFailed = true;
                continue;
            }
            if (bytes.Length == 0) continue;

            var text = ExtractText(bytes, file);
            if (string.IsNullOrWhiteSpace(text)) continue;

            totalChars += text.Length;
            // 单文件站点就是一个完整长页面，不能仍按 8000 字截断：用户问到页面后半段时，
            // 模型虽然“读到了正文”，实际却永远看不到答案。多文件站按文件数公平分配总预算，
            // 至少保留原有 8000 字下限，既用满上下文，又不让一个大文件吞掉其它文件。
            var perFileBudget = picked.Count == 1
                ? TotalBudget
                : Math.Max(PerFileBudget, TotalBudget / picked.Count);
            if (text.Length > perFileBudget)
            {
                text = text[..perFileBudget];
                result.Truncated = true;
            }

            var remaining = TotalBudget - used;
            if (text.Length > remaining)
            {
                text = text[..remaining];
                result.Truncated = true;
            }

            // 多文件站标一下每段来自哪个文件，模型答"在哪一页"时有据可依
            if (picked.Count > 1)
                sb.AppendLine($"--- {file.Path} ---");
            sb.AppendLine(text);
            sb.AppendLine();

            used += text.Length;
            result.FileCount++;
        }

        result.Text = sb.ToString().Trim();
        result.TotalChars = totalChars;

        if (result.Text.Length == 0)
        {
            // 一个字都没攒到，但有文件读失败了 —— 这是"暂时读不到"，不是"这页没内容"。
            // 说成后者既是撒谎，还会被缓存半小时，让存储恢复后照样问不了。
            result.TransientFailure = downloadFailed;
            result.Unavailable = downloadFailed
                ? "暂时读取不到这个页面的内容，请稍后再试。"
                : "这个页面没有可供阅读的文字内容。";
        }
        else if (downloadFailed)
        {
            // 攒到了一部分，但有文件没读回来：内容不完整，如实标注
            result.Truncated = true;
        }

        return result;
    }

    private static bool IsEntryFile(HostedSite site, HostedSiteFile file)
        => !string.IsNullOrWhiteSpace(site.EntryFile)
           && string.Equals(file.Path, site.EntryFile, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// 当前 Provider 找不到存量入口对象时，从站点落库的旧公网地址读取一次。
    /// 下载前后都执行 2MB 上限，并使用独立短超时；失败返回 null，让调用方继续按暂时故障处理。
    /// </summary>
    private async Task<byte[]?> TryDownloadLegacyEntryAsync(
        HostedSite site,
        HostedSiteFile file,
        CancellationToken ct)
    {
        if (_httpClientFactory == null || file.Size > MaxFileDownloadBytes)
            return null;
        if (!Uri.TryCreate(site.SiteUrl, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
            return null;

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            // 历史 SiteUrl 不是当前请求直接传入，但其 CDN/DNS 状态仍可能在落库后变化。
            // 必须走 SafeOutbound：它在建连时拒绝内网/保留地址，并关闭自动重定向，
            // 避免旧 CDN 通过 DNS 或 3xx 把正文读取导向内部服务或云元数据地址。
            using var response = await _httpClientFactory.CreateClient("SafeOutbound")
                .GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength is > MaxFileDownloadBytes)
                return null;

            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffered = new MemoryStream();
            var chunk = new byte[8192];
            while (true)
            {
                var read = await stream.ReadAsync(chunk, timeout.Token);
                if (read <= 0) break;
                if (buffered.Length + read > MaxFileDownloadBytes)
                    return null;
                await buffered.WriteAsync(chunk.AsMemory(0, read), timeout.Token);
            }

            var bytes = buffered.ToArray();
            if (bytes.Length > 0)
            {
                _logger.LogInformation(
                    "站点正文快照：当前存储缺少入口对象，已从存量站点地址读取 site={SiteId} key={Key}",
                    site.Id,
                    file.CosKey);
            }
            return bytes.Length > 0 ? bytes : null;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
        {
            _logger.LogWarning(
                ex,
                "站点正文快照：存量入口地址读取失败 site={SiteId} key={Key}",
                site.Id,
                file.CosKey);
            return null;
        }
    }

    /// <summary>
    /// 挑出参与抽取的文件：入口文件优先，其余正文类文件按体积从小到大补齐
    /// （小文件通常是真正的内容页，超大文件多半是打包产物）。
    ///
    /// 返回值第二项是**被数量上限挡掉的文件数**——调用方据此置 Truncated，
    /// 否则「只读了一部分」会被 prompt 说成「这是全部内容」。
    /// </summary>
    private static (List<HostedSiteFile> Picked, int Dropped) SelectFiles(HostedSite site, List<HostedSiteFile> files)
    {
        // 体积上限放在**所有分支之前**，对任何站点形态一视同仁。
        //
        // 上一版把它放在 PDF 分支之后，于是 PDF 包装站整条路绕过了闸门——一个 200MB 的 PDF，
        // 拿着公开分享 token 每问一次就整份下载 + 抽取一次。同一个函数里「按形态分支」与
        // 「按安全上限过滤」两件事的先后顺序错了，闸门就只挡住其中一条路。
        // 这类「修一条分支、漏兄弟分支」正是 predicate-and-wiring-discipline 形状 1，
        // 所以这里不再逐分支补，而是把闸门提到分支之前，让任何新增形态都不可能绕过。
        var oversized = files.Count(f => f.Size > MaxFileDownloadBytes);
        files = files.Where(f => f.Size <= MaxFileDownloadBytes).ToList();

        // PDF 包装站：读原始 PDF，不读那个只有一个 iframe 的壳子 index.html
        if (string.Equals(site.WrappedAssetType, "pdf", StringComparison.OrdinalIgnoreCase))
        {
            var pdf = files.FirstOrDefault(f =>
                f.Path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase));
            return (pdf != null ? new List<HostedSiteFile> { pdf } : new List<HostedSiteFile>(), oversized);
        }

        var textual = files
            .Where(f => TextualExtensions.Contains(Path.GetExtension(f.Path)))
            .ToList();

        var entry = textual.FirstOrDefault(f =>
            string.Equals(f.Path, site.EntryFile, StringComparison.OrdinalIgnoreCase));

        var rest = textual.Where(f => f != entry).OrderBy(f => f.Size).ToList();

        var ordered = new List<HostedSiteFile>();
        if (entry != null) ordered.Add(entry);
        // 一个站点最多取 12 个文件，避免几百个碎文件把每个文件的固定开销放大
        ordered.AddRange(rest.Take(MaxFilesPerSite));

        // 丢掉的文件数必须报上去。漏报的后果很具体：prompt 会说「以下是这个页面的全部内容」，
        // 模型据此把没读到的东西当成"页面里没有"，斩钉截铁地回答不存在——
        // 而事实是我们压根没给它看。宁可告诉用户「只读了一部分」。
        // 被数量上限挡掉的 + 被体积上限挡掉的，都算「没给模型看」，一起报上去置 Truncated
        return (ordered, Math.Max(0, rest.Count - MaxFilesPerSite) + oversized);
    }

    private string? ExtractText(byte[] bytes, HostedSiteFile file)
    {
        var ext = Path.GetExtension(file.Path);

        if (string.Equals(ext, ".pdf", StringComparison.OrdinalIgnoreCase))
            return _extractor.Extract(bytes, "application/pdf", file.Path);

        var raw = DecodeUtf8(bytes);
        if (string.IsNullOrWhiteSpace(raw)) return null;

        return ext.Equals(".html", StringComparison.OrdinalIgnoreCase)
               || ext.Equals(".htm", StringComparison.OrdinalIgnoreCase)
            ? HtmlToPlainText(raw)
            : Collapse(raw);
    }

    private static string DecodeUtf8(byte[] bytes)
    {
        // 去掉 UTF-8 BOM，否则首个字符会是 ﻿，喂进 prompt 里是噪音
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>
    /// HTML 转纯文本：先摘掉 script/style/noscript 整块（含内容），再去标签、解实体、压空白。
    ///
    /// 顺序不能反 —— 先去标签的话，script 里的 JS 源码会变成正文的一部分混进上下文。
    /// </summary>
    internal static string HtmlToPlainText(string html)
    {
        var staticText = ExtractStaticMarkupText(html);
        // 只有“空挂载节点 + module 脚本 + body 没有可见正文”三个条件同时成立，
        // 才确认它是纯客户端壳子并从 bundle 补文案。服务端已渲染页面即使带 hydration
        // 脚本也不读取脚本字符串，避免隐藏错误、管理文案或重复 hydration 数据混进正文。
        var bundledText = IsConfirmedClientRenderedShell(html)
            ? ExtractHumanReadableScriptText(html)
            : string.Empty;

        if (string.IsNullOrWhiteSpace(bundledText)) return staticText;
        if (string.IsNullOrWhiteSpace(staticText)) return bundledText;
        return Collapse($"{staticText}\n{bundledText}");
    }

    private static string ExtractStaticMarkupText(string html)
    {
        var s = StripInertMarkup(html);
        // 块级标签转换行，保住段落感；否则整页会被压成一行，模型很难引用"某一段"
        s = Regex.Replace(s, @"<(br|/p|/div|/li|/h[1-6]|/tr|/section|/article)\s*>", "\n",
            RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<[^>]+>", " ");
        s = System.Net.WebUtility.HtmlDecode(s);
        return Collapse(s);
    }

    private static string StripInertMarkup(string html)
    {
        var stripped = Regex.Replace(html, @"<(script|style|noscript|template)\b[^>]*>[\s\S]*?</\1>", " ",
            RegexOptions.IgnoreCase);
        return Regex.Replace(stripped, @"<!--[\s\S]*?-->", " ");
    }

    private static bool IsConfirmedClientRenderedShell(string html)
    {
        var bodyMatch = Regex.Match(html, @"<body\b[^>]*>([\s\S]*?)</body>", RegexOptions.IgnoreCase);
        if (!bodyMatch.Success) return false;

        var body = bodyMatch.Groups[1].Value;
        var activeMarkup = StripInertMarkup(body);
        var hasKnownMount = Regex.IsMatch(
            activeMarkup,
            @"\bid\s*=\s*(?:""(?:root|app|__next)""|'(?:root|app|__next)'|(?:root|app|__next)\b)",
            RegexOptions.IgnoreCase);
        var hasModuleScript = Regex.IsMatch(
            html,
            @"<script\b[^>]*\btype\s*=\s*(?:""module""|'module'|module\b)",
            RegexOptions.IgnoreCase);
        var visibleBodyText = ExtractStaticMarkupText(body);

        return hasKnownMount && hasModuleScript && string.IsNullOrWhiteSpace(visibleBodyText);
    }

    private static string ExtractHumanReadableScriptText(string html)
    {
        var output = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        // 只读真正承载客户端页面的 module 脚本。hydration JSON、兼容脚本、
        // 埋点和错误处理脚本不是可见正文，不得被混入快照。
        var scripts = Regex.Matches(
            html,
            @"<script\b(?=[^>]*\btype\s*=\s*(?:""module""|'module'|module\b))[^>]*>([\s\S]*?)</script>",
            RegexOptions.IgnoreCase);

        foreach (Match script in scripts)
        {
            var source = script.Groups[1].Value;
            // 带路由的 bundle 同时包含多个页面，服务端不知道浏览器当前渲染了哪一条。
            // 这种形态宁可拒绝自动补文案，也不把其它路由的内容说成当前页正文。
            if (Regex.IsMatch(
                    source,
                    @"\b(?:createBrowserRouter|BrowserRouter|HashRouter|MemoryRouter|useRoutes)\b|\blocation\s*\.\s*pathname\b",
                    RegexOptions.IgnoreCase))
                continue;

            // 只提取 React 元素 children 属性中的文本节点，不再扫描任意 JS 字符串。
            // 这会排除路由表元数据、对话框配置、隐藏错误和管理员文案常量。
            var children = Regex.Matches(
                source,
                @"\bchildren\s*:\s*(?:\[\s*)?(?<quote>[""'`])(?<text>(?:\\.|(?!\k<quote>)[\s\S]){2,1000}?)\k<quote>");
            foreach (Match child in children)
            {
                var value = child.Groups["text"].Value;
                if (string.IsNullOrWhiteSpace(value)
                    || !Regex.IsMatch(value, @"[\u3400-\u9fff]"))
                    continue;

                value = Collapse(System.Net.WebUtility.HtmlDecode(value));
                if (value.Length > 0 && seen.Add(value)) output.Add(value);
            }
        }

        return string.Join('\n', output);
    }

    /// <summary>压掉多余空白：行内连续空白压成一个空格，连续空行压成一个。</summary>
    private static string Collapse(string s)
    {
        s = s.Replace("\r\n", "\n").Replace('\r', '\n');
        s = Regex.Replace(s, @"[ \t\f\v]+", " ");
        s = Regex.Replace(s, @" *\n *", "\n");
        s = Regex.Replace(s, @"\n{3,}", "\n\n");
        return s.Trim();
    }
}
