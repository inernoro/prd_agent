using System.Net;
using System.Text;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

/// <summary>
/// 营销问策 HTML 渲染器 — 把「服务端整理的客户硬数据 + LLM 结构化评估」渲染为自包含 HTML 单文件。
/// 模板固定走服务端（不让 LLM 直接写整页 HTML）：样式稳定、防 prompt 注入、省 token。
/// 所有动态文本一律 HtmlEncode。提供 4 套专业模版（exec/consulting/dashboard/magazine），区别于项目简报的休闲风。
/// 对照 PmBriefingRenderer 复用同款结构（RenderData 落库 + 切模版重渲染不重调 LLM）。
/// </summary>
public static class MarketingReportRenderer
{
    /// <summary>问策硬数据（服务端整理，不经 LLM，保真）。整体序列化存入 RenderDataJson 供切换模版重渲染。</summary>
    public class RenderData
    {
        public string CustomerName { get; set; } = string.Empty;
        public string? MerchantNo { get; set; }
        public string? Industry { get; set; }
        public string? Region { get; set; }
        public string? Company { get; set; }
        public DateTime GeneratedAt { get; set; } = DateTime.UtcNow;
        public MarketingConsultAiContent Ai { get; set; } = new();
        public string? Model { get; set; }
        /// <summary>模版 key：exec | consulting | dashboard | magazine</summary>
        public string Template { get; set; } = "exec";
    }

    /// <summary>模版 token（颜色全部走模版，不在正文里写死）。四套均为专业严肃风。</summary>
    private sealed record Theme(
        string Label,
        string PageBg,
        string CardBg,
        string CardBorder,
        string CardShadow,
        string Radius,
        string TextPrimary,
        string TextSecondary,
        string TextMuted,
        string Accent,
        string AccentSoft,
        string MetricBg,
        string MetricBorder,
        string BarTrack,
        string FontFamily,
        string HeadingExtra,
        bool Dark);

    private const string SansFont = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
    private const string SerifFont = "Georgia,'Songti SC','STSong',serif";

    private static readonly Dictionary<string, Theme> Themes = new(StringComparer.OrdinalIgnoreCase)
    {
        // 行政简报：克制、稳重的深蓝商务（默认）
        ["exec"] = new Theme("行政简报", "#F1F4F9", "#FFFFFF", "#E2E8F0", "0 1px 3px rgba(15,23,42,0.06)", "12px",
            "#0F172A", "#1E293B", "#64748B", "#1D4ED8", "#1D4ED81a", "#F8FAFC", "#E2E8F0", "#E2E8F0", SansFont, "", false),
        // 咨询报告：麦肯锡式黑红、强调结构与依据
        ["consulting"] = new Theme("咨询报告", "#FBFAF8", "#FFFFFF", "#1A1A1A", "none", "2px",
            "#111111", "#2A2A2A", "#6B6B6B", "#B91C1C", "#B91C1C14", "#FAF7F5", "#E5E0DA", "#EAE6E0", SerifFont,
            "text-transform:uppercase;letter-spacing:1.5px;font-size:13px", false),
        // 数据看板：暗夜科技、青色高光、指标导向
        ["dashboard"] = new Theme("数据看板", "#0B1220", "#131C2E", "#243049", "0 6px 20px rgba(0,0,0,0.45)", "14px",
            "#E6EDF7", "#B6C2D6", "#7A8AA5", "#22D3EE", "#22D3EE1f", "#0F1828", "#243049", "#243049", SansFont, "", true),
        // 高端杂志：暖纸 + 衬线 + 大字标题
        ["magazine"] = new Theme("高端杂志", "#F6F1E9", "#FFFDF8", "#E4D8C5", "0 2px 10px rgba(120,90,40,0.07)", "8px",
            "#2C2418", "#473A28", "#8A7A63", "#9A6A28", "#9A6A2814", "#F2EADC", "#E4D8C5", "#E4D8C5", SerifFont,
            "font-family:" + SerifFont + ";letter-spacing:0.5px", false),
    };

    /// <summary>所有可选模版（key + 中文名 + 预览色），前端模版选择器消费同一份（SSOT，不在前端硬编码）。</summary>
    public static IReadOnlyList<(string Key, string Label, string Accent, string PageBg)> Templates =>
        new[] { "exec", "consulting", "dashboard", "magazine" }
            .Select(k => (k, Themes[k].Label, Themes[k].Accent, Themes[k].PageBg))
            .ToList();

    public static bool IsValidTemplate(string? template) => !string.IsNullOrWhiteSpace(template) && Themes.ContainsKey(template);

    public const string DefaultTemplate = "exec";

    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");

    /// <summary>UTC → 中国时区（报告面向国内业务方）。</summary>
    public static DateTime ToCst(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), ChinaTimeZone);

    private static string E(string? s) => WebUtility.HtmlEncode(s ?? string.Empty);

    private static (string label, string color, string bg) VerdictMeta(string verdict, bool dark) => verdict switch
    {
        "healthy" => dark ? ("健康", "#34D399", "rgba(52,211,153,0.15)") : ("健康", "#047857", "#D1FAE5"),
        "risk" => dark ? ("高风险", "#F87171", "rgba(248,113,113,0.15)") : ("高风险", "#B91C1C", "#FEE2E2"),
        _ => dark ? ("需关注", "#FBBF24", "rgba(251,191,36,0.15)") : ("需关注", "#B45309", "#FEF3C7"),
    };

    private static (string label, string color) RiskMeta(string level, bool dark) => level switch
    {
        "high" => ("高", dark ? "#F87171" : "#B91C1C"),
        "low" => ("低", dark ? "#34D399" : "#047857"),
        _ => ("中", dark ? "#FBBF24" : "#B45309"),
    };

    /// <summary>四力评分条颜色随分值梯度（红→黄→绿）。</summary>
    private static string ScoreColor(int score, bool dark)
    {
        if (score >= 75) return dark ? "#34D399" : "#059669";
        if (score >= 50) return dark ? "#FBBF24" : "#D97706";
        return dark ? "#F87171" : "#DC2626";
    }

    public static string Render(RenderData d)
    {
        var t = Themes.TryGetValue(d.Template ?? DefaultTemplate, out var theme) ? theme : Themes[DefaultTemplate];
        var (vLabel, vColor, vBg) = VerdictMeta(d.Ai.Verdict, t.Dark);
        var dateText = ToCst(d.GeneratedAt).ToString("yyyy-MM-dd");
        var sb = new StringBuilder();
        sb.Append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">");
        sb.Append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
        sb.Append($"<title>{E(d.CustomerName)} 营销问策 · {dateText}</title>");
        sb.Append("<style>");
        sb.Append("*{margin:0;padding:0;box-sizing:border-box}");
        sb.Append($"body{{font-family:{t.FontFamily};background:{t.PageBg};color:{t.TextPrimary};line-height:1.65;min-height:100vh}}");
        sb.Append(".page{max-width:880px;margin:0 auto;padding:32px 20px 48px}");
        sb.Append($".card{{background:{t.CardBg};border:1px solid {t.CardBorder};border-radius:{t.Radius};padding:28px 32px;margin-bottom:16px;box-shadow:{t.CardShadow}}}");
        sb.Append($".hd-kicker{{font-size:12px;letter-spacing:2px;color:{t.TextMuted};text-transform:uppercase;margin-bottom:8px}}");
        sb.Append($"h1{{font-size:{(d.Template == "magazine" ? "30px" : "24px")};font-weight:700;letter-spacing:0.3px}}");
        sb.Append($".hd-meta{{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:12px;font-size:13px;color:{t.TextMuted}}}");
        sb.Append(".pill{display:inline-block;font-size:12.5px;font-weight:600;padding:3px 12px;border-radius:999px;vertical-align:3px;margin-left:12px}");
        sb.Append($"h2{{font-size:15px;font-weight:700;margin-bottom:14px;padding-left:10px;border-left:3px solid {t.Accent};{t.HeadingExtra}}}");
        sb.Append($".summary{{font-size:14.5px;color:{t.TextSecondary};white-space:pre-wrap}}");
        sb.Append($".verdict-note{{font-size:13px;color:{t.TextMuted};margin-top:8px}}");
        sb.Append(".forces{display:flex;flex-direction:column;gap:14px}");
        sb.Append(".force{display:grid;grid-template-columns:88px 1fr 46px;align-items:center;gap:12px}");
        sb.Append($".force .fn{{font-size:13.5px;font-weight:600;color:{t.TextPrimary}}}");
        sb.Append($".force .fc{{grid-column:2/4;font-size:12.5px;color:{t.TextMuted};margin-top:2px}}");
        sb.Append($".bar{{background:{t.BarTrack};border-radius:999px;height:8px;overflow:hidden}}");
        sb.Append(".bar>span{display:block;height:100%;border-radius:999px}");
        sb.Append($".force .fv{{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;color:{t.TextPrimary}}}");
        sb.Append($"ul.plain{{list-style:none}}ul.plain li{{position:relative;padding-left:18px;margin-bottom:8px;font-size:14px;color:{t.TextSecondary}}}");
        sb.Append($"ul.plain li::before{{content:'';position:absolute;left:2px;top:9px;width:6px;height:6px;border-radius:50%;background:{t.Accent}}}");
        sb.Append(".tag{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px}");
        sb.Append($".risk-item{{display:flex;gap:10px;align-items:flex-start;margin-bottom:10px;font-size:14px;color:{t.TextSecondary}}}");
        sb.Append($".footer{{margin-top:8px;font-size:12px;color:{t.TextMuted};text-align:center}}");
        sb.Append($"@media print{{body{{background:{(t.Dark ? "#0B1220" : "#fff")}}}.card{{box-shadow:none}}}}");
        sb.Append("</style></head><body><div class=\"page\">");

        // 头部
        sb.Append("<div class=\"card\">");
        sb.Append("<div class=\"hd-kicker\">MARKETING CONSULT · 营销问策</div>");
        sb.Append($"<h1>{E(d.CustomerName)}<span class=\"pill\" style=\"color:{vColor};background:{vBg}\">{vLabel}</span></h1>");
        sb.Append("<div class=\"hd-meta\">");
        if (!string.IsNullOrWhiteSpace(d.MerchantNo)) sb.Append($"<span>商户编号 {E(d.MerchantNo)}</span>");
        if (!string.IsNullOrWhiteSpace(d.Company)) sb.Append($"<span>所属公司 {E(d.Company)}</span>");
        if (!string.IsNullOrWhiteSpace(d.Industry)) sb.Append($"<span>行业 {E(d.Industry)}</span>");
        if (!string.IsNullOrWhiteSpace(d.Region)) sb.Append($"<span>区域 {E(d.Region)}</span>");
        sb.Append($"<span>问策日期 {dateText}</span>");
        sb.Append("</div>");
        if (!string.IsNullOrWhiteSpace(d.Ai.VerdictNote))
            sb.Append($"<div class=\"verdict-note\">{E(d.Ai.VerdictNote)}</div>");
        sb.Append("</div>");

        // 总体评估
        if (!string.IsNullOrWhiteSpace(d.Ai.Summary))
            sb.Append($"<div class=\"card\"><h2>总体评估</h2><div class=\"summary\">{E(d.Ai.Summary)}</div></div>");

        // 四力评分（4FM）
        if (d.Ai.Forces.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>四力诊断（产品力 · 渠道力 · 场景力 · 传播力）</h2><div class=\"forces\">");
            foreach (var f in d.Ai.Forces)
            {
                var score = Math.Clamp(f.Score, 0, 100);
                var c = ScoreColor(score, t.Dark);
                sb.Append("<div class=\"force\">");
                sb.Append($"<div class=\"fn\">{E(f.Name)}</div>");
                sb.Append($"<div class=\"bar\"><span style=\"width:{score}%;background:{c}\"></span></div>");
                sb.Append($"<div class=\"fv\" style=\"color:{c}\">{score}</div>");
                if (!string.IsNullOrWhiteSpace(f.Comment))
                    sb.Append($"<div class=\"fc\">{E(f.Comment)}</div>");
                sb.Append("</div>");
            }
            sb.Append("</div></div>");
        }

        // 核心优势
        if (d.Ai.Strengths.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>核心优势</h2><ul class=\"plain\">");
            foreach (var s in d.Ai.Strengths) sb.Append($"<li>{E(s)}</li>");
            sb.Append("</ul></div>");
        }

        // 风险与问题
        if (d.Ai.Risks.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>风险与问题</h2>");
            foreach (var r in d.Ai.Risks)
            {
                var (rl, rc) = RiskMeta(r.Level, t.Dark);
                sb.Append($"<div class=\"risk-item\"><span class=\"tag\" style=\"color:{rc};background:{rc}1f;flex-shrink:0;margin-top:2px\">{rl}</span><span>{E(r.Text)}</span></div>");
            }
            sb.Append("</div>");
        }

        // 营销建议
        if (d.Ai.Suggestions.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>营销建议</h2><ul class=\"plain\">");
            foreach (var s in d.Ai.Suggestions) sb.Append($"<li>{E(s)}</li>");
            sb.Append("</ul></div>");
        }

        // 下一步行动
        if (d.Ai.NextActions.Count > 0)
        {
            sb.Append("<div class=\"card\"><h2>下一步行动</h2><ul class=\"plain\">");
            foreach (var n in d.Ai.NextActions) sb.Append($"<li>{E(n)}</li>");
            sb.Append("</ul></div>");
        }

        if (!string.IsNullOrWhiteSpace(d.Model))
            sb.Append($"<div class=\"footer\">由 {E(d.Model)} 生成 · 仅供内部营销决策参考</div>");

        sb.Append("</div></body></html>");
        return sb.ToString();
    }
}
