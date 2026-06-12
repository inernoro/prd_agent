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
        ["tech-dark"] = "monochrome",
        ["aurora-gradient"] = "bold-poster",
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
            (new[] { "时间线", "里程碑", "排期", "流程", "步骤" }, new[] { "timeline", "process", "roadmap", "cycle", "method" }),
            (new[] { "列表", "清单", "要点", "功能" }, new[] { "list", "grid", "index", "services", "pillars", "insights" }),
            (new[] { "表格", "table" }, new[] { "table", "dense", "financial" }),
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
