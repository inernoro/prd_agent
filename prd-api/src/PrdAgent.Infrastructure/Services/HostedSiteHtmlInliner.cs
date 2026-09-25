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

    /// <summary>
    /// 留在原处、离线时仍要联网才能加载的外部地址（http(s) 与协议相对 //；按完整地址去重）。
    /// 页面自己写的绝对地址、以及 base 指向站外时的相对引用都算。data: 与纯锚点不算。
    /// </summary>
    public IReadOnlyList<string> External { get; init; } = Array.Empty<string>();

    /// <summary>非空 = 超过体积上限，没有产出。值是压线时正在处理的那个文件（或「整页」）。</summary>
    public string? OverLimitAt { get; init; }

    public bool Succeeded => OverLimitAt == null;
}

/// <summary>
/// 把托管站点的入口 HTML 打成一份自包含的离线 HTML：
/// 站内相对引用的样式表、脚本、图片、字体、CSS url() 一律换成自带内容的 data: URL（元素与其余属性原样保留），
/// 外部绝对地址原样保留并计入「仍依赖外部网络」清单。
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

    /// <summary>
    /// 浏览器会真的去取回文件的 rel——白名单，不是黑名单。canonical / alternate / author /
    /// next / prev 这类是元数据或导航，渲染时不加载；preconnect / dns-prefetch 指向主机。
    /// 它们一律不内嵌、不算缺失、也不计入外部依赖。
    /// </summary>
    private static readonly HashSet<string> ResourceRels = new(StringComparer.OrdinalIgnoreCase)
    {
        "stylesheet", "icon", "apple-touch-icon", "apple-touch-icon-precomposed", "mask-icon",
        "manifest", "preload", "modulepreload", "prefetch",
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
    private readonly List<string> _external = new();
    private readonly HashSet<string> _externalKeys = new(StringComparer.Ordinal);
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
            External = _external.ToList(),
        };
    }

    private HostedSiteInlineResult OverLimit(string at) => new()
    {
        OverLimitAt = at,
        InlinedCount = _inlined,
        Missing = _missing.ToList(),
        External = _external.ToList(),
    };

    /// <summary>
    /// 相对引用按谁解析。站内文件（入口、样式表）给 SitePath；
    /// 文档里的第一个 &lt;base href&gt; 指向站外时给 External（相对引用全部当外部地址计数、原样保留）；
    /// 指向站点根之外时 OutsideRoot（相对引用一律不读，记为越界）。
    /// </summary>
    private sealed record ReferenceBase(string SitePath, Uri? External = null, bool OutsideRoot = false)
    {
        public static ReferenceBase ForFile(string path) => new(path);
    }

    /// <summary>
    /// 算出文档级引用的解析基准：取文档里第一个带 href 的 &lt;base&gt;（与浏览器一致，后面的不算）。
    /// 没有就是入口文件本身。base 本身也按入口所在目录解析，且必须落在站点根之内。
    ///
    /// 输出里 &lt;base&gt; 原样保留：凡是被改写的引用都换成了自带内容的 data: URL，不受 base 影响；
    /// 没能内嵌的引用与页内链接则继续按作者写的 base 解析，与线上行为一致。
    /// </summary>
    private static ReferenceBase ResolveDocumentBase(string entryPath, string html)
    {
        foreach (Match m in HtmlToken.Matches(html))
        {
            if (!m.Groups["tag"].Success
                || !string.Equals(m.Groups["name"].Value, "base", StringComparison.OrdinalIgnoreCase))
                continue;
            var href = FindAttribute(m.Groups["attrs"].Value, "href")?.Value;
            if (href == null) continue;

            var raw = href.Trim();
            var (kind, _) = ResolveReference(entryPath, raw);
            if (kind == HostedSiteReferenceKind.External)
            {
                var absolute = raw.StartsWith("//", StringComparison.Ordinal) ? "https:" + raw : raw;
                return Uri.TryCreate(absolute, UriKind.Absolute, out var external)
                    ? new ReferenceBase(entryPath, External: external)
                    : ReferenceBase.ForFile(entryPath);
            }

            var cut = raw.IndexOfAny(['?', '#']);
            var pathPart = (cut >= 0 ? raw[..cut] : raw).Replace('\\', '/');
            if (pathPart.Length == 0) return ReferenceBase.ForFile(entryPath);

            // 以 / 结尾的 base 指的是一个目录：借一个占位文件名让「取所在目录」的规则照常成立
            var probe = pathPart.EndsWith('/') ? pathPart + "__base__" : pathPart;
            var (baseKind, basePath) = ResolveReference(entryPath, probe);
            return baseKind switch
            {
                HostedSiteReferenceKind.Site => ReferenceBase.ForFile(basePath!),
                HostedSiteReferenceKind.OutsideSiteRoot => new ReferenceBase(entryPath, OutsideRoot: true),
                _ => ReferenceBase.ForFile(entryPath),
            };
        }
        return ReferenceBase.ForFile(entryPath);
    }

    private async Task<string> InlineHtmlAsync(string entryPath, string html, CancellationToken ct)
    {
        var docBase = ResolveDocumentBase(entryPath, html);
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
                var attrs = m.Groups["sattrs"].Value;
                var rewritten = await RewriteReferenceAttributeAsync(docBase, attrs, "src", PayloadKind.Script, ct);
                // 元素、属性、顺序原样保留（defer / async / type=module / integrity 等语义都不动），只换了 src 的值；
                // 带 src 的脚本体本来就不执行，照抄即可。
                sb.Append(rewritten == null ? m.Value : "<script" + rewritten + ">" + m.Groups["sbody"].Value + "</script>");
            }
            else if (m.Groups["style"].Success)
            {
                var css = await ProcessCssAsync(m.Groups["stbody"].Value, docBase, 0, new HashSet<string>(StringComparer.Ordinal), ct);
                sb.Append("<style").Append(m.Groups["stattrs"].Value).Append('>')
                    .Append(EscapeClosing(ClosingStyle, css, "<\\/style"))
                    .Append("</style>");
            }
            else
            {
                sb.Append(await InlineTagAsync(docBase, m, ct));
            }
        }
        sb.Append(html, last, html.Length - last);
        return sb.ToString();
    }

    private async Task<string> InlineTagAsync(ReferenceBase docBase, Match m, CancellationToken ct)
    {
        var name = m.Groups["name"].Value;
        var attrs = m.Groups["attrs"].Value;

        if (string.Equals(name, "link", StringComparison.OrdinalIgnoreCase))
        {
            var kind = LinkPayloadKind(attrs);
            if (kind == null) return m.Value;
            var rewritten = await RewriteReferenceAttributeAsync(docBase, attrs, "href", kind.Value, ct);
            return rewritten == null ? m.Value : "<link" + rewritten + ">";
        }

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
                var css = await ProcessCssAsync(attr.Value, docBase, MaxCssImportDepth, new HashSet<string>(StringComparer.Ordinal), ct);
                if (css != attr.Value) rewritten = css;
            }
            else if (targets.Contains(attrName, StringComparer.OrdinalIgnoreCase))
            {
                rewritten = string.Equals(attrName, "srcset", StringComparison.OrdinalIgnoreCase)
                    ? await RewriteSrcSetAsync(docBase, attr.Value, ct)
                    : (await BuildDataUrlAsync(docBase, attr.Value, PayloadKind.Binary, ct))?.DataUrl;
            }

            if (rewritten != null && rewritten != attr.Value)
                replacements[attr.Index] = attr.Name + "=\"" + EscapeAttribute(rewritten) + "\"";
        }

        if (replacements.Count == 0) return m.Value;
        return "<" + name + ReplaceAttributes(attrs, parsed, replacements) + ">";
    }

    /// <summary>
    /// &lt;link&gt; 指向的东西按什么内容打包——所有 link 的唯一判定：
    /// 样式表、as=style 的预加载 → 样式表（要先内嵌里面的 url() / @import）；
    /// modulepreload、as=script 的预加载 → 脚本；其余（图标、字体预加载、prefetch 等）→ 原字节。
    /// rel 不在 <see cref="ResourceRels"/> 里的（元数据、导航、preconnect 等）不动。
    /// </summary>
    private static PayloadKind? LinkPayloadKind(string attrs)
    {
        var rels = (FindAttribute(attrs, "rel")?.Value ?? string.Empty)
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (!rels.Any(ResourceRels.Contains)) return null;

        var asValue = (FindAttribute(attrs, "as")?.Value ?? string.Empty).Trim();
        if (rels.Contains("stylesheet", StringComparer.OrdinalIgnoreCase)
            || string.Equals(asValue, "style", StringComparison.OrdinalIgnoreCase))
            return PayloadKind.Stylesheet;
        if (rels.Contains("modulepreload", StringComparer.OrdinalIgnoreCase)
            || string.Equals(asValue, "script", StringComparison.OrdinalIgnoreCase))
            return PayloadKind.Script;
        return PayloadKind.Binary;
    }

    private enum PayloadKind { Script, Stylesheet, Binary }

    private sealed record BuiltDataUrl(string DataUrl, bool ContentChanged);

    /// <summary>
    /// 属性里的引用 → data: URL 的唯一改写路径（脚本 src、link href 共用）：元素不换、属性不删，
    /// 只把引用那个属性的值换掉。defer / async / module、disabled / id / title / media / onload
    /// 以及书写顺序全部按作者原样生效。内容被改写（样式表内嵌了子资源）时去掉 integrity——
    /// 摘要对不上新内容，留着浏览器会拒绝加载；字节没变的一律保留。
    /// 返回改写后的属性串；引用不在站内 / 读不到时返回 null（调用方保留原样，缺失已登记）。
    /// </summary>
    private async Task<string?> RewriteReferenceAttributeAsync(
        ReferenceBase basis, string attrs, string attributeName, PayloadKind kind, CancellationToken ct)
    {
        var parsed = ParseAttributes(attrs);
        var target = parsed.FirstOrDefault(a => a.Value != null
            && string.Equals(a.Name, attributeName, StringComparison.OrdinalIgnoreCase));
        if (target == null) return null;

        var built = await BuildDataUrlAsync(basis, target.Value!, kind, ct);
        if (built == null) return null;

        var replacements = new Dictionary<int, string>
        {
            [target.Index] = target.Name + "=\"" + EscapeAttribute(built.DataUrl) + "\"",
        };
        if (built.ContentChanged)
        {
            foreach (var attr in parsed.Where(a => string.Equals(a.Name, "integrity", StringComparison.OrdinalIgnoreCase)))
                replacements[attr.Index] = string.Empty;
        }
        return ReplaceAttributes(attrs, parsed, replacements);
    }

    /// <summary>
    /// 一个引用 → 自带内容的 data: URL。所有内嵌（元素属性、srcset、CSS url()、link）都经这里：
    /// 样式表在编码前先把自己的 url() 与 @import 按样式表所在目录内嵌（data: URL 没有可用的基准地址，
    /// 留下的相对路径离线都解析不到）；引用里的 #片段（SVG 符号、媒体片段）原样接回 data: URL 末尾。
    /// </summary>
    private async Task<BuiltDataUrl?> BuildDataUrlAsync(
        ReferenceBase basis, string reference, PayloadKind kind, CancellationToken ct)
    {
        // 协议相对地址（//cdn…）留在原处会被本地文件按 file:// 解析，联网也加载不到：补成 https:。
        // 内容没变，所以不算内嵌、也不去掉 integrity；外部依赖照常登记。
        if (ExplicitHttps(reference) is { } absolute)
        {
            Classify(basis, reference);
            return new BuiltDataUrl(absolute, ContentChanged: false);
        }
        var file = await ResolveAndLoadAsync(basis, reference, isText: kind != PayloadKind.Binary, ct);
        if (file == null) return null;
        // 读入时已按原文字节计入预算；样式表里的子资源会在下面各自计入。最终按 data: URL 的真实长度重算这一项。
        var baseline = _estimatedBytes - (kind == PayloadKind.Binary
            ? Base64Length(file.Value.Bytes.Length)
            : file.Value.Bytes.Length);

        byte[] payload = file.Value.Bytes;
        string mime;
        var changed = false;
        switch (kind)
        {
            case PayloadKind.Stylesheet:
                var original = DecodeText(file.Value.Bytes);
                var css = await ProcessCssAsync(original, ReferenceBase.ForFile(file.Value.Path), 0,
                    new HashSet<string>(StringComparer.Ordinal) { file.Value.Path }, ct);
                payload = Encoding.UTF8.GetBytes(css);
                mime = "text/css;charset=utf-8";
                changed = css != original;
                break;
            case PayloadKind.Script:
                mime = "text/javascript";
                break;
            default:
                mime = file.Value.Mime;
                break;
        }

        // 子资源已经包含在 payload 里，改用「读这个文件之前的预算 + 整个 data: URL」，避免同一份字节算两遍
        _estimatedBytes = baseline + Base64Length(payload.Length);
        if (_estimatedBytes > _maxOutputBytes) throw new OverLimitException(file.Value.Path);

        _inlined++;
        return new BuiltDataUrl(
            "data:" + mime + ";base64," + Convert.ToBase64String(payload) + FragmentOf(reference),
            changed);
    }

    /// <summary>协议相对地址（// 开头）补成 https:；其余返回 null。</summary>
    internal static string? ExplicitHttps(string reference)
    {
        var raw = reference.Trim();
        return raw.StartsWith("//", StringComparison.Ordinal) && raw.Length > 2 ? "https:" + raw : null;
    }

    /// <summary>引用里第一个 # 起的片段（含 #）；纯锚点与没有片段的给空串。</summary>
    internal static string FragmentOf(string reference)
    {
        var raw = reference.Trim();
        var hash = raw.IndexOf('#');
        return hash > 0 && hash < raw.Length - 1 ? raw[hash..] : string.Empty;
    }

    /// <summary>
    /// CSS 里的 @import 与 url() 一次从左到右扫完：@import 的内容先按它自己的路径处理好再原位嵌入，
    /// 所以里面的相对 url() 认的是被导入文件的目录，而不是外层文件的目录。
    /// depth ≥ 上限（行内 style 属性直接传上限）时 @import 不再展开。
    /// </summary>
    private async Task<string> ProcessCssAsync(
        string css, ReferenceBase basis, int depth, HashSet<string> importChain, CancellationToken ct)
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
                sb.Append(await InlineImportAsync(m, basis, depth, importChain, ct));
                continue;
            }

            var reference = m.Groups["ud"].Success ? m.Groups["ud"].Value
                : m.Groups["us"].Success ? m.Groups["us"].Value
                : m.Groups["uu"].Value;
            var built = await BuildDataUrlAsync(basis, reference, PayloadKind.Binary, ct);
            sb.Append(built == null ? m.Value : "url(" + built.DataUrl + ")");
        }
        sb.Append(css, last, css.Length - last);
        return sb.ToString();
    }

    private async Task<string> InlineImportAsync(
        Match m, ReferenceBase basis, int depth, HashSet<string> importChain, CancellationToken ct)
    {
        var reference = m.Groups["iu"].Success && m.Groups["iu"].Length > 0 ? m.Groups["iu"].Value : m.Groups["iu2"].Value;
        var media = m.Groups["media"].Value.Trim();

        // 协议相对的外部导入：离线文件里会被按 file:// 解析，补成 https: 后原样保留修饰。
        if (ExplicitHttps(reference) is { } absolute)
        {
            Classify(basis, reference);
            return m.Value.Replace(reference, absolute, StringComparison.Ordinal);
        }

        // layer()/supports() 包不进 @media，展开会改变语义；深度或环路超限同理——保持原样。
        if (depth >= MaxCssImportDepth
            || media.Contains("layer(", StringComparison.OrdinalIgnoreCase)
            || media.Contains("supports(", StringComparison.OrdinalIgnoreCase))
            return m.Value;

        var (kind, path) = Classify(basis, reference);
        if (kind != HostedSiteReferenceKind.Site) return m.Value;
        if (importChain.Contains(ToCanonical(path!))) return m.Value;

        var file = await LoadAsync(reference, path!, isText: true, ct);
        if (file == null) return m.Value;

        var chain = new HashSet<string>(importChain, StringComparer.Ordinal) { file.Value.Path };
        var inner = await ProcessCssAsync(DecodeText(file.Value.Bytes), ReferenceBase.ForFile(file.Value.Path), depth + 1, chain, ct);
        _inlined++;
        return media.Length == 0 ? inner : "@media " + media + "{" + inner + "}";
    }

    private async Task<string?> RewriteSrcSetAsync(ReferenceBase basis, string srcset, CancellationToken ct)
    {
        var candidates = ParseSrcSet(srcset);
        if (candidates.Count == 0) return null;
        var changed = false;
        var parts = new List<string>(candidates.Count);
        foreach (var (url, descriptor) in candidates)
        {
            var built = await BuildDataUrlAsync(basis, url, PayloadKind.Binary, ct);
            if (built != null) changed = true;
            var chosen = built?.DataUrl ?? url;
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

    /// <summary>
    /// 按解析基准给一个引用归类，并把「留在原处的外部地址」「越出站点根」登记下来——
    /// 所有内嵌路径都经这一处归类，外部计数与越界上报不会有第二个口径。
    /// </summary>
    private (HostedSiteReferenceKind Kind, string? Path) Classify(ReferenceBase basis, string reference)
    {
        var (kind, path) = ResolveReference(basis.SitePath, reference);
        switch (kind)
        {
            case HostedSiteReferenceKind.Ignored:
                return (kind, null);
            case HostedSiteReferenceKind.External:
                RecordExternal(reference.Trim());
                return (kind, null);
        }

        var raw = reference.Trim().Replace('\\', '/');
        if (basis.External != null)
        {
            // base 指向站外：相对引用（含 / 开头）都相对那个站外地址，留在原处并计入外部依赖
            if (Uri.TryCreate(basis.External, raw, out var absolute)) RecordExternal(absolute.ToString());
            return (HostedSiteReferenceKind.External, null);
        }
        if (basis.OutsideRoot && !raw.StartsWith('/'))
        {
            RecordMissing(reference, HostedSiteInlineMissingReason.OutsideSiteRoot);
            return (HostedSiteReferenceKind.OutsideSiteRoot, null);
        }
        if (kind == HostedSiteReferenceKind.OutsideSiteRoot)
            RecordMissing(reference, HostedSiteInlineMissingReason.OutsideSiteRoot);
        return (kind, path);
    }

    private async Task<LoadedFile?> ResolveAndLoadAsync(ReferenceBase basis, string reference, bool isText, CancellationToken ct)
    {
        var (kind, path) = Classify(basis, reference);
        if (kind != HostedSiteReferenceKind.Site) return null;
        return await LoadAsync(reference, path!, isText, ct);
    }

    /// <summary>只记 http(s) 与协议相对（//）的地址；按完整地址去重。</summary>
    private void RecordExternal(string url)
    {
        var lowered = url.ToLowerInvariant();
        if (!lowered.StartsWith("//", StringComparison.Ordinal)
            && !lowered.StartsWith("http://", StringComparison.Ordinal)
            && !lowered.StartsWith("https://", StringComparison.Ordinal))
            return;
        if (_externalKeys.Add(url)) _external.Add(url);
    }

    /// <summary>外部地址的主机名（协议相对的按 https 解析）；解析不了给 null。</summary>
    public static string? HostOf(string url)
    {
        var absolute = url.StartsWith("//", StringComparison.Ordinal) ? "https:" + url : url;
        return Uri.TryCreate(absolute, UriKind.Absolute, out var uri) && !string.IsNullOrEmpty(uri.Host)
            ? uri.Host
            : null;
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
