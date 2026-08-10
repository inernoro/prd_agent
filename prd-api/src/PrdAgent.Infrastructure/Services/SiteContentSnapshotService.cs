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

    public SiteContentSnapshotService(
        IAssetStorage storage,
        IFileContentExtractor extractor,
        IMemoryCache cache,
        ILogger<SiteContentSnapshotService> logger)
    {
        _storage = storage;
        _extractor = extractor;
        _cache = cache;
        _logger = logger;
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
            if (text.Length > PerFileBudget)
            {
                text = text[..PerFileBudget];
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

    /// <summary>
    /// 挑出参与抽取的文件：入口文件优先，其余正文类文件按体积从小到大补齐
    /// （小文件通常是真正的内容页，超大文件多半是打包产物）。
    ///
    /// 返回值第二项是**被数量上限挡掉的文件数**——调用方据此置 Truncated，
    /// 否则「只读了一部分」会被 prompt 说成「这是全部内容」。
    /// </summary>
    private static (List<HostedSiteFile> Picked, int Dropped) SelectFiles(HostedSite site, List<HostedSiteFile> files)
    {
        // PDF 包装站：读原始 PDF，不读那个只有一个 iframe 的壳子 index.html
        if (string.Equals(site.WrappedAssetType, "pdf", StringComparison.OrdinalIgnoreCase))
        {
            var pdf = files.FirstOrDefault(f =>
                f.Path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase));
            return (pdf != null ? new List<HostedSiteFile> { pdf } : new List<HostedSiteFile>(), 0);
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
        return (ordered, Math.Max(0, rest.Count - MaxFilesPerSite));
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
        var s = Regex.Replace(html, @"<(script|style|noscript)\b[^>]*>[\s\S]*?</\1>", " ",
            RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<!--[\s\S]*?-->", " ");
        // 块级标签转换行，保住段落感；否则整页会被压成一行，模型很难引用"某一段"
        s = Regex.Replace(s, @"<(br|/p|/div|/li|/h[1-6]|/tr|/section|/article)\s*>", "\n",
            RegexOptions.IgnoreCase);
        s = Regex.Replace(s, @"<[^>]+>", " ");
        s = System.Net.WebUtility.HtmlDecode(s);
        return Collapse(s);
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
