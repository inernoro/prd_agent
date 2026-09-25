using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 托管站点里的一个文件。Path 相对站点根（如 "css/app.css"）；StorageKey 是调用方读字节用的不透明键，
/// 本类只把它原样交回读取委托，从不拼接或解析它。
/// </summary>
public sealed record HostedSiteInlineFile(string Path, long Size, string? MimeType, string? StorageKey = null);

/// <summary>一处没能打包进离线文件的引用。</summary>
public sealed record HostedSiteInlineMissing(string Reference, HostedSiteInlineMissingReason Reason);

public enum HostedSiteInlineMissingReason
{
    /// <summary>站点文件清单里没有这个路径（写错了、或上传时就漏了）。</summary>
    NotInSite,

    /// <summary>引用跳出了站点根目录（../../x），出于安全不读取。</summary>
    OutsideSiteRoot,

    /// <summary>清单里有，但存储这会儿没把字节交回来。</summary>
    ReadFailed,
}

/// <summary>引用的归类：站内相对路径才会被内嵌，其余原样保留。</summary>
public enum HostedSiteReferenceKind
{
    /// <summary>空串、锚点、data:/blob:/javascript: 等——不是要取的文件。</summary>
    Ignored,

    /// <summary>http(s):// 或 // 开头的外部地址，离线文件里原样保留。</summary>
    External,

    /// <summary>站内相对路径（已规范化）。</summary>
    Site,

    /// <summary>../ 走出了站点根目录。</summary>
    OutsideSiteRoot,
}

public sealed class HostedSiteInlineResult
{
    public string Html { get; init; } = string.Empty;
    public long OutputBytes { get; init; }
    public int InlinedCount { get; init; }
    public IReadOnlyList<HostedSiteInlineMissing> Missing { get; init; } = Array.Empty<HostedSiteInlineMissing>();

    /// <summary>非空 = 超过体积上限，没有产出。值是压线时正在处理的那个文件（或「整页」）。</summary>
    public string? OverLimitAt { get; init; }

    public bool Succeeded => OverLimitAt == null;
}

/// <summary>
/// 把托管站点的入口 HTML 打成一份自包含的离线 HTML：
/// 站内相对引用的 CSS 变成 &lt;style&gt;、脚本变成内联 &lt;script&gt;、图片 / 字体 / CSS url() 变成 data: URI，
/// 外部绝对地址原样保留。
///
/// 纯逻辑：文件清单与读字节的委托由调用方给，本类不碰存储、不碰权限。
/// 读文件只会以「清单里的路径」为键去取，规范化后跳出站点根的引用一律不读——
/// 所以这里不存在目录穿越：能读到的集合在构造时就确定了。
/// </summary>
public sealed class HostedSiteHtmlInliner
{
    public const long DefaultMaxOutputBytes = 20L * 1024 * 1024;
    private const int MaxCssImportDepth = 8;

    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(5);

    private static readonly Regex HtmlToken = new(
        """(?<comment><!--[\s\S]*?-->)|(?<script><script\b(?<sattrs>(?:[^>"']|"[^"]*"|'[^']*')*)>(?<sbody>[\s\S]*?)</script\s*>)|(?<style><style\b(?<stattrs>(?:[^>"']|"[^"]*"|'[^']*')*)>(?<stbody>[\s\S]*?)</style\s*>)|(?<tag><(?<name>[a-zA-Z][a-zA-Z0-9:-]*)\b(?<attrs>(?:[^>"']|"[^"]*"|'[^']*')*)>)""",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);

    private static readonly Regex Attribute = new(
        """(?<name>[^\s"'>/=]+)(?:\s*=\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<uq>[^\s"'=<>`]+)))?""",
        RegexOptions.Compiled, RegexTimeout);

    private static readonly Regex CssToken = new(
        """(?<import>@import\s+(?:url\(\s*(?<iq>['"]?)(?<iu>[^'")]*?)\k<iq>\s*\)|(?<iq2>['"])(?<iu2>[^'"]*)\k<iq2>)(?<media>[^;]*);)|(?<url>url\(\s*(?:"(?<ud>[^"]*)"|'(?<us>[^']*)'|(?<uu>[^)'"\s]*))\s*\))""",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);

    private static readonly Regex SchemePrefix = new(
        "^[a-zA-Z][a-zA-Z0-9+.\\-]*:", RegexOptions.Compiled, RegexTimeout);

    private static readonly Regex ClosingStyle = new(
        "</style", RegexOptions.IgnoreCase | RegexOptions.Compiled, RegexTimeout);

    /// <summary>这几种 rel 只是加载提示；目标已经被内嵌在别处，改写它们只会让文件重复变胖。</summary>
    private static readonly HashSet<string> HintRels = new(StringComparer.OrdinalIgnoreCase)
    {
        "preload", "prefetch", "modulepreload", "preconnect", "dns-prefetch",
    };

    /// <summary>哪些标签的哪些属性指向一份要内嵌的资源（iframe / a / form 是导航，不内嵌）。</summary>
    private static readonly Dictionary<string, string[]> AssetAttributes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["img"] = ["src", "srcset"],
        ["source"] = ["src", "srcset"],
        ["video"] = ["src", "poster"],
        ["audio"] = ["src"],
        ["track"] = ["src"],
        ["embed"] = ["src"],
        ["input"] = ["src"],
        ["object"] = ["data"],
        ["image"] = ["href", "xlink:href"],
        ["body"] = ["background"],
        ["table"] = ["background"],
        ["td"] = ["background"],
        ["th"] = ["background"],
    };

    private static readonly Dictionary<string, string> MimeByExtension = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".webp"] = "image/webp",
        [".avif"] = "image/avif",
        [".svg"] = "image/svg+xml",
        [".ico"] = "image/x-icon",
        [".bmp"] = "image/bmp",
        [".woff"] = "font/woff",
        [".woff2"] = "font/woff2",
        [".ttf"] = "font/ttf",
        [".otf"] = "font/otf",
        [".eot"] = "application/vnd.ms-fontobject",
        [".css"] = "text/css",
        [".js"] = "text/javascript",
        [".mjs"] = "text/javascript",
        [".json"] = "application/json",
        [".mp4"] = "video/mp4",
        [".webm"] = "video/webm",
        [".mp3"] = "audio/mpeg",
        [".wav"] = "audio/wav",
        [".ogg"] = "audio/ogg",
        [".vtt"] = "text/vtt",
        [".pdf"] = "application/pdf",
        [".html"] = "text/html",
        [".htm"] = "text/html",
        [".txt"] = "text/plain",
    };

    private readonly Dictionary<string, HostedSiteInlineFile> _exact;
    private readonly Dictionary<string, HostedSiteInlineFile> _ignoreCase;
    private readonly Func<HostedSiteInlineFile, CancellationToken, Task<byte[]?>> _load;
    private readonly long _maxOutputBytes;

    private readonly Dictionary<string, byte[]?> _cache = new(StringComparer.Ordinal);
    private readonly List<HostedSiteInlineMissing> _missing = new();
    private readonly HashSet<string> _missingKeys = new(StringComparer.Ordinal);
    private long _estimatedBytes;
    private int _inlined;

    public HostedSiteHtmlInliner(
        IEnumerable<HostedSiteInlineFile> files,
        Func<HostedSiteInlineFile, CancellationToken, Task<byte[]?>> load,
        long maxOutputBytes = DefaultMaxOutputBytes)
    {
        _exact = new Dictionary<string, HostedSiteInlineFile>(StringComparer.Ordinal);
        _ignoreCase = new Dictionary<string, HostedSiteInlineFile>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            var normalized = NormalizeSitePath(file.Path);
            if (normalized == null) continue;
            var entry = file with { Path = normalized };
            _exact.TryAdd(normalized, entry);
            _ignoreCase.TryAdd(normalized, entry);
        }
        _load = load;
        _maxOutputBytes = maxOutputBytes;
    }

    /// <summary>
    /// 把 <paramref name="reference"/> 相对 <paramref name="baseFilePath"/>（站内文件路径）解析成站内路径。
    /// 查询串与锚点丢弃、百分号编码先解码再规范化（所以 %2e%2e 同样算 ..）、反斜杠当斜杠、
    /// 以 / 开头的按站点根解析；.. 走出根目录判 <see cref="HostedSiteReferenceKind.OutsideSiteRoot"/>。
    /// </summary>
    public static (HostedSiteReferenceKind Kind, string? Path) ResolveReference(string baseFilePath, string? reference)
    {
        var raw = (reference ?? string.Empty).Trim();
        if (raw.Length == 0 || raw[0] == '#') return (HostedSiteReferenceKind.Ignored, null);
        if (raw.StartsWith("//", StringComparison.Ordinal)) return (HostedSiteReferenceKind.External, null);
        if (SchemePrefix.IsMatch(raw))
        {
            var scheme = raw[..raw.IndexOf(':')].ToLowerInvariant();
            return scheme is "http" or "https" or "ftp" or "ws" or "wss"
                ? (HostedSiteReferenceKind.External, null)
                : (HostedSiteReferenceKind.Ignored, null);
        }

        var cut = raw.IndexOfAny(['?', '#']);
        var pathPart = cut >= 0 ? raw[..cut] : raw;
        pathPart = Uri.UnescapeDataString(pathPart).Replace('\\', '/');
        if (pathPart.Length == 0) return (HostedSiteReferenceKind.Ignored, null);

        string combined;
        if (pathPart.StartsWith('/'))
        {
            combined = pathPart;
        }
        else
        {
            var baseNormalized = (baseFilePath ?? string.Empty).Replace('\\', '/');
            var slash = baseNormalized.LastIndexOf('/');
            var baseDir = slash >= 0 ? baseNormalized[..(slash + 1)] : string.Empty;
            combined = baseDir + pathPart;
        }

        var stack = new List<string>();
        foreach (var segment in combined.Split('/'))
        {
            if (segment.Length == 0 || segment == ".") continue;
            if (segment == "..")
            {
                if (stack.Count == 0) return (HostedSiteReferenceKind.OutsideSiteRoot, null);
                stack.RemoveAt(stack.Count - 1);
                continue;
            }
            stack.Add(segment);
        }
        return stack.Count == 0
            ? (HostedSiteReferenceKind.Ignored, null)
            : (HostedSiteReferenceKind.Site, string.Join('/', stack));
    }

    /// <summary>
    /// 入口 HTML 是否用 &lt;meta http-equiv="Content-Security-Policy"&gt; 声明了作者自己的内容安全策略。
    /// 这种策略通常会拦下 data: 地址的脚本 / 样式 / 图片，离线文件打开后会大面积失效；
    /// 而改写或删掉作者的安全策略不是打包该做的决定，所以由调用方据此拒绝导出。
    /// 注释与脚本里的同名字样不算（走同一个标签扫描，跳过注释、脚本与样式块）；仅报告模式的策略不拦截，不算。
    /// </summary>
    public static bool DeclaresContentSecurityPolicy(string html)
    {
        foreach (Match m in HtmlToken.Matches(html ?? string.Empty))
        {
            if (!m.Groups["tag"].Success
                || !string.Equals(m.Groups["name"].Value, "meta", StringComparison.OrdinalIgnoreCase))
                continue;
            var httpEquiv = FindAttribute(m.Groups["attrs"].Value, "http-equiv")?.Value;
            if (string.Equals(httpEquiv?.Trim(), "Content-Security-Policy", StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    public async Task<HostedSiteInlineResult> InlineAsync(string entryPath, string html, CancellationToken ct)
    {
        _estimatedBytes = Encoding.UTF8.GetByteCount(html);
        if (_estimatedBytes > _maxOutputBytes)
            return OverLimit(entryPath);

        string output;
        try
        {
            output = await InlineHtmlAsync(entryPath, html, ct);
        }
        catch (OverLimitException ex)
        {
            return OverLimit(ex.At);
        }

        var bytes = Encoding.UTF8.GetByteCount(output);
        if (bytes > _maxOutputBytes) return OverLimit("整页");

        return new HostedSiteInlineResult
        {
            Html = output,
            OutputBytes = bytes,
            InlinedCount = _inlined,
            Missing = _missing.ToList(),
        };
    }

    private HostedSiteInlineResult OverLimit(string at) => new()
    {
        OverLimitAt = at,
        InlinedCount = _inlined,
        Missing = _missing.ToList(),
    };

    private async Task<string> InlineHtmlAsync(string entryPath, string html, CancellationToken ct)
    {
        var sb = new StringBuilder(html.Length);
        var last = 0;
        foreach (Match m in HtmlToken.Matches(html))
        {
            ct.ThrowIfCancellationRequested();
            sb.Append(html, last, m.Index - last);
            last = m.Index + m.Length;

            if (m.Groups["comment"].Success)
            {
                sb.Append(m.Value);
            }
            else if (m.Groups["script"].Success)
            {
                sb.Append(await InlineScriptAsync(entryPath, m, ct));
            }
            else if (m.Groups["style"].Success)
            {
                var css = await ProcessCssAsync(m.Groups["stbody"].Value, entryPath, 0, new HashSet<string>(StringComparer.Ordinal), ct);
                sb.Append("<style").Append(m.Groups["stattrs"].Value).Append('>')
                    .Append(EscapeClosing(ClosingStyle, css, "<\\/style"))
                    .Append("</style>");
            }
            else
            {
                sb.Append(await InlineTagAsync(entryPath, m, ct));
            }
        }
        sb.Append(html, last, html.Length - last);
        return sb.ToString();
    }

    private async Task<string> InlineScriptAsync(string entryPath, Match m, CancellationToken ct)
    {
        var attrs = m.Groups["sattrs"].Value;
        var rewritten = await RewriteExternalResourceAsync(entryPath, attrs, "src", ExternalResourceKind.Script, ct);
        // 元素、属性、顺序原样保留（defer / async / type=module / integrity 等语义都不动），只换了 src 的值；
        // 带 src 的脚本体本来就不执行，照抄即可。
        return rewritten == null ? m.Value : "<script" + rewritten + ">" + m.Groups["sbody"].Value + "</script>";
    }

    private async Task<string> InlineTagAsync(string entryPath, Match m, CancellationToken ct)
    {
        var name = m.Groups["name"].Value;
        var attrs = m.Groups["attrs"].Value;

        if (string.Equals(name, "link", StringComparison.OrdinalIgnoreCase))
            return await InlineLinkAsync(entryPath, m.Value, attrs, ct);

        var targets = AssetAttributes.TryGetValue(name, out var list) ? list : Array.Empty<string>();
        var parsed = ParseAttributes(attrs);
        var replacements = new Dictionary<int, string>();

        foreach (var attr in parsed)
        {
            if (attr.Value == null) continue;
            var attrName = attr.Name;
            string? rewritten = null;

            if (string.Equals(attrName, "style", StringComparison.OrdinalIgnoreCase))
            {
                var css = await ProcessCssAsync(attr.Value, entryPath, MaxCssImportDepth, new HashSet<string>(StringComparer.Ordinal), ct);
                if (css != attr.Value) rewritten = css;
            }
            else if (targets.Contains(attrName, StringComparer.OrdinalIgnoreCase))
            {
                rewritten = string.Equals(attrName, "srcset", StringComparison.OrdinalIgnoreCase)
                    ? await RewriteSrcSetAsync(entryPath, attr.Value, ct)
                    : await DataUriForAsync(entryPath, attr.Value, ct);
            }

            if (rewritten != null && rewritten != attr.Value)
                replacements[attr.Index] = attr.Name + "=\"" + EscapeAttribute(rewritten) + "\"";
        }

        if (replacements.Count == 0) return m.Value;
        return "<" + name + ReplaceAttributes(attrs, parsed, replacements) + ">";
    }

    private async Task<string> InlineLinkAsync(string entryPath, string original, string attrs, CancellationToken ct)
    {
        var href = FindAttribute(attrs, "href");
        if (href == null) return original;

        var rels = (FindAttribute(attrs, "rel")?.Value ?? string.Empty)
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (rels.Any(HintRels.Contains)) return original;

        if (rels.Contains("stylesheet", StringComparer.OrdinalIgnoreCase))
        {
            // 元素与全部属性原样保留（disabled / id / title / media / alternate 都照旧生效），只换 href 的值。
            var rewritten = await RewriteExternalResourceAsync(entryPath, attrs, "href", ExternalResourceKind.Stylesheet, ct);
            return rewritten == null ? original : "<link" + rewritten + ">";
        }

        // 图标一类：href 直接换成 data: URI
        var dataUri = await DataUriForAsync(entryPath, href.Value.Value, ct);
        if (dataUri == null) return original;
        var parsed = ParseAttributes(attrs);
        var target = parsed.First(a => string.Equals(a.Name, "href", StringComparison.OrdinalIgnoreCase));
        return "<link" + ReplaceAttributes(attrs, parsed, new Dictionary<int, string>
        {
            [target.Index] = target.Name + "=\"" + EscapeAttribute(dataUri) + "\"",
        }) + ">";
    }

    private enum ExternalResourceKind { Script, Stylesheet }

    /// <summary>
    /// 外链脚本与外链样式表的唯一内嵌路径：元素不换、属性不删，只把 src / href 的值换成 data: URL。
    /// 这样 defer / async / module、disabled / id / title / media 以及书写顺序全部按作者的原样生效，
    /// 不必逐个语义去「模拟」（换成内联元素会丢掉它们）。
    ///
    /// 样式表在编码前先把自己的 url() 与 @import 按样式表所在目录解析、内嵌——data: URL 没有可用的
    /// 基准地址，里面留下的任何相对路径离线都解析不到；解析不了的照旧进缺失清单。
    ///
    /// 返回改写后的属性串；引用不在站内 / 读不到时返回 null（调用方保留原样，缺失已登记）。
    /// </summary>
    private async Task<string?> RewriteExternalResourceAsync(
        string basePath, string attrs, string attributeName, ExternalResourceKind kind, CancellationToken ct)
    {
        var parsed = ParseAttributes(attrs);
        var target = parsed.FirstOrDefault(a => a.Value != null
            && string.Equals(a.Name, attributeName, StringComparison.OrdinalIgnoreCase));
        if (target == null) return null;

        var file = await ResolveAndLoadAsync(basePath, target.Value!, isText: true, ct);
        if (file == null) return null;
        // 读入时已按原文字节计入预算；样式表里的子资源会在下面各自计入。最终按 data: URL 的真实长度重算这一项。
        var baseline = _estimatedBytes - file.Value.Bytes.Length;

        byte[] payload;
        string mime;
        var removals = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (kind == ExternalResourceKind.Stylesheet)
        {
            var original = DecodeText(file.Value.Bytes);
            var css = await ProcessCssAsync(original, file.Value.Path, 0,
                new HashSet<string>(StringComparer.Ordinal) { file.Value.Path }, ct);
            payload = Encoding.UTF8.GetBytes(css);
            mime = "text/css;charset=utf-8";
            // 内容被改写（资源已内嵌）后，作者写的完整性摘要对不上新内容，留着浏览器会拒绝加载整张样式表。
            // 只有内容真的变了才去掉它；脚本与未改写的样式表字节不变，摘要照样成立，一律保留。
            if (css != original) removals.Add("integrity");
        }
        else
        {
            payload = file.Value.Bytes;
            mime = "text/javascript";
        }

        // 子资源已经包含在 payload 里，改用「读这个文件之前的预算 + 整个 data: URL」，避免同一份字节算两遍
        _estimatedBytes = baseline + Base64Length(payload.Length);
        if (_estimatedBytes > _maxOutputBytes) throw new OverLimitException(file.Value.Path);

        _inlined++;
        var dataUrl = "data:" + mime + ";base64," + Convert.ToBase64String(payload);
        var replacements = new Dictionary<int, string>
        {
            [target.Index] = target.Name + "=\"" + EscapeAttribute(dataUrl) + "\"",
        };
        foreach (var attr in parsed.Where(a => removals.Contains(a.Name)))
            replacements[attr.Index] = string.Empty;
        return ReplaceAttributes(attrs, parsed, replacements);
    }

    /// <summary>
    /// CSS 里的 @import 与 url() 一次从左到右扫完：@import 的内容先按它自己的路径处理好再原位嵌入，
    /// 所以里面的相对 url() 认的是被导入文件的目录，而不是外层文件的目录。
    /// depth ≥ 上限（行内 style 属性直接传上限）时 @import 不再展开。
    /// </summary>
    private async Task<string> ProcessCssAsync(
        string css, string cssFilePath, int depth, HashSet<string> importChain, CancellationToken ct)
    {
        var matches = CssToken.Matches(css);
        if (matches.Count == 0) return css;

        var sb = new StringBuilder(css.Length);
        var last = 0;
        foreach (Match m in matches)
        {
            ct.ThrowIfCancellationRequested();
            sb.Append(css, last, m.Index - last);
            last = m.Index + m.Length;

            if (m.Groups["import"].Success)
            {
                sb.Append(await InlineImportAsync(m, cssFilePath, depth, importChain, ct));
                continue;
            }

            var reference = m.Groups["ud"].Success ? m.Groups["ud"].Value
                : m.Groups["us"].Success ? m.Groups["us"].Value
                : m.Groups["uu"].Value;
            var dataUri = await DataUriForAsync(cssFilePath, reference, ct);
            sb.Append(dataUri == null ? m.Value : "url(" + dataUri + ")");
        }
        sb.Append(css, last, css.Length - last);
        return sb.ToString();
    }

    private async Task<string> InlineImportAsync(
        Match m, string cssFilePath, int depth, HashSet<string> importChain, CancellationToken ct)
    {
        var reference = m.Groups["iu"].Success && m.Groups["iu"].Length > 0 ? m.Groups["iu"].Value : m.Groups["iu2"].Value;
        var media = m.Groups["media"].Value.Trim();

        // layer()/supports() 包不进 @media，展开会改变语义；深度或环路超限同理——保持原样。
        if (depth >= MaxCssImportDepth
            || media.Contains("layer(", StringComparison.OrdinalIgnoreCase)
            || media.Contains("supports(", StringComparison.OrdinalIgnoreCase))
            return m.Value;

        var (kind, path) = ResolveReference(cssFilePath, reference);
        if (kind == HostedSiteReferenceKind.OutsideSiteRoot)
        {
            RecordMissing(reference, HostedSiteInlineMissingReason.OutsideSiteRoot);
            return m.Value;
        }
        if (kind != HostedSiteReferenceKind.Site) return m.Value;
        if (importChain.Contains(ToCanonical(path!))) return m.Value;

        var file = await LoadAsync(reference, path!, isText: true, ct);
        if (file == null) return m.Value;

        var chain = new HashSet<string>(importChain, StringComparer.Ordinal) { file.Value.Path };
        var inner = await ProcessCssAsync(DecodeText(file.Value.Bytes), file.Value.Path, depth + 1, chain, ct);
        _inlined++;
        return media.Length == 0 ? inner : "@media " + media + "{" + inner + "}";
    }

    private async Task<string?> RewriteSrcSetAsync(string basePath, string srcset, CancellationToken ct)
    {
        var candidates = ParseSrcSet(srcset);
        if (candidates.Count == 0) return null;
        var changed = false;
        var parts = new List<string>(candidates.Count);
        foreach (var (url, descriptor) in candidates)
        {
            var dataUri = await DataUriForAsync(basePath, url, ct);
            if (dataUri != null) changed = true;
            var chosen = dataUri ?? url;
            parts.Add(descriptor.Length == 0 ? chosen : chosen + " " + descriptor);
        }
        return changed ? string.Join(", ", parts) : null;
    }

    /// <summary>按 HTML 规范切 srcset：URL 是一段非空白字符，其后的描述符到逗号为止（data: URI 里的逗号不会被切开）。</summary>
    internal static List<(string Url, string Descriptor)> ParseSrcSet(string srcset)
    {
        var result = new List<(string, string)>();
        var i = 0;
        while (i < srcset.Length)
        {
            while (i < srcset.Length && (char.IsWhiteSpace(srcset[i]) || srcset[i] == ',')) i++;
            if (i >= srcset.Length) break;
            var start = i;
            while (i < srcset.Length && !char.IsWhiteSpace(srcset[i])) i++;
            var url = srcset[start..i];
            var descriptor = string.Empty;
            if (url.EndsWith(','))
            {
                url = url.TrimEnd(',');
            }
            else
            {
                var dStart = i;
                while (i < srcset.Length && srcset[i] != ',') i++;
                descriptor = srcset[dStart..i].Trim();
            }
            if (url.Length > 0) result.Add((url, descriptor));
        }
        return result;
    }

    private async Task<string?> DataUriForAsync(string basePath, string reference, CancellationToken ct)
    {
        var file = await ResolveAndLoadAsync(basePath, reference, isText: false, ct);
        if (file == null) return null;
        _inlined++;
        return "data:" + file.Value.Mime + ";base64," + Convert.ToBase64String(file.Value.Bytes);
    }

    private async Task<LoadedFile?> ResolveAndLoadAsync(string basePath, string reference, bool isText, CancellationToken ct)
    {
        var (kind, path) = ResolveReference(basePath, reference);
        if (kind == HostedSiteReferenceKind.OutsideSiteRoot)
        {
            RecordMissing(reference, HostedSiteInlineMissingReason.OutsideSiteRoot);
            return null;
        }
        if (kind != HostedSiteReferenceKind.Site) return null;
        return await LoadAsync(reference, path!, isText, ct);
    }

    private async Task<LoadedFile?> LoadAsync(string reference, string path, bool isText, CancellationToken ct)
    {
        if (!_exact.TryGetValue(path, out var file) && !_ignoreCase.TryGetValue(path, out file))
        {
            RecordMissing(path, HostedSiteInlineMissingReason.NotInSite);
            return null;
        }

        // 读之前先按清单登记的大小预判：一份 400MB 的视频不该先整份读进内存才发现装不下。
        var projected = _estimatedBytes + (isText ? file.Size : Base64Length(file.Size));
        if (file.Size > 0 && projected > _maxOutputBytes) throw new OverLimitException(file.Path);

        if (!_cache.TryGetValue(file.Path, out var bytes))
        {
            bytes = await _load(file, ct);
            _cache[file.Path] = bytes;
        }
        if (bytes == null)
        {
            RecordMissing(file.Path, HostedSiteInlineMissingReason.ReadFailed);
            return null;
        }

        _estimatedBytes += isText ? bytes.Length : Base64Length(bytes.Length);
        if (_estimatedBytes > _maxOutputBytes) throw new OverLimitException(file.Path);

        return new LoadedFile(file.Path, bytes, ResolveMime(file));
    }

    private void RecordMissing(string reference, HostedSiteInlineMissingReason reason)
    {
        var key = reason + "|" + reference;
        if (_missingKeys.Add(key)) _missing.Add(new HostedSiteInlineMissing(reference, reason));
    }

    private string ToCanonical(string path) =>
        _exact.TryGetValue(path, out var f) || _ignoreCase.TryGetValue(path, out f) ? f.Path : path;

    private static string? NormalizeSitePath(string? path)
    {
        var (kind, resolved) = ResolveReference(string.Empty, "/" + (path ?? string.Empty).TrimStart('/'));
        return kind == HostedSiteReferenceKind.Site ? resolved : null;
    }

    private static long Base64Length(long bytes) => (bytes + 2) / 3 * 4 + 64;

    private static string ResolveMime(HostedSiteInlineFile file)
    {
        var declared = (file.MimeType ?? string.Empty).Split(';')[0].Trim();
        if (declared.Length > 0 && !string.Equals(declared, "application/octet-stream", StringComparison.OrdinalIgnoreCase))
            return declared;
        return MimeByExtension.TryGetValue(System.IO.Path.GetExtension(file.Path), out var mime)
            ? mime
            : "application/octet-stream";
    }

    private static string DecodeText(byte[] bytes) =>
        bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF
            ? Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3)
            : Encoding.UTF8.GetString(bytes);

    private static string EscapeClosing(Regex closing, string text, string replacement) =>
        closing.Replace(text, _ => replacement);

    private static string EscapeAttribute(string value) =>
        value.Replace("&", "&amp;", StringComparison.Ordinal).Replace("\"", "&quot;", StringComparison.Ordinal);

    private sealed record ParsedAttribute(int Index, int Length, string Name, string? Value);

    private static List<ParsedAttribute> ParseAttributes(string attrs)
    {
        var list = new List<ParsedAttribute>();
        foreach (Match a in Attribute.Matches(attrs))
        {
            string? value = a.Groups["dq"].Success ? a.Groups["dq"].Value
                : a.Groups["sq"].Success ? a.Groups["sq"].Value
                : a.Groups["uq"].Success ? a.Groups["uq"].Value
                : null;
            list.Add(new ParsedAttribute(a.Index, a.Length, a.Groups["name"].Value,
                value == null ? null : WebUtility.HtmlDecode(value)));
        }
        return list;
    }

    private static (string Name, string Value)? FindAttribute(string attrs, string name)
    {
        foreach (var attr in ParseAttributes(attrs))
        {
            if (attr.Value != null && string.Equals(attr.Name, name, StringComparison.OrdinalIgnoreCase))
                return (attr.Name, attr.Value);
        }
        return null;
    }

    private static string ReplaceAttributes(string attrs, List<ParsedAttribute> parsed, Dictionary<int, string> replacements)
    {
        var sb = new StringBuilder(attrs.Length);
        var last = 0;
        foreach (var attr in parsed)
        {
            if (!replacements.TryGetValue(attr.Index, out var replacement)) continue;
            sb.Append(attrs, last, attr.Index - last);
            // 删除属性时连同它前面的空白一起删，避免留下一串空格
            if (replacement.Length == 0)
                while (sb.Length > 0 && char.IsWhiteSpace(sb[^1])) sb.Length--;
            sb.Append(replacement);
            last = attr.Index + attr.Length;
        }
        sb.Append(attrs, last, attrs.Length - last);
        return sb.ToString();
    }

    private readonly record struct LoadedFile(string Path, byte[] Bytes, string Mime);

    private sealed class OverLimitException(string at) : Exception
    {
        public string At { get; } = at;
    }
}
