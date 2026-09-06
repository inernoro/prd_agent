using System.Collections.Concurrent;
using System.Text.Json;

namespace PrdAgent.Api.Services.MdToPpt;

/// <summary>
/// 锚定 deck 模板提供器（2026-06-12 质量目标：治"自由排版互相重叠"的架构解）。
///
/// 来源：open-design（MIT）vendored 的 zhangzara 成品 deck（scripts/extract-ppt-anchors.py 提取，
/// 资产在 Resources/mdppt/anchors/&lt;name&gt;/）。每套 = 人工调校的完整 deck：
/// prefix（head + 设计系统 CSS + 容器开头）+ 每个版式一份示例 slide 源码 + suffix（自带导航运行时）。
///
/// 工作流照搬 open-design：子智能体拿到"本页版式的真实范本源码"，只换内容不造布局——
/// 模型从不自由发挥排版，所以从不塌。
/// </summary>
public static class MdToPptAnchors
{
    internal const string MobilePresentationGuardId = "mdppt-mobile-presentation-guard";

    private const string MobilePresentationGuard = """
<style id="mdppt-mobile-presentation-guard">
@media (max-width: 640px) {
  html, body { width:100%; height:100%; overflow:hidden; }
  .slide {
    padding:48px 22px 112px !important;
    justify-content:flex-start !important;
    align-items:stretch !important;
    box-sizing:border-box !important;
    width:100vw !important;
    min-width:100vw !important;
    height:100vh !important;
    min-height:100vh !important;
    max-height:none !important;
    overflow-x:auto !important;
    overflow-y:auto !important;
    overscroll-behavior:contain;
  }
  .slide *, .slide *::before, .slide *::after { box-sizing:border-box !important; min-width:0 !important; max-width:100% !important; }
  .slide img, .slide svg, .slide canvas, .slide video { height:auto !important; object-fit:contain !important; }
  .slide pre, .slide table { display:block; width:100% !important; overflow-x:auto !important; }
  .slide h1, .slide [class*="-h1"] {
    font-size:clamp(32px, 9.5vw, 44px) !important;
    line-height:1.08 !important;
    letter-spacing:-.025em !important;
    overflow-wrap:break-word !important;
    word-break:normal !important;
  }
  .slide h2, .slide [class*="-h2"] {
    font-size:clamp(28px, 8vw, 38px) !important;
    line-height:1.14 !important;
    overflow-wrap:break-word !important;
    word-break:normal !important;
  }
  .slide h3, .slide [class*="-h3"] { font-size:clamp(20px, 6vw, 28px) !important; }
  .slide p, .slide li, .slide [class*="lede"], .slide [class*="desc"] {
    font-size:clamp(14px, 4.1vw, 18px) !important;
    line-height:1.55 !important;
    white-space:normal !important;
    overflow-wrap:anywhere !important;
  }
  .slide [class*="grid"], .slide [class*="columns"], .slide [class*="split"],
  .slide [style*="grid-template-columns"] { grid-template-columns:minmax(0, 1fr) !important; }
  .slide [class*="row"] { flex-wrap:wrap !important; }
  .slide [class*="big"], .slide [class*="display"], .slide [class*="hero-title"] {
    font-size:clamp(32px, 12vw, 52px) !important;
    overflow-wrap:anywhere !important;
  }
  .slide-4 .slide-header { flex-wrap:wrap !important; gap:12px !important; }
  .slide-4 .chart-container { width:100% !important; gap:16px !important; }
  .slide--chart .bar-track { gap:8px !important; padding-left:0 !important; }
  .slide-rsvp .hand-line { font-size:0 !important; overflow:hidden !important; }
  .deck-header, .deck-footer { left:18px !important; right:18px !important; font-size:9px !important; }
  .deck-footer { bottom:68px !important; }
  .overview.open { grid-template-columns:1fr !important; padding:20px !important; }
}
</style>
""";

    // soft-editorial 使用 OpenDesign 的固定画布 deck-stage 运行时自适应缩放。
    // 若套用通用移动端重排规则，会把 1920x1080 画布强行改成 390px 宽并破坏版式语义。
    private const string SoftEditorialMobilePresentationGuard = """
<style id="mdppt-mobile-presentation-guard">
@media (max-width: 640px) {
  html, body { width:100%; height:100%; margin:0; overflow:hidden; }
  deck-stage { position:fixed; inset:0; display:block; }
}
</style>
""";

    public sealed record AnchorSlide(string File, string Layout, string ClassAttr, string Summary, string Html);

    public sealed record Anchor(string Name, string Prefix, string Suffix, IReadOnlyList<AnchorSlide> Slides)
    {
        public AnchorSlide Cover => Slides[0];
        public AnchorSlide Closing => Slides[^1];
        public IReadOnlyList<AnchorSlide> ContentSlides => Slides.Skip(1).Take(Slides.Count - 2).ToList();
    }

    private static readonly ConcurrentDictionary<string, Anchor?> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>官方主题 → 锚定模板映射（暂未独立锚定的主题就近归并；打磨循环里可扩锚）</summary>
    private static readonly Dictionary<string, string> ThemeToAnchor = new(StringComparer.OrdinalIgnoreCase)
    {
        ["cobalt-grid"] = "cobalt-grid",
        ["warm-zine"] = "retro-zine",
        ["atelier-zero"] = "coral",
        ["swiss-minimal"] = "monochrome",
        ["forest-organic"] = "grove",
        ["sunset-bold"] = "bold-poster",
        ["editorial-ink"] = "soft-editorial",
        ["kami-paper"] = "vellum",
        ["tech-dark"] = "cyber-terminal",
        ["aurora-gradient"] = "dark-graph",
        ["royal-velvet"] = "vellum",
        ["ocean-glass"] = "soft-editorial",
    };

    public static Anchor? Resolve(string? theme)
    {
        var key = (theme ?? "tech-dark").Trim().ToLowerInvariant();
        var anchorName = ThemeToAnchor.GetValueOrDefault(key, "cobalt-grid");
        return Load(anchorName);
    }

    public static Anchor? Load(string anchorName)
    {
        return Cache.GetOrAdd(anchorName, name =>
        {
            try
            {
                var root = Path.Combine(AppContext.BaseDirectory, "Resources", "mdppt", "anchors", name);
                if (!Directory.Exists(root)) return null;
                var prefix = File.ReadAllText(Path.Combine(root, "prefix.html"));
                if (name.Equals("soft-editorial", StringComparison.OrdinalIgnoreCase))
                {
                    prefix = EnsureEmbeddedRuntime(prefix);
                    if (HasUnresolvedRuntimeReference(prefix)) return null;
                }
                var suffix = File.ReadAllText(Path.Combine(root, "suffix.html"));
                using var meta = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "meta.json")));
                var slides = new List<AnchorSlide>();
                foreach (var l in meta.RootElement.GetProperty("layouts").EnumerateArray())
                {
                    var file = l.GetProperty("file").GetString()!;
                    slides.Add(new AnchorSlide(
                        file,
                        l.GetProperty("layout").GetString() ?? file,
                        l.GetProperty("classAttr").GetString() ?? "slide",
                        l.TryGetProperty("summary", out var sm) ? sm.GetString() ?? "" : "",
                        File.ReadAllText(Path.Combine(root, "slides", file))));
                }
                return slides.Count >= 3 ? new Anchor(name, prefix, suffix, slides) : null;
            }
            catch
            {
                return null;
            }
        });
    }

    /// <summary>
    /// 把历史 soft-editorial 产物的精确受信运行时引用固化为单文件脚本。
    /// 只处理包含 deck-stage 的官方相对路径，不下载、不接受调用方指定的脚本。
    /// </summary>
    internal static string EnsureEmbeddedRuntime(string html)
    {
        if (string.IsNullOrWhiteSpace(html)
            || html.Contains("data-open-design-runtime", StringComparison.Ordinal)
            || !HasUnresolvedRuntimeReference(html)
            || !html.Contains("<deck-stage", StringComparison.OrdinalIgnoreCase))
            return html;

        var runtimePath = Path.Combine(
            AppContext.BaseDirectory,
            "Resources",
            "mdppt",
            "anchors",
            "soft-editorial",
            "deck-stage.js");
        if (!File.Exists(runtimePath)) return html;
        var runtime = File.ReadAllText(runtimePath);
        return System.Text.RegularExpressions.Regex.Replace(
            html,
            "<script\\s+src=[\"']assets/deck-stage\\.js[\"']\\s*></script>",
            _ => $"<script data-open-design-runtime>\n{runtime}\n</script>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));
    }

    internal static bool HasUnresolvedRuntimeReference(string html) =>
        !string.IsNullOrWhiteSpace(html)
        && System.Text.RegularExpressions.Regex.IsMatch(
            html,
            "<script\\s+src=[\"']assets/deck-stage\\.js[\"']\\s*></script>",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase,
            TimeSpan.FromSeconds(1));

    internal static string EnsureMobilePresentationGuard(string htmlHead, string? anchorName = null)
    {
        if (string.IsNullOrWhiteSpace(htmlHead)
            || htmlHead.Contains(MobilePresentationGuardId, StringComparison.Ordinal))
            return htmlHead;

        var taggedHead = htmlHead;
        var normalizedAnchorName = (anchorName ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedAnchorName.Length > 0
            && normalizedAnchorName.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '-'))
        {
            taggedHead = System.Text.RegularExpressions.Regex.Replace(
                taggedHead,
                "<body(?<attrs>[^>]*)>",
                match => $"<body{match.Groups["attrs"].Value} data-mdppt-anchor=\"{normalizedAnchorName}\">",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase,
                TimeSpan.FromSeconds(1));
        }

        var guard = normalizedAnchorName == "soft-editorial"
            ? SoftEditorialMobilePresentationGuard
            : MobilePresentationGuard;
        var headClose = taggedHead.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        return headClose >= 0
            ? taggedHead.Insert(headClose, guard + "\n")
            : guard + taggedHead;
    }

    /// <summary>
    /// 按页角色 + 设计意图挑版式范本：封面=首版式，结语=末版式；
    /// 中间页按设计意图关键词匹配（数据/对比/引用/时间线/列表/表格），否则轮换不重复。
    /// </summary>
    public static AnchorSlide PickLayout(Anchor anchor, int index, int total, string? designIntent)
    {
        if (index == 0) return anchor.Cover;
        if (index == total - 1) return anchor.Closing;
        var pool = anchor.ContentSlides;
        if (pool.Count == 0) return anchor.Cover;

        var intent = designIntent ?? string.Empty;
        var keywordMap = new (string[] Keys, string[] LayoutHints)[]
        {
            (new[] { "数据", "数字", "指标", "看板", "stat" }, new[] { "stats", "data", "numbers", "chart", "pie", "financial" }),
            (new[] { "对比", "比较", "vs" }, new[] { "compare", "split", "matrix" }),
            (new[] { "引用", "金句", "观点", "quote" }, new[] { "quote", "statement", "manifesto" }),
            (new[] { "时间线", "里程碑", "排期", "流程", "步骤" }, new[] { "timeline", "process", "roadmap", "cycle", "method", "pipeline" }),
            (new[] { "列表", "清单", "要点", "功能" }, new[] { "list", "grid", "index", "services", "pillars", "insights" }),
            (new[] { "表格", "table" }, new[] { "table", "dense", "financial" }),
            (new[] { "代码", "命令", "终端", "code" }, new[] { "code", "terminal" }),
        };
        foreach (var (keys, hints) in keywordMap)
        {
            if (!keys.Any(k => intent.Contains(k, StringComparison.OrdinalIgnoreCase))) continue;
            var hit = pool.FirstOrDefault(s => hints.Any(h => s.Layout.Contains(h, StringComparison.OrdinalIgnoreCase)));
            if (hit != null) return hit;
        }
        // 轮换：相邻内容页不重复版式
        return pool[(index - 1) % pool.Count];
    }
}
