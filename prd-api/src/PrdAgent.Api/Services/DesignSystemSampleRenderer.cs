using System.Globalization;
using System.Net;
using System.Text;

namespace PrdAgent.Api.Services;

/// <summary>
/// 风格样张：某套设计系统的真实 tokens.css + 所有设计系统共用的一份样张模板。
/// 模板只引用 OpenDesign 统一的语义令牌（--bg / --fg / --accent / --font-display / --text-* / --space-* …），
/// 不写任何具体颜色、字体或尺寸——同一份版式在不同设计系统下长成什么样，完全由它自己的 tokens 决定，
/// 所以缩略图就是这个风格真实的样子，而不是手画的色块。
///
/// 输出是完整、自包含的 HTML：没有脚本、没有外部资源、没有链接跳转，
/// 适合放进 <c>sandbox=""</c> 的 iframe 里渲染。
/// </summary>
public static class DesignSystemSampleRenderer
{
    public const int MaxTitleLength = 60;
    public const string DefaultTitle = "码安全与性能架构提升";

    public static readonly IReadOnlyList<string> Formats = new[] { SampleFormats.Page, SampleFormats.Slides };

    public static class SampleFormats
    {
        public const string Page = "page";
        public const string Slides = "slides";
    }

    /// <summary>样张 URL（不含查询串）。目录接口与生成设置接口都用这一个函数给出地址。</summary>
    public static string SamplePath(string designSystemId)
        => $"/api/design-artifacts/design-systems/{Uri.EscapeDataString(designSystemId)}/sample";

    /// <summary>
    /// 规范化标题：去掉控制字符、压缩空白、按字素截到 <see cref="MaxTitleLength"/> 个字；空则用默认示例标题。
    /// 返回的是纯文本，写进 HTML 前还要转义（<see cref="Render"/> 负责）。
    /// </summary>
    public static string NormalizeTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return DefaultTitle;
        var builder = new StringBuilder(title.Length);
        var lastWasSpace = false;
        foreach (var ch in title)
        {
            if (char.IsControl(ch) || char.IsWhiteSpace(ch))
            {
                if (!lastWasSpace && builder.Length > 0) builder.Append(' ');
                lastWasSpace = true;
                continue;
            }
            builder.Append(ch);
            lastWasSpace = false;
        }
        var cleaned = builder.ToString().Trim();
        if (cleaned.Length == 0) return DefaultTitle;
        var info = new StringInfo(cleaned);
        return info.LengthInTextElements <= MaxTitleLength
            ? cleaned
            : info.SubstringByTextElements(0, MaxTitleLength);
    }

    public static bool IsKnownFormat(string? format)
        => format is null || Formats.Contains(format.Trim().ToLowerInvariant());

    public static string Render(DesignSystemEntry system, string? title, string? format)
    {
        var normalizedFormat = string.IsNullOrWhiteSpace(format) ? SampleFormats.Page : format.Trim().ToLowerInvariant();
        if (!Formats.Contains(normalizedFormat))
            throw new ArgumentOutOfRangeException(nameof(format), format, "样张格式只支持 page 或 slides");
        var safeTitle = WebUtility.HtmlEncode(NormalizeTitle(title));
        var safeName = WebUtility.HtmlEncode(system.Name);
        // tokens.css 来自仓库里提交的快照，不含用户输入；仍然防一手「</style」提前闭合样式块。
        var tokens = system.TokensCss.Replace("</", "<\\/", StringComparison.Ordinal);
        var body = normalizedFormat == SampleFormats.Slides
            ? SlidesBody(safeTitle, safeName)
            : PageBody(safeTitle, safeName);
        var layout = normalizedFormat == SampleFormats.Slides ? SlidesCss : PageCss;
        return $$"""
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="map-design-system" content="{{WebUtility.HtmlEncode(system.Id)}}">
<title>{{safeTitle}}</title>
<style>
{{tokens}}
</style>
<style>
{{SharedCss}}
{{layout}}
</style>
</head>
<body>
{{body}}
</body>
</html>
""";
    }

    // 共享排版：只用语义令牌。
    private const string SharedCss = """
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:var(--font-body);font-size:var(--text-base);line-height:var(--leading-body);-webkit-font-smoothing:antialiased}
h1,h2,h3,p,ol,ul,figure,blockquote{margin:0;padding:0}
ol,ul{list-style:none}
.eyebrow{font-family:var(--font-mono);font-size:var(--text-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--meta)}
.display{font-family:var(--font-display);letter-spacing:var(--tracking-display);line-height:var(--leading-tight);color:var(--fg);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.lead{color:var(--fg-2);font-size:var(--text-lg);line-height:var(--leading-body)}
.metric-value{font-family:var(--font-display);font-size:var(--text-2xl);line-height:var(--leading-tight);letter-spacing:var(--tracking-display);color:var(--accent)}
.metric-label{color:var(--muted);font-size:var(--text-sm)}
.pill{display:inline-flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-4);border-radius:var(--radius-pill);background:var(--accent);color:var(--accent-on);font-size:var(--text-sm);font-weight:600}
""";

    private const string PageCss = """
.page{min-height:760px;display:flex;flex-direction:column}
.nav{display:flex;align-items:center;justify-content:space-between;padding:var(--space-4) var(--space-12);border-bottom:1px solid var(--border-soft);background:var(--surface)}
.brand{font-family:var(--font-display);font-size:var(--text-lg);font-weight:600;color:var(--fg)}
.nav-links{display:flex;align-items:center;gap:var(--space-6);color:var(--muted);font-size:var(--text-sm)}
.nav-links .current{color:var(--fg);box-shadow:inset 0 -2px 0 var(--accent);padding-bottom:var(--space-2)}
.hero{display:grid;grid-template-columns:1.35fr 1fr;gap:var(--space-12);padding:var(--space-8) var(--space-12) var(--space-6)}
.hero h1{font-size:var(--text-3xl);margin:var(--space-3) 0 var(--space-4)}
.metrics{display:grid;grid-template-columns:1fr;gap:var(--space-3);align-self:end}
.metric{display:flex;align-items:baseline;gap:var(--space-4);padding:var(--space-4);border-radius:var(--radius-md);background:var(--surface);box-shadow:var(--elev-ring)}
.metric-value{font-size:var(--text-xl);min-width:6.5em}
.section{padding:0 var(--space-12) var(--space-6)}
.section-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:var(--space-4)}
.section-head h2{font-family:var(--font-display);font-size:var(--text-xl);letter-spacing:var(--tracking-display);line-height:var(--leading-tight)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-4)}
.card{padding:var(--space-6);border-radius:var(--radius-lg);background:var(--surface);border:1px solid var(--border);box-shadow:var(--elev-raised)}
.card .index{font-family:var(--font-mono);font-size:var(--text-xs);color:var(--accent)}
.card h3{font-family:var(--font-display);font-size:var(--text-lg);margin:var(--space-2) 0;color:var(--fg)}
.card p{color:var(--fg-2);font-size:var(--text-sm)}
.timeline{display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:var(--space-4);align-items:stretch}
.step{padding:var(--space-4) var(--space-6);border-left:3px solid var(--accent);background:var(--surface-warm);border-radius:var(--radius-sm)}
.step.later{border-left-color:var(--border)}
.step strong{display:block;font-family:var(--font-display);font-size:var(--text-lg);color:var(--fg)}
.step span{color:var(--muted);font-size:var(--text-sm)}
blockquote{padding:var(--space-4) var(--space-6);border-radius:var(--radius-md);background:var(--accent);color:var(--accent-on);font-family:var(--font-display);font-size:var(--text-lg);line-height:var(--leading-tight);display:flex;align-items:center}
""";

    private const string SlidesCss = """
.slide{width:1280px;height:720px;display:flex;flex-direction:column;justify-content:space-between;padding:var(--space-12) calc(var(--space-12) * 1.5);background:var(--bg);border-top:var(--space-2) solid var(--accent);overflow:hidden}
.slide-top{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:var(--text-sm)}
.slide h1{font-size:var(--text-4xl);margin:var(--space-4) 0 var(--space-6);max-width:18em}
.slide .lead{max-width:40em}
.slide-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--space-6);padding-top:var(--space-6);border-top:1px solid var(--border)}
.slide-metrics .metric-value{font-size:var(--text-2xl)}
""";

    private static string PageBody(string safeTitle, string safeName) => $$"""
<div class="page">
  <header class="nav">
    <div class="brand">方案简报</div>
    <nav class="nav-links" aria-label="样张导航">
      <span class="current">概览</span><span>关键数字</span><span>行业镜子</span><span>时间窗口</span>
      <span class="pill">查看全文</span>
    </nav>
  </header>
  <section class="hero">
    <div>
      <p class="eyebrow">架构提升 · {{safeName}} 风格样张</p>
      <h1 class="display">{{safeTitle}}</h1>
      <p class="lead">6 个长期存在的安全与性能问题，放在同一次架构提升里一起解决。现在做需要 1 个月，拖到明年要 3 个月。</p>
    </div>
    <ol class="metrics" aria-label="关键数字">
      <li class="metric"><span class="metric-value">6 个</span><span class="metric-label">长期安全与性能问题</span></li>
      <li class="metric"><span class="metric-value">4%</span><span class="metric-label">GDPR 罚款上限参照全球营收</span></li>
      <li class="metric"><span class="metric-value">1 → 3 个月</span><span class="metric-label">现在做与明年做的工期</span></li>
    </ol>
  </section>
  <section class="section" aria-label="三面行业镜子">
    <div class="section-head"><h2>三面行业镜子</h2><span class="eyebrow">同类问题在别处的样子</span></div>
    <ul class="cards">
      <li class="card"><span class="index">01</span><h3>窜码与假码</h3><p>码在渠道之间被复制、冒用，出了问题追不回源头。</p></li>
      <li class="card"><span class="index">02</span><h3>数据库拖库</h3><p>数据被整库导出带走，损失在发现之前就已经发生。</p></li>
      <li class="card"><span class="index">03</span><h3>密钥硬编码</h3><p>密钥写死在代码里，跟着仓库和安装包一起扩散。</p></li>
    </ul>
  </section>
  <section class="section" aria-label="时间窗口">
    <div class="timeline">
      <div class="step"><strong>现在做</strong><span>1 个月完成架构提升</span></div>
      <div class="step later"><strong>明年做</strong><span>同样的工作要 3 个月</span></div>
      <blockquote>同一件事，越晚做越贵。</blockquote>
    </div>
  </section>
</div>
""";

    private static string SlidesBody(string safeTitle, string safeName) => $$"""
<section class="slide" aria-label="封面">
  <div class="slide-top"><span class="eyebrow">架构提升 · {{safeName}} 风格样张</span><span>方案简报</span></div>
  <div>
    <h1 class="display">{{safeTitle}}</h1>
    <p class="lead">6 个长期存在的安全与性能问题，放在同一次架构提升里一起解决。</p>
  </div>
  <div class="slide-metrics">
    <div><div class="metric-value">6 个</div><div class="metric-label">长期安全与性能问题</div></div>
    <div><div class="metric-value">4%</div><div class="metric-label">GDPR 罚款上限参照全球营收</div></div>
    <div><div class="metric-value">1 → 3 个月</div><div class="metric-label">现在做与明年做的工期</div></div>
  </div>
</section>
""";
}
